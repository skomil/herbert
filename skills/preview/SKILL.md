---
name: preview
description: Expose the running app/preview for the current Claude Code session as an "Open ↗" link on the herbert dashboard by setting the session's preview URL via the set_preview_url MCP tool. Use when you start a dev/preview server for the user, when the user asks to preview or open the running implementation, wants a live preview link for this session, or wants to check the running work periodically.
---

# Set the session's preview link

Herbert shows a per-session **Preview** link on the dashboard session page. Each session has its own preview URL, so parallel sessions that each run their own preview server don't collide. The URL is set **only** through the `set_preview_url` MCP tool — the dashboard displays it read-only.

Use this whenever there is a running thing worth opening: a dev server you launched (`npm run dev`, `vite`, a temporary `node server.js`, a notebook, a deployed preview), so the user can pop it open while you work.

## Do this

1. **Get the URL of the running preview.** It must be reachable over http(s) — e.g. `http://localhost:3000`, `http://127.0.0.1:16399`, or a deployed `https://…` URL. If you just started the server, use the port it bound. If nothing is running yet, start it first (or ask the user for the URL); don't invent one.
2. **Register it:** call the `set_preview_url` MCP tool with `{ "url": "<the running URL>" }`. It resolves the current session automatically and attaches the URL to it.
3. **Confirm:** the tool echoes the URL it set. It now appears as **Open ↗** on that session's page in the dashboard (get the dashboard URL from `dashboard_info` if needed).

## Notes

- Only http(s) URLs are accepted (the server rejects `javascript:`/`data:` since it renders the URL as a link).
- Pass an **empty string** (`{ "url": "" }`) to clear the link when the preview server is gone, so the page doesn't show a dead link.
- Re-call the tool to update the URL when you restart the preview on a different port. The link always reflects the last value set for this session.
- One session, one preview URL: if you spin up several preview servers in a session, point the link at the one the user should look at now.
