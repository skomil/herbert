---
name: kanban
description: Work a session's specifications as a Kanban board on the herbert dashboard — view specs by status (Proposed → Ready to pick up → In progress → Complete), track the planning/implementing/verifying sub-stage of in-progress specs, keep a spec's status in step with the work as you implement, add specs at the right status, reopen completed specs, and attach revisions. Use when the user wants to see or organize the spec board, triage or pick up specs, mark work in progress or done, advance an in-progress spec's stage, or plan a session's specs as a board.
---

# Work the spec Kanban board

Each session's logged specifications render as a Kanban board on the dashboard, scoped to one session and reached from the session drill-down (`#session=<id>&view=kanban`). Columns are lifecycle statuses; the user drags cards between them, adds proposed specs in the first column, and reopens/revises specs. Your job is to **keep the board honest as you work** and to help organize it on request.

## Statuses (the columns)

- **Proposed** — a not-yet-implemented idea (user- or agent-added). `status: "proposed"`.
- **Ready to pick up** — triaged, ready to implement. `status: "ready"`.
- **In progress** — actively being implemented right now. `status: "in_progress"`. In-progress specs carry a **sub-stage** shown as pills on the card (see below).
- **Complete** — implemented. `status: "complete"`. The Complete column can be hidden with the board's "Hide complete" toggle.

Every spec **always** has an explicit status — there is no statusless spec. (Legacy specs with no stored status display as Complete.)

### In-progress sub-stages

An `in_progress` spec always has a **stage**, advanced by clicking its pill on the card or via the API:

- **planning** — working out the approach (the default when a spec enters in_progress).
- **implementing** — writing the code.
- **verifying** — testing / checking the change.

The stage exists **only** while the spec is in_progress; moving the spec to any other column clears it, so a card's stage can never disagree with its status.

## The workflow rule — keep status and stage in step with the work

- **Log a spec at its real status.** When you log a spec for work you're about to start or are doing, log it **in_progress** from the start — don't let it default to Complete. Pass `status` (and optionally `stage`) to `log_specification`, or use the API below.
- When you **start implementing** an existing spec, move it to **in_progress** (from proposed/ready). Don't leave actively-worked specs in ready.
- As the work moves, **advance the stage**: planning → implementing → verifying.
- When the work — including any **revision** attached to the card — is **done**, move it to **complete**. Don't mark it complete prematurely.
- A **revision** is a new requirement the user attaches to a spec; it reopens the spec. Treat a pending revision as work to do, implement it, then complete the spec (completing folds the revision text into the summary).

## How to act on the board

Get the server's base URL from the `dashboard_info` MCP tool (default `http://127.0.0.1:16300`). Then use its REST API:

- **Read** the session's specs: `GET /api/summary?session=<sessionId>` → `specifications[]`, each with `t` (its timestamp id), `status`, `stage` (present only while in_progress), `context`, `summary`, `revision`.
- **Move a spec** between columns: `POST /api/specs/annotate` with `{ "spec": <t>, "status": "proposed" | "ready" | "in_progress" | "complete" }`.
- **Set the stage** of an in_progress spec: `POST /api/specs/annotate` with `{ "spec": <t>, "stage": "planning" | "implementing" | "verifying" }`.
- **Log a spec at a chosen status/stage**: `log_specification` with `{ summary, context, status, stage }` — or `POST /api/events` with `{ "type": "specification", "summary": "…", "status": "in_progress", "stage": "implementing", "context": "<component>", "sessionId": "<sessionId>", "cwd": "<repo path>" }`. (The board's Proposed column also has an "Add proposed spec" form the user can use directly.)
- **Attach a revision** (reopens the spec): `POST /api/specs/annotate` with `{ "spec": <t>, "revision": "…" }`.
- **Reopen a completed spec**: move it back to an active column (set its `status`), or attach a revision.

## Notes

- The board is **per-session**: it shows only the specs belonging to that session id. Log specs with the `log_specification` MCP tool during work — pass a `status` (and `stage`) so a spec you're actively working lands in the right column instead of defaulting to Complete.
- Resolve the current session id from `CLAUDE_CODE_SESSION_ID`, or the `get_session_data` tool's `currentSessionId`.
- Mirror board completion on any corresponding Ayvee/todo task, but only the user confirms a task truly complete — set it to pending confirmation, not complete, unless told otherwise.
