---
name: backfill
description: Backfill herbert specifications from the project's git history — distill durable requirements from past commits, classify them by component, and log them with the commit's timestamp. Use when the user asks to backfill specs, import spec history, or seed the spec map / PRD from previous commits.
---

# Backfill specifications from git history

Turn the project's commit history into logged specifications so the spec map and PRD reflect work done before herbert was tracking it.

## 1. Gather

- Call `get_session_data` with scope `all` and note the existing specifications (summaries and components) — never log a spec that duplicates one already recorded, whether logged live or by a previous backfill.
- Call `dashboard_info` for the local server URL (used to POST in step 4).
- Walk the history: `git log --reverse --pretty='%H|%ct|%s'` for the full list; for substantial commits, `git show --stat <hash>` (and the diff when the message is vague) to understand what was actually built.

## 2. Distill

Extract only durable, requirement-shaped decisions — what the product must do or how it must behave — not mechanical changes (renames, bumps, fixes with no behavioral contract). One specification per requirement:

- `summary`: a single self-contained statement under 599 characters.
- `context`: the component it belongs to. Reuse the components already in use (from step 1) before inventing new ones.
- `deps`: other components it depends on, when the commit makes that clear.
- `t`: the commit's timestamp in ms epoch (`%ct` × 1000). If two commits share a second, offset each subsequent spec by +1 ms so every spec keeps a unique timestamp (feedback and annotations key on it).

## 3. Confirm

Show the user the proposed list — commit, component, summary — and let them prune or reword before anything is logged. Skip this only if the user explicitly said to proceed without review.

## 4. Log

POST each approved spec to the local server:

```
POST /api/events
{"type":"specification","summary":"…","context":"<component>","cwd":"<repo path>","t":<commit ms epoch>}
```

Then apply deps via `POST /api/specs/annotate {"spec":<t>,"deps":[…]}`.

## 5. Close

Report how many specs were backfilled per component, and point at the spec map and PRD page (component list) to review the result.
