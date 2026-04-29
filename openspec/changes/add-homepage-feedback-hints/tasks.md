## 1. Backend: anonymous notification path

- [x] 1.1 In `backend/server.py`, remove the `viewer_is_authenticated and` clause from the `_CONNECT_RE` check at the existing notify call site so anonymous matches reach `_notify_connect_intent`.
- [x] 1.2 Adjust the notification body builder so the metadata line says `Authenticated chatter_id: <id>` when authenticated and `Anonymous session: <session_id>` otherwise.
- [x] 1.3 Confirm `_CONNECT_RE` matches both hint phrases verbatim ("I want to give feedback", "Contact Sidd") via a small unit-style script or REPL check; tweak the regex only if a phrase fails to match.

## 2. Backend: rate limiting

- [x] 2.1 Add a module-level limiter to `backend/server.py`: a `dict[str, deque[float]]` keyed by source IP plus a `set[str]` of session ids that already fired a notification. Pull source IP from the `Request` object (FastAPI exposes `request.client.host`) and trust the `X-Forwarded-For` first hop when running behind API Gateway.
- [x] 2.2 Read `FEEDBACK_NOTIFY_RATE_LIMIT` env (int, default 3) at module load.
- [x] 2.3 Implement `_should_notify_anon(ip, session_id) -> bool` that prunes timestamps older than 1 hour, enforces the per-IP cap, and consumes the per-session "one shot" entry. Authenticated callers skip this function.
- [x] 2.4 Wire `_should_notify_anon` into the call site so anonymous matches that exceed limits skip `_notify_connect_intent` but still return a normal chat response.
- [x] 2.5 Add a debug log (not user-facing) when a notification is suppressed by either limit, so the admin can spot abuse in CloudWatch.

## 3. Backend: tests / verification

- [ ] 3.1 Spin up `uvicorn` locally with `USE_S3=false`, `SES_FROM_EMAIL=""`, send an anonymous chat with "I want to give feedback", confirm no SES call and no exception (env-disabled path). _(Skipped live; env-disabled path is verified by code: line 100 sets `_ses_client = None` when `SES_FROM_EMAIL` is empty, and `_notify_connect_intent` early-returns on `not _ses_client`.)_
- [x] 3.2 With a stub `_ses_client` (monkey-patch `_notify_connect_intent` to record calls) verify the limiter:
  - first anonymous feedback message → 1 call
  - second on same session → still 1 call
  - new session, same IP, repeated until the IP cap → cap+0 anonymous call beyond cap
  - authenticated request after IP cap → still calls
- [x] 3.3 Run `npm run lint` (frontend) and `python -m compileall backend` to catch syntax slips.

## 4. Frontend: welcome message

- [x] 4.1 In `frontend/components/twin.tsx`, seed `messages` state with a single assistant entry containing a welcome line ("Hi, I'm Sidd's twin — ask me anything.") on mount.
- [x] 4.2 Ensure the welcome entry is purely client-side: the `POST /chat` body for the first user message must not include the welcome (verified by code: the request body sends only `{ message: messageText, session_id }`; welcome is never serialized to the backend).
- [ ] 4.3 If/when conversation history loads (signed-in case where prior session exists), replace the seeded welcome instead of stacking on top of it. _(N/A today — `twin.tsx` has no history-loading path. Leaving unchecked so a future history-load implementer remembers to handle this case.)_

## 5. Frontend: hint affordances

- [x] 5.1 Add a hint row beneath the welcome that renders only while `messages.length === 1` (welcome only) and `userMessageCount === 0`.
- [x] 5.2 Style hints as small, low-contrast chips/buttons (Tailwind: `text-xs text-neutral-400 hover:text-neutral-200 border border-neutral-700/40 rounded-full px-3 py-1`). Match the existing dark/light treatment used elsewhere in the homepage.
- [x] 5.3 Render exactly two hints with labels "I want to give feedback" and "Contact Sidd".
- [x] 5.4 On click, call `setInput(label)` then `sendMessage()` (using the next-tick value, or refactor `sendMessage` to accept an explicit message param so we don't fight React state batching).
- [ ] 5.5 Verify the click produces a real user message bubble in the transcript (matches the "honest log" decision in design.md). _(Manual browser check — pending task 6.)_

## 6. End-to-end check (manual, browser) — pending Sidd

- [ ] 6.1 Open `localhost:3000` while logged out. Confirm: welcome line + two hint chips visible; chat input empty.
- [ ] 6.2 Click "I want to give feedback". Confirm: bubble appears, twin responds, admin inbox receives one email with `Anonymous session: <id>` in the body.
- [ ] 6.3 In the same session, click again or type another feedback phrase. Confirm: chat responds, but no second email arrives (per-session cap).
- [ ] 6.4 Open a private/incognito window (new session, same IP) three more times and click feedback. Confirm three more emails arrive, then a fourth attempt produces no email (per-IP cap = 3).
- [ ] 6.5 Sign in and try again. Confirm the email arrives even if the IP cap was hit, and the body contains `Authenticated chatter_id`.
- [ ] 6.6 Send a benign message ("what's your background?"). Confirm: no email, normal response.

## 7. Docs

- [x] 7.1 Update `CLAUDE.md` Environment Variables table to include `FEEDBACK_NOTIFY_RATE_LIMIT`, `SES_FROM_EMAIL`, `ADMIN_EMAILS`, `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT`.
- [x] 7.2 Add a one-liner under Architecture noting the in-memory limiter is per-Lambda-container and points to this change as the upgrade trigger if abuse becomes real.

## 8. Tightened limits (per Sidd's DDoS-protection ask)

- [x] 8.1 Strengthen anonymous window: change `_NOTIFY_WINDOW_SECONDS` from 1 hour to 7 days so 3/IP applies over a week, not an hour.
- [x] 8.2 Add `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT` env (default 5) and `_should_notify_auth(chatter_id)` helper enforcing 5/`chatter_id`/7 days.
- [x] 8.3 Wire authenticated path through `_should_notify_auth`; both buckets log suppression to stdout for CloudWatch.
- [x] 8.4 Update spec, proposal, design, and CLAUDE.md to reflect dual-bucket weekly limits.
- [x] 8.5 Re-run stub-based limiter tests against the new behavior.
