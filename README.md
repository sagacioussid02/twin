# Personality Twin

> **Turn human expertise into an always-on AI persona.**

Personality Twin is a production-ready platform for creating digital versions of real people, founders, experts, and public figures. It captures voice, judgment, values, and decision-making style, then turns that into a conversational AI experience users can interact with anytime.

Built for scale on AWS, it combines a polished Next.js frontend with a FastAPI backend powered by Bedrock, Lambda, S3, and CloudFront.

---

## Why it stands out

- **Capture more than a resume** — preserve how someone thinks, not just what they have done
- **Create premium AI experiences** — let users chat with a founder, advisor, mentor, or historical persona
- **Deploy with confidence** — secure, serverless AWS architecture designed for real-world usage
- **Personalize at depth** — guided interviews and uploaded context make each twin feel distinct and believable

## Core experience

1. **Try a live twin instantly** — start chatting from the homepage with no setup required
2. **Build your own personality twin** — answer guided prompts and upload context to create a richer AI identity
3. **Refine the model** — deepen the twin with values, trade-offs, and pivotal decisions
4. **Launch memorable conversations** — explore curated public personas and showcase the product experience

---

## Running locally

You need: Node 20+, Python 3.12, AWS credentials with Bedrock access, and a Clerk account (free tier works).

### Backend

```bash
cd backend
pip install -r requirements.txt      # or: uv pip install -r requirements.txt

# Copy and fill in the required values
cp .env.example .env
# Required: CLERK_JWKS_URL, SESSION_HMAC_SECRET (64-char hex)
# Optional: USE_S3=false uses local disk (fine for dev)

uvicorn server:app --reload --port 8000
```

The API is now at `http://localhost:8000`. Hit `/docs` for the auto-generated Swagger UI — FastAPI gives you that for free, which almost makes up for Python's packaging situation.

### Frontend

```bash
cd frontend
npm install

# Copy and fill in
cp .env.local.example .env.local
# NEXT_PUBLIC_API_URL=http://localhost:8000
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...

npm run dev
```

App runs at `http://localhost:3000`.

### Environment variables you actually need

| Variable | Where | What |
|---|---|---|
| `CLERK_JWKS_URL` | backend | From your Clerk dashboard → API Keys |
| `SESSION_HMAC_SECRET` | backend | 64-char hex. Generate with: `python -c "import secrets; print(secrets.token_hex(32))"` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | frontend | From Clerk dashboard |
| `NEXT_PUBLIC_API_URL` | frontend | `http://localhost:8000` for local dev |

Everything else has sensible defaults for local development.

---

## Architecture (the 30-second version)

```
Browser
  │
  ├── Static frontend (Next.js)
  │     S3 + CloudFront in prod, localhost:3000 locally
  │
  └── API calls ──► FastAPI (Python)
                      Lambda in prod, uvicorn locally
                      │
                      ├── AWS Bedrock  ← all the LLM calls (Nova / Claude)
                      │
                      └── S3  ← twin JSON files + conversation history
                                (local disk when USE_S3=false)
```

**Auth:** Clerk handles sign-up/login. The frontend gets a JWT, sends it as a Bearer token, and the backend verifies it against Clerk's public keys. Standard stuff.

**Twin storage:** Each twin is a single JSON file. No database. This is either elegant simplicity or a future problem, depending on when you're reading this.

**Conversations:** Also JSON files, keyed by a session ID. Authenticated sessions use an HMAC-derived ID so they're stable across devices without any server-side session lookup.

**LLM calls:** Everything goes through AWS Bedrock. The default model is Amazon Nova — fast and cheap for homepage chat. The same model handles twin creation synthesis, deepen re-synthesis, and tagline generation.

---

## Project structure

```
├── backend/
│   ├── server.py          # All API endpoints (~2200 lines, yes it's a lot)
│   ├── context.py         # Prompt engineering for twin conversations
│   ├── personality_agent.py  # Archetype detection
│   ├── resources.py       # Loads the default twin's data files
│   ├── data/              # Sidd's actual profile data (bio, skills, etc.)
│   └── public_personas/   # Public persona JSON files loaded at startup
│
├── frontend/
│   ├── app/               # Next.js App Router pages
│   │   ├── page.tsx       # Homepage
│   │   ├── dashboard/     # Your twins
│   │   ├── create/        # Twin creation flow
│   │   ├── twin/          # Chat with any twin
│   │   └── deepen/        # Depth interview
│   └── components/
│       ├── twin.tsx        # Unauthenticated homepage chat
│       └── twin-chat.tsx   # Authenticated chat for user twins
│
└── terraform/             # AWS infrastructure as code
```

---

## Deploying

Push to `main`. GitHub Actions handles the rest — builds the Lambda package, runs Terraform, and deploys the frontend to the AWS-hosted static site stack managed in this repo (S3 + CloudFront).

The platform runs on a modern serverless AWS stack using Lambda, API Gateway, S3, CloudFront, and Bedrock, giving it the speed, scalability, and production posture expected from a sellable AI product.

---

## The backstory

This started as "what if my resume could talk back" and evolved into something more interesting: a platform for capturing how people actually reason, not just what they've done. Resumes list accomplishments. This tries to capture the mental model behind them.

The historical personas (like Gandhi, Charlie Chaplin, and Buffett) exist to prove the concept works for public figures — and because having Gandhi explain nonviolent resistance to you directly is genuinely a different experience than reading a Wikipedia summary.

---

*Built by [Siddharth Shankar](https://github.com/sagacioussid02) · Binosus LLC · 2026*
