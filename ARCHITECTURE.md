# Sidd's AI Twin - Architecture Diagram

## High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            USERS / CLIENTS                                   │
└───────────────────────────┬───────────────────────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────────┐
        │     CLOUDFRONT CDN (Global Edge)      │
        │   - HTTPS/TLS Termination             │
        │   - Cache Layer (Static Assets)        │
        │   - Custom Domain Support              │
        └───────────────────────┬─────────────────┘
                                │
                ┌───────────────┴──────────────┐
                │                              │
                ▼                              ▼
    ┌──────────────────────┐      ┌──────────────────────┐
    │   S3 Frontend Bucket │      │  API Gateway Proxy   │
    │  - Next.js App       │      │  - REST API Endpoint │
    │  - Static Assets     │      │  - CORS Handling     │
    │  - 404 Error Page    │      │  - Request Logging   │
    └──────────────────────┘      └──────────┬───────────┘
                                             │
                                             ▼
                        ┌────────────────────────────────────┐
                        │      AWS LAMBDA (Compute)          │
                        │                                    │
                        │  FastAPI Backend Application       │
                        │  ┌────────────────────────────┐    │
                        │  │ • Chat Endpoint (/chat)    │    │
                        │  │ • Taglines Endpoint        │    │
                        │  │ • Health Check             │    │
                        │  │ • Conversation Retrieval   │    │
                        │  │ • Data Loading             │    │
                        │  └────────────────────────────┘    │
                        │                                    │
                        │  Context Module:                   │
                        │  ┌────────────────────────────┐    │
                        │  │ • Bio                      │    │
                        │  │ • Skills                   │    │
                        │  │ • Experience               │    │
                        │  │ • LinkedIn Profile         │    │
                        │  │ • Achievements             │    │
                        │  │ • Communication Style      │    │
                        │  └────────────────────────────┘    │
                        └────────────┬───────────────────────┘
                                     │
                ┌────────────────────┼────────────────────┐
                │                    │                    │
                ▼                    ▼                    ▼
    ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
    │  AWS BEDROCK     │  │ S3 MEMORY Bucket │  │  DynamoDB State  │
    │                  │  │                  │  │  Lock Table      │
    │ • Claude Models  │  │ • Conversations  │  │                  │
    │ • Nova Models    │  │ • Session Data   │  │ • Terraform Lock │
    │ • Text Generation│  │ • JSON Storage   │  │ • Managed Lock   │
    │ • AI Inference   │  └──────────────────┘  └──────────────────┘
    └──────────────────┘
```

---

## Detailed Component Breakdown

### 1. **Frontend Layer**
- **Technology**: Next.js 14 (React + TypeScript)
- **Hosting**: AWS S3 + CloudFront CDN
- **Features**:
  - Real-time chat interface
  - Streaming tagline generation
  - Professional avatar display
  - Message history
  - Session management
  - Responsive design

### 2. **CDN & Edge Layer**
- **Service**: CloudFront
- **Features**:
  - Global content delivery
  - HTTPS/TLS encryption
  - Static asset caching
  - Custom domain support (Route 53)
  - Origin failover

### 3. **API Gateway**
- **Type**: REST API
- **Features**:
  - Request routing to Lambda
  - CORS configuration
  - Request/Response logging
  - Throttling & rate limiting
  - Authentication (if needed)

### 4. **Backend Application**
- **Technology**: Python FastAPI
- **Deployment**: AWS Lambda
- **Runtime**: Python 3.11+
- **Port**: 8000 (local) / API Gateway (production)

#### Endpoints:
```
GET  /              → Service info
GET  /health        → Health check
POST /chat          → Send message to AI Twin
GET  /taglines      → Generate/fetch AI taglines
GET  /conversation/{id} → Retrieve conversation history
```

### 5. **Data Loading & Context**

#### **resources.py** (Data Loader)
```
DATA_DIR/
├── facts.json           ← Basic info
├── summary.txt          ← Professional summary
├── style.txt            ← Communication style
├── linkedin.pdf         ← LinkedIn profile
├── bio.md               ← Biography
├── skills.json          ← Technical skills
├── achievements.md      ← Achievements
├── work_experience.md   ← Work history
├── interests.md         ← Interests
└── communication_style.md ← Communication guide
```

#### **context.py** (Prompt Engineering)
- Loads all data files dynamically
- Builds comprehensive system prompt
- Formats data for LLM consumption
- Manages conversation context

### 6. **AI Integration**

#### AWS Bedrock Models:
- **For Chat**: `anthropic.claude-3-sonnet-20240229-v1:0` or `amazon.nova-2-lite`
- **For Taglines**: Same model with creative parameters (temperature: 0.9)
- **Features**:
  - Streaming responses
  - Token-based pricing
  - Multi-turn conversations

### 7. **Storage Layer**

#### **S3 Buckets**:
1. **Frontend Bucket**
   - Static website hosting
   - Next.js build output
   - Assets and images
   - Public read access

2. **Memory Bucket**
   - Conversation history (JSON)
   - Per-session files
   - Private access (Lambda only)

#### **DynamoDB**:
- State lock table for Terraform
- Prevents concurrent deployments
- Auto-cleanup of stale locks

---

## Data Flow Diagrams

### Chat Interaction Flow
```
User Input (UI)
    │
    ▼
API Request → API Gateway → Lambda
    │
    ├─► Load Conversation History (S3)
    │
    ├─► Build Context (resources.py + context.py)
    │   ├─ Facts
    │   ├─ Skills
    │   ├─ Experience
    │   └─ Communication Style
    │
    ├─► Call AWS Bedrock API
    │   └─ Generate Response
    │
    ├─► Save Conversation (S3)
    │
    ▼
API Response ← API Gateway ← Lambda
    │
    ▼
Chat UI (Display)
```

### Tagline Generation Flow
```
Frontend Component Mounts
    │
    ▼
GET /taglines (API Request)
    │
    ▼
Lambda Handler
    │
    ├─► Check Cache (1 hour TTL)
    │   ├─ Cache Hit → Return cached taglines
    │   └─ Cache Miss → Continue
    │
    ├─► Call Bedrock with Prompt
    │   └─ Generate 10 taglines
    │
    ├─► Parse JSON Response
    │
    ├─► Cache Result (1 hour)
    │
    ▼
Return JSON Array
    │
    ▼
Frontend Streaming Component
    │
    ▼
Animate Typing Effect (User Sees)
```

---

## Infrastructure as Code (Terraform)

### Directory Structure
```
terraform/
├── main.tf              ← Core resources (S3, Lambda, API Gateway)
├── variables.tf         ← Input variables
├── outputs.tf           ← Output values
├── versions.tf          ← Provider configuration
├── backend.tf           ← State management (DynamoDB)
├── terraform.tfvars     ← Variable values
└── modules/             ← Reusable modules
    ├── storage/         ← S3 bucket setup
    ├── compute/         ← Lambda function
    └── cdn/             ← CloudFront distribution
```

### Key Terraform Resources
```
Resource Type           │ Count │ Purpose
─────────────────────────────────────────────────────────
S3 Buckets             │   2   │ Frontend + Memory
CloudFront Distribution │   1   │ CDN
API Gateway            │   1   │ REST API
Lambda Function        │   1   │ Backend logic
IAM Roles/Policies     │   2   │ Permissions
DynamoDB Table         │   1   │ State lock
Route 53 Records       │   2   │ Custom domain
```

---

## Deployment Architecture

### Development (Local)
```
Localhost:3000 (Frontend)
    │
    ▼
Localhost:8000 (Backend)
    │
    ▼
AWS Bedrock (Cloud API)
AWS S3 (Local file path: /memory)
```

### Production (AWS)
```
User (Browser)
    │
    ▼
CloudFront (CDN) → S3 (Frontend)
    │
    ▼
API Gateway
    │
    ▼
Lambda → Bedrock + S3
```

---

## Security Architecture

### Network Security
- ✅ CloudFront HTTPS/TLS encryption
- ✅ API Gateway request validation
- ✅ S3 public access blocked (except frontend)
- ✅ Lambda in private VPC (optional)

### Data Security
- ✅ S3 bucket policies for fine-grained access
- ✅ IAM roles with least-privilege principle
- ✅ Bedrock API calls authenticated via IAM
- ✅ Conversation data encrypted at rest

### Access Control
- ✅ Terraform state lock (DynamoDB)
- ✅ Lambda execution role
- ✅ S3 bucket permissions
- ✅ CloudFront origin access identity

---

## Scaling Considerations

### Horizontal Scaling
- **Lambda**: Auto-scales with concurrent requests
- **API Gateway**: Throttling limits configurable
- **CloudFront**: Automatic edge location distribution
- **S3**: Unlimited storage and requests

### Performance Optimization
- CloudFront caching (static assets)
- Lambda function optimization
- Bedrock model selection (Nova for speed, Claude for quality)
- Conversation batching

### Cost Optimization
- S3 lifecycle policies (archive old conversations)
- CloudFront cache hit ratio improvement
- Lambda timeout tuning
- Bedrock token usage monitoring

---

## Environment Variables

### Backend (.env)
```
DEFAULT_AWS_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-3-sonnet-20240229-v1:0
CORS_ORIGINS=http://localhost:3000,http://localhost:8000
USE_S3=true  # Use S3 for memory (false = local files)
MEMORY_DIR=../memory  # Local fallback
S3_BUCKET=twin-dev-memory-{account-id}
```

### Frontend (.env.local)
```
NEXT_PUBLIC_API_URL=http://localhost:8000  # or production API URL
```

---

## Summary

**Sidd's AI Twin** is a **modern, cloud-native application** combining:
- ✅ **Frontend**: Next.js on S3 + CloudFront
- ✅ **Backend**: FastAPI on Lambda
- ✅ **AI**: AWS Bedrock LLMs
- ✅ **Storage**: S3 for state + memory
- ✅ **Infrastructure**: Terraform IaC
- ✅ **CDN**: CloudFront for global delivery

This architecture is **scalable, cost-effective, and production-ready**! 🚀
