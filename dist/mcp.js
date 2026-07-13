/**
 * Dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Exposes herbert's logging/retro tools to the Claude session. Every tool
 * call first ensures the shared local server is running (spawning it if
 * this is the only session), then talks to it over HTTP — the server is
 * the single writer to the persisted data.
 */
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { MAX_SUMMARY_CHARS, VERSION, baseUrl } from './config.js';
import { ensureServer } from './ensure.js';
const SERVER_PATH = new URL('./server.js', import.meta.url).pathname;
const summaryInput = (what, extra = {}) => ({
    type: 'object',
    properties: {
        summary: {
            type: 'string',
            maxLength: MAX_SUMMARY_CHARS,
            description: `${what} Must be a single self-contained summary statement under ${MAX_SUMMARY_CHARS + 1} characters.`,
        },
        ...extra,
    },
    required: ['summary'],
});
export const TOOLS = [
    {
        name: 'log_specification',
        description: 'Record a specification the user stated (a requirement, decision, or constraint) as it happens. Distill what was provided into one summary statement, with a short context naming the part of the system it concerns.',
        inputSchema: summaryInput('The specification, condensed from what the user provided.', {
            context: {
                type: 'string',
                maxLength: MAX_SUMMARY_CHARS,
                description: "Short label for the part of the system the specification concerns, shown before it on the dashboard — e.g. 'session page' or 'MCP server'.",
            },
        }),
    },
    {
        name: 'log_correction',
        description: 'Record a correction the user made (redirected the approach, fixed a misunderstanding, adjusted output) as it happens. Distill what was provided into one summary statement.',
        inputSchema: summaryInput('The correction, condensed from what the user provided.'),
    },
    {
        name: 'save_retro',
        description: 'Persist the outcome of a session retrospective interview. Takes an overall summary plus optional structured sections (what worked, what did not, what to change next time), each a summary statement distilled from user feedback.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: {
                    type: 'string',
                    maxLength: MAX_SUMMARY_CHARS,
                    description: `Overall retro takeaway, under ${MAX_SUMMARY_CHARS + 1} characters.`,
                },
                whatWorked: {
                    type: 'string',
                    maxLength: MAX_SUMMARY_CHARS,
                    description: 'What worked well this session, distilled from the user interview.',
                },
                whatDidnt: {
                    type: 'string',
                    maxLength: MAX_SUMMARY_CHARS,
                    description: 'What did not work or caused friction, distilled from the user interview.',
                },
                changeNext: {
                    type: 'string',
                    maxLength: MAX_SUMMARY_CHARS,
                    description: 'What to change next session, distilled from the user interview.',
                },
            },
            required: ['summary'],
        },
    },
    {
        name: 'get_prd',
        description: 'Fetch the product requirements document: the product summary, per-component requirements (markdown written on the dashboard PRD page), and the logged specifications grouped by component. Call this before beginning work so the product context is understood.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'get_session_data',
        description: 'Fetch persisted herbert data for a retro or review: analytics per session (tokens, cost, tool usage, prompts), plus all logged specifications, corrections, and past retros. scope "current" limits analytics to this session.',
        inputSchema: {
            type: 'object',
            properties: {
                scope: { type: 'string', enum: ['current', 'all'], description: 'Default: current' },
            },
        },
    },
    {
        name: 'dashboard_info',
        description: 'Get the URL of the local herbert analytics dashboard (starting the server if needed).',
        inputSchema: { type: 'object', properties: {} },
    },
];
function text(s, isError = false) {
    return { content: [{ type: 'text', text: s }], isError: isError || undefined };
}
async function api(path, init) {
    const res = await fetch(`${baseUrl()}${path}`, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(body?.error ?? `server returned ${res.status}`);
    return body;
}
/**
 * Session id of the Claude process that spawned this MCP server. Preferred
 * over pid resolution: hooks may run behind a shell wrapper, so the pid the
 * hook registers is not always the pid MCP tool calls see as their parent.
 */
const envSessionId = () => process.env.CLAUDE_CODE_SESSION_ID || undefined;
async function postEvent(type, summary, sections = {}) {
    for (const [field, value] of [['summary', summary], ...Object.entries(sections)]) {
        if (value === undefined)
            continue;
        if (typeof value !== 'string' || !value.trim()) {
            return text(`Error: ${field} must be a non-empty string.`, true);
        }
        if (value.length > MAX_SUMMARY_CHARS) {
            return text(`Error: ${field} is ${value.length} characters; the limit is ${MAX_SUMMARY_CHARS}. Rewrite it more concisely and try again.`, true);
        }
    }
    const result = await api('/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            type,
            summary,
            ...sections,
            sessionId: envSessionId(),
            pid: process.ppid,
            cwd: process.cwd(),
        }),
    });
    return text(`Logged ${type} (session ${result.event.sessionId ?? 'unknown'}).`);
}
async function getPrd() {
    const [prd, summary] = await Promise.all([api('/api/prd'), api('/api/summary')]);
    const byComp = {};
    for (const s of summary.specifications ?? []) {
        const c = s.context || 'general';
        (byComp[c] ??= []).push(s.summary);
    }
    const parts = ['# Product summary', prd.summary?.md ?? '(no product summary written yet)'];
    const comps = [...new Set([...Object.keys(prd.components), ...Object.keys(byComp)])];
    for (const c of comps) {
        parts.push(`\n## Component: ${c}`);
        if (prd.components[c])
            parts.push('### Requirements\n' + prd.components[c].md);
        if (byComp[c])
            parts.push('### Specifications\n' + byComp[c].map((s) => `- ${s}`).join('\n'));
    }
    return text(parts.join('\n'));
}
async function getSessionData(scope) {
    const summary = await api('/api/summary');
    if (scope !== 'all') {
        let sid = envSessionId();
        if (!sid) {
            const resolved = await api(`/api/resolve-session?pid=${process.ppid}`);
            sid = resolved.session?.sessionId;
        }
        if (sid) {
            summary.sessions = summary.sessions.filter((s) => s.sessionId === sid);
            summary.specifications = summary.specifications.filter((e) => e.sessionId === sid);
            summary.corrections = summary.corrections.filter((e) => e.sessionId === sid);
            summary.currentSessionId = sid;
            // retros are intentionally left unfiltered: past retros are the point of a retro
        }
    }
    delete summary.recentEvents;
    return text(JSON.stringify(summary, null, 2));
}
export async function callTool(name, args) {
    const ensured = await ensureServer(SERVER_PATH);
    if (ensured === 'failed') {
        return text(`Error: could not start or reach the herbert server at ${baseUrl()}.`, true);
    }
    switch (name) {
        case 'log_specification':
            return postEvent('specification', args.summary, { context: args.context });
        case 'log_correction':
            return postEvent('correction', args.summary);
        case 'save_retro':
            return postEvent('retro', args.summary, {
                whatWorked: args.whatWorked,
                whatDidnt: args.whatDidnt,
                changeNext: args.changeNext,
            });
        case 'get_prd':
            return getPrd();
        case 'get_session_data':
            return getSessionData(typeof args.scope === 'string' ? args.scope : 'current');
        case 'dashboard_info':
            return text(`herbert dashboard: ${baseUrl()} (server ${ensured})`);
        default:
            return text(`Error: unknown tool "${name}".`, true);
    }
}
export async function handleRequest(msg) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
        case 'initialize':
            return reply({
                protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'herbert', version: VERSION },
            });
        case 'tools/list':
            return reply({ tools: TOOLS });
        case 'tools/call':
            try {
                return reply(await callTool(msg.params?.name, msg.params?.arguments ?? {}));
            }
            catch (err) {
                return reply(text(`Error: ${err?.message ?? err}`, true));
            }
        case 'ping':
            return reply({});
        default:
            if (msg.id === undefined)
                return null; // notification — no response
            return {
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32601, message: `method not found: ${msg.method}` },
            };
    }
}
export function serveStdio() {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', async (line) => {
        if (!line.trim())
            return;
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            return;
        }
        const response = await handleRequest(msg);
        if (response)
            process.stdout.write(JSON.stringify(response) + '\n');
    });
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain)
    serveStdio();
