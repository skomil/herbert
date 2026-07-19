import fs from 'node:fs';
import path from 'node:path';
import { MAX_SUMMARY_CHARS } from './config.js';
import type { EventRecord, MetricRecord, OtelRecord } from './otlp.js';

export type SummaryEventType = 'specification' | 'correction' | 'retro';

export const SPEC_FEEDBACK = [
  'dispute',
  'contentious',
  'mildly agree',
  'strongly agree',
  'too much detail',
  'too little detail',
] as const;
export type SpecFeedback = (typeof SPEC_FEEDBACK)[number];

/**
 * A spec's position in the implementation lifecycle. An *absent* status means
 * the spec is implemented/complete; these three are the active (not-yet-done)
 * states shown as Kanban columns. 'proposed' also marks a user-added spec that
 * was never implemented, and is what a revision reopens a spec to.
 */
export const SPEC_STATUSES = ['proposed', 'ready', 'in_progress'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

export interface SummaryEvent {
  type: SummaryEventType;
  sessionId: string | null;
  /** working directory the event was logged from */
  repo?: string | null;
  summary: string;
  /** structured retro sections, each subject to the same 599-char cap */
  whatWorked?: string;
  whatDidnt?: string;
  changeNext?: string;
  /** feedback set from the dashboard combo box (specifications only) */
  feedback?: SpecFeedback;
  /** short label for the part of the system a specification concerns */
  context?: string;
  /** components this specification depends on (dashboard-set, specifications only) */
  deps?: string[];
  /** active lifecycle state; absent = implemented/complete (dashboard-set, specifications only) */
  status?: SpecStatus;
  /** pending revision comment; reopens the spec until re-implemented (specifications only) */
  revision?: string;
  t: number; // ms epoch
}

export interface SessionInfo {
  sessionId: string;
  pid?: number;
  cwd?: string;
  source?: string;
  startedAt?: number;
  endedAt?: number;
}

/** A metric datapoint normalized to a delta increment at time t. */
interface MetricIncrement {
  t: number;
  name: string;
  sid: string;
  type: string;
  model?: string;
  value: number;
}

interface EvRec {
  t: number;
  name: string;
  sid: string;
  tool?: string;
  success?: string;
}

/** One completed sub-agent run within a session, from a `subagent_completed` event. */
export interface AgentRun {
  type: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
  model?: string;
}

/** An AgentRun with the session and time it belongs to, kept in the flat store. */
type AgentRunRec = AgentRun & { t: number; sid: string };

export interface SummaryFilter {
  from?: number;
  to?: number;
  sessionId?: string;
}

export interface SessionSummary extends SessionInfo {
  sessionId: string;
  tokens: Record<string, number>;
  cost: number;
  /** USD per model; the keys are the models used in the session */
  costByModel: Record<string, number>;
  linesAdded: number;
  linesRemoved: number;
  activeTimeSec: number;
  commits: number;
  pullRequests: number;
  prompts: number;
  apiRequests: number;
  apiErrors: number;
  toolCalls: Record<string, { count: number; errors: number }>;
  /** sub-agent runs (Explore, general-purpose, …) that ran under this session */
  agents: AgentRun[];
  /** configured preview URL for this session's repo (its running app), if any */
  previewUrl?: string;
  specifications: SummaryEvent[];
  corrections: SummaryEvent[];
  retros: SummaryEvent[];
}

const EVENTS_FILE = 'events.jsonl';
const SESSIONS_FILE = 'sessions.jsonl';
const OTEL_FILE = 'otel.jsonl';
const FEEDBACK_FILE = 'feedback.jsonl';
const ANNOTATIONS_FILE = 'annotations.jsonl';
const PRD_FILE = 'prd.jsonl';
const PREVIEW_FILE = 'previews.jsonl';
const SETTINGS_FILE = 'settings.json';
const RECENT_LIMIT = 200;

export function validateSummary(summary: unknown): string | null {
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    return 'summary must be a non-empty string';
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    return `summary is ${summary.length} characters; the limit is ${MAX_SUMMARY_CHARS}. Rewrite it more concisely.`;
  }
  return null;
}

/**
 * Recurring report window, settable to line up with the user's Claude
 * account usage-reset schedule (e.g. weekly on Fridays at 16:00 EST).
 */
export interface ReportWindowConfig {
  period: 'daily' | 'weekly';
  /** 0 (Sunday) – 6 (Saturday); used when period is weekly */
  weekday: number;
  /** boundary hour 0–23, in the configured offset */
  hour: number;
  /** fixed UTC offset in hours the boundary is anchored to, e.g. -5 for EST, 0 for GMT */
  utcOffset: number;
  /** what the user actually pays per window (e.g. a subscription slice), USD; 0 = unset */
  costPerWindow: number;
}

export const DEFAULT_REPORT_WINDOW: ReportWindowConfig = {
  period: 'daily',
  weekday: 5,
  hour: 0,
  utcOffset: 0,
  costPerWindow: 0,
};

/** The `count` most recent report windows, newest first; the first is usually still in progress. */
export function reportWindows(
  cfg: ReportWindowConfig,
  now: number,
  count: number,
): Array<{ from: number; to: number }> {
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
export function specDetailGuidance(specs: Array<{ feedback?: string }>): string {
  const tooMuch = specs.filter((s) => s.feedback === 'too much detail').length;
  const tooLittle = specs.filter((s) => s.feedback === 'too little detail').length;
  if (tooMuch === tooLittle) return '';
  return tooMuch > tooLittle
    ? `The user marked ${tooMuch} past specification(s) "too much detail": write specification summaries at a somewhat higher level — broader strokes, fewer specifics.`
    : `The user marked ${tooLittle} past specification(s) "too little detail": write specification summaries with somewhat more specifics — concrete values, names, and scope.`;
}

export class Store {
  private events: SummaryEvent[] = [];
  private sessions = new Map<string, SessionInfo>();
  /** spec timestamp → feedback (last write wins) */
  private specFeedback = new Map<number, SpecFeedback>();
  /** spec timestamp → evolving classification (component/summary overrides, deps, status, revision, soft delete) */
  private specAnnotations = new Map<
    number,
    { context?: string; deps?: string[]; status?: SpecStatus; summary?: string; revision?: string; deleted?: true }
  >();
  /** PRD markdown per component; '' is the product summary (last write wins) */
  private prdDocs = new Map<string, { md: string; t: number }>();
  /** preview URL per session (its running app / preview server); last write wins */
  private previewUrls = new Map<string, string>();
  private reportWindowCfg: ReportWindowConfig = { ...DEFAULT_REPORT_WINDOW };
  private increments: MetricIncrement[] = [];
  private eventRecords: EvRec[] = [];
  private agentRuns: AgentRunRec[] = [];
  /** last raw value per cumulative/gauge series, for delta conversion */
  private lastBySeries = new Map<string, number>();

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private appendLine(name: string, obj: unknown): void {
    fs.appendFileSync(this.file(name), JSON.stringify(obj) + '\n');
  }

  private readLines(name: string): any[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(name), 'utf8');
    } catch {
      return [];
    }
    const out: any[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip corrupt lines rather than failing the whole load
      }
    }
    return out;
  }

  private load(): void {
    for (const e of this.readLines(EVENTS_FILE)) this.events.push(e);
    for (const s of this.readLines(SESSIONS_FILE)) this.mergeSession(s);
    for (const r of this.readLines(OTEL_FILE)) this.applyOtel(r, false);
    for (const c of this.readLines(FEEDBACK_FILE)) this.mergeFeedback(c);
    for (const a of this.readLines(ANNOTATIONS_FILE)) this.mergeAnnotation(a);
    for (const p of this.readLines(PRD_FILE)) this.mergePrdDoc(p);
    for (const p of this.readLines(PREVIEW_FILE)) this.mergePreview(p);
    try {
      const s = JSON.parse(fs.readFileSync(this.file(SETTINGS_FILE), 'utf8'));
      if (s?.reportWindow) this.reportWindowCfg = { ...this.reportWindowCfg, ...s.reportWindow };
    } catch {
      // no settings saved yet
    }
  }

  reportWindow(): ReportWindowConfig {
    return { ...this.reportWindowCfg };
  }

  /** Standard-API-priced cost (USD) tracked between from and to. */
  costBetween(from: number, to: number): number {
    let cost = 0;
    for (const m of this.increments) {
      if (m.name === 'claude_code.cost.usage' && m.t >= from && m.t <= to) cost += m.value;
    }
    return cost;
  }

  /** True if any telemetry or logged entry landed between from and to. */
  hasDataBetween(from: number, to: number): boolean {
    const inR = (t: number) => t >= from && t <= to;
    return (
      this.increments.some((m) => inR(m.t)) ||
      this.eventRecords.some((e) => inR(e.t)) ||
      this.events.some((e) => inR(e.t))
    );
  }

  setReportWindow(patch: Partial<ReportWindowConfig>): ReportWindowConfig {
    this.reportWindowCfg = { ...this.reportWindowCfg, ...patch };
    fs.writeFileSync(
      this.file(SETTINGS_FILE),
      JSON.stringify({ reportWindow: this.reportWindowCfg }, null, 2),
    );
    return this.reportWindow();
  }

  addEvent(e: SummaryEvent): void {
    this.events.push(e);
    this.appendLine(EVENTS_FILE, e);
  }

  upsertSession(s: SessionInfo): void {
    this.mergeSession(s);
    this.appendLine(SESSIONS_FILE, s);
  }

  private mergeSession(s: SessionInfo): void {
    if (!s?.sessionId) return;
    const existing = this.sessions.get(s.sessionId) ?? { sessionId: s.sessionId };
    this.sessions.set(s.sessionId, { ...existing, ...s });
  }

  /**
   * Save PRD markdown for a repo's component ('' component = that repo's product
   * summary; '' repo = the unassigned bucket for legacy docs). Empty markdown
   * deletes the doc. Docs are keyed by repo so two projects on one machine keep
   * separate PRDs.
   */
  setPrdDoc(repo: string, component: string, md: string): void {
    const doc = { repo, component, md, t: Date.now() };
    this.mergePrdDoc(doc);
    this.appendLine(PRD_FILE, doc);
  }

  private mergePrdDoc(doc: { repo?: unknown; component?: unknown; md?: unknown; t?: number }): void {
    if (typeof doc?.component !== 'string' || typeof doc.md !== 'string') return;
    // legacy docs written before repo-scoping have no repo → the unassigned bucket
    const repo = typeof doc.repo === 'string' ? doc.repo : '';
    const key = repo + '\x00' + doc.component;
    if (doc.md.trim()) this.prdDocs.set(key, { md: doc.md, t: doc.t ?? 0 });
    else this.prdDocs.delete(key);
  }

  prd(repo = ''): { summary: { md: string; t: number } | null; components: Record<string, { md: string; t: number }> } {
    const prefix = repo + '\x00';
    const components: Record<string, { md: string; t: number }> = {};
    let summary: { md: string; t: number } | null = null;
    for (const [k, v] of this.prdDocs) {
      if (!k.startsWith(prefix)) continue;
      const component = k.slice(prefix.length);
      if (component) components[component] = v;
      else summary = v;
    }
    return { summary, components };
  }

  /** Repos that have PRD content (a doc or a spec), for the dashboard picker; '' = unassigned. */
  prdRepos(): string[] {
    const repos = new Set<string>();
    for (const k of this.prdDocs.keys()) repos.add(k.slice(0, k.indexOf('\x00')));
    for (const e of this.events) if (e.type === 'specification' && e.repo) repos.add(e.repo);
    return [...repos].sort();
  }

  /** Set (or clear, with empty url) the preview URL for a session — its running app / preview server. */
  setPreviewUrl(sessionId: string, url: string): void {
    this.mergePreview({ sessionId, url });
    this.appendLine(PREVIEW_FILE, { sessionId, url });
  }

  previewUrl(sessionId: string): string | undefined {
    return this.previewUrls.get(sessionId);
  }

  private mergePreview(p: { sessionId?: unknown; url?: unknown }): void {
    if (typeof p?.sessionId !== 'string' || typeof p.url !== 'string') return;
    if (p.url) this.previewUrls.set(p.sessionId, p.url);
    else this.previewUrls.delete(p.sessionId);
  }

  /** A specification with its dashboard feedback and evolving annotations merged in. */
  private annotated(e: SummaryEvent): SummaryEvent {
    const f = this.specFeedback.get(e.t);
    const a = this.specAnnotations.get(e.t);
    if (!f && !a) return e;
    const out = { ...e };
    if (f) out.feedback = f;
    if (a?.context) out.context = a.context; // evolved classification wins over logged context
    if (a?.deps) out.deps = a.deps;
    if (a?.status) out.status = a.status;
    if (a?.summary) out.summary = a.summary; // proposed specs are editable in place
    if (a?.revision) out.revision = a.revision;
    return out;
  }

  /** Live specifications (annotations applied, soft-deleted excluded), for export; optionally scoped to one repo. */
  specs(repo?: string): SummaryEvent[] {
    return this.events
      .filter((e) => e.type === 'specification' && this.specAnnotations.get(e.t)?.deleted !== true)
      .filter((e) => repo === undefined || (e.repo ?? '') === repo)
      .map((e) => this.annotated(e));
  }

  /** Add a specification shared via herbert.json, assigned to the importing `repo`; skips (returns false) if one already exists at its timestamp. */
  importSpec(
    s: { t?: unknown; summary?: unknown; context?: unknown; deps?: unknown; status?: unknown },
    repo = '',
  ): boolean {
    if (typeof s?.t !== 'number' || typeof s.summary !== 'string') return false;
    if (this.events.some((e) => e.type === 'specification' && e.t === s.t)) return false;
    const event: SummaryEvent = { type: 'specification', sessionId: null, repo: repo || null, summary: s.summary, t: s.t };
    if (typeof s.context === 'string' && s.context) event.context = s.context;
    this.addEvent(event);
    const deps = Array.isArray(s.deps) ? s.deps.filter((d): d is string => typeof d === 'string') : undefined;
    const status = SPEC_STATUSES.includes(s.status as SpecStatus) ? (s.status as SpecStatus) : undefined;
    // status/deps live in annotations so imported proposed specs stay editable in the receiving clone
    if (deps?.length || status) this.annotateSpec(s.t, { deps: deps ?? null, status: status ?? null });
    return true;
  }

  /** Set (or clear, with null) the feedback on the specification logged at specT. */
  setSpecFeedback(specT: number, feedback: SpecFeedback | null): boolean {
    if (!this.events.some((e) => e.type === 'specification' && e.t === specT)) return false;
    this.mergeFeedback({ spec: specT, feedback });
    this.appendLine(FEEDBACK_FILE, { spec: specT, feedback });
    return true;
  }

  private mergeFeedback(c: { spec?: number; feedback?: SpecFeedback | null }): void {
    if (typeof c?.spec !== 'number') return;
    if (c.feedback) this.specFeedback.set(c.spec, c.feedback);
    else this.specFeedback.delete(c.spec);
  }

  /** True if the spec currently carries the proposed status (edit/remove are proposed-only). */
  isProposedSpec(specT: number): boolean {
    return this.specAnnotations.get(specT)?.status === 'proposed';
  }

  /** Pending revision comment on a spec, if any. */
  specRevision(specT: number): string | undefined {
    return this.specAnnotations.get(specT)?.revision;
  }

  /** Effective summary (annotation override, else the logged text); undefined if no such spec. */
  specEffectiveSummary(specT: number): string | undefined {
    const e = this.events.find((x) => x.type === 'specification' && x.t === specT);
    if (!e) return undefined;
    return this.specAnnotations.get(specT)?.summary ?? e.summary;
  }

  /** Set or clear (null/empty) annotation fields on the spec logged at specT. */
  annotateSpec(
    specT: number,
    ann: {
      context?: string | null;
      deps?: string[] | null;
      status?: SpecStatus | null;
      summary?: string | null;
      revision?: string | null;
      deleted?: boolean;
    },
  ): boolean {
    if (!this.events.some((e) => e.type === 'specification' && e.t === specT)) return false;
    this.mergeAnnotation({ spec: specT, ...ann });
    this.appendLine(ANNOTATIONS_FILE, { spec: specT, ...ann });
    return true;
  }

  private mergeAnnotation(a: {
    spec?: number;
    context?: string | null;
    deps?: string[] | null;
    status?: SpecStatus | null;
    summary?: string | null;
    revision?: string | null;
    deleted?: boolean;
  }): void {
    if (typeof a?.spec !== 'number') return;
    const cur = this.specAnnotations.get(a.spec) ?? {};
    if (a.context !== undefined) {
      if (a.context) cur.context = a.context;
      else delete cur.context;
    }
    if (a.deps !== undefined) {
      if (a.deps?.length) cur.deps = a.deps;
      else delete cur.deps;
    }
    if (a.status !== undefined) {
      if (a.status) cur.status = a.status;
      else delete cur.status;
    }
    if (a.summary !== undefined) {
      if (a.summary) cur.summary = a.summary;
      else delete cur.summary;
    }
    if (a.revision !== undefined) {
      if (a.revision) cur.revision = a.revision;
      else delete cur.revision;
    }
    if (a.deleted !== undefined) {
      if (a.deleted) cur.deleted = true;
      else delete cur.deleted;
    }
    if (Object.keys(cur).length) this.specAnnotations.set(a.spec, cur);
    else this.specAnnotations.delete(a.spec);
  }

  /** Latest-started session registered under a given Claude process pid. */
  resolveSessionByPid(pid: number): SessionInfo | undefined {
    let best: SessionInfo | undefined;
    for (const s of this.sessions.values()) {
      if (s.pid !== pid) continue;
      if (!best || (s.startedAt ?? 0) > (best.startedAt ?? 0)) best = s;
    }
    return best;
  }

  addOtel(records: OtelRecord[]): void {
    for (const r of records) this.applyOtel(r, true);
  }

  private applyOtel(r: OtelRecord, persist: boolean): void {
    if (r.kind === 'metric') this.applyMetric(r);
    else if (r.kind === 'event') this.applyEvent(r);
    else return;
    if (persist) this.appendLine(OTEL_FILE, r);
  }

  private applyMetric(r: MetricRecord): void {
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
    if (inc === 0) return;
    this.increments.push({
      t: r.t,
      name: r.name,
      sid: r.attrs['session.id'] ?? 'unknown',
      type: r.attrs['type'] ?? 'total',
      model: r.attrs['model'],
      value: inc,
    });
  }

  private applyEvent(r: EventRecord): void {
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

  summary(filter: SummaryFilter = {}) {
    const { from, to, sessionId } = filter;
    const inRange = (t: number) => (from === undefined || t >= from) && (to === undefined || t <= to);
    const wantSid = (sid: string) => sessionId === undefined || sid === sessionId;

    const perSession = new Map<string, SessionSummary>();
    const get = (sid: string): SessionSummary => {
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
      if (!wantSid(info.sessionId)) continue;
      const started = info.startedAt ?? 0;
      const ended = info.endedAt ?? Number.POSITIVE_INFINITY;
      if ((to === undefined || started <= to) && (from === undefined || ended >= from)) {
        get(info.sessionId);
      }
    }

    for (const m of this.increments) {
      if (!inRange(m.t) || !wantSid(m.sid)) continue;
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
          if (m.type === 'removed') s.linesRemoved += m.value;
          else s.linesAdded += m.value;
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

    const recentEvents: Array<{ t: number; name: string; sessionId: string; tool?: string }> = [];
    for (const e of this.eventRecords) {
      if (!inRange(e.t) || !wantSid(e.sid)) continue;
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
          if (e.success === 'false') tc.errors++;
          break;
        }
      }
      recentEvents.push({ t: e.t, name: e.name, sessionId: e.sid, tool: e.tool });
      if (recentEvents.length > RECENT_LIMIT) recentEvents.shift();
    }

    for (const a of this.agentRuns) {
      if (!inRange(a.t) || !wantSid(a.sid)) continue;
      get(a.sid).agents.push({
        type: a.type,
        tokens: a.tokens,
        toolUses: a.toolUses,
        durationMs: a.durationMs,
        model: a.model,
      });
    }

    const sessions = [...perSession.values()].sort(
      (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
    );

    const totals = sessions.reduce(
      (acc, s) => {
        for (const [k, v] of Object.entries(s.tokens)) acc.tokens[k] = (acc.tokens[k] ?? 0) + v;
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
      },
      {
        tokens: {} as Record<string, number>,
        cost: 0,
        costByModel: {} as Record<string, number>,
        prompts: 0,
        linesAdded: 0,
        linesRemoved: 0,
        toolCalls: {} as Record<string, { count: number; errors: number }>,
      },
    );

    const wantEvent = (e: SummaryEvent) => inRange(e.t) && wantSid(e.sessionId ?? 'unknown');
    const isDeleted = (e: SummaryEvent) =>
      e.type === 'specification' && this.specAnnotations.get(e.t)?.deleted === true;

    for (const e of this.events) {
      if (!e.sessionId || !wantEvent(e) || isDeleted(e)) continue;
      const s = get(e.sessionId);
      if (e.type === 'specification') s.specifications.push(this.annotated(e));
      else if (e.type === 'correction') s.corrections.push(e);
      else if (e.type === 'retro') s.retros.push(e);
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
