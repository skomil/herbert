# Herbert — project notes for Claude

Claude Code plugin: local per-session analytics (OTel-fed dashboard), spec/correction logging (≤599-char summaries), and persisted session retros. TypeScript, ESM, zero runtime dependencies — everything runs on Node built-ins.

## Layout
- `src/server.ts` — shared local HTTP server: OTLP receiver (`/v1/metrics`, `/v1/logs`), REST API (`/api/*`), dashboard (`/`). One instance per machine (port 16300); leader election is just "who binds the port".
- `src/mcp.ts` — dependency-free MCP stdio server (tools: log_specification, log_correction, save_retro, get_session_data, dashboard_info).
- `src/store.ts` — append-only JSONL persistence under `~/.claude/herbert/`, replayed on start.
- `src/hook.ts` — SessionStart/SessionEnd hook: ensures the server is up, registers the session by `session_id` + parent pid (how MCP calls resolve their session).
- `.claude-plugin/`, `hooks/`, `commands/` — plugin wiring. `dist/` is committed; run `npm run build` after changing `src/`.

## Run commands
| Task | Command |
|---|---|
| Type check | `npm run check` |
| Tests | `npm test` |
| Build (required before the plugin picks up changes) | `npm run build` |
| Dev server (foreground, port 16300) | `npm run dev` |
| Run server manually | `node dist/server.js` (HERBERT_PORT / HERBERT_DATA_DIR / HERBERT_HOST override defaults) |

Dev notes: hooks and MCP always run from `dist/`, so rebuild after `src/` changes. `npm run dev` exits immediately if a server already owns the port — kill the running one first (`kill $(curl -s http://127.0.0.1:16300/health | jq .pid)`). The dashboard uses only relative URLs + hash routing, so it works behind any vhost or path-prefix proxy.

## Conventions
- **Don't read `.env*` files.** They may contain secrets. For env var *names*, check the README or config module; values stay out of the conversation.
- **Tests live alongside a flat, one-file-per-module convention** — `<module>.test.ts`. Don't mirror the source tree into deep subdirectories.

---

## Behavioral guidelines

Bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical changes

Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that *your* changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### 4. Goal-driven execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

### 5. Testing and verification standards

- Every behavior change ships with a test that fails without the change and passes with it.
- Run the full test suite and type check (`tsc --noEmit` or the project's check script) before declaring work done — passing tests plus a clean type check is the definition of done.
- Verify end-to-end, not just in tests: actually exercise the changed code path (run the CLI, hit the endpoint, render the component) when the change has a runtime surface.
- Report results faithfully: if tests fail, say so with the output; never claim verification that didn't happen.
- Don't weaken or delete a failing test to make it pass — fix the code, or flag the test if it's genuinely wrong.

### 6. SOLID principles

Follow SOLID when designing classes and modules. These are defaults, not dogma — when a principle and rule #2 (Simplicity first) conflict, simplicity wins for single-use code.

- **S — Single responsibility.** Each module, class, or function has one reason to change. If you find yourself writing "and" in the doc comment (`"parses input and writes to DB and sends email"`), split it.
- **O — Open/closed.** Open for extension, closed for modification. Adding a new variant shouldn't require editing unrelated existing code — extend via registration, discriminated unions, or new files, not by patching switch statements that already work.
- **L — Liskov substitution.** Subtypes must honor the contract of their base: any new implementation must work everywhere the base type works, without callers special-casing it.
- **I — Interface segregation.** Don't force callers to depend on methods they don't use. Prefer two small interfaces over one wide one.
- **D — Dependency inversion.** High-level code depends on abstractions, not concretions — inject dependencies (DB clients, services) rather than importing concrete implementations directly.

When SOLID would push you toward an abstraction that has only one implementation today, don't build it speculatively — wait until the second use case is real. Rule #2 outranks premature SOLID compliance.
