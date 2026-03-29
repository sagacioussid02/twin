from fastapi import FastAPI, HTTPException, UploadFile, File, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import field_validator
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import os
from dotenv import load_dotenv
from typing import Optional, List, Dict, Any, Union
import json
import uuid
import re
from datetime import datetime
import boto3
from botocore.exceptions import ClientError
from pathlib import Path
from pypdf import PdfReader
import io
import asyncio
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
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
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
if not SESSION_HMAC_SECRET and (_IN_LAMBDA or os.getenv("USE_S3", "").lower() in ("1", "true") or os.getenv("ENVIRONMENT", "").lower() == "prod"):
    raise RuntimeError(
        "SESSION_HMAC_SECRET environment variable must be set in production. "
        "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
    )

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
    """Decode user_id from credentials.

    Returns None for missing credentials or JWT validation failures (expired,
    bad signature, unknown kid). Propagates 5xx HTTPExceptions from auth
    infrastructure (JWKS fetch timeout, misconfigured CLERK_JWKS_URL, etc.) so
    callers can surface them correctly rather than masking outages as 401s.
    """
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
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        # Token is bad/expired — treat as anonymous, don't raise
        return None
    except HTTPException as exc:
        if exc.status_code >= 500:
            raise  # Auth infrastructure failure — propagate so it surfaces correctly
        return None  # 4xx from auth layer — treat as invalid token


async def get_current_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> str:
    """Strict auth — raises 401 if token is missing or invalid. Use for protected endpoints.
    5xx auth infrastructure errors (JWKS outage, misconfiguration) propagate as-is.
    """
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


def _extract_json_object(text: str, required_key: str | None = None) -> dict:
    """Extract the first complete JSON object from *text*.

    Scans every '{' position in turn so that a stray JSON fragment appended
    after natural-language text doesn't shadow the real response object.
    Returns the first valid dict (optionally containing *required_key*).
    """
    pos = 0
    last_error: Exception = ValueError("No JSON object found in response")
    while True:
        start = text.find('{', pos)
        if start == -1:
            raise last_error
        depth, in_string, escape_next = 0, False, False
        end = None
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
                    end = i
                    break
        if end is None:
            # Record the error but continue scanning from the next position
            last_error = ValueError("Unbalanced braces — could not extract JSON object")
            pos = start + 1
            continue
        try:
            candidate = json.loads(text[start:end + 1])
            if isinstance(candidate, dict):
                if required_key is None or required_key in candidate:
                    return candidate
        except json.JSONDecodeError as exc:
            last_error = exc
        pos = end + 1  # advance past this block and try the next '{'


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


# Valid session_id shapes:
#   - UUID (any version) from str(uuid.uuid4()): xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#     Note: the regex accepts any lowercase hex UUID, not only v4.
#   - 64-char hex from HMAC-SHA256 / SHA-256 _derive_session_id
_SESSION_ID_RE = re.compile(r'^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$')


def _validate_session_id(session_id: str) -> None:
    """Raise 400 if session_id doesn't match the allowed format, preventing path traversal."""
    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session ID format")


# Memory management functions
def get_memory_path(session_id: str) -> str:
    return f"sessions/{session_id}.json"


def _load_raw_record(session_id: str) -> Optional[Union[List[Dict], Dict[str, Any]]]:
    """Load the raw conversation record from storage (S3 or local).

    Returns the parsed JSON value (list or dict) if found, or None if the session
    does not exist. Raises on storage errors (e.g. AccessDenied, throttling).
    """
    _validate_session_id(session_id)
    if USE_S3:
        try:
            response = s3_client.get_object(Bucket=S3_BUCKET, Key=get_memory_path(session_id))
            return json.loads(response["Body"].read().decode("utf-8"))
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                # Fallback: check legacy flat key (pre-sessions/ prefix)
                try:
                    response = s3_client.get_object(Bucket=S3_BUCKET, Key=f"{session_id}.json")
                    return json.loads(response["Body"].read().decode("utf-8"))
                except ClientError as legacy_e:
                    if legacy_e.response["Error"]["Code"] == "NoSuchKey":
                        return None
                    raise  # AccessDenied, throttling, etc. — surface, don't silently drop
            else:
                raise
    else:
        sessions_dir = os.path.realpath(os.path.join(MEMORY_DIR, "sessions"))
        file_path = os.path.realpath(os.path.join(sessions_dir, f"{session_id}.json"))
        if not file_path.startswith(sessions_dir + os.sep):
            raise HTTPException(status_code=400, detail="Invalid session ID format")
        if os.path.exists(file_path):
            with open(file_path, "r") as f:
                return json.load(f)
        # Fallback: check legacy flat path (pre-sessions/ prefix)
        memory_dir_real = os.path.realpath(MEMORY_DIR)
        legacy_path = os.path.realpath(os.path.join(MEMORY_DIR, f"{session_id}.json"))
        if not legacy_path.startswith(memory_dir_real + os.sep):
            raise HTTPException(status_code=400, detail="Invalid session ID format")
        if os.path.exists(legacy_path):
            with open(legacy_path, "r") as f:
                return json.load(f)
        return None


def load_conversation(session_id: str) -> List[Dict]:
    """Load conversation history from storage. Handles legacy list format and current dict format."""
    raw = _load_raw_record(session_id)
    if raw is None:
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
    _validate_session_id(session_id)
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
        sessions_dir = os.path.realpath(os.path.join(MEMORY_DIR, "sessions"))
        os.makedirs(sessions_dir, exist_ok=True)
        file_path = os.path.realpath(os.path.join(sessions_dir, f"{session_id}.json"))
        if not file_path.startswith(sessions_dir + os.sep):
            raise HTTPException(status_code=400, detail="Invalid session ID format")
        with open(file_path, "w") as f:
            json.dump(data, f, indent=2)


def call_bedrock(
    conversation: List[Dict],
    user_message: str,
    personality_model: Optional[dict] = None,
    twin_name: Optional[str] = None,
    twin_title: Optional[str] = None,
    response_style: str = "balanced",
    corrections: Optional[List[dict]] = None,
) -> str:
    """Call AWS Bedrock with conversation history"""

    # Build messages in Bedrock format
    messages = []

    system_prompt = prompt(
        personality_model=personality_model,
        twin_name=twin_name,
        twin_title=twin_title,
        response_style=response_style,
        corrections=corrections,
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
    non-guessable even if both IDs are known. This keeps session identifiers
    opaque for authenticated callers (e.g. when fetching /conversation/{session_id})
    and avoids leaking information about underlying user or twin IDs.
    Falls back to SHA-256 without a secret when SESSION_HMAC_SECRET is not set
    (local development only) — preserves stability and format validity but not secrecy.
    """
    if SESSION_HMAC_SECRET:
        return hmac.new(
            SESSION_HMAC_SECRET.encode("utf-8"),
            f"{chatter_id}:{twin_id}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
    # Dev fallback — no secret, but still produces a valid 64-char hex so the
    # session_id passes format validation. Not safe for production (predictable).
    return hashlib.sha256(f"{chatter_id}:{twin_id}".encode("utf-8")).hexdigest()


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

        # Guard against session hijacking: if the stored record was created by
        # an authenticated user, only that same user (or a caller with no stored
        # chatter_id to compare against) may continue it.
        existing_record = _load_raw_record(session_id)
        stored_chatter_id = (
            existing_record.get("chatter_id")
            if isinstance(existing_record, dict)
            else None
        )
        if stored_chatter_id is not None and stored_chatter_id != chatter_id:
            raise HTTPException(
                status_code=403,
                detail="Forbidden: this session belongs to a different user",
            )

        # Load conversation history from the already-fetched record (avoids a
        # second storage read).
        if existing_record is None:
            conversation: List[Dict] = []
        elif isinstance(existing_record, list):
            conversation = existing_record
        else:
            conversation = existing_record.get("messages", [])

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

        corrections = twin_data.get("corrections") if twin_data else None
        assistant_response = call_bedrock(
            conversation,
            request.message,
            personality_model,
            twin_name,
            twin_title,
            response_style,
            corrections=corrections,
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

        # Save conversation — preserve an existing non-null chatter_id so that
        # unauthenticated retries cannot "de-own" a session that was previously
        # created by an authenticated caller.
        twin_owner_id = twin_data.get("user_id") if twin_data else None
        effective_chatter_id = chatter_id or stored_chatter_id
        save_conversation(session_id, conversation, chatter_id=effective_chatter_id, twin_owner_id=twin_owner_id)

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
    """Retrieve conversation history for the given session_id.

    Requires authentication. Enforces ownership: only the authenticated user
    whose ``chatter_id`` matches the stored record may retrieve the conversation.
    Returns 404 for unknown sessions, sessions without ownership metadata, or
    sessions owned by a different user.
    """
    try:
        raw = _load_raw_record(session_id)
        if raw is None:
            raise HTTPException(status_code=404, detail="Conversation not found")

        # Enforce ownership using stored chatter_id metadata.
        if isinstance(raw, dict) and "chatter_id" in raw:
            if raw["chatter_id"] != _user_id:
                # Hide existence details from unauthorized callers.
                raise HTTPException(status_code=404, detail="Conversation not found")
            messages = raw.get("messages", [])
        else:
            # Legacy list format or missing chatter_id — deny to avoid leaking data
            # from conversations not clearly associated with this user.
            raise HTTPException(status_code=404, detail="Conversation not found")

        return {"session_id": session_id, "messages": messages}
    except HTTPException:
        raise
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
        response = await asyncio.to_thread(
            bedrock_client.converse,
            modelId=BEDROCK_MODEL_ID,
            messages=[{"role": "user", "content": [{"text": extract_prompt}]}],
            inferenceConfig={"maxTokens": 1500, "temperature": 0.2},
        )
        response_text = response["output"]["message"]["content"][0]["text"]

        try:
            parsed = _extract_json_object(response_text)
        except (ValueError, json.JSONDecodeError) as exc:
            print(f"JSON extraction failed in parse-linkedin: {exc}")
            raise HTTPException(status_code=500, detail="Could not parse AI response as JSON")

        # Detect archetype from title
        archetype = detect_archetype(parsed.get("title", ""))
        parsed["archetype_id"] = archetype["id"] if archetype else None
        parsed["archetype_display_name"] = archetype["display_name"] if archetype else None

        return parsed

    except HTTPException:
        raise
    except ClientError as e:
        print(f"Bedrock ClientError in parse-linkedin: {e}")
        raise HTTPException(status_code=500, detail="Failed to process LinkedIn profile")
    except Exception as e:
        print(f"Unexpected error in parse-linkedin: {e}")
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


def _save_twin(twin_id: str, user_id: str, twin_data: dict) -> None:
    """Persist twin_data to both S3 keys (flat + per-user) or local disk."""
    if USE_S3:
        payload = json.dumps(twin_data, indent=2)
        for key in (
            f"{TWINS_S3_PREFIX}{twin_id}.json",
            f"{TWINS_S3_PREFIX}{user_id}/{twin_id}.json",
        ):
            s3_client.put_object(
                Bucket=S3_BUCKET,
                Key=key,
                Body=payload,
                ContentType="application/json",
            )
    else:
        os.makedirs(TWINS_DIR, exist_ok=True)
        with open(os.path.join(TWINS_DIR, f"{twin_id}.json"), "w") as f:
            json.dump(twin_data, f, indent=2)


class AddCorrectionRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=500)
    wrong_response: str = Field(..., min_length=1, max_length=500)
    correction: str = Field(..., min_length=1, max_length=500)

    @field_validator("question", "wrong_response", "correction", mode="before")
    @classmethod
    def strip_and_validate_non_empty(cls, v: Any) -> str:
        if v is None:
            raise ValueError("must not be empty")
        if not isinstance(v, str):
            raise TypeError("must be a string")
        v = v.strip()
        if not v:
            raise ValueError("must not be empty or whitespace")
        return v
@app.patch("/twin/{twin_id}/corrections")
async def add_correction(
    twin_id: str,
    request: AddCorrectionRequest,
    user_id: str = Depends(get_current_user_id),
):
    """Append a user-supplied correction to a twin they own."""
    twin_data = load_twin(twin_id)
    if not twin_data or twin_data.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Twin not found")

    corrections: list = twin_data.get("corrections", [])
    corrections.append({
        "question": request.question[:500],
        "wrong_response": request.wrong_response[:500],
        "correction": request.correction[:500],
        "created_at": datetime.now().isoformat(),
    })
    # Cap stored corrections to avoid unbounded growth
    twin_data["corrections"] = corrections[-20:]
    _save_twin(twin_id, user_id, twin_data)
    return {"status": "ok", "corrections_count": len(twin_data["corrections"])}


# ---------------------------------------------------------------------------
# Persona vs Persona debate
# ---------------------------------------------------------------------------

# Number of rounds for the batched /chat/debate endpoint only.
# Each twin speaks once per round (total turns = DEBATE_ROUNDS * 2).
# Default kept at 2 to stay safely within the API Gateway 30s hard timeout —
# 4 sequential Bedrock calls at ~5-7s each ≈ 20-28s, leaving a safety margin.
# Set DEBATE_ROUNDS=3 via env var to enable 3 rounds (6 calls, ~24-30s — slim margin).
# Default kept at 3 to match the frontend NEXT_PUBLIC_DEBATE_ROUNDS default
# (3 rounds, 6 total Bedrock calls). This can bring total latency close to
# the API Gateway 30s hard timeout (6 calls at ~5-7s each ≈ 30-42s).
# If you observe timeouts, lower DEBATE_ROUNDS to 2 via env var to stay more
# safely within the timeout (4 calls, ~20-28s total).
# NOTE: This does NOT govern /debate/turn (turn-by-turn). That endpoint handles
# a single turn per request; the number of turns is driven entirely by the
# frontend's NEXT_PUBLIC_DEBATE_ROUNDS env var (default 3). Both env vars
# should be set to the same value to keep the two debate modes consistent.
_DEBATE_ROUNDS_DEFAULT = 3
_DEBATE_ROUNDS_MIN = 1
_DEBATE_ROUNDS_MAX = 3
_debate_rounds_raw = os.getenv("DEBATE_ROUNDS", "").strip()
try:
    _debate_rounds_val = int(_debate_rounds_raw) if _debate_rounds_raw else _DEBATE_ROUNDS_DEFAULT
except (TypeError, ValueError):
    _debate_rounds_val = _DEBATE_ROUNDS_DEFAULT
if _debate_rounds_val < _DEBATE_ROUNDS_MIN:
    _debate_rounds_val = _DEBATE_ROUNDS_MIN
elif _debate_rounds_val > _DEBATE_ROUNDS_MAX:
    _debate_rounds_val = _DEBATE_ROUNDS_MAX
DEBATE_ROUNDS = _debate_rounds_val


class DebateAgent:
    """Autonomous agent representing a single twin in a structured debate.

    Each agent maintains its own conversation history so it has independent,
    persona-consistent context across the exchange without seeing the other
    twin's internal state.
    """

    def __init__(self, twin_data: dict) -> None:
        self.twin_id: str = twin_data["twin_id"]
        self.name: str = twin_data.get("name", "Unknown")
        self.title: str = twin_data.get("title", "")
        personality_model = twin_data.get("personality_model", {})
        self._system_prompt: str = prompt(
            personality_model=personality_model,
            twin_name=self.name,
            twin_title=self.title,
        )
        self._history: List[Dict] = []  # agent's own view of the debate

    def _build_messages(self, user_turn: str) -> List[Dict]:
        messages: List[Dict] = [
            {"role": "user", "content": [{"text": f"System: {self._system_prompt}"}]}
        ]
        for msg in self._history[-10:]:  # cap at last 10 messages (5 exchanges)
            messages.append({"role": msg["role"], "content": [{"text": msg["content"]}]})
        messages.append({"role": "user", "content": [{"text": user_turn}]})
        return messages

    def respond(self, user_turn: str) -> str:
        """Call Bedrock synchronously, update internal history, return response text.

        Designed to be called via asyncio.to_thread so it doesn't block the
        event loop during the debate orchestration.
        """
        messages = self._build_messages(user_turn)
        response = bedrock_client.converse(
            modelId=BEDROCK_MODEL_ID,
            messages=messages,
            inferenceConfig={"maxTokens": 200, "temperature": 0.75, "topP": 0.9},
        )
        text: str = response["output"]["message"]["content"][0]["text"]
        self._history.append({"role": "user", "content": user_turn})
        self._history.append({"role": "assistant", "content": text})
        return text


# Maximum allowed number of history entries for /debate/turn.
# Intentionally decoupled from DEBATE_ROUNDS / frontend NEXT_PUBLIC_DEBATE_ROUNDS
# so config drift cannot cause mid-debate 422s. Can be overridden via env var.
try:
    _MAX_HISTORY_ENTRIES = int(os.getenv("DEBATE_MAX_HISTORY_ENTRIES", "20"))
except (TypeError, ValueError):
    _MAX_HISTORY_ENTRIES = 20
if _MAX_HISTORY_ENTRIES < 1:
    _MAX_HISTORY_ENTRIES = 1
_MAX_TWIN_NAME_LEN = 100
# 1000 chars per entry: generous for 3-5 sentences (~300-500 chars typical).
_MAX_HISTORY_TEXT_LEN = 1000
# Total character budget for history injected into the prompt.
# Oldest entries are dropped server-side if the budget is exceeded.
_MAX_HISTORY_TOTAL_CHARS = 8000


class DebateHistoryEntry(BaseModel):
    twin_name: str
    text: str

    @field_validator("twin_name")
    @classmethod
    def twin_name_length(cls, v: str) -> str:
        if len(v) > _MAX_TWIN_NAME_LEN:
            raise ValueError(f"twin_name must be {_MAX_TWIN_NAME_LEN} characters or fewer")
        return v

    @field_validator("text")
    @classmethod
    def text_length(cls, v: str) -> str:
        if len(v) > _MAX_HISTORY_TEXT_LEN:
            raise ValueError(f"history text must be {_MAX_HISTORY_TEXT_LEN} characters or fewer")
        return v


class DebateTurnRequest(BaseModel):
    twin_id: str
    topic: str
    history: List[DebateHistoryEntry] = Field(default_factory=list)  # full debate so far, oldest first

    @field_validator("history")
    @classmethod
    def history_max_entries(cls, v: List[DebateHistoryEntry]) -> List[DebateHistoryEntry]:
        if len(v) > _MAX_HISTORY_ENTRIES:
            raise ValueError(f"history must not exceed {_MAX_HISTORY_ENTRIES} entries")
        return v

    @field_validator("topic")
    @classmethod
    def topic_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("topic must not be empty")
        if len(v) > 500:
            raise ValueError("topic must be 500 characters or fewer")
        return v


class DebateRequest(BaseModel):
    twin_id_a: str
    twin_id_b: str
    topic: str

    @field_validator("topic")
    @classmethod
    def topic_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("topic must not be empty")
        if len(v) > 500:
            raise ValueError("topic must be 500 characters or fewer")
        return v


class DebateTurn(BaseModel):
    twin_id: str
    twin_name: str
    turn_number: int
    text: str


class DebateResponse(BaseModel):
    topic: str
    turns: List[DebateTurn]


class DebateTurnResponse(BaseModel):
    twin_id: str
    twin_name: str
    text: str


@app.post("/debate/turn", response_model=DebateTurnResponse)
async def debate_turn(
    request: DebateTurnRequest,
    user_id: str = Depends(get_current_user_id),
):
    """Generate a single debate turn for one twin.

    The frontend drives the debate loop: it calls this endpoint once per turn,
    passing the full history so far. This makes each agent's response feel live
    (typing indicator while waiting, typewriter animation on arrival) without
    requiring Lambda response streaming.
    """
    twin_data = load_twin(request.twin_id)
    if not twin_data or twin_data.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Twin not found")

    agent = DebateAgent(twin_data)

    # Build the debate-context prompt from history
    def _esc(s: str) -> str:
        """JSON-escape a string so quotes/newlines don't break prompt structure."""
        return json.dumps(s)[1:-1]

    if not request.history:
        turn_prompt = (
            f'You are in a live debate on the topic: "{_esc(request.topic)}". '
            f"Open with your perspective. Speak in your natural voice. 3-5 sentences."
        )
    else:
        # Server-side truncation: drop oldest entries until total chars fit in budget.
        history = list(request.history)
        total_chars = sum(len(e.twin_name) + len(e.text) for e in history)
        while len(history) > 1 and total_chars > _MAX_HISTORY_TOTAL_CHARS:
            dropped = history.pop(0)
            total_chars -= len(dropped.twin_name) + len(dropped.text)

        history_lines = "\n".join(
            f'{_esc(e.twin_name)}: "{_esc(e.text)}"' for e in history
        )
        last = history[-1]
        turn_prompt = (
            f'You are in a live debate on the topic: "{_esc(request.topic)}".\n\n'
            f"Debate so far:\n{history_lines}\n\n"
            f'{_esc(last.twin_name)} just said: "{_esc(last.text)}"\n\n'
            f"Respond to their point. Stay in character. 3-5 sentences."
        )

    try:
        text = await asyncio.to_thread(agent.respond, turn_prompt)
    except ClientError as e:
        print(f"Bedrock error in debate/turn: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate response")
    except Exception as e:
        print(f"Unexpected error in debate/turn: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate response")

    return {"twin_id": agent.twin_id, "twin_name": agent.name, "text": text}


@app.post("/chat/debate", response_model=DebateResponse)
async def debate(
    request: DebateRequest,
    user_id: str = Depends(get_current_user_id),
):
    """Run a structured debate between two user-owned twins.

    Each twin is instantiated as an independent DebateAgent with its own
    persona and conversation context. The orchestrator alternates calls for
    DEBATE_ROUNDS rounds (each twin speaks DEBATE_ROUNDS times = 2×DEBATE_ROUNDS
    total turns).

    Note: responses are buffered and returned as a single JSON payload.
    True token-level streaming requires Lambda Function URL response streaming
    and is a planned future upgrade.
    """
    # Load and authorise both twins — only owner may use their twins in a debate
    twin_a_data = load_twin(request.twin_id_a)
    twin_b_data = load_twin(request.twin_id_b)

    if not twin_a_data or twin_a_data.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Twin A not found")
    if not twin_b_data or twin_b_data.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Twin B not found")
    if request.twin_id_a == request.twin_id_b:
        raise HTTPException(status_code=400, detail="Debate requires two different twins")

    agent_a = DebateAgent(twin_a_data)
    agent_b = DebateAgent(twin_b_data)

    turns: List[Dict] = []
    last_text = ""

    try:
        for round_num in range(DEBATE_ROUNDS):
            # ── Agent A's turn ────────────────────────────────────────────
            if round_num == 0:
                prompt_a = (
                    f'You are debating {agent_b.name} on the topic: "{request.topic}". '
                    f"Open with your perspective. Be direct and speak in your natural voice. "
                    f"Keep it to 3-5 sentences."
                )
            else:
                prompt_a = (
                    f'{agent_b.name} said: "{last_text}"\n\n'
                    f"Respond to their point in the debate. Stay in character. "
                    f"Keep it to 3-5 sentences."
                )
            response_a = await asyncio.to_thread(agent_a.respond, prompt_a)
            turns.append({"twin_id": agent_a.twin_id, "twin_name": agent_a.name,
                          "turn_number": len(turns) + 1, "text": response_a})
            last_text = response_a

            # ── Agent B's turn ────────────────────────────────────────────
            if round_num == 0:
                prompt_b = (
                    f'You are debating {agent_a.name} on the topic: "{request.topic}". '
                    f'{agent_a.name} just said: "{response_a}"\n\n'
                    f"Respond with your perspective. Be direct and speak in your natural voice. "
                    f"Keep it to 3-5 sentences."
                )
            else:
                prompt_b = (
                    f'{agent_a.name} said: "{last_text}"\n\n'
                    f"Respond to their point in the debate. Stay in character. "
                    f"Keep it to 3-5 sentences."
                )
            response_b = await asyncio.to_thread(agent_b.respond, prompt_b)
            turns.append({"twin_id": agent_b.twin_id, "twin_name": agent_b.name,
                          "turn_number": len(turns) + 1, "text": response_b})
            last_text = response_b

    except ClientError as e:
        print(f"Bedrock ClientError in debate: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate debate response")
    except Exception as e:
        print(f"Unexpected error in debate: {e}")
        raise HTTPException(status_code=500, detail="An unexpected error occurred during the debate")

    return {"topic": request.topic, "turns": turns}


# ---------------------------------------------------------------------------
# Chat-based onboarding interview
# ---------------------------------------------------------------------------

_ONBOARD_SYSTEM_TEMPLATE = """\
You are a sharp, warm interviewer helping someone build their AI twin — a digital version of them \
that can answer questions on their behalf.

Your job: learn who they are through a natural conversation, covering 6 topics in order.

TOPICS:
1. IDENTITY      → name, job title, short bio (who they are in a sentence or two)
2. PROFESSIONAL  → key skills, career story, one notable achievement{linkedin_skip}
3. DECISIONS     → how they make hard calls (want a real example), risk appetite
4. VALUES        → what they stand for; one thing they would push back on under pressure
5. WORKING_STYLE → how they communicate; what colleagues sometimes misread about them
6. VOICE         → a phrase they overuse or a verbal tic; bullet-points or paragraphs?

RULES — follow exactly:
- One question per turn. 2–4 sentences per message. Be concise.
- CRITICAL: Every message MUST end with a question, except the final closing message \
when done is true. Never just acknowledge — always ask about the next remaining topic \
in the same message. If you acknowledge, do it in one short phrase, then immediately ask.
- If an answer is vague or generic (e.g. "I just go with my gut", "I value honesty"), \
push back ONCE: invent a tiny relatable story in one sentence that mirrors the vague answer \
(first-person or "I once worked with someone who..."), then re-ask more concretely. \
Push back only once per topic — then accept and move on regardless of the answer.
- After a rich or interesting answer, acknowledge in one brief phrase \
("Got it.", "That's clear.", "Interesting.") and immediately ask the next question.
- Mirror their tone: terse answers → short questions; expressive answers → slightly warmer.
- Never use form-speak ("Question 3 of 6", "Next section", "Moving on to topic...").
- When all 6 topics are covered (none remaining), close with one natural sentence and set done to true.

CURRENT STATE:
Topics remaining: {topics_remaining}
Fields collected so far:
{fields_json}
{linkedin_section}

RETURN ONLY valid JSON — no markdown, no text outside the JSON object.
NEVER include JSON or curly-brace fragments inside the "message" string value.
The "done" field belongs only in the top-level JSON structure, not in the message text:
{{
  "message": "your conversational response and next question as natural prose",
  "field_updates": {{
    "name": "value or omit key entirely if not in this message",
    "title": "...",
    "bio": "...",
    "skills": "...",
    "experience": "...",
    "achievements": "...",
    "coreValues": "...",
    "decisionStyle": "...",
    "riskTolerance": "low or medium or high — omit if unclear",
    "pastDecisions": "...",
    "communicationStyle": "...",
    "blindSpots": "...",
    "verbalQuirks": "...",
    "responseStyle": "concise or balanced or detailed — omit if unclear"
  }},
  "topics_covered": ["IDENTITY", "PROFESSIONAL"],
  "done": false
}}

When done is true, set "done": true in the JSON above. Do NOT include a twin_payload field — \
the client will assemble the twin from the collected fields_collected data.
"""


class OnboardHistoryItem(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class OnboardRequest(BaseModel):
    history: List[OnboardHistoryItem] = Field(default_factory=list)
    linkedin_parsed: Optional[Dict[str, Any]] = None
    fields_collected: Optional[Dict[str, Any]] = None
    topics_covered: List[str] = Field(default_factory=list)


class OnboardFieldUpdates(BaseModel):
    """Validated field updates extracted from the model response."""

    name: Optional[str] = None
    title: Optional[str] = None
    bio: Optional[str] = None
    skills: Optional[str] = None
    experience: Optional[str] = None
    achievements: Optional[str] = None
    coreValues: Optional[str] = None
    decisionStyle: Optional[str] = None
    riskTolerance: Optional[str] = None
    pastDecisions: Optional[str] = None
    communicationStyle: Optional[str] = None
    blindSpots: Optional[str] = None
    verbalQuirks: Optional[str] = None
    responseStyle: Optional[str] = None

    model_config = {"extra": "ignore"}


class OnboardResponse(BaseModel):
    """Validated response returned by /onboard/message."""

    message: str
    field_updates: OnboardFieldUpdates = Field(default_factory=OnboardFieldUpdates)
    topics_covered: List[str] = Field(default_factory=list)
    done: bool = False
    twin_payload: Optional[Dict[str, Any]] = None

    model_config = {"extra": "ignore"}

    @field_validator("field_updates", mode="before")
    @classmethod
    def _coerce_field_updates(cls, v: Any) -> Any:
        """Accept a dict or fall back to an empty OnboardFieldUpdates."""
        if not isinstance(v, dict):
            return {}
        return v

    @field_validator("topics_covered", mode="before")
    @classmethod
    def _coerce_topics_covered(cls, v: Any) -> Any:
        """Accept a list of strings or fall back to an empty list."""
        if not isinstance(v, list):
            return []
        return [item for item in v if isinstance(item, str)]

    @field_validator("done", mode="before")
    @classmethod
    def _coerce_done(cls, v: Any) -> Any:
        """Accept a bool; coerce any non-bool value to False."""
        if isinstance(v, bool):
            return v
        return False


_ALL_ONBOARD_TOPICS = ["IDENTITY", "PROFESSIONAL", "DECISIONS", "VALUES", "WORKING_STYLE", "VOICE"]


@app.post("/onboard/message")
async def onboard_message(
    request: OnboardRequest,
    _user_id: str = Depends(get_current_user_id),
):
    covered = list(request.topics_covered)
    # Auto-mark PROFESSIONAL covered when LinkedIn data is provided
    if request.linkedin_parsed and "PROFESSIONAL" not in covered:
        covered.append("PROFESSIONAL")
    # Auto-mark IDENTITY covered when name+title+bio are already collected
    # (from LinkedIn, a previous turn, or any other source)
    fields = request.fields_collected or {}
    if (
        "IDENTITY" not in covered
        and fields.get("name")
        and fields.get("title")
        and fields.get("bio")
    ):
        covered.append("IDENTITY")

    remaining = [t for t in _ALL_ONBOARD_TOPICS if t not in covered]

    linkedin_skip = " (SKIP — LinkedIn PDF provided)" if request.linkedin_parsed else ""

    linkedin_section = ""
    if request.linkedin_parsed:
        lp = request.linkedin_parsed
        lines = []
        if lp.get("name"):        lines.append(f"Name: {lp['name']}")
        if lp.get("title"):       lines.append(f"Title: {lp['title']}")
        if lp.get("skills"):      lines.append(f"Skills: {str(lp['skills'])[:300]}")
        if lp.get("experience"):  lines.append(f"Experience: {str(lp['experience'])[:400]}")
        if lp.get("achievements"): lines.append(f"Achievements: {str(lp['achievements'])[:200]}")
        if lines:
            linkedin_section = "\nLinkedIn PDF already parsed (use this, don't re-ask):\n" + "\n".join(lines)

    system_prompt = _ONBOARD_SYSTEM_TEMPLATE.format(
        linkedin_skip=linkedin_skip,
        topics_remaining=", ".join(remaining) if remaining else "ALL COVERED",
        fields_json=json.dumps(request.fields_collected or {}, indent=2),
        linkedin_section=linkedin_section,
    )

    messages: List[Dict[str, Any]] = []
    if not request.history:
        # Seed with a minimal opener so the model produces the first question
        messages = [{"role": "user", "content": [{"text": "hi, let's start"}]}]
    else:
        # Cap the amount of history sent to Bedrock to avoid unbounded prompts
        for item in request.history[-50:]:
            if item.role == "user":
                role = "user"
            elif item.role == "assistant":
                role = "assistant"
            else:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid role in history item: {item.role!r}. Allowed roles are 'user' and 'assistant'.",
                )
            messages.append({"role": role, "content": [{"text": item.content}]})

    try:
        response = await asyncio.to_thread(
            bedrock_client.converse,
            modelId=BEDROCK_MODEL_ID,
            system=[{"text": system_prompt}],
            messages=messages,
            inferenceConfig={"maxTokens": 700, "temperature": 0.9, "topP": 0.95},
        )
        raw = response["output"]["message"]["content"][0]["text"].strip()

        # Use robust JSON extraction — handles code fences and leading/trailing text.
        # Pass required_key so stray {"done": true} fragments are skipped.
        data = _extract_json_object(raw, required_key="message")

        if not isinstance(data, dict) or "message" not in data:
            raise ValueError("Invalid onboarding JSON structure")

        # Validate and coerce model output against a strict response model so that
        # missing keys default safely and wrong types don't reach the frontend.
        validated = OnboardResponse.model_validate(data)
        return validated.model_dump(exclude_none=True)
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"Onboard JSON parse error: {exc!r}")
        if os.getenv("DEBUG_LOG_ONBOARD_RAW") == "1":
            print(f"Onboard raw snippet (truncated): {raw[:200]!r}")

        # Salvage a clean plain-text message and detect the done signal.
        # Strategy: look for a trailing JSON fragment (rfind '{' in the latter half
        # of the text) and parse it with json.loads — only trust done:true when it
        # appears as an actual top-level key in a parseable object, not anywhere in
        # the raw string (which would produce false positives on quoted examples).
        done_msg = "Thanks — that's everything I need! Let me put your twin together."
        cont_msg = "Got it — let me keep going. Could you tell me a bit more?"

        fallback_done = False
        fallback_message = raw

        if raw.strip().startswith("{") or raw.strip().startswith("```"):
            # Entire output looks like a (possibly malformed) JSON blob — can't
            # salvage natural language, so use a canned message.
            fallback_message = cont_msg
        else:
            # Check for a trailing JSON fragment like  ...nice. {"done": true}
            last_brace = raw.rfind('{')
            if last_brace > len(raw) // 2:
                try:
                    fragment = json.loads(raw[last_brace:])
                    # Only treat this as a real trailer (and truncate) if it parses
                    # and looks like the expected {"done": ...} object.
                    if isinstance(fragment, dict) and "done" in fragment:
                        if fragment.get("done") is True:
                            fallback_done = True
                        fallback_message = raw[:last_brace].strip()
                except json.JSONDecodeError:
                    # Leave fallback_message as the full raw text if the fragment
                    # doesn't parse; don't truncate on malformed JSON.
                    pass
            if not fallback_message:
                fallback_message = done_msg if fallback_done else cont_msg

        fallback_topics = list(_ALL_ONBOARD_TOPICS) if fallback_done else covered

        return {
            "message": fallback_message,
            "field_updates": {},
            "topics_covered": fallback_topics,
            "done": fallback_done,
        }
    except Exception as exc:
        print(f"Unexpected error in /onboard/message: {exc}")
        raise HTTPException(status_code=500, detail="An unexpected error occurred. Please try again.")


_DEEPEN_SYSTEM_TEMPLATE = """\
You are helping someone deepen their AI twin. They already built a basic version; now you're \
uncovering the nuance that makes reasoning feel real instead of generic.

Your job: ask exactly 3 focused questions, one per turn, to surface depth data most twins lack.

TOPICS (ask in this order, skip already-covered ones):
1. PAST_DECISIONS  → "Walk me through 2-3 decisions you've made that were genuinely hard — \
what you chose, what you gave up, and whether you'd do it again."
2. NON_NEGOTIABLES → "What would you flat-out refuse to do even under real pressure? \
And what would you bend on if the trade-off was right?"
3. MIND_CHANGE     → "Tell me about a time you changed your mind on something you'd held \
strongly. What actually moved you?"

RULES — follow exactly:
- One question per turn. 2-4 sentences max. Be direct and warm.
- CRITICAL: Every message MUST end with a question, except the final closing when done is true.
- If an answer is too vague, push back once with a concrete prompt ("Can you give me a specific \
example?"), then accept whatever they say.
- After a rich answer, acknowledge in one short phrase and immediately ask the next topic.
- When all 3 topics are covered, close naturally and set done to true.
- Never sound like a form — no "Question 1 of 3", no "Moving on to".

CURRENT STATE:
Topics remaining: {topics_remaining}
Existing twin context (for reference — do NOT repeat back to them):
{existing_context}

RETURN ONLY valid JSON — no markdown, no text outside the JSON:
{{
  "message": "your question or closing as natural prose",
  "field_updates": {{
    "pastDecisions": "extracted from their answer — omit key if not in this message",
    "nonNegotiables": "what they won't bend on — omit if not in this message",
    "softPreferences": "what they would compromise on — omit if not in this message",
    "mindChange": "the story of changing their mind — omit if not in this message"
  }},
  "topics_covered": ["PAST_DECISIONS"],
  "done": false
}}
"""

_ALL_DEEPEN_TOPICS = ["PAST_DECISIONS", "NON_NEGOTIABLES", "MIND_CHANGE"]


class DeepenHistoryItem(BaseModel):
    role: str
    content: str


class DeepenFieldUpdates(BaseModel):
    pastDecisions: Optional[str] = None
    nonNegotiables: Optional[str] = None
    softPreferences: Optional[str] = None
    mindChange: Optional[str] = None

    model_config = {"extra": "ignore"}


class DeepenRequest(BaseModel):
    history: List[DeepenHistoryItem] = Field(default_factory=list)
    topics_covered: List[str] = Field(default_factory=list)
    fields_collected: Optional[Dict[str, Any]] = None

    model_config = {"extra": "ignore"}


class DeepenResponse(BaseModel):
    message: str
    field_updates: DeepenFieldUpdates = Field(default_factory=DeepenFieldUpdates)
    topics_covered: List[str] = Field(default_factory=list)
    done: bool = False

    model_config = {"extra": "ignore"}

    @field_validator("field_updates", mode="before")
    @classmethod
    def _coerce_field_updates(cls, v: Any) -> Any:
        if not isinstance(v, dict):
            return {}
        return v

    @field_validator("topics_covered", mode="before")
    @classmethod
    def _coerce_topics_covered(cls, v: Any) -> Any:
        if not isinstance(v, list):
            return []
        return [item for item in v if isinstance(item, str)]

    @field_validator("done", mode="before")
    @classmethod
    def _coerce_done(cls, v: Any) -> Any:
        if isinstance(v, bool):
            return v
        return False


async def _deepen_and_save(twin_id: str, user_id: str, twin_data: dict, new_fields: dict) -> None:
    """Merge new depth data into the twin's personality_model._context and re-synthesize the personality model."""
    existing_model = twin_data.get("personality_model", {})
    # context.py reads depth fields from personality_model["_context"], so persist there
    ctx = dict(existing_model.get("_context", {}))

    for key in ("pastDecisions", "nonNegotiables", "softPreferences", "mindChange"):
        if new_fields.get(key):
            if key == "pastDecisions" and ctx.get(key):
                ctx[key] = ctx[key].strip() + "\n\n" + new_fields[key].strip()
            else:
                ctx[key] = new_fields[key]

    # Write the updated _context back into personality_model so prompt building picks it up
    existing_model["_context"] = ctx
    twin_data["personality_model"] = existing_model

    synthesis_prompt = f"""You are updating an AI twin's personality model with new depth data.

EXISTING MODEL:
{json.dumps(existing_model, indent=2)}

NEW DEPTH DATA:
Past decisions: {ctx.get("pastDecisions", "N/A")}
Non-negotiables (won't bend on): {ctx.get("nonNegotiables", "N/A")}
What they'd compromise on: {ctx.get("softPreferences", "N/A")}
Changed their mind: {ctx.get("mindChange", "N/A")}

Using the existing model as a base, return an improved JSON model that incorporates the new data.
The new data should sharpen: decision_heuristics, blind_spots, what_they_avoid, decision_framework, personality_summary.
Preserve fields unaffected by this data: core_values, communication_traits, risk_profile, what_they_optimize_for.
Return ONLY valid JSON with the same structure as the existing model. No markdown, no extra text."""

    try:
        response = await asyncio.to_thread(
            bedrock_client.converse,
            modelId=BEDROCK_MODEL_ID,
            system=[{"text": synthesis_prompt}],
            messages=[{"role": "user", "content": [{"text": "Update the personality model with the new depth data."}]}],
            inferenceConfig={"maxTokens": 1200, "temperature": 0.5, "topP": 0.9},
        )
        raw = response["output"]["message"]["content"][0]["text"].strip()
        updated_model = _extract_json_object(raw)
        if isinstance(updated_model, dict) and updated_model:
            # Always carry the updated _context into the re-synthesized model
            updated_model["_context"] = ctx
            twin_data["personality_model"] = updated_model
    except Exception as exc:
        print(f"Deepen re-synthesis failed (non-fatal): {exc}")
        # Depth data is already merged into personality_model["_context"] above, so it will be saved even if synthesis fails

    twin_data["deepen_completed_at"] = datetime.now().isoformat()
    _save_twin(twin_id, user_id, twin_data)


@app.post("/twin/{twin_id}/deepen/message")
async def deepen_message(
    twin_id: str,
    request: DeepenRequest,
    user_id: str = Depends(get_current_user_id),
):
    """Run one turn of the deepen interview for a twin the caller owns."""
    twin_data = load_twin(twin_id)
    if not twin_data or twin_data.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Twin not found")

    covered = list(request.topics_covered)
    remaining = [t for t in _ALL_DEEPEN_TOPICS if t not in covered]

    # Build a short existing-context summary to orient the LLM
    pm = twin_data.get("personality_model", {})
    ctx_lines = []
    if twin_data.get("name"):
        ctx_lines.append(f"Name: {twin_data['name']}")
    if twin_data.get("title"):
        ctx_lines.append(f"Title: {twin_data['title']}")
    if pm.get("personality_summary"):
        ctx_lines.append(f"Personality: {pm['personality_summary']}")
    if pm.get("decision_framework"):
        ctx_lines.append(f"Decision framework: {pm['decision_framework']}")
    existing_context = "\n".join(ctx_lines) if ctx_lines else "No existing context."

    system_prompt = _DEEPEN_SYSTEM_TEMPLATE.format(
        topics_remaining=", ".join(remaining) if remaining else "ALL COVERED",
        existing_context=existing_context,
    )

    messages: List[Dict[str, Any]] = []
    if not request.history:
        messages = [{"role": "user", "content": [{"text": "hi, let's start"}]}]
    else:
        for item in request.history[-30:]:
            if item.role not in ("user", "assistant"):
                raise HTTPException(status_code=400, detail=f"Invalid role: {item.role!r}")
            messages.append({"role": item.role, "content": [{"text": item.content}]})

    try:
        response = await asyncio.to_thread(
            bedrock_client.converse,
            modelId=BEDROCK_MODEL_ID,
            system=[{"text": system_prompt}],
            messages=messages,
            inferenceConfig={"maxTokens": 600, "temperature": 0.9, "topP": 0.95},
        )
        raw = response["output"]["message"]["content"][0]["text"].strip()
        data = _extract_json_object(raw, required_key="message")

        if not isinstance(data, dict) or "message" not in data:
            raise ValueError("Invalid deepen JSON structure")

        validated = DeepenResponse.model_validate(data)
        result = validated.model_dump(exclude_none=True)

        # If done, merge new fields and re-synthesize synchronously before returning
        if validated.done:
            all_fields = dict(request.fields_collected or {})
            fu = validated.field_updates
            for key in ("pastDecisions", "nonNegotiables", "softPreferences", "mindChange"):
                val = getattr(fu, key, None)
                if val:
                    all_fields[key] = val
            await _deepen_and_save(twin_id, user_id, twin_data, all_fields)

        return result

    except (ValueError, json.JSONDecodeError) as exc:
        print(f"Deepen JSON parse error: {exc!r}")
        done_msg = "Got it — I've gathered enough to deepen your twin. Saving now."
        cont_msg = "Got it — let me keep going. Could you tell me more?"

        done_fallback = False
        fallback_message = raw if "raw" in locals() else cont_msg

        if "raw" in locals():
            if raw.strip().startswith("{") or raw.strip().startswith("```"):
                # Entire output looks like a JSON blob — substitute a canned message.
                fallback_message = cont_msg
            else:
                last_brace = raw.rfind('{')
                if last_brace > len(raw) // 2:
                    try:
                        fragment = json.loads(raw[last_brace:])
                        if isinstance(fragment, dict) and "done" in fragment:
                            if fragment.get("done") is True:
                                done_fallback = True
                            fallback_message = raw[:last_brace].strip()
                    except json.JSONDecodeError:
                        pass
                if not fallback_message:
                    fallback_message = done_msg if done_fallback else cont_msg

        return {
            "message": fallback_message,
            "field_updates": {},
            "topics_covered": list(_ALL_DEEPEN_TOPICS) if done_fallback else covered,
            "done": done_fallback,
        }
    except Exception as exc:
        print(f"Unexpected error in /twin/{{twin_id}}/deepen/message: {exc}")
        raise HTTPException(status_code=500, detail="An unexpected error occurred. Please try again.")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)  # nosec B104 — local dev only, not used in Lambda
