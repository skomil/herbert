---
name: reconsider
description: Revisit disputed specifications — read the feedback set on the herbert dashboard (dispute, contentious, mildly agree, strongly agree, too much/little detail), delve into the implementation behind each disputed spec, and reconsider it with the user. Use when the user wants to revisit disputed or contentious specs, or reconsider implementation decisions that got dispute feedback.
---

# Reconsider disputed specifications

Specifications logged during sessions can be given feedback on the herbert dashboard via a combo box: `dispute`, `contentious`, `mildly agree`, `strongly agree`, `too much detail`, `too little detail`. This skill works through the contested ones and reconsiders the implementation they produced. Run it as a conversation — the feedback says the user doubts the decision, not what the answer should be.

## 1. Gather

- Call the `get_session_data` MCP tool with scope `all`. Each specification may carry a `feedback` field; collect the ones marked `dispute` (primary) and `contentious` (secondary). Prefer entries whose `repo` matches the current project.
- Also note the `strongly agree` / `mildly agree` specs: they are settled constraints — reconsidering a disputed spec must not quietly violate an agreed one.
- Ignore `too much detail` / `too little detail`: that is reporting-level calibration, applied automatically to new sessions by the herbert hook, not a dispute about the decision itself.
- If nothing is marked `dispute` or `contentious`, say so and stop; point out that feedback is set via the combo box on each specification in the dashboard.

## 2. Delve

For each disputed spec, in order (disputes first, oldest first):

- Find the implementation it drove. Use the spec's timestamp `t` and session to scope the search: `git log --since`/`--until` around that time, then grep for the code the spec describes. Read what was actually built, not just the diff.
- Reconstruct the tradeoff: what the spec asked for, what the implementation costs (complexity, coupling, performance, UX), and what the plausible alternatives were.

## 3. Reconsider

Present one spec at a time, briefly: what it said, what implements it (file:line), why it is worth disputing, and 2–3 concrete options — typically keep as-is, amend, or reverse — each with its tradeoff and your recommendation first (AskUserQuestion works well). React to answers; the user may re-affirm the spec, in which case suggest updating its feedback on the dashboard and move on.

## 4. Apply

Implement the agreed changes following the project's normal standards (tests that fail without the change, full check + test run). For each resolution, log the outcome: `log_correction` if the original approach was overturned, or `log_specification` if the reconsideration produced a new durable decision. Close with a one-line summary per spec of what was decided.
