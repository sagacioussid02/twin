from fastapi import FastAPI, HTTPException, UploadFile, File
from pydantic import field_validator
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
from dotenv import load_dotenv
from typing import Optional, List, Dict
import json
import uuid
from datetime import datetime
import boto3
from botocore.exceptions import ClientError
from pathlib import Path
from pypdf import PdfReader
import io
import re
from context import prompt

# Load environment variables
load_dotenv()

app = FastAPI()

# Configure CORS
origins = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Initialize Bedrock client - see Q42 on https://edwarddonner.com/faq if the Region gives you problems
bedrock_client = boto3.client(
    service_name="bedrock-runtime", 
    region_name=os.getenv("DEFAULT_AWS_REGION", "us-east-1")
)

# Bedrock model selection - see Q42 on https://edwarddonner.com/faq for more
BEDROCK_MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "global.amazon.nova-2-lite-v1:0")

# Memory storage configuration
USE_S3 = os.getenv("USE_S3", "false").lower() == "true"
S3_BUCKET = os.getenv("S3_BUCKET", "")
MEMORY_DIR = os.getenv("MEMORY_DIR", "../memory")

# Initialize S3 client if needed
if USE_S3:
    if not S3_BUCKET:
        raise RuntimeError("USE_S3=true but S3_BUCKET environment variable is not set")
    s3_client = boto3.client("s3")


# Request/Response models
# Local twins dir: use /tmp/twins in Lambda (package dir is read-only), local path otherwise
_IN_LAMBDA = bool(os.getenv("AWS_LAMBDA_FUNCTION_NAME"))
TWINS_DIR = "/tmp/twins" if _IN_LAMBDA else os.path.join(os.path.dirname(__file__), "twins")  # nosec B108 — /tmp is the only writable path in Lambda; S3 is used when USE_S3=true
TWINS_S3_PREFIX = "twins/"


_TWIN_ID_RE = re.compile(r'^[a-f0-9]{32}$')

# Expected keys for the personality model returned by /create-twin
_PERSONALITY_MODEL_KEYS = {
    "core_values", "decision_heuristics", "risk_profile",
    "what_they_optimize_for", "what_they_avoid",
    "communication_traits", "blind_spots",
    "decision_framework", "personality_summary",
}


def _extract_json_object(text: str) -> dict:
    """Extract the first complete JSON object using balanced-brace scan.
    Handles nested objects correctly — greedy regex would over-capture."""
    start = text.find('{')
    if start == -1:
        raise ValueError("No JSON object found in response")
    depth, in_string, escape_next = 0, False, False
    for i, ch in enumerate(text[start:], start):
        if escape_next:
            escape_next = False
            continue
        if ch == '\\' and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i + 1])
    raise ValueError("Unbalanced braces — could not extract JSON object")


def _extract_json_array(text: str) -> list:
    """Extract the first complete JSON array using balanced-bracket scan."""
    start = text.find('[')
    if start == -1:
        raise ValueError("No JSON array found in response")
    depth, in_string, escape_next = 0, False, False
    for i, ch in enumerate(text[start:], start):
        if escape_next:
            escape_next = False
            continue
        if ch == '\\' and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                return json.loads(text[start:i + 1])
    raise ValueError("Unbalanced brackets — could not extract JSON array")


def load_twin(twin_id: str) -> Optional[dict]:
    """Load a saved twin's data by ID. Validates ID format and confines path to TWINS_DIR."""
    if not _TWIN_ID_RE.match(twin_id):
        raise HTTPException(status_code=400, detail="Invalid twin ID format")

    if USE_S3:
        try:
            response = s3_client.get_object(Bucket=S3_BUCKET, Key=f"{TWINS_S3_PREFIX}{twin_id}.json")
            return json.loads(response["Body"].read().decode("utf-8"))
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                return None
            raise

    path = os.path.realpath(os.path.join(TWINS_DIR, f"{twin_id}.json"))
    if not path.startswith(os.path.realpath(TWINS_DIR) + os.sep):
        raise HTTPException(status_code=400, detail="Invalid twin ID")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return None


class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    twin_id: Optional[str] = None  # if set, chat with a user-created twin


class ChatResponse(BaseModel):
    response: str
    session_id: str


class Message(BaseModel):
    role: str
    content: str
    timestamp: str


# Memory management functions
def get_memory_path(session_id: str) -> str:
    return f"{session_id}.json"


def load_conversation(session_id: str) -> List[Dict]:
    """Load conversation history from storage"""
    if USE_S3:
        try:
            response = s3_client.get_object(Bucket=S3_BUCKET, Key=get_memory_path(session_id))
            return json.loads(response["Body"].read().decode("utf-8"))
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                return []
            raise
    else:
        # Local file storage
        file_path = os.path.join(MEMORY_DIR, get_memory_path(session_id))
        if os.path.exists(file_path):
            with open(file_path, "r") as f:
                return json.load(f)
        return []


def save_conversation(session_id: str, messages: List[Dict]):
    """Save conversation history to storage"""
    if USE_S3:
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=get_memory_path(session_id),
            Body=json.dumps(messages, indent=2),
            ContentType="application/json",
        )
    else:
        # Local file storage
        os.makedirs(MEMORY_DIR, exist_ok=True)
        file_path = os.path.join(MEMORY_DIR, get_memory_path(session_id))
        with open(file_path, "w") as f:
            json.dump(messages, f, indent=2)


def call_bedrock(conversation: List[Dict], user_message: str, personality_model: Optional[dict] = None, twin_name: Optional[str] = None, twin_title: Optional[str] = None) -> str:
    """Call AWS Bedrock with conversation history"""

    # Build messages in Bedrock format
    messages = []

    system_prompt = prompt(personality_model=personality_model, twin_name=twin_name, twin_title=twin_title)
    messages.append({
        "role": "user",
        "content": [{"text": f"System: {system_prompt}"}]
    })
    
    # Add conversation history (limit to last 25 exchanges)
    for msg in conversation[-50:]:
        messages.append({
            "role": msg["role"],
            "content": [{"text": msg["content"]}]
        })
    
    # Add current user message
    messages.append({
        "role": "user",
        "content": [{"text": user_message}]
    })
    
    try:
        # Call Bedrock using the converse API
        response = bedrock_client.converse(
            modelId=BEDROCK_MODEL_ID,
            messages=messages,
            inferenceConfig={
                "maxTokens": 2000,
                "temperature": 0.7,
                "topP": 0.9
            }
        )
        
        # Extract the response text
        return response["output"]["message"]["content"][0]["text"]
        
    except ClientError as e:
        error_code = e.response['Error']['Code']
        if error_code == 'ValidationException':
            # Handle message format issues
            print(f"Bedrock validation error: {e}")
            raise HTTPException(status_code=400, detail="Invalid message format for Bedrock")
        elif error_code == 'AccessDeniedException':
            print(f"Bedrock access denied: {e}")
            raise HTTPException(status_code=403, detail="Access denied to Bedrock model")
        else:
            print(f"Bedrock error: {e}")
            raise HTTPException(status_code=500, detail=f"Bedrock error: {str(e)}")


@app.get("/")
async def root():
    return {
        "message": "AI Digital Twin API (Powered by AWS Bedrock)",
        "memory_enabled": True,
        "storage": "S3" if USE_S3 else "local",
        "ai_model": BEDROCK_MODEL_ID
    }


@app.get("/health")
async def health_check():
    return {
        "status": "healthy", 
        "use_s3": USE_S3,
        "bedrock_model": BEDROCK_MODEL_ID
    }


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    try:
        session_id = request.session_id or str(uuid.uuid4())
        conversation = load_conversation(session_id)

        # Load twin personality model if twin_id provided
        personality_model = None
        twin_name = None
        twin_title = None
        if request.twin_id:
            twin_data = load_twin(request.twin_id)
            if not twin_data:
                raise HTTPException(status_code=404, detail=f"Twin '{request.twin_id}' not found")
            personality_model = twin_data.get("personality_model", {})
            # Attach raw fields so context builder can access them
            personality_model["_context"] = twin_data.get("personality_model", {}).get("_context", {})
            twin_name = twin_data.get("name")
            twin_title = twin_data.get("title")

        assistant_response = call_bedrock(conversation, request.message, personality_model, twin_name, twin_title)

        # Update conversation history
        conversation.append(
            {"role": "user", "content": request.message, "timestamp": datetime.now().isoformat()}
        )
        conversation.append(
            {
                "role": "assistant",
                "content": assistant_response,
                "timestamp": datetime.now().isoformat(),
            }
        )

        # Save conversation
        save_conversation(session_id, conversation)

        return ChatResponse(response=assistant_response, session_id=session_id)

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in chat endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conversation/{session_id}")
async def get_conversation(session_id: str):
    """Retrieve conversation history"""
    try:
        conversation = load_conversation(session_id)
        return {"session_id": session_id, "messages": conversation}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Cache for taglines to reduce API calls
tagline_cache = {"taglines": None, "timestamp": None}
TAGLINE_CACHE_TTL = 3600  # Cache for 1 hour

@app.get("/taglines")
async def get_taglines():
    """Generate humorous and attractive taglines dynamically using AI (cached)"""
    global tagline_cache
    from datetime import datetime, timedelta
    
    # Check if cache is still valid
    if (tagline_cache["taglines"] is not None and 
        tagline_cache["timestamp"] is not None and
        datetime.now() - tagline_cache["timestamp"] < timedelta(seconds=TAGLINE_CACHE_TTL)):
        print("Returning cached taglines")
        return {"taglines": tagline_cache["taglines"]}
    
    try:
        print("Generating new taglines from AI...")
        prompt_text = """Generate exactly 10 short, humorous, witty, and attractive taglines for an AI Digital Twin product. 
        Each tagline should be catchy, fun, and appeal to tech-savvy users. They should relate to AI, digital clones, productivity, or self-improvement.
        Keep each tagline to 2-5 words maximum.
        Format: Return only a JSON array of strings, nothing else.
        Example format: ["Coffee with this guy", "Resumes are old school", "Your digital brainpower unleashed"]"""
        
        messages = [
            {
                "role": "user",
                "content": [{"text": prompt_text}]
            }
        ]
        
        response = bedrock_client.converse(
            modelId=BEDROCK_MODEL_ID,
            messages=messages,
            inferenceConfig={
                "maxTokens": 500,
                "temperature": 0.9,
                "topP": 0.95
            }
        )
        
        response_text = response["output"]["message"]["content"][0]["text"]
        
        try:
            taglines = _extract_json_array(response_text)
            tagline_cache["taglines"] = taglines
            tagline_cache["timestamp"] = datetime.now()
            return {"taglines": taglines}
        except (ValueError, json.JSONDecodeError):
            fallback = ["Talk to your AI twin", "Your digital self awaits", "AI collaboration unlocked"]
            tagline_cache["taglines"] = fallback
            tagline_cache["timestamp"] = datetime.now()
            return {"taglines": fallback}
            
    except Exception as e:
        print(f"Error generating taglines: {str(e)}")
        # Return fallback taglines on error
        fallback = [
            "Coffee with this guy",
            "Resumes are old school",
            "Your digital brainpower unleashed",
            "The future of collaboration is here",
            "AI that gets you",
            "Your second brain in action",
            "Talk to your smarter self",
            "Meet Sidd 2.0",
            "Intelligence amplified",
            "Your AI just leveled up"
        ]
        tagline_cache["taglines"] = fallback
        tagline_cache["timestamp"] = datetime.now()
        return {"taglines": fallback}


@app.post("/parse-linkedin")
async def parse_linkedin(file: UploadFile = File(...)):
    """Extract structured profile data from a LinkedIn PDF using Bedrock"""
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    try:
        contents = await file.read()
        reader = PdfReader(io.BytesIO(contents))
        text = ""
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                text += page_text + "\n"
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read PDF: {str(e)}")

    if not text.strip():
        raise HTTPException(status_code=400, detail="Could not extract text from PDF")

    extract_prompt = f"""You are extracting structured profile data from a LinkedIn PDF export.

LinkedIn PDF content:
{text[:6000]}

Extract the following fields and return ONLY a valid JSON object with these exact keys:
{{
  "name": "full name",
  "title": "current job title and company",
  "bio": "2-3 sentence professional summary",
  "skills": "comma-separated list of top skills",
  "experience": "bullet list of roles: Company (dates): what they did",
  "achievements": "notable achievements, awards, or highlights",
  "communicationStyle": "inferred communication style based on their writing and background"
}}

If a field cannot be determined, use an empty string. Return only the JSON, no other text."""

    try:
        response = bedrock_client.converse(
            modelId=BEDROCK_MODEL_ID,
            messages=[{"role": "user", "content": [{"text": extract_prompt}]}],
            inferenceConfig={"maxTokens": 1500, "temperature": 0.2},
        )
        response_text = response["output"]["message"]["content"][0]["text"]

        try:
            return _extract_json_object(response_text)
        except (ValueError, json.JSONDecodeError):
            raise HTTPException(status_code=500, detail="Could not parse AI response as JSON")

    except HTTPException:
        raise
    except ClientError as e:
        raise HTTPException(status_code=500, detail=f"Bedrock error: {str(e)}")


class CreateTwinRequest(BaseModel):
    name: str
    title: str
    bio: str
    email: str = ""
    skills: str = ""
    experience: str = ""
    achievements: str = ""
    coreValues: str = ""
    decisionStyle: str = ""
    riskTolerance: str = ""
    pastDecisions: str = ""
    communicationStyle: str = ""
    writingSamples: str = ""
    blindSpots: str = ""

    @field_validator("name", "title", "bio")
    @classmethod
    def strip_and_require(cls, v: str, info) -> str:
        v = v.strip()
        if not v:
            raise ValueError(f"{info.field_name} must not be empty")
        limits = {"name": 100, "title": 150, "bio": 2000}
        limit = limits.get(info.field_name, 2000)
        if len(v) > limit:
            raise ValueError(f"{info.field_name} must be {limit} characters or fewer")
        return v

    @field_validator(
        "email", "skills", "experience", "achievements",
        "coreValues", "decisionStyle", "riskTolerance", "pastDecisions",
        "communicationStyle", "writingSamples", "blindSpots",
    )
    @classmethod
    def strip_optional(cls, v: str) -> str:
        return v.strip()


@app.get("/twin/{twin_id}")
async def get_twin(twin_id: str):
    """Fetch public profile data for a twin"""
    twin_data = load_twin(twin_id)
    if not twin_data:
        raise HTTPException(status_code=404, detail="Twin not found")
    return {
        "twin_id": twin_data["twin_id"],
        "name": twin_data["name"],
        "title": twin_data.get("title", ""),
        "personality_summary": twin_data.get("personality_model", {}).get("personality_summary", ""),
        "core_values": twin_data.get("personality_model", {}).get("core_values", []),
        "created_at": twin_data.get("created_at", ""),
    }


@app.post("/create-twin")
async def create_twin(request: CreateTwinRequest):
    """Synthesize submitted profile data into a structured personality model via Bedrock"""

    synthesis_prompt = f"""You are building a personality model for an AI twin. Your job is to deeply analyze everything provided and produce a structured JSON model that captures how this person THINKS and DECIDES — not just what they've done.

This model will be used to answer questions like "What would {request.name} do?" in real situations.

=== PROFILE DATA ===

Name: {request.name}
Title: {request.title}
Bio: {request.bio}

Skills: {request.skills}

Work Experience:
{request.experience}

Achievements:
{request.achievements}

Core Values:
{request.coreValues}

Decision-Making Style:
{request.decisionStyle}

Risk Tolerance: {request.riskTolerance}

Past Decisions & Reasoning:
{request.pastDecisions}

Communication Style:
{request.communicationStyle}

Writing Samples/Links:
{request.writingSamples}

Blind Spots & Biases:
{request.blindSpots}

=== TASK ===

Analyze all of the above and return ONLY a valid JSON object with this exact structure:

{{
  "core_values": ["value 1", "value 2", ...],
  "decision_heuristics": [
    "When facing X type of decision, they tend to Y",
    ...
  ],
  "risk_profile": "one paragraph describing how they approach risk and uncertainty",
  "what_they_optimize_for": ["thing 1", "thing 2", ...],
  "what_they_avoid": ["thing 1", "thing 2", ...],
  "communication_traits": ["trait 1", "trait 2", ...],
  "blind_spots": ["blind spot 1", "blind spot 2", ...],
  "decision_framework": "2-3 sentence summary of their overall decision-making philosophy",
  "personality_summary": "3-4 sentence paragraph capturing the essence of who this person is and how they operate — written in second person as if talking to their twin"
}}

Be specific and concrete. Avoid generic statements. Infer from the data even when not explicit. Return only the JSON."""

    try:
        response = bedrock_client.converse(
            modelId=BEDROCK_MODEL_ID,
            messages=[{"role": "user", "content": [{"text": synthesis_prompt}]}],
            inferenceConfig={"maxTokens": 2000, "temperature": 0.3},
        )
        response_text = response["output"]["message"]["content"][0]["text"]

        try:
            personality_model = _extract_json_object(response_text)
        except (ValueError, json.JSONDecodeError):
            raise HTTPException(status_code=500, detail="Could not parse personality model from AI response")

        missing = _PERSONALITY_MODEL_KEYS - personality_model.keys()
        if missing:
            raise HTTPException(status_code=500, detail=f"Personality model missing expected keys: {missing}")

    except HTTPException:
        raise
    except ClientError as e:
        raise HTTPException(status_code=500, detail=f"Bedrock error: {str(e)}")

    twin_id = uuid.uuid4().hex  # 32 hex chars (128-bit) — no truncation, no collision risk

    # Only persist what's needed at chat time — no email or raw form fields (PII).
    # Embed the context fields the prompt builder needs directly in the personality model.
    personality_model["_context"] = {
        "bio": request.bio,
        "skills": request.skills,
        "experience": request.experience,
        "achievements": request.achievements,
        "communicationStyle": request.communicationStyle,
    }

    twin_data = {
        "twin_id": twin_id,
        "name": request.name,
        "title": request.title,
        "personality_model": personality_model,
        "created_at": datetime.now().isoformat(),
        "chat_url": f"/twin?id={twin_id}",
    }

    if USE_S3:
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=f"{TWINS_S3_PREFIX}{twin_id}.json",
            Body=json.dumps(twin_data, indent=2),
            ContentType="application/json",
        )
    else:
        # Local / Lambda /tmp fallback — not durable across Lambda cold starts
        os.makedirs(TWINS_DIR, exist_ok=True)
        try:
            max_twins = int(os.getenv("MAX_TWINS_FILES", "1000"))
        except ValueError:
            max_twins = 1000
        existing = sorted(Path(TWINS_DIR).glob("*.json"), key=lambda p: p.stat().st_mtime)
        for old_file in existing[: max(0, len(existing) - max_twins + 1)]:
            old_file.unlink(missing_ok=True)
        with open(os.path.join(TWINS_DIR, f"{twin_id}.json"), "w") as f:
            json.dump(twin_data, f, indent=2)

    return {"twin_id": twin_id, "personality_model": personality_model}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)  # nosec B104 — local dev only, not used in Lambda