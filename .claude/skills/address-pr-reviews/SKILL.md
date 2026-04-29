---
name: address-pr-reviews
description: Fetch GitHub PR review comments and optionally address them with code changes. Trigger when the user asks to "check the review comments", "see what the reviewer said", "address the review feedback", "respond to PR reviews", "fix the review nits", or any variant on responding to review activity. Defaults to the PR for the current branch when no PR number is given.
license: MIT
compatibility: Requires gh CLI authenticated against the repo's GitHub remote.
---

Fetch and (optionally) address review comments on a GitHub pull request.

## Inputs

- **PR number** (optional): if omitted, resolve from the current branch.
- **Mode**: `fetch` (default — list comments only) vs `address` (make changes). Decide from the user's wording. If the user only asks to "see" / "check" / "show" comments, do NOT make changes. If they say "address" / "fix" / "apply" / "respond to", proceed to step 5.

## Steps

### 1. Identify the PR

```bash
# If the user gave a number, use it directly.
# Otherwise, resolve from the current branch:
gh pr view --json number,headRefName,baseRefName,url 2>/dev/null
```

If no PR exists for the current branch, tell the user (e.g. "the branch hasn't been pushed yet, so the auto-PR workflow hasn't created one") and stop.

Announce: `Reviewing PR #<n> — <url>`.

### 2. Resolve repo coordinates

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

Use that for subsequent `gh api` calls.

### 3. Fetch all comment surfaces — in parallel

PRs have three distinct comment streams. Fetch all three so nothing is missed:

```bash
# Inline / line-anchored review comments (the main signal)
gh api "repos/<owner>/<repo>/pulls/<n>/comments" --paginate

# Review summaries (approve / request-changes / commented headers)
gh api "repos/<owner>/<repo>/pulls/<n>/reviews" --paginate

# PR-level discussion (top-level conversation, not anchored to lines)
gh api "repos/<owner>/<repo>/issues/<n>/comments" --paginate
```

Capture for each inline comment: `id`, `user.login`, `path`, `line` (or `original_line` if outdated), `body`, `in_reply_to_id`, `created_at`, `updated_at`. Group threaded replies under their root `id`.

### 4. Present a structured summary

Render to the user a numbered list grouped by file, e.g.:

```
PR #45 — 3 review threads, 1 review summary

▸ backend/server.py
  1. [line 145] @reviewer: "this regex won't match 'send feedback'..."
     ↳ no replies yet
  2. [line 782] @reviewer: "should we cap by IP?"
     ↳ @sidd: "yeah, let me think about it"
     ↳ no resolution

▸ frontend/components/twin.tsx
  3. [line 49] @reviewer: "extract WELCOME_TEXT to i18n later"
     ↳ no replies yet

Review summaries: 1 CHANGES_REQUESTED from @reviewer
```

If `mode == fetch`, stop here and let the user choose what to address next.

### 5. Address mode — only with explicit user intent

For each comment to address, follow this loop:

a. **Re-read the file** at the referenced path before editing. Lines drift; trust the file, not the comment's line number alone.

b. **Classify the comment**:
   - **Agree → fix it.** Apply the change.
   - **Partially agree / alternative approach.** Propose your fix to the user before editing.
   - **Disagree.** Draft a reply explaining why, surface to user for approval, do not change code.
   - **Ambiguous / out of scope.** Ask the user.

c. **Verify the fix locally**. For changed files:
   - Python: `python -m py_compile <file>` (and run any narrow unit-style check if logic changed).
   - TS / TSX: `npm run lint` from `frontend/`.
   - Don't claim a UI fix works without running the dev server (per CLAUDE.md: "Type checking and test suites verify code correctness, not feature correctness").

d. **Commit per logical fix** — do NOT amend, do NOT batch unrelated fixes:
   ```
   review: <one-line summary of the fix>

   Addresses review comment from @<reviewer> on <path>:<line>.
   <Why this matches what they asked for, in 1–2 sentences.>

   Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
   ```
   Stage explicitly (`git add <files>`); never `git add -A` / `git add .`.

e. **Reply in-thread** for comments where you want to push back, clarify, or note that the fix is in commit X:
   ```bash
   gh api -X POST "repos/<owner>/<repo>/pulls/<n>/comments/<comment_id>/replies" \
     -f body="<your reply>"
   ```
   Always show the reply to the user first and get approval. Do not auto-reply.

### 6. Final summary

Report back with:
- Number of comments addressed (with new commit SHAs).
- Number replied to (with the body of each reply).
- Number left open (and the reason for each — e.g. "needs design discussion").
- Whether commits exist to push, and the suggested push command:
  ```bash
  git push
  ```

## Guardrails

- **Never push** without explicit user approval. The user said "I will push" in past sessions for this repo — assume the same default until told otherwise.
- **Never resolve** a review thread the reviewer hasn't accepted. Leaving a thread open is the right move when you've fixed something — let the reviewer mark it resolved.
- **Never amend** prior commits. Always create new ones (CLAUDE.md is explicit about this — failed pre-commit hooks make amend dangerous, and force-pushes to shared branches are off-limits).
- **Never skip hooks** (`--no-verify`) or bypass signing without explicit user permission.
- **Stage files explicitly** (`git add <file>`); avoid `-A` / `.` to prevent accidental inclusion of `.env`, secrets, or large binaries.
- **Don't hallucinate review comments**. If a fetch returns nothing, say so. Don't invent reviewer concerns to look helpful.
- **Skip credentials / secrets** even if a comment requests changes there — flag to user instead.
- **gh auth check** before any GitHub call: if `gh auth status` fails, tell the user to run `gh auth login` and stop. Do not try to work around it.
- **Branch sanity**: if the current branch is `main` (or any protected branch) and the user asks to "address review comments," refuse and ask them to switch to the feature branch first.

## When NOT to use this skill

- The user is asking about pre-PR feedback (`/review` skill, security-review skill, etc.) — those run before a PR exists.
- The user wants to write a brand-new PR description — use `gh pr edit` directly.
- The user wants to merge / close the PR — that's a separate operation requiring extra confirmation.
