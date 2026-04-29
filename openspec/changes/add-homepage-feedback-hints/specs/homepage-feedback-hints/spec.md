## ADDED Requirements

### Requirement: Welcome message on empty homepage chat
The homepage chat component SHALL render an initial assistant message before the visitor sends any input. The message SHALL identify the twin by name and invite a question (e.g., "Hi, I'm Sidd's twin — ask me anything."). The welcome SHALL NOT be persisted to the backend session record.

#### Scenario: Anonymous visitor opens the homepage
- **WHEN** an anonymous visitor loads `/` and the chat component mounts
- **THEN** the chat displays exactly one assistant message containing the welcome line
- **AND** no `POST /chat` request is fired as a result of mounting

#### Scenario: Welcome message is not persisted
- **WHEN** the visitor sends their first real message
- **THEN** the request body to `POST /chat` contains only the visitor's message
- **AND** the saved session record does not contain the welcome line

### Requirement: Visible feedback and contact hints
Below the welcome message, the homepage chat SHALL display at least two greyed-out hint affordances whose visible labels are exactly:
- "I want to give feedback"
- "Contact Sidd"

The hints SHALL be visually subordinate to the welcome (e.g., smaller / lower-contrast text or chip styling) and SHALL be readable on both light and dark backgrounds.

#### Scenario: Hints render in the empty state
- **WHEN** the chat component mounts and `messages` contains only the welcome
- **THEN** both hint labels are present in the DOM
- **AND** they are visually distinct from real assistant message bubbles

#### Scenario: Hints disappear after first user message
- **WHEN** the visitor sends any message
- **THEN** the hint affordances are no longer rendered

### Requirement: Hint click sends the canonical phrase via the existing chat path
Clicking a hint SHALL trigger the same `sendMessage` flow as a typed message, with the input pre-set to the hint's exact label. No dedicated endpoint, header, or request flag SHALL be introduced for hints.

#### Scenario: Click on "I want to give feedback"
- **WHEN** the visitor clicks the "I want to give feedback" hint
- **THEN** a user message bubble with content "I want to give feedback" appears in the transcript
- **AND** a `POST /chat` request is sent with `message: "I want to give feedback"` and the same session id behavior as a typed message

#### Scenario: Click on "Contact Sidd"
- **WHEN** the visitor clicks the "Contact Sidd" hint
- **THEN** a user message bubble with content "Contact Sidd" appears in the transcript
- **AND** a `POST /chat` request is sent with `message: "Contact Sidd"`

### Requirement: Anonymous feedback messages trigger admin notification
The backend SHALL fire `_notify_connect_intent` for messages matching `_CONNECT_RE` regardless of whether the chatter is authenticated, subject to the rate limits below. The notification email body SHALL include the chatter's identity if available (`chatter_id` for authenticated; the session id for anonymous).

#### Scenario: Anonymous match fires a notification
- **WHEN** an unauthenticated `POST /chat` is received with message "I want to give feedback"
- **AND** rate limits have not been exceeded
- **AND** `SES_FROM_EMAIL` and `ADMIN_EMAILS` are configured
- **THEN** `_notify_connect_intent` is invoked once
- **AND** the notification body identifies the source as anonymous and includes the session id

#### Scenario: Authenticated match still fires a notification
- **WHEN** an authenticated `POST /chat` is received with message "Contact Sidd"
- **THEN** `_notify_connect_intent` is invoked once
- **AND** the notification body includes the authenticated `chatter_id`

#### Scenario: Non-matching message does not fire
- **WHEN** any `POST /chat` is received with a message that does not match `_CONNECT_RE`
- **THEN** `_notify_connect_intent` is NOT invoked

### Requirement: Anonymous notifications are rate-limited per session and per IP
The backend SHALL limit anonymous-feedback emails to at most one notification per session id, and at most `FEEDBACK_NOTIFY_RATE_LIMIT` notifications per source IP per rolling 7 days (default 3). When a limit is hit, the chat reply path SHALL still execute normally; only the email is suppressed.

#### Scenario: Second feedback message in the same anonymous session
- **WHEN** an anonymous session has already triggered one notification
- **AND** a second feedback-matching message is sent on that same session id
- **THEN** `_notify_connect_intent` is NOT invoked for the second message
- **AND** the chat response is returned to the user as usual

#### Scenario: IP rate limit exceeded
- **WHEN** anonymous requests from the same source IP have already produced `FEEDBACK_NOTIFY_RATE_LIMIT` notifications within the last 7 days
- **AND** another anonymous feedback-matching request arrives from that IP
- **THEN** `_notify_connect_intent` is NOT invoked
- **AND** the chat response is returned normally

### Requirement: Authenticated notifications are rate-limited per user
The backend SHALL limit authenticated-feedback emails to at most `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT` notifications per `chatter_id` per rolling 7 days (default 5). The limit is independent of the anonymous IP cap — authenticated callers do not consume from, nor are blocked by, the anonymous IP bucket. When the auth limit is hit, the chat reply path SHALL still execute normally; only the email is suppressed.

#### Scenario: Authenticated user under cap
- **WHEN** an authenticated user has triggered fewer than `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT` notifications in the last 7 days
- **AND** sends a feedback-matching message
- **THEN** `_notify_connect_intent` is invoked
- **AND** the body identifies the `chatter_id`

#### Scenario: Authenticated user at cap
- **WHEN** an authenticated user has already triggered `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT` notifications in the last 7 days
- **AND** sends another feedback-matching message
- **THEN** `_notify_connect_intent` is NOT invoked
- **AND** the chat response is returned normally
- **AND** a suppression line is logged (CloudWatch / stdout)

#### Scenario: Authenticated user not blocked by anonymous IP cap
- **WHEN** the anonymous IP bucket for the source IP is exhausted
- **AND** an authenticated user from the same IP sends a feedback-matching message under their own per-user cap
- **THEN** `_notify_connect_intent` IS invoked

### Requirement: Notification path is configurable via environment
The notification path SHALL be controllable without a code change via the existing SES envs and the rate-limit envs.

| Env | Effect |
|-----|--------|
| `SES_FROM_EMAIL` unset or empty | All notifications disabled (existing behavior) |
| `ADMIN_EMAILS` unset or empty | All notifications disabled (existing behavior) |
| `FEEDBACK_NOTIFY_RATE_LIMIT=0` | Anonymous notifications disabled; authenticated still fire (subject to their own cap) |
| `FEEDBACK_NOTIFY_RATE_LIMIT=N` (N>0) | Up to N anonymous notifications per IP per rolling 7 days |
| `FEEDBACK_NOTIFY_RATE_LIMIT` unset | Default 3 |
| `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT=0` | Authenticated notifications disabled; anonymous still fire (subject to their own cap) |
| `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT=N` (N>0) | Up to N authenticated notifications per `chatter_id` per rolling 7 days |
| `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT` unset | Default 5 |

#### Scenario: SES_FROM_EMAIL not configured
- **WHEN** any feedback-matching request arrives
- **AND** `SES_FROM_EMAIL` is empty
- **THEN** no SES call is attempted
- **AND** no error is raised to the chat caller

#### Scenario: Anonymous notifications disabled by env
- **WHEN** `FEEDBACK_NOTIFY_RATE_LIMIT=0`
- **AND** an anonymous feedback-matching request arrives
- **THEN** `_notify_connect_intent` is NOT invoked
- **AND** an authenticated feedback-matching request from the same IP still fires a notification (subject to its own cap)

#### Scenario: Authenticated notifications disabled by env
- **WHEN** `AUTH_FEEDBACK_NOTIFY_RATE_LIMIT=0`
- **AND** an authenticated feedback-matching request arrives
- **THEN** `_notify_connect_intent` is NOT invoked
- **AND** an anonymous feedback-matching request still fires (subject to its own cap)
