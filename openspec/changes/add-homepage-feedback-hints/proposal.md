## Why

When an unauthenticated visitor lands on the homepage, the chat opens empty with no greeting, no examples, and no clue that the chat itself is the way to send feedback or contact Sidd. The backend already detects feedback/contact intent (`_CONNECT_RE` in `backend/server.py`) and emails the admin via SES, but two things make it undiscoverable today:

1. The hint is never surfaced to the user, so visitors never type the trigger phrases.
2. The notification path (`server.py:782`) is gated to `viewer_is_authenticated`, so anonymous homepage feedback is silently dropped.

This change makes feedback and contact reachable from the very first interaction.

## What Changes

- Show a one-line welcome message in the homepage chat before any user input (e.g., "Hi, I'm Sidd's twin — ask me anything.").
- Below the welcome, render greyed-out hint chips/text that double as one-tap prompts:
  - "I want to give feedback"
  - "Contact Sidd"
- Tapping a hint inserts the phrase into the input (or sends it directly) — same code path as a regular `/chat` message.
- Allow the SES notification to fire for **anonymous** chatters when the message matches `_CONNECT_RE`, with rate-limiting to prevent abuse.
- Rate-limit **authenticated** chatters too — the existing path was wide open and a logged-in attacker could spam the inbox indefinitely. New cap is per-`chatter_id` per rolling 7 days.
- Keep notification metadata accurate: include `chatter_id` when authenticated, anonymous session id otherwise.

Not in scope: a separate `/feedback` form, persistent feedback storage, or modal UI. We reuse the existing chat → regex → SES path.

## Capabilities

### New Capabilities
- `homepage-feedback-hints`: Welcome message and visible feedback/contact hint affordances for anonymous homepage chatters, plus the anonymous notification path that turns those messages into admin emails.

### Modified Capabilities
<!-- None. There are no existing OpenSpec specs in this repo to modify; the
     anonymous-notification behavior is new at the requirement level. -->

## Impact

- **Frontend** (`frontend/components/twin.tsx`): seed an initial assistant message and a hint row; clicking a hint sends the phrase via the existing `sendMessage` flow.
- **Backend** (`backend/server.py`): drop the `viewer_is_authenticated` gate around `_notify_connect_intent`; add per-session and per-IP rate limiting for anonymous callers (3 / IP / 7 days) and per-`chatter_id` rate limiting for authenticated callers (5 / user / 7 days).
- **Env vars**: optional `FEEDBACK_NOTIFY_RATE_LIMIT` (anonymous max per IP per 7 days, default 3) and `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT` (authenticated max per `chatter_id` per 7 days, default 5). Existing `SES_FROM_EMAIL` and `ADMIN_EMAILS` continue to control whether email is sent at all.
- **No infra changes**: SES is already provisioned; no new IAM, no new endpoints.
- **No data model changes**: notification is fire-and-forget, no DB write.
