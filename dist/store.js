import fs from 'node:fs';
import path from 'node:path';
import { MAX_SUMMARY_CHARS } from './config.js';
export const SPEC_FEEDBACK = [
    'dispute',
    'contentious',
    'mildly agree',
    'strongly agree',
    'too much detail',
    'too little detail',
];
/**
 * A spec's position in the implementation lifecycle. An *absent* status means
 * the spec is implemented/complete; these three are the active (not-yet-done)
 * states shown as Kanban columns. 'proposed' also marks a user-added spec that
 * was never implemented, and is what a revision reopens a spec to.
 */
export const SPEC_STATUSES = ['proposed', 'ready', 'in_progress'];
const EVENTS_FILE = 'events.jsonl';
const SESSIONS_FILE = 'sessions.jsonl';
const OTEL_FILE = 'otel.jsonl';
const FEEDBACK_FILE = 'feedback.jsonl';
const ANNOTATIONS_FILE = 'annotations.jsonl';
const PRD_FILE = 'prd.jsonl';
const PREVIEW_FILE = 'previews.jsonl';
const SETTINGS_FILE = 'settings.json';
const RECENT_LIMIT = 200;
export function validateSummary(summary) {
    if (typeof summary !== 'string' || summary.trim().length === 0) {
        return 'summary must be a non-empty string';
    }
    if (summary.length > MAX_SUMMARY_CHARS) {
        return `summary is ${summary.length} characters; the limit is ${MAX_SUMMARY_CHARS}. Rewrite it more concisely.`;
    }
    return null;
}
export const DEFAULT_REPORT_WINDOW = {
    period: 'daily',
    weekday: 5,
    hour: 0,
    utcOffset: 0,
    costPerWindow: 0,
};
/** The `count` most recent report windows, newest first; the first is usually still in progress. */
export function reportWindows(cfg, now, count) {
    const HOUR = 3600_000;
    const DAY = 864e5;
    const len = cfg.period === 'weekly' ? 7 * DAY : DAY;
    const offset = cfg.utcOffset * HOUR;
    // shift into the configured offset so boundaries are plain modular arithmetic
    const local = now + offset;
    // ms from a period start to the anchor (the epoch, day 0, was a Thursday)
    const anchor = cfg.period === 'weekly'
        ? ((cfg.weekday - 4 + 7) % 7) * DAY + cfg.hour * HOUR
        : cfg.hour * HOUR;
    const start = Math.floor((local - anchor) / len) * len + anchor;
    return Array.from({ length: count }, (_, i) => ({
        from: start - i * len - offset,
        to: start - (i - 1) * len - offset,
    }));
}
/**
 * Standing instruction derived from "too much detail" / "too little detail"
 * feedback on past specifications. The SessionStart hook appends it to the
 * context of every new session, shifting the level future specs are logged at.
 */
export function specDetailGuidance(specs) {
    const tooMuch = specs.filter((s) => s.feedback === 'too much detail').length;
    const tooLittle = specs.filter((s) => s.feedback === 'too little detail').length;
    if (tooMuch === tooLittle)
        return '';
    return tooMuch > tooLittle
        ? `The user marked ${tooMuch} past specification(s) "too much detail": write specification summaries at a somewhat higher level — broader strokes, fewer specifics.`
        : `The user marked ${tooLittle} past specification(s) "too little detail": write specification summaries with somewhat more specifics — concrete values, names, and scope.`;
}
export class Store {
    dir;
    events = [];
    sessions = new Map();
    /** spec timestamp → feedback (last write wins) */
    specFeedback = new Map();
    /** spec timestamp → evolving classification (component/summary overrides, deps, status, revision, soft delete) */
    specAnnotations = new Map();
    /** PRD markdown per component; '' is the product summary (last write wins) */
    prdDocs = new Map();
    /** preview URL per session (its running app / preview server); last write wins */
    previewUrls = new Map();
    reportWindowCfg = { ...DEFAULT_REPORT_WINDOW };
    increments = [];
    eventRecords = [];
    agentRuns = [];
    /** last raw value per cumulative/gauge series, for delta conversion */
    lastBySeries = new Map();
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true });
        this.load();
    }
    file(name) {
        return path.join(this.dir, name);
    }
    appendLine(name, obj) {
        fs.appendFileSync(this.file(name), JSON.stringify(obj) + '\n');
    }
    readLines(name) {
        let raw;
        try {
            raw = fs.readFileSync(this.file(name), 'utf8');
        }
        catch {
            return [];
        }
        const out = [];
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            try {
                out.push(JSON.parse(line));
            }
            catch {
                // skip corrupt lines rather than failing the whole load
            }
        }
        return out;
    }
    load() {
        for (const e of this.readLines(EVENTS_FILE))
            this.events.push(e);
        for (const s of this.readLines(SESSIONS_FILE))
            this.mergeSession(s);
        for (const r of this.readLines(OTEL_FILE))
            this.applyOtel(r, false);
        for (const c of this.readLines(FEEDBACK_FILE))
            this.mergeFeedback(c);
        for (const a of this.readLines(ANNOTATIONS_FILE))
            this.mergeAnnotation(a);
        for (const p of this.readLines(PRD_FILE))
            this.mergePrdDoc(p);
        for (const p of this.readLines(PREVIEW_FILE))
            this.mergePreview(p);
        try {
            const s = JSON.parse(fs.readFileSync(this.file(SETTINGS_FILE), 'utf8'));
            if (s?.reportWindow)
                this.reportWindowCfg = { ...this.reportWindowCfg, ...s.reportWindow };
        }
        catch {
            // no settings saved yet
        }
    }
    reportWindow() {
        return { ...this.reportWindowCfg };
    }
    /** Standard-API-priced cost (USD) tracked between from and to. */
    costBetween(from, to) {
        let cost = 0;
        for (const m of this.increments) {
            if (m.name === 'claude_code.cost.usage' && m.t >= from && m.t <= to)
                cost += m.value;
        }
        return cost;
    }
    /** True if any telemetry or logged entry landed between from and to. */
    hasDataBetween(from, to) {
        const inR = (t) => t >= from && t <= to;
        return (this.increments.some((m) => inR(m.t)) ||
            this.eventRecords.some((e) => inR(e.t)) ||
            this.events.some((e) => inR(e.t)));
    }
    setReportWindow(patch) {
        this.reportWindowCfg = { ...this.reportWindowCfg, ...patch };
        fs.writeFileSync(this.file(SETTINGS_FILE), JSON.stringify({ reportWindow: this.reportWindowCfg }, null, 2));
        return this.reportWindow();
    }
    addEvent(e) {
        this.events.push(e);
        this.appendLine(EVENTS_FILE, e);
    }
    upsertSession(s) {
        this.mergeSession(s);
        this.appendLine(SESSIONS_FILE, s);
    }
    mergeSession(s) {
        if (!s?.sessionId)
            return;
        const existing = this.sessions.get(s.sessionId) ?? { sessionId: s.sessionId };
        this.sessions.set(s.sessionId, { ...existing, ...s });
    }
    /**
     * Save PRD markdown for a repo's component ('' component = that repo's product
     * summary; '' repo = the unassigned bucket for legacy docs). Empty markdown
     * deletes the doc. Docs are keyed by repo so two projects on one machine keep
     * separate PRDs.
     */
    setPrdDoc(repo, component, md) {
        const doc = { repo, component, md, t: Date.now() };
        this.mergePrdDoc(doc);
        this.appendLine(PRD_FILE, doc);
    }
    mergePrdDoc(doc) {
        if (typeof doc?.component !== 'string' || typeof doc.md !== 'string')
            return;
        // legacy docs written before repo-scoping have no repo → the unassigned bucket
        const repo = typeof doc.repo === 'string' ? doc.repo : '';
        const key = repo + '\x00' + doc.component;
        if (doc.md.trim())
            this.prdDocs.set(key, { md: doc.md, t: doc.t ?? 0 });
        else
            this.prdDocs.delete(key);
    }
    prd(repo = '') {
        const prefix = repo + '\x00';
        const components = {};
        let summary = null;
        for (const [k, v] of this.prdDocs) {
            if (!k.startsWith(prefix))
                continue;
            const component = k.slice(prefix.length);
            if (component)
                components[component] = v;
            else
                summary = v;
        }
        return { summary, components };
    }
    /** Repos that have PRD content (a doc or a spec), for the dashboard picker; '' = unassigned. */
    prdRepos() {
        const repos = new Set();
        for (const k of this.prdDocs.keys())
            repos.add(k.slice(0, k.indexOf('\x00')));
        for (const e of this.events)
            if (e.type === 'specification' && e.repo)
                repos.add(e.repo);
        return [...repos].sort();
    }
    /** Set (or clear, with empty url) the preview URL for a session — its running app / preview server. */
    setPreviewUrl(sessionId, url) {
        this.mergePreview({ sessionId, url });
        this.appendLine(PREVIEW_FILE, { sessionId, url });
    }
    previewUrl(sessionId) {
        return this.previewUrls.get(sessionId);
    }
    mergePreview(p) {
        if (typeof p?.sessionId !== 'string' || typeof p.url !== 'string')
            return;
        if (p.url)
            this.previewUrls.set(p.sessionId, p.url);
        else
            this.previewUrls.delete(p.sessionId);
    }
    /** A specification with its dashboard feedback and evolving annotations merged in. */
    annotated(e) {
        const f = this.specFeedback.get(e.t);
        const a = this.specAnnotations.get(e.t);
        if (!f && !a)
            return e;
        const out = { ...e };
        if (f)
            out.feedback = f;
        if (a?.context)
            out.context = a.context; // evolved classification wins over logged context
        if (a?.deps)
            out.deps = a.deps;
        if (a?.status)
            out.status = a.status;
        if (a?.summary)
            out.summary = a.summary; // proposed specs are editable in place
        if (a?.revision)
            out.revision = a.revision;
        return out;
    }
    /** Live specifications (annotations applied, soft-deleted excluded), for export; optionally scoped to one repo. */
    specs(repo) {
        return this.events
            .filter((e) => e.type === 'specification' && this.specAnnotations.get(e.t)?.deleted !== true)
            .filter((e) => repo === undefined || (e.repo ?? '') === repo)
            .map((e) => this.annotated(e));
    }
    /** Add a specification shared via herbert.json, assigned to the importing `repo`; skips (returns false) if one already exists at its timestamp. */
    importSpec(s, repo = '') {
        if (typeof s?.t !== 'number' || typeof s.summary !== 'string')
            return false;
        if (this.events.some((e) => e.type === 'specification' && e.t === s.t))
            return false;
        const event = { type: 'specification', sessionId: null, repo: repo || null, summary: s.summary, t: s.t };
        if (typeof s.context === 'string' && s.context)
            event.context = s.context;
        this.addEvent(event);
        const deps = Array.isArray(s.deps) ? s.deps.filter((d) => typeof d === 'string') : undefined;
        const status = SPEC_STATUSES.includes(s.status) ? s.status : undefined;
        // status/deps live in annotations so imported proposed specs stay editable in the receiving clone
        if (deps?.length || status)
            this.annotateSpec(s.t, { deps: deps ?? null, status: status ?? null });
        return true;
    }
    /** Set (or clear, with null) the feedback on the specification logged at specT. */
    setSpecFeedback(specT, feedback) {
        if (!this.events.some((e) => e.type === 'specification' && e.t === specT))
            return false;
        this.mergeFeedback({ spec: specT, feedback });
        this.appendLine(FEEDBACK_FILE, { spec: specT, feedback });
        return true;
    }
    mergeFeedback(c) {
        if (typeof c?.spec !== 'number')
            return;
        if (c.feedback)
            this.specFeedback.set(c.spec, c.feedback);
        else
            this.specFeedback.delete(c.spec);
    }
    /** True if the spec currently carries the proposed status (edit/remove are proposed-only). */
    isProposedSpec(specT) {
        return this.specAnnotations.get(specT)?.status === 'proposed';
    }
    /** Pending revision comment on a spec, if any. */
    specRevision(specT) {
        return this.specAnnotations.get(specT)?.revision;
    }
    /** Effective summary (annotation override, else the logged text); undefined if no such spec. */
    specEffectiveSummary(specT) {
        const e = this.events.find((x) => x.type === 'specification' && x.t === specT);
        if (!e)
            return undefined;
        return this.specAnnotations.get(specT)?.summary ?? e.summary;
    }
    /** Set or clear (null/empty) annotation fields on the spec logged at specT. */
    annotateSpec(specT, ann) {
        if (!this.events.some((e) => e.type === 'specification' && e.t === specT))
            return false;
        this.mergeAnnotation({ spec: specT, ...ann });
        this.appendLine(ANNOTATIONS_FILE, { spec: specT, ...ann });
        return true;
    }
    mergeAnnotation(a) {
        if (typeof a?.spec !== 'number')
            return;
        const cur = this.specAnnotations.get(a.spec) ?? {};
        if (a.context !== undefined) {
            if (a.context)
                cur.context = a.context;
            else
                delete cur.context;
        }
        if (a.deps !== undefined) {
            if (a.deps?.length)
                cur.deps = a.deps;
            else
                delete cur.deps;
        }
        if (a.status !== undefined) {
            if (a.status)
                cur.status = a.status;
            else
                delete cur.status;
        }
        if (a.summary !== undefined) {
            if (a.summary)
                cur.summary = a.summary;
            else
                delete cur.summary;
        }
        if (a.revision !== undefined) {
            if (a.revision)
                cur.revision = a.revision;
            else
                delete cur.revision;
        }
        if (a.deleted !== undefined) {
            if (a.deleted)
                cur.deleted = true;
            else
                delete cur.deleted;
        }
        if (Object.keys(cur).length)
            this.specAnnotations.set(a.spec, cur);
        else
            this.specAnnotations.delete(a.spec);
    }
    /** Latest-started session registered under a given Claude process pid. */
    resolveSessionByPid(pid) {
        let best;
        for (const s of this.sessions.values()) {
            if (s.pid !== pid)
                continue;
            if (!best || (s.startedAt ?? 0) > (best.startedAt ?? 0))
                best = s;
        }
        return best;
    }
    addOtel(records) {
        for (const r of records)
            this.applyOtel(r, true);
    }
    applyOtel(r, persist) {
        if (r.kind === 'metric')
            this.applyMetric(r);
        else if (r.kind === 'event')
            this.applyEvent(r);
        else
            return;
        if (persist)
            this.appendLine(OTEL_FILE, r);
    }
    applyMetric(r) {
        let inc = r.value;
        if (r.temporality !== 'delta') {
            // Convert cumulative/gauge to an increment against the last value seen
            // for this series; startTimeUnixNano separates process restarts.
            const attrKey = Object.keys(r.attrs)
                .sort()
                .map((k) => `${k}=${r.attrs[k]}`)
                .join(',');
            const key = `${r.name}|${r.start ?? ''}|${attrKey}`;
            const last = this.lastBySeries.get(key);
            inc = last === undefined || r.value < last ? r.value : r.value - last;
            this.lastBySeries.set(key, r.value);
        }
        if (inc === 0)
            return;
        this.increments.push({
            t: r.t,
            name: r.name,
            sid: r.attrs['session.id'] ?? 'unknown',
            type: r.attrs['type'] ?? 'total',
            model: r.attrs['model'],
            value: inc,
        });
    }
    applyEvent(r) {
        this.eventRecords.push({
            t: r.t,
            name: r.name,
            sid: r.attrs['session.id'] ?? 'unknown',
            tool: r.attrs['tool_name'] ?? r.attrs['name'],
            success: r.attrs['success'],
        });
        // Sub-agents share the parent's session.id; each completed run is reported
        // by its own event carrying the agent type and its resource usage.
        if (r.name === 'subagent_completed') {
            this.agentRuns.push({
                t: r.t,
                sid: r.attrs['session.id'] ?? 'unknown',
                type: r.attrs['agent_type'] ?? r.attrs['agent.name'] ?? 'unknown',
                tokens: Number(r.attrs['total_tokens']) || 0,
                toolUses: Number(r.attrs['total_tool_uses']) || 0,
                durationMs: Number(r.attrs['duration_ms']) || 0,
                model: r.attrs['model'],
            });
        }
    }
    summary(filter = {}) {
        const { from, to, sessionId } = filter;
        const inRange = (t) => (from === undefined || t >= from) && (to === undefined || t <= to);
        const wantSid = (sid) => sessionId === undefined || sid === sessionId;
        const perSession = new Map();
        const get = (sid) => {
            let s = perSession.get(sid);
            if (!s) {
                const info = this.sessions.get(sid);
                s = {
                    ...(info ?? {}),
                    sessionId: sid,
                    previewUrl: this.previewUrls.get(sid),
                    tokens: {},
                    cost: 0,
                    costByModel: {},
                    linesAdded: 0,
                    linesRemoved: 0,
                    activeTimeSec: 0,
                    commits: 0,
                    pullRequests: 0,
                    prompts: 0,
                    apiRequests: 0,
                    apiErrors: 0,
                    toolCalls: {},
                    agents: [],
                    specifications: [],
                    corrections: [],
                    retros: [],
                };
                perSession.set(sid, s);
            }
            return s;
        };
        // registered sessions whose lifetime overlaps the range appear even
        // before any telemetry arrives
        for (const info of this.sessions.values()) {
            if (!wantSid(info.sessionId))
                continue;
            const started = info.startedAt ?? 0;
            const ended = info.endedAt ?? Number.POSITIVE_INFINITY;
            if ((to === undefined || started <= to) && (from === undefined || ended >= from)) {
                get(info.sessionId);
            }
        }
        for (const m of this.increments) {
            if (!inRange(m.t) || !wantSid(m.sid))
                continue;
            const s = get(m.sid);
            switch (m.name) {
                case 'claude_code.token.usage':
                    s.tokens[m.type] = (s.tokens[m.type] ?? 0) + m.value;
                    break;
                case 'claude_code.cost.usage': {
                    s.cost += m.value;
                    const model = m.model ?? 'unknown';
                    s.costByModel[model] = (s.costByModel[model] ?? 0) + m.value;
                    break;
                }
                case 'claude_code.lines_of_code.count':
                    if (m.type === 'removed')
                        s.linesRemoved += m.value;
                    else
                        s.linesAdded += m.value;
                    break;
                case 'claude_code.active_time.total':
                    s.activeTimeSec += m.value;
                    break;
                case 'claude_code.commit.count':
                    s.commits += m.value;
                    break;
                case 'claude_code.pull_request.count':
                    s.pullRequests += m.value;
                    break;
            }
        }
        const recentEvents = [];
        for (const e of this.eventRecords) {
            if (!inRange(e.t) || !wantSid(e.sid))
                continue;
            const s = get(e.sid);
            switch (e.name) {
                case 'user_prompt':
                    s.prompts++;
                    break;
                case 'api_request':
                    s.apiRequests++;
                    break;
                case 'api_error':
                    s.apiErrors++;
                    break;
                case 'tool_result': {
                    const tc = (s.toolCalls[e.tool ?? 'unknown'] ??= { count: 0, errors: 0 });
                    tc.count++;
                    if (e.success === 'false')
                        tc.errors++;
                    break;
                }
            }
            recentEvents.push({ t: e.t, name: e.name, sessionId: e.sid, tool: e.tool });
            if (recentEvents.length > RECENT_LIMIT)
                recentEvents.shift();
        }
        for (const a of this.agentRuns) {
            if (!inRange(a.t) || !wantSid(a.sid))
                continue;
            get(a.sid).agents.push({
                type: a.type,
                tokens: a.tokens,
                toolUses: a.toolUses,
                durationMs: a.durationMs,
                model: a.model,
            });
        }
        const sessions = [...perSession.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
        const totals = sessions.reduce((acc, s) => {
            for (const [k, v] of Object.entries(s.tokens))
                acc.tokens[k] = (acc.tokens[k] ?? 0) + v;
            acc.cost += s.cost;
            for (const [k, v] of Object.entries(s.costByModel)) {
                acc.costByModel[k] = (acc.costByModel[k] ?? 0) + v;
            }
            acc.prompts += s.prompts;
            acc.linesAdded += s.linesAdded;
            acc.linesRemoved += s.linesRemoved;
            for (const [tool, tc] of Object.entries(s.toolCalls)) {
                const t = (acc.toolCalls[tool] ??= { count: 0, errors: 0 });
                t.count += tc.count;
                t.errors += tc.errors;
            }
            return acc;
        }, {
            tokens: {},
            cost: 0,
            costByModel: {},
            prompts: 0,
            linesAdded: 0,
            linesRemoved: 0,
            toolCalls: {},
        });
        const wantEvent = (e) => inRange(e.t) && wantSid(e.sessionId ?? 'unknown');
        const isDeleted = (e) => e.type === 'specification' && this.specAnnotations.get(e.t)?.deleted === true;
        for (const e of this.events) {
            if (!e.sessionId || !wantEvent(e) || isDeleted(e))
                continue;
            const s = get(e.sessionId);
            if (e.type === 'specification')
                s.specifications.push(this.annotated(e));
            else if (e.type === 'correction')
                s.corrections.push(e);
            else if (e.type === 'retro')
                s.retros.push(e);
        }
        return {
            generatedAt: Date.now(),
            filter: { from: from ?? null, to: to ?? null, sessionId: sessionId ?? null },
            sessionCount: sessions.length,
            sessions,
            totals,
            specifications: this.events
                .filter((e) => e.type === 'specification' && wantEvent(e) && !isDeleted(e))
                .map((e) => this.annotated(e)),
            corrections: this.events.filter((e) => e.type === 'correction' && wantEvent(e)),
            retros: this.events.filter((e) => e.type === 'retro' && wantEvent(e)),
            recentEvents: recentEvents.reverse(),
        };
    }
}
