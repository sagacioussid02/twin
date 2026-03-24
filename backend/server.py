from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
from dotenv import load_dotenv
from typing import Optional, List, Dict, Any
import json
import uuid
from datetime import datetime
import boto3
from botocore.exceptions import ClientError
from pypdf import PdfReader
import io
from context import prompt, build_prompt
from personality_agent import detect_archetype, get_archetype, get_all_archetypes, review_response

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
TWINS_DIR = os.path.join(os.path.dirname(__file__), "twins")

# Initialize S3 client if needed
if USE_S3:
    s3_client = boto3.client("s3")


# Request/Response models
class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None
    archetype_id: Optional[str] = None  # only used on first message of a session


class ChatResponse(BaseModel):
    response: str
    session_id: str


class Message(BaseModel):
    role: str
    content: str
    timestamp: str


class CreateTwinRequest(BaseModel):
    name: str
    title: str
    bio: str
    skills: str
    experience: str
    achievements: Optional[str] = ""
    communicationStyle: str
    verbalQuirks: Optional[str] = ""
    responseStyle: Optional[str] = "balanced"  # concise | balanced | detailed
    email: Optional[str] = ""
    archetype_id: Optional[str] = None


class TwinRecord(BaseModel):
    twin_id: str
    name: str
    title: str
    archetype_id: Optional[str]
    archetype_display_name: Optional[str]
    chat_url: str
    raw: Dict[str, Any]


# Memory management functions
def get_memory_path(session_id: str) -> str:
    return f"{session_id}.json"


def load_session(session_id: str) -> Dict:
    """Load session (messages + metadata) from storage. Returns {"messages": [], "archetype_id": None}."""
    raw = None
    if USE_S3:
        try:
            response = s3_client.get_object(Bucket=S3_BUCKET, Key=get_memory_path(session_id))
            raw = json.loads(response["Body"].read().decode("utf-8"))
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                pass
            else:
                raise
    else:
        file_path = os.path.join(MEMORY_DIR, get_memory_path(session_id))
        if os.path.exists(file_path):
            with open(file_path, "r") as f:
                raw = json.load(f)

    if raw is None:
        return {"messages": [], "archetype_id": None}
    # Legacy: plain list of messages
    if isinstance(raw, list):
        return {"messages": raw, "archetype_id": None}
    return raw


def load_conversation(session_id: str) -> List[Dict]:
    """Backward-compatible: return just the messages list."""
    return load_session(session_id)["messages"]


def save_session(session_id: str, messages: List[Dict], archetype_id: Optional[str] = None):
    """Save session with messages and metadata."""
    data = {"messages": messages, "archetype_id": archetype_id}
    if USE_S3:
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=get_memory_path(session_id),
            Body=json.dumps(data, indent=2),
            ContentType="application/json",
        )
    else:
        os.makedirs(MEMORY_DIR, exist_ok=True)
        file_path = os.path.join(MEMORY_DIR, get_memory_path(session_id))
        with open(file_path, "w") as f:
            json.dump(data, f, indent=2)


def save_conversation(session_id: str, messages: List[Dict]):
    """Backward-compatible: save messages, preserving existing archetype_id."""
    existing = load_session(session_id)
    save_session(session_id, messages, existing.get("archetype_id"))


# Twin storage helpers
def load_twin(twin_id: str) -> Optional[Dict]:
    path = os.path.join(TWINS_DIR, f"{twin_id}.json")
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return None


def save_twin(twin_id: str, data: Dict):
    os.makedirs(TWINS_DIR, exist_ok=True)
    path = os.path.join(TWINS_DIR, f"{twin_id}.json")
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def call_bedrock(conversation: List[Dict], user_message: str) -> str:
    """Call AWS Bedrock with conversation history"""
    
    # Build messages in Bedrock format
    messages = []
    
    # Add system prompt as first user message
    # Or there's a better way to do this - pass in system=[{"text": prompt()}] to the converse call below
    messages.append({
        "role": "user", 
        "content": [{"text": f"System: {prompt()}"}]
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

        session = load_session(session_id)
        conversation = session["messages"]

        # On first message, persist archetype_id from request
        archetype_id = session.get("archetype_id") or request.archetype_id

        draft = call_bedrock(conversation, request.message)

        # Personality review step
        archetype = get_archetype(archetype_id) if archetype_id else None
        if archetype:
            twin_context = f"This is Sidd's AI twin — a digital twin for professional conversations."
            assistant_response = review_response(draft, archetype, twin_context, bedrock_client, BEDROCK_MODEL_ID)
        else:
            assistant_response = draft

        conversation.append(
            {"role": "user", "content": request.message, "timestamp": datetime.now().isoformat()}
        )
        conversation.append(
            {"role": "assistant", "content": assistant_response, "timestamp": datetime.now().isoformat()}
        )

        save_session(session_id, conversation, archetype_id)

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
        
        # Extract JSON array from response
        import re
        json_match = re.search(r'\[.*\]', response_text, re.DOTALL)
        if json_match:
            taglines = json.loads(json_match.group())
            # Update cache
            tagline_cache["taglines"] = taglines
            tagline_cache["timestamp"] = datetime.now()
            return {"taglines": taglines}
        else:
            # Fallback if JSON parsing fails
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

        import re
        json_match = re.search(r'\{.*\}', response_text, re.DOTALL)
        if not json_match:
            raise HTTPException(status_code=500, detail="Could not parse AI response")

        parsed = json.loads(json_match.group())

        # Detect archetype from title
        archetype = detect_archetype(parsed.get("title", ""))
        parsed["archetype_id"] = archetype["id"] if archetype else None
        parsed["archetype_display_name"] = archetype["display_name"] if archetype else None

        return parsed

    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="AI returned invalid JSON")
    except ClientError as e:
        raise HTTPException(status_code=500, detail=f"Bedrock error: {str(e)}")


@app.get("/archetypes")
async def list_archetypes():
    """Return all available archetypes for the frontend dropdown."""
    return {"archetypes": get_all_archetypes()}


@app.post("/twins", response_model=TwinRecord)
async def create_twin(request: CreateTwinRequest):
    """
    Save a new twin from the create-your-twin form.
    Returns twin_id and chat_url so the frontend can redirect immediately.
    """
    twin_id = str(uuid.uuid4())[:8]

    archetype = get_archetype(request.archetype_id) if request.archetype_id else None

    twin_data = {
        "twin_id": twin_id,
        "name": request.name,
        "title": request.title,
        "email": request.email,
        "archetype_id": archetype["id"] if archetype else None,
        "archetype_display_name": archetype["display_name"] if archetype else None,
        "chat_url": f"/twin?id={twin_id}",
        "created_at": datetime.now().isoformat(),
        "raw": {
            "name": request.name,
            "title": request.title,
            "bio": request.bio,
            "skills": request.skills,
            "experience": request.experience,
            "achievements": request.achievements,
            "communicationStyle": request.communicationStyle,
            "verbalQuirks": request.verbalQuirks,
            "responseStyle": request.responseStyle,
        },
    }

    save_twin(twin_id, twin_data)

    return TwinRecord(
        twin_id=twin_id,
        name=request.name,
        title=request.title,
        archetype_id=twin_data["archetype_id"],
        archetype_display_name=twin_data["archetype_display_name"],
        chat_url=twin_data["chat_url"],
        raw=twin_data["raw"],
    )


@app.get("/twins/{twin_id}")
async def get_twin(twin_id: str):
    """Fetch a twin record by ID."""
    twin = load_twin(twin_id)
    if not twin:
        raise HTTPException(status_code=404, detail="Twin not found")
    return twin


@app.post("/twin/{twin_id}/chat", response_model=ChatResponse)
async def twin_chat(twin_id: str, request: ChatRequest):
    """
    Chat endpoint for a specific twin (created via /twins).
    Uses the twin's stored data and archetype for context and personality review.
    """
    twin = load_twin(twin_id)
    if not twin:
        raise HTTPException(status_code=404, detail="Twin not found")

    session_id = request.session_id or str(uuid.uuid4())
    session = load_session(session_id)
    conversation = session["messages"]

    archetype_id = twin.get("archetype_id")
    twin_system_prompt = build_prompt(twin["raw"])

    # Build messages using the twin's specific system prompt
    messages = [
        {"role": "user", "content": [{"text": f"System: {twin_system_prompt}"}]}
    ]
    for msg in conversation[-50:]:
        messages.append({
            "role": msg["role"],
            "content": [{"text": msg["content"]}],
        })
    messages.append({"role": "user", "content": [{"text": request.message}]})

    try:
        response = bedrock_client.converse(
            modelId=BEDROCK_MODEL_ID,
            messages=messages,
            inferenceConfig={"maxTokens": 2000, "temperature": 0.7, "topP": 0.9},
        )
        draft = response["output"]["message"]["content"][0]["text"]
    except ClientError as e:
        raise HTTPException(status_code=500, detail=f"Bedrock error: {str(e)}")

    # Personality review step
    archetype = get_archetype(archetype_id) if archetype_id else None
    if archetype:
        twin_context = f"{twin['name']}, {twin['title']}. {twin['raw'].get('bio', '')[:200]}"
        assistant_response = review_response(draft, archetype, twin_context, bedrock_client, BEDROCK_MODEL_ID)
    else:
        assistant_response = draft

    conversation.append(
        {"role": "user", "content": request.message, "timestamp": datetime.now().isoformat()}
    )
    conversation.append(
        {"role": "assistant", "content": assistant_response, "timestamp": datetime.now().isoformat()}
    )

    save_session(session_id, conversation, archetype_id)

    return ChatResponse(response=assistant_response, session_id=session_id)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)