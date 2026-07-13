import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { MAX_SUMMARY_CHARS, VERSION, dataDir, host, port } from './config.js';
import { dashboardHtml } from './dashboard.js';
import { isHerbertUp } from './ensure.js';
import { parseLogs, parseMetrics } from './otlp.js';
import { SPEC_FEEDBACK, Store, reportWindows, validateSummary, } from './store.js';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const EVENT_TYPES = ['specification', 'correction', 'retro'];
const MAX_PRD_CHARS = 50_000;
function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(data);
}
const CSV_COLUMNS = [
    'session_id', 'project', 'started', 'ended', 'prompts', 'tool_calls',
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens',
    'cost_usd', 'lines_added', 'lines_removed', 'active_time_sec', 'commits', 'pull_requests',
];
function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Per-session usage rows plus a TOTAL row, in CSV_COLUMNS order (Excel-compatible). */
function usageCsv(summary) {
    const iso = (t) => (t ? new Date(t).toISOString() : '');
    const rows = summary.sessions.map((s) => {
        const tok = (k) => s.tokens[k] ?? 0;
        const toolCalls = Object.values(s.toolCalls).reduce((a, c) => a + c.count, 0);
        const totalTokens = Object.values(s.tokens).reduce((a, b) => a + b, 0);
        return [
            s.sessionId, s.cwd ?? '', iso(s.startedAt), iso(s.endedAt), s.prompts, toolCalls,
            tok('input'), tok('output'), tok('cacheRead'), tok('cacheCreation'), totalTokens,
            s.cost.toFixed(4), s.linesAdded, s.linesRemoved, s.activeTimeSec, s.commits, s.pullRequests,
        ];
    });
    if (rows.length) {
        const sum = (i) => rows.reduce((a, r) => a + Number(r[i]), 0);
        rows.push([
            'TOTAL', '', '', '',
            ...CSV_COLUMNS.slice(4).map((_, j) => (j + 4 === 11 ? sum(11).toFixed(4) : sum(j + 4))),
        ]);
    }
    return [CSV_COLUMNS, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}
export function startServer(p = port(), dir = dataDir()) {
    const store = new Store(dir);
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const route = `${req.method} ${url.pathname}`;
        try {
            switch (route) {
                case 'GET /health':
                    return json(res, 200, { service: 'herbert', version: VERSION, pid: process.pid });
                case 'GET /':
                    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                    return res.end(dashboardHtml());
                case 'GET /api/summary': {
                    const num = (k) => {
                        const v = url.searchParams.get(k);
                        const n = Number(v);
                        return v && Number.isFinite(n) ? n : undefined;
                    };
                    return json(res, 200, store.summary({
                        from: num('from'),
                        to: num('to'),
                        sessionId: url.searchParams.get('session') ?? undefined,
                    }));
                }
                case 'GET /api/prd':
                    return json(res, 200, store.prd());
                case 'POST /api/prd': {
                    const body = JSON.parse(await readBody(req));
                    const component = body.component ?? '';
                    if (typeof component !== 'string' || component.length > MAX_SUMMARY_CHARS) {
                        return json(res, 400, { error: 'component must be a string (empty for the product summary)' });
                    }
                    if (typeof body.md !== 'string' || body.md.length > MAX_PRD_CHARS) {
                        return json(res, 400, { error: `md must be a markdown string under ${MAX_PRD_CHARS + 1} characters` });
                    }
                    store.setPrdDoc(component, body.md);
                    return json(res, 200, { ok: true });
                }
                case 'GET /api/prd/export': {
                    const prd = store.prd();
                    const out = {
                        version: 1,
                        summary: prd.summary?.md ?? null,
                        components: Object.fromEntries(Object.entries(prd.components).map(([k, v]) => [k, v.md])),
                        // full specs (proposed included) travel with the repo so a clone starts with the spec map
                        specifications: store.specs().map((s) => ({
                            t: s.t,
                            summary: s.summary,
                            ...(s.context ? { context: s.context } : {}),
                            ...(s.deps?.length ? { deps: s.deps } : {}),
                            ...(s.status ? { status: s.status } : {}),
                        })),
                    };
                    res.writeHead(200, {
                        'content-type': 'application/json',
                        'content-disposition': 'attachment; filename="herbert.json"',
                    });
                    return res.end(JSON.stringify(out, null, 2) + '\n');
                }
                case 'POST /api/prd/import': {
                    const body = JSON.parse(await readBody(req));
                    const fill = body.mode === 'fill'; // fill = only add docs that don't exist locally
                    const docs = [];
                    if (body.summary !== undefined && body.summary !== null) {
                        if (typeof body.summary !== 'string')
                            return json(res, 400, { error: 'summary must be a string' });
                        docs.push(['', body.summary]);
                    }
                    if (body.components !== undefined) {
                        if (typeof body.components !== 'object' || body.components === null || Array.isArray(body.components)) {
                            return json(res, 400, { error: 'components must be an object mapping name to markdown' });
                        }
                        for (const [k, v] of Object.entries(body.components)) {
                            if (typeof v !== 'string')
                                return json(res, 400, { error: `component "${k}" must map to a markdown string` });
                            docs.push([k, v]);
                        }
                    }
                    const existing = store.prd();
                    const has = (k) => (k === '' ? !!existing.summary : k in existing.components);
                    let imported = 0;
                    for (const [k, v] of docs) {
                        if (v.length > MAX_PRD_CHARS) {
                            return json(res, 400, { error: `doc "${k || 'summary'}" exceeds ${MAX_PRD_CHARS} characters` });
                        }
                        if (fill && has(k))
                            continue;
                        store.setPrdDoc(k, v);
                        imported++;
                    }
                    // specs are keyed by timestamp and always deduped, regardless of mode — never duplicated
                    let importedSpecs = 0;
                    if (body.specifications !== undefined) {
                        if (!Array.isArray(body.specifications)) {
                            return json(res, 400, { error: 'specifications must be an array' });
                        }
                        for (const s of body.specifications)
                            if (store.importSpec(s))
                                importedSpecs++;
                    }
                    return json(res, 200, { ok: true, imported, importedSpecs });
                }
                case 'GET /api/report-window': {
                    const config = store.reportWindow();
                    const windows = reportWindows(config, Date.now(), 26).map((w) => ({
                        ...w,
                        hasData: store.hasDataBetween(w.from, w.to),
                        cost: store.costBetween(w.from, w.to),
                    }));
                    // pid lets the page detect a server restart and reload itself for fresh UI code
                    return json(res, 200, { config, windows, pid: process.pid });
                }
                case 'POST /api/report-window': {
                    const body = JSON.parse(await readBody(req));
                    const patch = {};
                    if (body.period !== undefined) {
                        if (body.period !== 'daily' && body.period !== 'weekly') {
                            return json(res, 400, { error: 'period must be "daily" or "weekly"' });
                        }
                        patch.period = body.period;
                    }
                    for (const [k, lo, hi] of [['weekday', 0, 6], ['hour', 0, 23], ['utcOffset', -12, 14]]) {
                        if (body[k] === undefined)
                            continue;
                        if (!Number.isInteger(body[k]) || body[k] < lo || body[k] > hi) {
                            return json(res, 400, { error: `${k} must be an integer between ${lo} and ${hi}` });
                        }
                        patch[k] = body[k];
                    }
                    if (body.costPerWindow !== undefined) {
                        if (typeof body.costPerWindow !== 'number' || !Number.isFinite(body.costPerWindow) || body.costPerWindow < 0) {
                            return json(res, 400, { error: 'costPerWindow must be a non-negative number (USD)' });
                        }
                        patch.costPerWindow = body.costPerWindow;
                    }
                    return json(res, 200, { ok: true, config: store.setReportWindow(patch) });
                }
                case 'GET /api/report.csv': {
                    const n = (k) => {
                        const v = url.searchParams.get(k);
                        const x = Number(v);
                        return v && Number.isFinite(x) ? x : undefined;
                    };
                    const from = n('from');
                    const to = n('to');
                    if (from === undefined || to === undefined) {
                        return json(res, 400, { error: 'from and to (ms epoch) are required' });
                    }
                    res.writeHead(200, {
                        'content-type': 'text/csv; charset=utf-8',
                        'content-disposition': `attachment; filename="herbert-usage-${new Date(from).toISOString().slice(0, 10)}.csv"`,
                    });
                    return res.end(usageCsv(store.summary({ from, to })));
                }
                case 'GET /api/resolve-session': {
                    const pid = Number(url.searchParams.get('pid'));
                    const session = Number.isInteger(pid) ? store.resolveSessionByPid(pid) : undefined;
                    return json(res, 200, { session: session ?? null });
                }
                case 'POST /v1/metrics': {
                    store.addOtel(parseMetrics(JSON.parse(await readBody(req))));
                    return json(res, 200, {});
                }
                case 'POST /v1/logs': {
                    store.addOtel(parseLogs(JSON.parse(await readBody(req))));
                    return json(res, 200, {});
                }
                case 'POST /v1/traces':
                    await readBody(req); // accepted and discarded
                    return json(res, 200, {});
                case 'POST /api/events': {
                    const body = JSON.parse(await readBody(req));
                    if (!EVENT_TYPES.includes(body.type)) {
                        return json(res, 400, { error: `type must be one of: ${EVENT_TYPES.join(', ')}` });
                    }
                    const invalid = validateSummary(body.summary);
                    if (invalid)
                        return json(res, 400, { error: invalid });
                    const sections = {};
                    if (body.type === 'retro') {
                        for (const k of ['whatWorked', 'whatDidnt', 'changeNext']) {
                            if (body[k] === undefined)
                                continue;
                            const bad = validateSummary(body[k]);
                            if (bad)
                                return json(res, 400, { error: `${k}: ${bad}` });
                            sections[k] = body[k];
                        }
                    }
                    if (body.type === 'specification' && body.context !== undefined) {
                        const bad = validateSummary(body.context);
                        if (bad)
                            return json(res, 400, { error: `context: ${bad}` });
                        sections.context = body.context;
                    }
                    let sessionId = body.sessionId ?? null;
                    let repo = typeof body.cwd === 'string' && body.cwd ? body.cwd : null;
                    if (!sessionId && Number.isInteger(body.pid)) {
                        const session = store.resolveSessionByPid(body.pid);
                        sessionId = session?.sessionId ?? null;
                        repo ??= session?.cwd ?? null;
                    }
                    if (body.status !== undefined && (body.status !== 'proposed' || body.type !== 'specification')) {
                        return json(res, 400, { error: "status may only be 'proposed', on specifications" });
                    }
                    // an explicit past timestamp is allowed so history backfills keep an honest timeline
                    const t = Number.isFinite(body.t) && body.t > 0 && body.t <= Date.now() ? body.t : Date.now();
                    const event = { type: body.type, sessionId, repo, summary: body.summary, ...sections, t };
                    store.addEvent(event);
                    if (body.status === 'proposed')
                        store.annotateSpec(t, { status: 'proposed' });
                    return json(res, 200, { ok: true, event });
                }
                case 'POST /api/specs/feedback': {
                    const body = JSON.parse(await readBody(req));
                    if (!Number.isFinite(body.spec)) {
                        return json(res, 400, { error: 'spec (the specification timestamp) is required' });
                    }
                    const feedback = (body.feedback || null);
                    if (feedback !== null && !SPEC_FEEDBACK.includes(feedback)) {
                        return json(res, 400, {
                            error: `feedback must be one of: ${SPEC_FEEDBACK.join(', ')} (or empty to clear)`,
                        });
                    }
                    if (!store.setSpecFeedback(body.spec, feedback)) {
                        return json(res, 404, { error: 'no specification logged at that timestamp' });
                    }
                    return json(res, 200, { ok: true });
                }
                case 'POST /api/specs/annotate': {
                    const body = JSON.parse(await readBody(req));
                    if (!Number.isFinite(body.spec)) {
                        return json(res, 400, { error: 'spec (the specification timestamp) is required' });
                    }
                    const ann = {};
                    if (body.revision !== undefined) {
                        if (typeof body.revision !== 'string' || body.revision.length > MAX_SUMMARY_CHARS) {
                            return json(res, 400, { error: `revision must be a string under ${MAX_SUMMARY_CHARS + 1} characters` });
                        }
                        ann.revision = body.revision.trim() || null;
                        if (ann.revision)
                            ann.status = 'proposed'; // a revision reopens the spec
                    }
                    if (body.summary !== undefined || body.deleted !== undefined) {
                        if (!store.isProposedSpec(body.spec)) {
                            return json(res, 400, { error: 'only proposed specs can be edited or removed' });
                        }
                    }
                    if (body.summary !== undefined) {
                        const bad = validateSummary(body.summary);
                        if (bad)
                            return json(res, 400, { error: `summary: ${bad}` });
                        ann.summary = body.summary;
                    }
                    if (body.deleted !== undefined)
                        ann.deleted = body.deleted === true;
                    if (body.status !== undefined) {
                        if (body.status !== 'proposed' && body.status !== '' && body.status !== null) {
                            return json(res, 400, { error: "status must be 'proposed', or empty to mark implemented" });
                        }
                        ann.status = body.status || null;
                    }
                    // implementing a spec with a pending revision folds the revision into the summary
                    if (ann.status === null && body.status !== undefined) {
                        const pending = store.specRevision(body.spec);
                        if (pending) {
                            const base = store.specEffectiveSummary(body.spec) ?? '';
                            ann.summary = `${base} — Revised: ${pending}`.slice(0, MAX_SUMMARY_CHARS);
                            ann.revision = null;
                        }
                    }
                    if (body.context !== undefined) {
                        if (typeof body.context !== 'string' || body.context.length > MAX_SUMMARY_CHARS) {
                            return json(res, 400, { error: `context must be a string under ${MAX_SUMMARY_CHARS + 1} characters` });
                        }
                        ann.context = body.context.trim() || null;
                    }
                    if (body.deps !== undefined) {
                        if (!Array.isArray(body.deps) || body.deps.some((x) => typeof x !== 'string')) {
                            return json(res, 400, { error: 'deps must be an array of component names' });
                        }
                        const deps = body.deps.map((x) => x.trim()).filter(Boolean);
                        if (deps.length > 20)
                            return json(res, 400, { error: 'at most 20 deps per spec' });
                        ann.deps = deps.length ? deps : null;
                    }
                    if (!store.annotateSpec(body.spec, ann)) {
                        return json(res, 404, { error: 'no specification logged at that timestamp' });
                    }
                    return json(res, 200, { ok: true });
                }
                case 'POST /api/sessions': {
                    const body = JSON.parse(await readBody(req));
                    if (typeof body.sessionId !== 'string' || !body.sessionId) {
                        return json(res, 400, { error: 'sessionId is required' });
                    }
                    store.upsertSession(body);
                    return json(res, 200, { ok: true });
                }
                default:
                    return json(res, 404, { error: 'not found' });
            }
        }
        catch (err) {
            return json(res, 400, { error: err?.message ?? 'bad request' });
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, host(), () => {
            server.removeListener('error', reject);
            resolve({
                server,
                store,
                port: p,
                close: () => new Promise((r, x) => server.close((e) => (e ? x(e) : r()))),
            });
        });
    });
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    startServer()
        .then((running) => {
        console.log(`herbert server listening on http://${host()}:${running.port} (data: ${dataDir()})`);
    })
        .catch(async (err) => {
        if (err?.code === 'EADDRINUSE') {
            // Lost the leader race (or a server is already up): become a client.
            if (await isHerbertUp())
                process.exit(0);
            console.error(`herbert: port ${port()} is taken by another process`);
            process.exit(1);
        }
        console.error('herbert server failed to start:', err);
        process.exit(1);
    });
}
