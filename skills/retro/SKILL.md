---
name: retro
description: Run an interactive session retrospective — interview the user about what worked and what didn't, grounded in herbert's persisted analytics, then persist the structured feedback. Use when the user wants to run a retro, reflect on the session, or give feedback on how the working session went.
---

# Session retro interview

Run this as a conversation, not a form. Ask one question at a time and react to the answers.

## 1. Gather context

Call the `get_session_data` MCP tool (scope `current`; scope `all` if the user wants a broader review). Note before you start interviewing:

- This session's analytics: prompts, tool calls (and failures), tokens, cost.
- Specifications and corrections logged this session — each correction marks a moment the approach had to be redirected; these are your best interview material.
- Past retros — especially their `changeNext` items.

## 2. Interview

Open with a one-paragraph recap of the session from the data (what was worked on, notable numbers, corrections that happened). Then interview the user, one question at a time, adapting to what they say (use AskUserQuestion where it helps, with concrete options drawn from the session data):

1. **What worked?** Offer your own hypothesis from the data as a starting point, but let the user confirm or override.
2. **What didn't work?** Bring up specific logged corrections and tool failures and ask whether they point at something systematic.
3. **Follow-through:** if past retros had `changeNext` items, ask whether they actually improved this session.
4. **What should change next time?** Push for something concrete and actionable, not "communicate better".

Keep it short — 3 to 5 questions total. If the user gives a rich first answer, don't re-ask what's already covered.

## 2b. Classify specs (only when needed)

While the data is in front of you, check this session's specifications' `context` (component) fields. If new components surfaced this session, or a spec has no component / an ambiguous one, ask the user where it belongs — one AskUserQuestion with the known components as options works well. Apply answers by POSTing to the local server (URL from `dashboard_info`):

```
POST /api/specs/annotate  {"spec": <spec t>, "context": "<component>", "deps": ["<component>", …]}
```

Skip this step entirely when every spec is already sensibly classified — it's an assist, not a ritual.

## 3. Persist

Distill the interview into summary statements, **each under 599 characters**:

- `whatWorked` — from question 1
- `whatDidnt` — from question 2
- `changeNext` — from question 4 (fold in question 3's verdict on past items)
- `summary` — the overall takeaway in one or two sentences

Show the user the four statements for a quick confirmation, adjust if asked, then call the `save_retro` MCP tool with all four fields. Close by mentioning the retro is on the dashboard (use `dashboard_info` for the URL).

## 4. Sync the repo PRD

After saving, check whether the repo keeps its PRD in-tree (a `herbert.json` at the repo root). If it does, refresh it so the PRD update rides the next commit: fetch `GET /api/prd/export` from the local server (URL from `dashboard_info`) and overwrite `herbert.json` with the response. Say that the file changed and offer to commit it — do not commit without the user's go-ahead. If there is no `herbert.json`, offer once to create it; skip silently if the user has declined before.
