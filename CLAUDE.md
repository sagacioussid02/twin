# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow
- Always create a feature branch before making any changes. Never push directly to `main`.
- Branch naming: `feature/<description>`, `fix/<description>`, `chore/<description>`
- All changes go through a PR targeting `main`
- PRs are auto-created by GitHub Actions on push — never manually create PRs
- The remote default branch is `main` (note: `origin/HEAD` points to `SiddData` but the actual default is `main`)

## Commands

### Frontend
```bash
cd frontend
cp .env.local.example .env.local   # Fill in NEXT_PUBLIC_API_URL and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
npm run dev        # Start dev server on localhost:3000
npm run build      # Production build (static export to out/)
npm run lint       # ESLint
```

### Backend
```bash
cd backend
cp .env.example .env          # Fill in CLERK_JWKS_URL and SESSION_HMAC_SECRET at minimum
uvicorn server:app --reload --host 0.0.0.0 --port 8000  # Dev server (API docs at /docs)
python deploy.py   # Build Lambda deployment package (lambda-deployment.zip)
# Generate SESSION_HMAC_SECRET: python -c "import secrets; print(secrets.token_hex(32))"
```

### Infrastructure
```bash
cd terraform
terraform init     # Initialize (requires AWS credentials + S3 backend config)
terraform plan
terraform apply
```

## Architecture

### Request Flow
```
Browser → CloudFront → API Gateway → Lambda (FastAPI/Mangum) → Bedrock + S3
                     ↘ S3 (static frontend assets)
```

### Key Files
- `backend/server.py` — All API endpoints (~2200 lines), auth logic, session management
- `backend/lambda_handler.py` — Mangum wrapper that adapts FastAPI for Lambda
- `backend/context.py` — System prompt construction for Bedrock calls; redacts PII from injected text
- `backend/personality_agent.py` — Archetype detection and optional per-response tone review
- `backend/resources.py` — Loads default twin data from `backend/data/`
- `backend/public_personas/` — Static JSON files for public personas (Gandhi, Chaplin, Warren Buffett); served without auth
- `backend/personalities/archetypes.json` — Role archetypes used to nudge twin tone (e.g. "engineer", "executive")
- `frontend/app/` — Next.js App Router pages
- `frontend/components/twin.tsx` — Unauthenticated chat component
- `frontend/components/twin-chat.tsx` — Authenticated chat for user-created twins

### Authentication
- Clerk provides JWTs (RS256) to the frontend
- Frontend sends `Authorization: Bearer <token>` on protected requests
- Backend verifies via Clerk JWKS (cached in-memory, refreshed on unknown `kid`)
- `user_id` is extracted from the JWT `sub` claim

### Session IDs
- **Anonymous users:** UUID (supplied by client or generated)
- **Authenticated users:** HMAC-SHA256(`user_id:twin_id`, `SESSION_HMAC_SECRET`) — opaque 64-char hex, stable across devices, prevents session hijacking
- Valid formats enforced by regex: UUID v4 or `[0-9a-f]{64}`
- Session records are stored as `{messages: [...], chatter_id: "..."}` (new format) or a bare `[...]` list (legacy); both are handled on read

### Twin IDs
- User-created twins use 32-char hex (`[a-f0-9]{32}`) — not UUID v4
- Public personas use stable hard-coded IDs defined in `backend/public_personas/*.json`

### Data Layout (S3 or local filesystem)
```
twins/{user_id}/{twin_id}.json   # User-created twins
twins/{twin_id}.json             # Public personas (no user_id prefix)
sessions/{session_id}.json       # Conversation history
```

### Bedrock Integration
- Default model: `global.amazon.nova-2-lite-v1:0`
- Called via `boto3` `bedrock-runtime` client; region defaults to `us-east-1` (override via `DEFAULT_AWS_REGION`)
- `USE_S3=false` uses local filesystem; `USE_S3=true` uses S3
- `openai` is listed in dependencies but all LLM calls go through Bedrock — the package is vestigial

### Dependency Management
`backend/requirements.txt` and `backend/pyproject.toml` must stay in sync — Lambda packaging uses `requirements.txt` but local dev uses `pyproject.toml` (uv).

### Anonymous feedback rate limiter
`backend/server.py` keeps the feedback-notification rate-limiter state (anonymous per-IP rolling 7 days, authenticated per-`chatter_id` rolling 7 days, plus per-session one-shot behavior) in module-level memory, so it lives in the warm Lambda container and resets on cold start. Acceptable today because the SES daily quota is the hard ceiling and the only destination is `ADMIN_EMAILS`. If real abuse appears, move the limiter to DynamoDB or Redis.

## Deployment
- CI/CD deploys automatically on push to `main` via `.github/workflows/deploy.yml`
- Lambda is built inside a Docker container matching the Lambda runtime to ensure binary compatibility
- Frontend is deployed via Vercel (connected to `main`); also buildable for S3/CloudFront static hosting

## Environment Variables

**Backend:**
| Variable | Purpose |
|----------|---------|
| `CLERK_JWKS_URL` | Clerk JWKS endpoint for JWT verification |
| `SESSION_HMAC_SECRET` | 64-char hex; derives authenticated session IDs |
| `USE_S3` | `true` = S3 storage, `false` = local filesystem |
| `S3_BUCKET` | Bucket name for twins/sessions |
| `BEDROCK_MODEL_ID` | Override default LLM |
| `DEFAULT_AWS_REGION` | AWS region for Bedrock client (default: `us-east-1`) |
| `CORS_ORIGINS` | Comma-separated allowed origins |
| `PERSONALITY_REVIEW_ENABLED` | `true` enables per-response archetype tone review (off by default; adds latency) |
| `MEMORY_DIR` | Local sessions directory when `USE_S3=false` (default: `../memory`) |
| `SES_FROM_EMAIL` | SES sender address for feedback/contact alerts. Empty disables all admin notifications. |
| `ADMIN_EMAILS` | Comma-separated admin recipients for feedback/contact alerts. Empty disables notifications. |
| `FEEDBACK_NOTIFY_RATE_LIMIT` | Max anonymous feedback notifications per source IP per rolling 7 days (default `3`; `0` disables the anonymous path while keeping the authenticated one) |
| `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT` | Max authenticated feedback notifications per `chatter_id` per rolling 7 days (default `5`; `0` disables the authenticated path while keeping the anonymous one) |

**Frontend:**
| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_URL` | Backend base URL |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk public key |
