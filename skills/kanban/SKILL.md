---
name: kanban
description: Work a session's specifications as a Kanban board on the herbert dashboard — view specs by status (Proposed → Ready to pick up → In progress → Complete), keep a spec's status in step with the work as you implement, add proposed specs, reopen completed specs, and attach revisions. Use when the user wants to see or organize the spec board, triage or pick up specs, mark work in progress or done, or plan a session's specs as a board.
---

# Work the spec Kanban board

Each session's logged specifications render as a Kanban board on the dashboard, scoped to one session and reached from the session drill-down (`#session=<id>&view=kanban`). Columns are lifecycle statuses; the user drags cards between them, adds proposed specs in the first column, and reopens/revises specs. Your job is to **keep the board honest as you work** and to help organize it on request.

## Statuses (the columns)

- **Proposed** — a not-yet-implemented idea (user- or agent-added). `status: "proposed"`.
- **Ready to pick up** — triaged, ready to implement. `status: "ready"`.
- **In progress** — actively being implemented right now. `status: "in_progress"`.
- **Complete** — implemented. Status is *absent* (empty). The Complete column can be hidden with the board's "Hide complete" toggle.

## The workflow rule — keep status in step with the work

- When you **start implementing** a spec, move it to **in_progress** (from proposed/ready). Don't leave actively-worked specs in ready.
- When the work — including any **revision** attached to the card — is **done**, move it to **complete**. Don't mark it complete prematurely.
- A **revision** is a new requirement the user attaches to a spec; it reopens the spec. Treat a pending revision as work to do, implement it, then complete the spec (completing folds the revision text into the summary).

## How to act on the board

Get the server's base URL from the `dashboard_info` MCP tool (default `http://127.0.0.1:16300`). Then use its REST API:

- **Read** the session's specs and their status: `GET /api/summary?session=<sessionId>` → `specifications[]`, each with `t` (its timestamp id), `status`, `context`, `summary`, `revision`.
- **Move a spec** between columns: `POST /api/specs/annotate` with `{ "spec": <t>, "status": "proposed" | "ready" | "in_progress" | "" }` (empty string = Complete/implemented).
- **Add a proposed spec** tied to the session: `POST /api/events` with `{ "type": "specification", "summary": "…", "status": "proposed", "context": "<component>", "sessionId": "<sessionId>", "cwd": "<repo path>" }`. (The board's Proposed column also has an "Add proposed spec" form the user can use directly.)
- **Attach a revision** (reopens the spec): `POST /api/specs/annotate` with `{ "spec": <t>, "revision": "…" }`.
- **Reopen a completed spec**: move it back to an active column (set its `status`), or attach a revision.

## Notes

- The board is **per-session**: it shows only the specs belonging to that session id. Specs are logged with the `log_specification` MCP tool during work; those default to Complete (they describe what was just built) and can be reopened here.
- Resolve the current session id from `CLAUDE_CODE_SESSION_ID`, or the `get_session_data` tool's `currentSessionId`.
- Mirror board completion on any corresponding Ayvee/todo task, but only the user confirms a task truly complete — set it to pending confirmation, not complete, unless told otherwise.
