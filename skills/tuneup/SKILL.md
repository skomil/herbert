---
name: tuneup
description: Tune up the project's CLAUDE.md — evaluate it against herbert's logged specifications, corrections, and retros, then hold a conversation with the user about concrete improvements and apply the agreed edits. Use when the user wants to tune up, review, or improve CLAUDE.md, or asks why the same corrections keep happening.
---

# CLAUDE.md tune-up

Run this as a conversation, not a report. The goal is a CLAUDE.md that prevents the problems herbert has actually recorded — not a rewrite for its own sake.

## 1. Gather evidence

- Call the `get_session_data` MCP tool with scope `all`. Prefer entries whose `repo` matches the current project (older entries may have no repo — include them if they plausibly belong here).
- Read the project's CLAUDE.md. If there is none, say so and offer to draft one from the evidence instead.

Look for, in order of value:

- **Repeated corrections** — the same redirect logged more than once means an instruction is missing, unclear, or being ignored.
- **Specifications that became durable** — requirements or constraints stated in sessions that belong in CLAUDE.md so they never need restating.
- **Retro `changeNext` items** — especially ones that recur across retros without improving.
- **Contradicted or stale instructions** — CLAUDE.md claims (commands, paths, conventions) that the evidence or the repo itself shows are wrong or unused.

## 2. Evaluate

Form a short list (3–6 items max) of proposed changes, each tied to evidence: add X (because corrections A and B), tighten Y (because it keeps being misread), delete Z (stale or never relevant). Skip anything speculative — no proposals without a logged event or repo fact behind them.

## 3. Converse

Present the recap in one paragraph, then go through proposals one at a time (AskUserQuestion works well: keep / reword / drop, with your suggested wording as the recommended option). React to answers — the user may know why an instruction exists; drop the proposal rather than argue. Ask if there's anything *they* keep having to repeat that the data missed.

## 4. Apply

Show the user the exact edits (old → new wording) for a final confirmation, then apply them to CLAUDE.md. Keep each instruction short and imperative; fold new items into existing sections rather than appending a new section per item. Close with a one-line summary of what changed and log it with `log_specification` (one summary statement for the tune-up as a whole, under 599 characters).
