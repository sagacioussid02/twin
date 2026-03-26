from fastapi import FastAPI, HTTPException, UploadFile, File, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import field_validator
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
from dotenv import load_dotenv
from typing import Optional, List, Dict, Any
import json
import uuid
import re
from datetime import datetime
import boto3
from botocore.exceptions import ClientError
from pathlib import Path
from pypdf import PdfReader
import io
import hmac
import hashlib
import httpx
import jwt
from context import prompt
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
PERSONALITY_REVIEW_ENABLED = os.getenv("PERSONALITY_REVIEW_ENABLED", "false").lower() == "true"
S3_BUCKET = os.getenv("S3_BUCKET", "")
MEMORY_DIR = os.getenv("MEMORY_DIR", "../memory")

# Initialize S3 client if needed
if USE_S3:
    if not S3_BUCKET:
        raise RuntimeError("USE_S3=true but S3_BUCKET environment variable is not set")
    s3_client = boto3.client("s3")

# Local twins dir: use /tmp/twins in Lambda (package dir is read-only), local path otherwise
_IN_LAMBDA = bool(os.getenv("AWS_LAMBDA_FUNCTION_NAME"))
TWINS_DIR = "/tmp/twins" if _IN_LAMBDA else os.path.join(os.path.dirname(__file__), "twins")  # nosec B108 — /tmp is the only writable path in Lambda; S3 is used when USE_S3=true
TWINS_S3_PREFIX = "twins/"

_TWIN_ID_RE = re.compile(r'^[a-f0-9]{32}$')

# Secret used to derive opaque session keys — must be set in production.
# Generate with: python -c "import secrets; print(secrets.token_hex(32))"
SESSION_HMAC_SECRET = os.getenv("SESSION_HMAC_SECRET", "")

# --- Clerk JWT auth ---
CLERK_JWKS_URL = os.getenv("CLERK_JWKS_URL", "")
# Derive issuer from JWKS URL: strip /.well-known/jwks.json
CLERK_ISSUER = CLERK_JWKS_URL.removesuffix("/.well-known/jwks.json") if CLERK_JWKS_URL else ""
# Optional: set CLERK_AUDIENCE if your Clerk app has a custom audience configured
CLERK_AUDIENCE = os.getenv("CLERK_AUDIENCE", "") or None
_jwks_cache: Optional[dict] = None
_bearer = HTTPBearer(auto_error=False)


async def _fetch_jwks() -> dict:
    if not CLERK_JWKS_URL:
        raise HTTPException(status_code=500, detail="Auth not configured")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(CLERK_JWKS_URL)
            resp.raise_for_status()
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=503, detail="JWKS endpoint timeout") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="JWKS endpoint unavailable") from exc
    try:
        return resp.json()
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="Invalid JWKS response") from exc


async def _get_jwks(force_refresh: bool = False) -> dict:
    global _jwks_cache
    if not force_refresh and _jwks_cache:
        return _jwks_cache
    _jwks_cache = await _fetch_jwks()
    return _jwks_cache


def _find_key(jwks: dict, kid: str) -> Optional[dict]:
    keys = jwks.get("keys")
    if not isinstance(keys, list):
        raise HTTPException(status_code=503, detail="JWKS payload invalid")
    return next((k for k in keys if k.get("kid") == kid), None)


async def _decode_user_id(credentials: Optional[HTTPAuthorizationCredentials]) -> Optional[str]:
    """Decode user_id from credentials. Returns None if missing or invalid (never raises)."""
    if not credentials:
        return None
    token = credentials.credentials
    try:
        header = jwt.get_unverified_header(token)
        kid = header.get("kid", "")

        jwks = await _get_jwks()
        key = _find_key(jwks, kid)

        if key is None:
            jwks = await _get_jwks(force_refresh=True)
            key = _find_key(jwks, kid)
        if key is None:
            return None

        public_key = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(key))
        decode_options: dict = {}
        if not CLERK_AUDIENCE:
            decode_options["verify_aud"] = False
        payload = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            issuer=CLERK_ISSUER if CLERK_ISSUER else None,
            audience=CLERK_AUDIENCE,
            options=decode_options,
        )
        user_id: str = payload.get("sub", "")
        return user_id or None
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError, HTTPException):
        return None


async def get_current_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> str:
    """Strict auth — raises 401 if token is missing or invalid. Use for protected endpoints."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user_id = await _decode_user_id(credentials)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")
    return user_id

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


def _s3_get_twin(key: str) -> Optional[dict]:
    """Fetch and parse a twin JSON from S3 by key. Returns None on missing key."""
    try:
        response = s3_client.get_object(Bucket=S3_BUCKET, Key=key)
        return json.loads(response["Body"].read().decode("utf-8"))
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchKey":
            return None
        raise


def load_twin(twin_id: str) -> Optional[dict]:
    """Load a saved twin's data by ID. Validates ID format and confines path to TWINS_DIR.

    S3 layout: flat key twins/{twin_id}.json for O(1) public lookup.
    Per-user key twins/{user_id}/{twin_id}.json exists in parallel for listing.
    """
    if not _TWIN_ID_RE.match(twin_id):
        raise HTTPException(status_code=400, detail="Invalid twin ID format")

    if USE_S3:
        # Direct flat-key lookup — O(1), safe for public endpoints
        return _s3_get_twin(f"{TWINS_S3_PREFIX}{twin_id}.json")

    path = os.path.realpath(os.path.join(TWINS_DIR, f"{twin_id}.json"))
    if not path.startswith(os.path.realpath(TWINS_DIR) + os.sep):
        raise HTTPException(status_code=400, detail="Invalid twin ID")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return None


# Request/Response models
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
    archetype_id: Optional[str] = None
    responseStyle: Optional[str] = "balanced"
    verbalQuirks: Optional[str] = ""

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
    def strip_optional(cls, v: str, info) -> str:
        v = v.strip()
        limits = {
            "email": 254,       # RFC 5321 max
            "skills": 1000,
            "experience": 5000,
            "achievements": 2000,
            "coreValues": 2000,
            "decisionStyle": 3000,
            "riskTolerance": 500,
            "pastDecisions": 3000,
            "communicationStyle": 2000,
            "writingSamples": 1000,
            "blindSpots": 2000,
        }
        limit = limits.get(info.field_name, 2000)
        if len(v) > limit:
            raise ValueError(f"{info.field_name} must be {limit} characters or fewer")
        return v

    @field_validator("archetype_id")
    @classmethod
    def strip_archetype_id(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip()
        if len(v) > 50:
            raise ValueError("archetype_id must be 50 characters or fewer")
        return v or None

    @field_validator("responseStyle")
    @classmethod
    def strip_response_style(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return "balanced"
        v_normalized = v.strip().lower()
        allowed_styles = {"concise", "balanced", "detailed"}
        if v_normalized not in allowed_styles:
            return "balanced"
        return v_normalized

    @field_validator("verbalQuirks")
    @classmethod
    def strip_verbal_quirks(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return ""
        v = v.strip()
        if len(v) > 1500:
            raise ValueError("verbalQuirks must be 1500 characters or fewer")
        return v


# Memory management functions
def get_memory_path(session_id: str) -> str:
    return f"sessions/{session_id}.json"


def load_conversation(session_id: str) -> List[Dict]:
    """Load conversation history from storage. Handles legacy list format and current dict format."""
    if USE_S3:
        try:
            response = s3_client.get_object(Bucket=S3_BUCKET, Key=get_memory_path(session_id))
            raw = json.loads(response["Body"].read().decode("utf-8"))
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                # Fallback: check legacy flat key (pre-sessions/ prefix)
                try:
                    response = s3_client.get_object(Bucket=S3_BUCKET, Key=f"{session_id}.json")
                    raw = json.loads(response["Body"].read().decode("utf-8"))
                except ClientError as legacy_e:
                    if legacy_e.response["Error"]["Code"] == "NoSuchKey":
                        return []
                    raise  # AccessDenied, throttling, etc. — surface, don't silently drop
            else:
                raise
    else:
        file_path = os.path.join(MEMORY_DIR, get_memory_path(session_id))
        if os.path.exists(file_path):
            with open(file_path, "r") as f:
                raw = json.load(f)
        else:
            # Fallback: check legacy flat path (pre-sessions/ prefix)
            legacy_path = os.path.join(MEMORY_DIR, f"{session_id}.json")
            if os.path.exists(legacy_path):
                with open(legacy_path, "r") as f:
                    raw = json.load(f)
            else:
                return []

    # Support both legacy list format and current dict format
    if isinstance(raw, list):
        return raw
    return raw.get("messages", [])


def save_conversation(
    session_id: str,
    messages: List[Dict],
    chatter_id: Optional[str] = None,
    twin_owner_id: Optional[str] = None,
):
    """Save conversation history with owner metadata for future access-control migration."""
    data: Any = {
        "session_id": session_id,
        "chatter_id": chatter_id,       # authenticated user who is chatting (None = anonymous)
        "twin_owner_id": twin_owner_id,  # user_id of the twin's creator
        "messages": messages,
    }
    if USE_S3:
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=get_memory_path(session_id),
            Body=json.dumps(data, indent=2),
            ContentType="application/json",
        )
    else:
        os.makedirs(os.path.join(MEMORY_DIR, "sessions"), exist_ok=True)
        file_path = os.path.join(MEMORY_DIR, get_memory_path(session_id))
        with open(file_path, "w") as f:
            json.dump(data, f, indent=2)


def call_bedrock(
    conversation: List[Dict],
    user_message: str,
    personality_model: Optional[dict] = None,
    twin_name: Optional[str] = None,
    twin_title: Optional[str] = None,
    response_style: str = "balanced",
) -> str:
    """Call AWS Bedrock with conversation history"""

    # Build messages in Bedrock format
    messages = []

    system_prompt = prompt(
        personality_model=personality_model,
        twin_name=twin_name,
        twin_title=twin_title,
        response_style=response_style,
    )
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
            print(f"Bedrock validation error: {e}")
            raise HTTPException(status_code=400, detail="Invalid message format for Bedrock")
        elif error_code == 'AccessDeniedException':
            print(f"Bedrock access denied: {e}")
            raise HTTPException(status_code=403, detail="Access denied to Bedrock model")
        else:
            print(f"Bedrock error: {e}")
            raise HTTPException(status_code=500, detail="AI service error")


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


@app.get("/archetypes")
async def list_archetypes():
    """Return all available archetypes for the frontend dropdown."""
    return {"archetypes": get_all_archetypes()}


def _derive_session_id(chatter_id: str, twin_id: str) -> str:
    """Return an opaque, stable session key for an authenticated user + twin pair.

    HMAC-SHA256 of 'chatter_id:twin_id' with SESSION_HMAC_SECRET makes the key
    non-guessable even if both IDs are known, preventing enumeration of
    conversation history via the public /conversation endpoint.
    Falls back to raw concatenation only when the secret is not configured
    (local dev without env var set).
    """
    if SESSION_HMAC_SECRET:
        return hmac.new(
            SESSION_HMAC_SECRET.encode("utf-8"),
            f"{chatter_id}:{twin_id}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
    # Dev fallback — deterministic but not secret-protected
    return f"{chatter_id}-{twin_id}"


@app.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
):
    try:
        # Resolve caller identity (optional — anonymous callers are allowed)
        chatter_id = await _decode_user_id(credentials)

        # Derive an opaque stable session key for authenticated users so memory
        # persists across devices and page reloads. Anonymous users fall back to
        # the client-supplied session_id (ephemeral, within-browser-session only).
        if chatter_id and request.twin_id:
            session_id = _derive_session_id(chatter_id, request.twin_id)
        else:
            session_id = request.session_id or str(uuid.uuid4())

        # Load conversation history
        conversation = load_conversation(session_id)

        # Load twin personality model if twin_id provided
        personality_model = None
        twin_name = None
        twin_title = None
        twin_data = None
        if request.twin_id:
            twin_data = load_twin(request.twin_id)
            if not twin_data:
                raise HTTPException(status_code=404, detail=f"Twin '{request.twin_id}' not found")
            personality_model = twin_data.get("personality_model", {})
            # Attach raw fields so context builder can access them
            personality_model["_context"] = twin_data.get("personality_model", {}).get("_context", {})
            twin_name = twin_data.get("name")
            twin_title = twin_data.get("title")

        # Determine response_style from personality model context
        response_style = "balanced"
        if personality_model:
            response_style = personality_model.get("_context", {}).get("responseStyle", "balanced")

        assistant_response = call_bedrock(
            conversation,
            request.message,
            personality_model,
            twin_name,
            twin_title,
            response_style,
        )

        # Personality review step (gated — enable via PERSONALITY_REVIEW_ENABLED=true)
        if PERSONALITY_REVIEW_ENABLED:
            archetype_id = twin_data.get("archetype_id") if request.twin_id and twin_data else None
            archetype = get_archetype(archetype_id) if archetype_id else None
            if archetype:
                twin_context = f"{twin_name or 'Professional'}, {twin_title or ''}. {twin_data.get('personality_model', {}).get('personality_summary', '')[:200]}"
                assistant_response = review_response(assistant_response, archetype, twin_context, bedrock_client, BEDROCK_MODEL_ID)

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

        # Save conversation — include owner metadata for future access-control migration
        twin_owner_id = twin_data.get("user_id") if twin_data else None
        save_conversation(session_id, conversation, chatter_id=chatter_id, twin_owner_id=twin_owner_id)

        return ChatResponse(response=assistant_response, session_id=session_id)

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in chat endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/conversation/{session_id}")
async def get_conversation(
    session_id: str,
    _user_id: str = Depends(get_current_user_id),
):
    """Retrieve conversation history. Requires auth — callers can only fetch
    sessions they own (i.e. where session_id matches the derived key for their
    identity + twin_id, or equals the anonymous session_id they created)."""
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
            parsed = _extract_json_object(response_text)
        except (ValueError, json.JSONDecodeError):
            raise HTTPException(status_code=500, detail="Could not parse AI response as JSON")

        # Detect archetype from title
        archetype = detect_archetype(parsed.get("title", ""))
        parsed["archetype_id"] = archetype["id"] if archetype else None
        parsed["archetype_display_name"] = archetype["display_name"] if archetype else None

        return parsed

    except HTTPException:
        raise
    except ClientError as e:
        print(f"Bedrock error in parse-linkedin: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to process LinkedIn profile")


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
        "archetype_display_name": twin_data.get("archetype_display_name"),
        "created_at": twin_data.get("created_at", ""),
    }


@app.get("/users/me/twins")
async def list_my_twins(user_id: str = Depends(get_current_user_id)):
    """List all twins belonging to the authenticated user."""
    twins = []
    if USE_S3:
        # Scoped prefix — only fetches this user's objects, not a full table scan
        user_prefix = f"{TWINS_S3_PREFIX}{user_id}/"
        paginator = s3_client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=user_prefix):
            for obj in page.get("Contents", []):
                try:
                    resp = s3_client.get_object(Bucket=S3_BUCKET, Key=obj["Key"])
                    data = json.loads(resp["Body"].read())
                    # Safety guard — prefix already scopes to this user
                    if data.get("user_id") == user_id:
                        twins.append({
                            "twin_id": data["twin_id"],
                            "name": data["name"],
                            "title": data.get("title", ""),
                            "archetype_display_name": data.get("archetype_display_name"),
                            "created_at": data.get("created_at", ""),
                            "chat_url": data.get("chat_url", f"/twin?id={data['twin_id']}"),
                        })
                except Exception as e:
                    print(f"Warning: could not read S3 object {obj['Key']}: {e}")
                    continue
    else:
        twins_path = Path(TWINS_DIR)
        if twins_path.exists():
            for f in sorted(twins_path.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
                try:
                    data = json.loads(f.read_text())
                    if data.get("user_id") == user_id:
                        twins.append({
                            "twin_id": data["twin_id"],
                            "name": data["name"],
                            "title": data.get("title", ""),
                            "archetype_display_name": data.get("archetype_display_name"),
                            "created_at": data.get("created_at", ""),
                            "chat_url": data.get("chat_url", f"/twin?id={data['twin_id']}"),
                        })
                except Exception as e:
                    print(f"Warning: could not read twin file {f}: {e}")
                    continue
    twins.sort(key=lambda t: t["created_at"], reverse=True)
    return {"twins": twins}


@app.post("/create-twin")
async def create_twin(request: CreateTwinRequest, user_id: str = Depends(get_current_user_id)):
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

    # Embed the context fields the prompt builder needs directly in the personality model.
    personality_model["_context"] = {
        "bio": request.bio,
        "skills": request.skills,
        "experience": request.experience,
        "achievements": request.achievements,
        "communicationStyle": request.communicationStyle,
        "verbalQuirks": request.verbalQuirks or "",
        "responseStyle": request.responseStyle or "balanced",
    }

    # Resolve archetype — reject unknown IDs so clients aren't misled
    archetype_id = request.archetype_id or None
    archetype_obj = get_archetype(archetype_id) if archetype_id else None
    if archetype_id and archetype_obj is None:
        raise HTTPException(status_code=400, detail=f"Unknown archetype_id: {archetype_id!r}")
    archetype_display_name = archetype_obj["display_name"] if archetype_obj else None

    twin_data: Dict[str, Any] = {
        "twin_id": twin_id,
        "user_id": user_id,
        "name": request.name,
        "title": request.title,
        "archetype_id": archetype_id,
        "archetype_display_name": archetype_display_name,
        "personality_model": personality_model,
        "created_at": datetime.now().isoformat(),
        "chat_url": f"/twin?id={twin_id}",
    }

    if USE_S3:
        payload = json.dumps(twin_data, indent=2)
        # Flat key for O(1) public lookup (load_twin, /twin/{id}, /chat)
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=f"{TWINS_S3_PREFIX}{twin_id}.json",
            Body=payload,
            ContentType="application/json",
        )
        # Per-user key for efficient user listing (list_my_twins)
        s3_client.put_object(
            Bucket=S3_BUCKET,
            Key=f"{TWINS_S3_PREFIX}{user_id}/{twin_id}.json",
            Body=payload,
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
