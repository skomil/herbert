/**
 * SessionStart / SessionEnd hook entry point (dist/hook.js start|end).
 * Registers the session with the shared herbert server (spawning it if
 * this is the only Claude session — leader election lives in ensure.ts).
 * process.ppid is the Claude process, which lets MCP tool calls from the
 * same session (also children of that process) resolve their session id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { baseUrl } from './config.js';
import { ensureServer } from './ensure.js';
import { specDetailGuidance } from './store.js';
const SERVER_PATH = new URL('./server.js', import.meta.url).pathname;
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}
async function main() {
    const phase = process.argv[2] === 'end' ? 'end' : 'start';
    let input = {};
    try {
        input = JSON.parse(await readStdin());
    }
    catch {
        // no/invalid stdin — still make sure the server is up
    }
    const ensured = await ensureServer(SERVER_PATH);
    if (ensured === 'failed') {
        console.error(`herbert: could not start or reach the server at ${baseUrl()}`);
        process.exit(0); // never block the session over analytics
    }
    const sessionId = input.session_id;
    if (typeof sessionId === 'string' && sessionId) {
        const body = { sessionId, pid: process.ppid, cwd: input.cwd };
        if (phase === 'start') {
            body.startedAt = Date.now();
            body.source = input.source;
        }
        else {
            body.endedAt = Date.now();
        }
        await fetch(`${baseUrl()}/api/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }).catch(() => { });
    }
    if (phase === 'start' && typeof input.cwd === 'string' && input.cwd) {
        // a repo can ship its PRD as herbert.json; docs missing locally are imported automatically
        try {
            const prd = JSON.parse(fs.readFileSync(path.join(input.cwd, 'herbert.json'), 'utf8'));
            await fetch(`${baseUrl()}/api/prd/import`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ...prd, mode: 'fill' }),
            });
        }
        catch {
            // no herbert.json (the usual case) or unreadable — never block the session
        }
    }
    if (phase === 'start') {
        // "too much/little detail" feedback on past specs shifts the level new specs are logged at
        let guidance = '';
        try {
            const summary = await (await fetch(`${baseUrl()}/api/summary`)).json();
            guidance = specDetailGuidance(summary.specifications ?? []);
        }
        catch {
            // no guidance beats a blocked session
        }
        // Surface the dashboard to the session as context.
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: `herbert analytics ${ensured === 'started' ? 'server started (this session is the server)' : 'server already running (this session is a client)'}; dashboard at ${baseUrl()}. ` +
                    'Call the get_prd tool before beginning work to load the product summary and per-component requirements. As the session runs: when the user states a requirement, decision, or constraint, record it with the log_specification tool, passing a short context naming the part of the system it concerns (e.g. "session page", "MCP server"); when the user corrects or redirects your approach, record it with log_correction. Each takes one summary statement under 599 characters distilled from what was provided.' +
                    (guidance ? ' ' + guidance : ''),
            },
        }));
    }
}
main().then(() => process.exit(0));
