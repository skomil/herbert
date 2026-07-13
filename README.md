# herbert

A self-contained Claude Code plugin for local session analytics and continuous improvement:

- **Analytics dashboard** — captures the OpenTelemetry metrics and logs Claude Code emits (tokens, cost, prompts, tool usage, lines changed) and shows them per session at http://127.0.0.1:16300.
- **Specification & correction logging** — MCP tools let Claude record requirements and course-corrections as they happen, each distilled into a summary statement under 599 characters, tagged with the component it concerns.
- **Spec feedback & classification** — every spec on the dashboard gets a feedback combo box (dispute / contentious / mildly agree / strongly agree / too much detail / too little detail), an editable component, and dependencies. Detail feedback automatically recalibrates how future specs are written; disputes feed the `reconsider` skill.
- **Spec map** — a clickable DAG (repo → component → spec, with dependency edges) that doubles as a filter. Users can also add *proposed* specs — requirements not yet implemented — and mark them implemented later.
- **Product requirements (PRD)** — a PRD page with an editable product summary and per-component requirements in markdown, exportable/importable as a `herbert.json` you can commit to the repo. Claude loads it via the `get_prd` tool before starting work.
- **Usage reports** — a configurable recurring window (daily or weekly, anchored to a weekday/hour/UTC offset, e.g. your Claude plan's reset schedule) with per-window CSV export and an API-cost-vs-plan-cost comparison.
- **Session retros** — `/herbert:retro` runs an interactive interview about what worked and what didn't, grounded in the session's data and past retros, and persists the structured feedback.
- **CLAUDE.md tune-ups** — `/herbert:tuneup` evaluates the project's CLAUDE.md against the logged specifications, corrections, and retros, then walks through proposed improvements in conversation and applies the agreed edits.
- **History backfill** — `/herbert:backfill` distills specifications from past git commits and logs them with the commit's timestamp.
- **Persistent** — everything is stored as append-only JSONL under `~/.claude/herbert/` and survives across sessions and restarts.

## How it works

Every Claude session runs a `SessionStart` hook that probes `http://127.0.0.1:16300/health`. If no herbert server is running, that session spawns one (detached, so it outlives the session) and becomes the server; every other session detects it and acts as a client. Races are resolved by the port bind. The server is the single writer: OTLP ingestion, MCP tool calls, and the dashboard all go through it.

## Install

Add the marketplace (a local checkout or the git URL both work), then install:

```
/plugin marketplace add /path/to/herbert     # or: /plugin marketplace add <git-url>
/plugin install herbert@herbert
```

Then run `/herbert:setup` once — it adds the OTel export env vars to `~/.claude/settings.json` (Claude Code only emits telemetry when they're set at startup):

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:16300",
    "OTEL_METRIC_EXPORT_INTERVAL": "10000",
    "OTEL_LOGS_EXPORT_INTERVAL": "5000"
  }
}
```

New sessions after that will stream telemetry to the dashboard.

## Commands & tools

| Surface | Name | Purpose |
|---|---|---|
| command | `/herbert:setup` | Enable OTel export to the local server |
| command | `/herbert:dashboard` | Get/open the dashboard URL |
| skill | `/herbert:retro` | Run the retro interview and persist the outcome; also offers to classify specs whose component is missing or unclear |
| skill | `/herbert:tuneup` | Evaluate CLAUDE.md against logged specs/corrections/retros and improve it through an interactive conversation |
| skill | `/herbert:reconsider` | Revisit specs the user marked `dispute`/`contentious`: delve into the implementation each one drove and reconsider it together |
| skill | `/herbert:backfill` | Distill specifications from past git commits (classified by component, logged at the commit's timestamp) |
| MCP tool | `log_specification` | Record a stated requirement/decision (≤599 chars) with a component context |
| MCP tool | `log_correction` | Record a user correction/redirect (≤599 chars) |
| MCP tool | `save_retro` | Persist a retro: overall summary + optional whatWorked / whatDidnt / changeNext (each ≤599 chars) |
| MCP tool | `get_prd` | Product summary + per-component requirements + specs, for loading context before starting work |
| MCP tool | `get_session_data` | Fetch analytics + specs/corrections/retros for review |
| MCP tool | `dashboard_info` | Dashboard URL (starts the server if needed) |

## Configuration

| Env var | Default | |
|---|---|---|
| `HERBERT_PORT` | `16300` | Port for the shared server (dashboard + OTLP + API) |
| `HERBERT_DATA_DIR` | `~/.claude/herbert` | Where JSONL data files live |

## Dashboard views

- **Overall** — the sessions table (click a row to drill in), stat tiles, tool usage, cost by model, tokens by session, and the logged corrections and retros.
- **Per session** — a session's own numbers and entries, plus a session-level feedback box that applies to all of its specs at once. `← All sessions` goes back.
- **Range filter** — the top bar is the definitive report setup: configure the recurring window (daily/weekly, weekday, hour, UTC offset, plan $ per window), then filter by All time / Current period / Last period / any earlier period that has data. The selected period is downloadable as CSV.
- **PRD & specs page** (`PRD & specs →` in the top bar) — product summary, components, the spec map, and every specification in one place; see below.

View state lives in the URL hash (`#range=current&session=<id>`, `#view=prd&pcomp=<component>`, …), so views are bookmarkable.

## Product requirements (PRD)

The PRD & specs page holds an editable **product summary**, **requirements per component** (markdown, edited in place), the **spec map**, and the filterable **specifications list**. Components come from spec classifications; click one to see its requirements and every spec logged for it, and to propose new specs there.

- **Spec map** — a graph with two relationship types: solid *contains* edges (repo → component → spec) and dashed *depends* edges. Toggle spec nodes and dependency edges on/off; with specs hidden, dependencies aggregate to component → component arcs. The map obeys the same filters as the list below it, and clicking a node applies that node as the filter.
- **Specs list** — filterable by component and *proposed only*. Each spec carries a feedback combo box, editable component / deps / revision inputs, and (while proposed) *mark implemented*, *edit*, and *remove* buttons. Adding a **revision comment** to any spec reopens it as proposed; when it's marked implemented again the revision folds into the spec text.

- **Proposed specs** — anyone can add a spec that is *not yet implemented* (from the PRD page); it appears with a `proposed` badge and a dashed node in the spec map until marked implemented, and can be edited or removed while proposed.
- **Export / import** — `Export herbert.json` downloads the PRD; `Import herbert.json` loads one (overwriting docs present in the file). The format is `{"version": 1, "summary": "<markdown>", "components": {"<name>": "<markdown>"}}`.
- **Commit it** — keep `herbert.json` at the repo root to share the PRD with everyone who works on the project. The SessionStart hook imports it automatically in *fill* mode: docs you don't have locally are added, docs you've already written are never overwritten.
- Claude reads all of this through the `get_prd` MCP tool before starting work.

## Usage reports

Configure the window in the top bar to match how you think about usage — e.g. weekly on Fridays at 16:00 UTC-5 to line up with a Claude plan reset, or daily at midnight GMT. Each period with data can be exported as CSV (per-session rows + totals: prompts, tool calls, tokens by type, cost, lines changed, active time). Set **plan $/window** to what you actually pay and the dashboard adds an API-cost-vs-plan table showing the dollar difference per window at standard API pricing.

## Running behind a proxy / vhost

The dashboard only uses **relative URLs** (resolved against `document.baseURI`) and hash-based routing, so you can front it with any reverse proxy — a dedicated vhost (`herbert.local` → `127.0.0.1:16300`) or a path prefix (`/herbert/` → `127.0.0.1:16300/`; keep the trailing slash on the prefix). No configuration needed on the herbert side. The server binds `127.0.0.1` by default; set `HERBERT_HOST=0.0.0.0` if the proxy lives on another interface.

## Development

Zero runtime dependencies; dev dependencies are TypeScript and Vitest.

```
npm install
npm test          # unit + integration tests
npm run check     # type check
npm run build     # compile src/ → dist/ (the plugin runs from dist/)
npm run dev       # build then run the server in the foreground on port 16300
```

Dev-mode tips:

- The plugin (hooks and MCP tools) always runs from `dist/`, so rebuild after changing `src/`.
- Run against scratch state to keep real data clean: `HERBERT_PORT=17300 HERBERT_DATA_DIR=/tmp/herbert-dev npm run dev`.
- If a detached herbert server already owns the port, `npm run dev` exits immediately (it detects the running leader). Stop it first: `kill $(curl -s http://127.0.0.1:16300/health | jq .pid)`.

## License

MIT — see [LICENSE](LICENSE).
