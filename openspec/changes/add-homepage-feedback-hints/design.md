## Context

The homepage chat lives at `frontend/components/twin.tsx` and is rendered for anyone visiting `/` (signed-in or not). It calls the FastAPI `POST /chat` endpoint with no special header for visitors.

The backend at `backend/server.py` already has:
- `_CONNECT_RE` (lines ~102–114): a permissive regex matching feedback/contact/connect intents.
- `_notify_connect_intent` (lines ~117–140): a fire-and-forget SES `send_email` to `ADMIN_EMAILS`.
- The call site at line ~782 is gated behind `viewer_is_authenticated`, so anonymous matches today fall through silently.

SES is provisioned and works for the signed-in path (most recent feedback fix landed in PR #45). No new infrastructure is needed.

The chat itself is anonymous-tolerant: a session id is generated server-side on first call, and conversation history is stored under that session id. The 5-message anonymous cap (`MAX_ANON_EXCHANGES`) already exists in `twin.tsx`, which gives us a built-in upper bound on per-session feedback firing.

## Goals / Non-Goals

**Goals:**
- A first-time visitor immediately sees a friendly greeting and two visible hint affordances explaining how to leave feedback or contact Sidd.
- A click on a hint produces the same outcome as if the visitor typed the phrase manually — single code path, no special endpoint.
- Anonymous feedback messages emit an admin email, with abuse mitigation strong enough that the SES daily quota cannot be exhausted by a single bad actor.

**Non-Goals:**
- A separate feedback form, modal, or `/feedback` endpoint.
- Persistent storage of feedback (it's email-only; the conversation transcript already lives in the session record).
- CAPTCHA or third-party anti-abuse — basic IP + session rate limiting is enough for a homepage hint.
- Localization. English-only matches the rest of the homepage today.
- Email replies / threading. Notifications stay one-way to the admin.

## Decisions

### 1. Welcome + hints are client-rendered, not returned by the backend
**Choice:** Seed an initial assistant `Message` in `twin.tsx` state on mount; render hint chips as a sibling element of the empty-state.

**Why:** Keeps the backend uninvolved in copy changes (no redeploy for a wording tweak), and avoids any extra `/chat` round-trip on page load. The hint copy is presentation, not persona output.

**Alternative considered:** Have the backend return a synthetic first turn. Rejected — couples persona logic to UI greeting, and the existing chat-history loading code would have to special-case "first turn we generated for you" to avoid re-saving it.

### 2. Hint click sends the phrase verbatim through the existing `/chat` path
**Choice:** Clicking a hint pre-fills the input with the canonical phrase ("I want to give feedback" or "Contact Sidd") and immediately calls `sendMessage()` — no new request shape, no `intent` flag.

**Why:** Reuses the regex match the backend already does. One code path means the regex can evolve to catch organic phrasings without touching the frontend, and free-typed feedback works identically to clicked feedback.

**Alternative considered:** A POST to a dedicated `/feedback` endpoint. Rejected — duplicates the SES path, adds a second auth/rate-limit surface, and forks the metadata story (transcript on one side, ad-hoc on the other).

### 3. Both anonymous and authenticated notifications are rate-limited
**Choice:** Drop the `viewer_is_authenticated` gate; add two independent limiters keyed differently.

- **Anonymous bucket (per-IP):** at most `FEEDBACK_NOTIFY_RATE_LIMIT` notifications per source IP per rolling 7 days (default 3). Plus a per-session "one shot" guard (the 5-message anon cap already bounds session reuse, so this is mostly belt-and-suspenders).
- **Authenticated bucket (per-`chatter_id`):** at most `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT` notifications per user per rolling 7 days (default 5). Independent of the anonymous IP bucket — they don't share state, so an authenticated user is not blocked by traffic from their IP and an anonymous spammer cannot consume an authenticated user's quota.

**Why:** Originally we left authenticated callers unlimited because they're attributable. But "attributable" is not "incapable of harm" — a logged-in spammer (or compromised account) could still flood the inbox. Capping both buckets is cheap, keeps the email path useful for legitimate users (5 in a week is plenty for organic feedback), and removes the "create an account to bypass limits" loophole. The 7-day window is a deliberate strengthening over the original 1-hour anon window: at 3/IP/hour an attacker could send 72/day; at 3/IP/week the worst case is ~21/year per IP if they wait out windows, which is well below any reasonable abuse threshold.

**Alternative considered:** Persistent (DynamoDB) state so limits hold across cold starts and horizontal scale. Rejected for now — see decision 4. The in-memory limiter weakens with longer windows because cold starts reset state, but SES quota is the hard ceiling and `ADMIN_EMAILS` is the only blast radius.

**Alternative considered:** Require sign-in to send feedback. Rejected — the user's complaint is exactly that anonymous visitors have no contact path; gating it on Clerk sign-up reintroduces the friction.

### 4. Rate-limiter state is per-Lambda-container in-memory
**Choice:** A module-level `dict[str, deque[float]]` keyed by IP, plus a `set[str]` of session ids that already fired.

**Why:** Lambda warm containers persist memory across invocations, so a single attacker hitting one container is throttled. The trade-off: cold containers reset state, so a determined attacker spreading requests across many cold starts could exceed the per-IP cap. Acceptable because (a) SES has its own send quota as a hard ceiling, (b) `ADMIN_EMAILS` is the only destination so the blast radius is bounded, and (c) we can move to Redis/Dynamo later if it ever matters.

**Alternative considered:** DynamoDB-backed limiter. Rejected for now — adds a write per chat and a new IAM policy for a non-existent abuse problem.

### 5. Hint copy is fixed; matching is the regex's job
**Choice:** The two visible hints are exactly:
- "I want to give feedback"
- "Contact Sidd"

Both already match `_CONNECT_RE` ("give … feedback" branch and "contact … sidd" branch respectively).

**Why:** Predictable behavior. We don't want to ship a hint whose phrasing the regex doesn't catch.

## Risks / Trade-offs

- **Risk:** SES quota exhaustion via spam → **Mitigation:** per-IP and per-session limiter; SES sandbox/production quota acts as a hard ceiling; admin can disable feature instantly by clearing `SES_FROM_EMAIL`.
- **Risk:** In-memory limiter is per-container, so horizontal Lambda scale-out weakens it → **Mitigation:** acceptable given SES quota; document the limitation in `CLAUDE.md` so future infra work knows when to upgrade.
- **Risk:** Initial assistant message confuses chat-history loading on the (rare) case where an anonymous user later signs in mid-session → **Mitigation:** the welcome message is client-only state and is not POSTed to `/chat`; it's purged when real history loads.
- **Trade-off:** Hint chips take vertical space in the empty-state. Acceptable — the chat is already empty before first send.
- **Trade-off:** Reusing the regex means hint phrasing changes need a regex review. Documented in tasks.

## Migration Plan

No data migration. Rollout is a single deploy:
1. Frontend ships welcome + hints (visible to all visitors).
2. Backend ships removal of the auth gate + the limiter (anonymous SES path opens).

If something is wrong with anonymous SES traffic, the rollback is one of:
- Unset `SES_FROM_EMAIL` (kills all notifications immediately, no redeploy).
- Set `FEEDBACK_NOTIFY_RATE_LIMIT=0` (kills the anonymous path only; keeps the auth path).
- Revert the backend PR.

## Open Questions

- Should the welcome message vary by twin (homepage = Sidd, but the same component is used for public personas at `/twin/<id>` for unauth viewers)? Default: yes — pass twin name into the welcome string. Confirm with Sidd before implementation.
- Should hint clicks be sent silently (no user message bubble) or rendered as a normal user message? Default: normal user message — keeps the conversation log honest and matches what the admin sees in the email body.
