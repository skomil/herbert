import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRecord, MetricRecord } from '../src/otlp.js';
import { Store, reportWindows, specDetailGuidance, validateSummary } from '../src/store.js';

let dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'herbert-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const tokenMetric = (
  value: number,
  t: number,
  overrides: Partial<MetricRecord> = {},
): MetricRecord => ({
  kind: 'metric',
  t,
  name: 'claude_code.token.usage',
  value,
  temporality: 'delta',
  attrs: { 'session.id': 's1', type: 'input' },
  ...overrides,
});

describe('validateSummary', () => {
  it('accepts strings up to 599 characters', () => {
    expect(validateSummary('x'.repeat(599))).toBeNull();
  });
  it('rejects strings over 599 characters', () => {
    expect(validateSummary('x'.repeat(600))).toMatch(/limit is 599/);
  });
  it('rejects empty and non-string values', () => {
    expect(validateSummary('')).toBeTruthy();
    expect(validateSummary('   ')).toBeTruthy();
    expect(validateSummary(42)).toBeTruthy();
  });
});

describe('specDetailGuidance', () => {
  const spec = (feedback?: string) => ({ feedback });
  it('asks for higher-level summaries when "too much detail" dominates', () => {
    const msg = specDetailGuidance([spec('too much detail'), spec('too much detail'), spec('too little detail'), spec('dispute'), spec()]);
    expect(msg).toContain('2');
    expect(msg).toContain('higher level');
  });
  it('asks for more specifics when "too little detail" dominates', () => {
    expect(specDetailGuidance([spec('too little detail')])).toContain('more specifics');
  });
  it('stays silent when feedback is absent or balanced', () => {
    expect(specDetailGuidance([])).toBe('');
    expect(specDetailGuidance([spec('dispute'), spec('strongly agree')])).toBe('');
    expect(specDetailGuidance([spec('too much detail'), spec('too little detail')])).toBe('');
  });
});

describe('reportWindows', () => {
  const sundayMorning = Date.UTC(2026, 6, 12, 10); // Sunday 2026-07-12 10:00 UTC

  it('computes daily GMT windows, newest first', () => {
    const w = reportWindows({ period: 'daily', weekday: 5, hour: 0, utcOffset: 0 }, sundayMorning, 3);
    expect(w[0]).toEqual({ from: Date.UTC(2026, 6, 12), to: Date.UTC(2026, 6, 13) });
    expect(w[2]).toEqual({ from: Date.UTC(2026, 6, 10), to: Date.UTC(2026, 6, 11) });
  });

  it('anchors weekly windows to Friday 16:00 EST (UTC-5)', () => {
    const w = reportWindows({ period: 'weekly', weekday: 5, hour: 16, utcOffset: -5 }, sundayMorning, 2);
    expect(w[0].from).toBe(Date.UTC(2026, 6, 10, 21)); // Fri Jul 10, 16:00 EST = 21:00 UTC
    expect(w[0].to).toBe(Date.UTC(2026, 6, 17, 21));
    expect(w[1].from).toBe(Date.UTC(2026, 6, 3, 21));
  });

  it('stays on yesterday until the boundary hour has passed', () => {
    const w = reportWindows({ period: 'daily', weekday: 5, hour: 18, utcOffset: 0 }, sundayMorning, 1);
    expect(w[0].from).toBe(Date.UTC(2026, 6, 11, 18)); // 10:00 < 18:00, window began Saturday 18:00
  });
});

describe('Store', () => {
  it('accumulates delta metrics', () => {
    const store = new Store(tmpDir());
    store.addOtel([tokenMetric(100, 1000), tokenMetric(50, 2000)]);
    const s = store.summary().sessions.find((x) => x.sessionId === 's1')!;
    expect(s.tokens.input).toBe(150);
  });

  it('takes the latest value for cumulative metrics instead of summing', () => {
    const store = new Store(tmpDir());
    store.addOtel([
      tokenMetric(100, 1000, { temporality: 'cumulative', start: '1' }),
      tokenMetric(180, 2000, { temporality: 'cumulative', start: '1' }),
    ]);
    const s = store.summary().sessions.find((x) => x.sessionId === 's1')!;
    expect(s.tokens.input).toBe(180);
  });

  it('sums cumulative series across process restarts (different start times)', () => {
    const store = new Store(tmpDir());
    store.addOtel([
      tokenMetric(100, 1000, { temporality: 'cumulative', start: '1' }),
      tokenMetric(40, 2000, { temporality: 'cumulative', start: '2' }),
    ]);
    const s = store.summary().sessions.find((x) => x.sessionId === 's1')!;
    expect(s.tokens.input).toBe(140);
  });

  it('breaks down cost per model', () => {
    const store = new Store(tmpDir());
    const cost = (value: number, model?: string): MetricRecord => ({
      kind: 'metric',
      t: 1000,
      name: 'claude_code.cost.usage',
      value,
      temporality: 'delta',
      attrs: { 'session.id': 's1', ...(model ? { model } : {}) },
    });
    store.addOtel([
      cost(0.5, 'claude-fable-5'),
      cost(0.25, 'claude-haiku-4-5'),
      cost(0.5, 'claude-fable-5'),
      cost(0.125),
    ]);
    const summary = store.summary();
    const s = summary.sessions.find((x) => x.sessionId === 's1')!;
    expect(s.cost).toBeCloseTo(1.375);
    expect(s.costByModel).toEqual({
      'claude-fable-5': 1,
      'claude-haiku-4-5': 0.25,
      unknown: 0.125,
    });
    expect(summary.totals.costByModel).toEqual(s.costByModel);
  });

  it('aggregates events per session', () => {
    const store = new Store(tmpDir());
    const ev = (name: string, attrs: Record<string, string>): EventRecord => ({
      kind: 'event',
      t: 1,
      name,
      attrs: { 'session.id': 's1', ...attrs },
    });
    store.addOtel([
      ev('user_prompt', {}),
      ev('tool_result', { tool_name: 'Bash', success: 'true' }),
      ev('tool_result', { tool_name: 'Bash', success: 'false' }),
      ev('tool_result', { tool_name: 'Read', success: 'true' }),
    ]);
    const s = store.summary().sessions.find((x) => x.sessionId === 's1')!;
    expect(s.prompts).toBe(1);
    expect(s.toolCalls).toEqual({ Bash: { count: 2, errors: 1 }, Read: { count: 1, errors: 0 } });
  });

  it('records sub-agent runs from subagent_completed events, scoped to the session', () => {
    const store = new Store(tmpDir());
    const subagent = (attrs: Record<string, string>, t: number, sid = 's1'): EventRecord => ({
      kind: 'event',
      t,
      name: 'subagent_completed',
      attrs: { 'session.id': sid, ...attrs },
    });
    store.addOtel([
      subagent({ agent_type: 'Explore', total_tokens: '32423', total_tool_uses: '7', duration_ms: '47332', model: 'claude-opus-4-8' }, 1000),
      subagent({ agent_type: 'general-purpose', total_tokens: '5000', total_tool_uses: '3', duration_ms: '9000' }, 2000),
      subagent({ agent_type: 'Explore', total_tokens: '1000', total_tool_uses: '1', duration_ms: '2000' }, 3000, 's2'),
    ]);
    const s1 = store.summary().sessions.find((x) => x.sessionId === 's1')!;
    // sorted by tokens desc in the store? No — order of arrival; assert by content
    expect(s1.agents).toHaveLength(2);
    const explore = s1.agents.find((a) => a.type === 'Explore')!;
    expect(explore).toEqual({ type: 'Explore', tokens: 32423, toolUses: 7, durationMs: 47332, model: 'claude-opus-4-8' });
    expect(s1.agents.find((a) => a.type === 'general-purpose')!.model).toBeUndefined();
    // the s2 run stays with s2, not s1
    expect(store.summary().sessions.find((x) => x.sessionId === 's2')!.agents).toHaveLength(1);
    // agent runs honor the date-range filter (both s1 runs are before 2500)
    expect(store.summary({ from: 2500 }).sessions.find((x) => x.sessionId === 's1')?.agents ?? []).toHaveLength(0);
  });

  it('nests logged entries under their session', () => {
    const store = new Store(tmpDir());
    store.upsertSession({ sessionId: 's1', startedAt: 500 });
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'spec A', t: 1000 });
    store.addEvent({ type: 'retro', sessionId: 's1', summary: 'retro A', t: 2000 });
    store.addEvent({ type: 'correction', sessionId: null, summary: 'no session', t: 3000 });
    const summary = store.summary();
    const s = summary.sessions.find((x) => x.sessionId === 's1')!;
    expect(s.specifications.map((e) => e.summary)).toEqual(['spec A']);
    expect(s.retros.map((e) => e.summary)).toEqual(['retro A']);
    expect(s.corrections).toEqual([]);
    // sessionless entries still appear in the top-level list only
    expect(summary.corrections.map((e) => e.summary)).toEqual(['no session']);
  });

  it('persists everything and reloads identically', () => {
    const dir = tmpDir();
    const store = new Store(dir);
    store.upsertSession({ sessionId: 's1', pid: 42, cwd: '/proj', startedAt: 1 });
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'Use TypeScript', t: 2 });
    store.addOtel([tokenMetric(100, 1000)]);

    const reloaded = new Store(dir).summary();
    expect(reloaded.specifications).toHaveLength(1);
    expect(reloaded.specifications[0].summary).toBe('Use TypeScript');
    const s = reloaded.sessions.find((x) => x.sessionId === 's1')!;
    expect(s.tokens.input).toBe(100);
    expect(s.cwd).toBe('/proj');
  });

  it('filters metrics, events, and logged entries by date range', () => {
    const store = new Store(tmpDir());
    store.addOtel([tokenMetric(100, 1000), tokenMetric(50, 5000)]);
    store.addOtel([
      { kind: 'event', t: 1000, name: 'user_prompt', attrs: { 'session.id': 's1' } },
      { kind: 'event', t: 5000, name: 'user_prompt', attrs: { 'session.id': 's1' } },
    ]);
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'early', t: 1000 });
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'late', t: 5000 });

    const windowed = store.summary({ from: 4000, to: 6000 });
    const s = windowed.sessions.find((x) => x.sessionId === 's1')!;
    expect(s.tokens.input).toBe(50);
    expect(s.prompts).toBe(1);
    expect(windowed.specifications.map((e) => e.summary)).toEqual(['late']);

    const all = store.summary();
    expect(all.sessions[0].tokens.input).toBe(150);
    expect(all.specifications).toHaveLength(2);
  });

  it('date-filters cumulative metrics via increments, not raw values', () => {
    const store = new Store(tmpDir());
    store.addOtel([
      tokenMetric(100, 1000, { temporality: 'cumulative', start: '1' }),
      tokenMetric(180, 5000, { temporality: 'cumulative', start: '1' }),
    ]);
    // only the 80-token increment lands in the window
    const s = store.summary({ from: 4000 }).sessions.find((x) => x.sessionId === 's1')!;
    expect(s.tokens.input).toBe(80);
  });

  it('filters by session id', () => {
    const store = new Store(tmpDir());
    store.addOtel([
      tokenMetric(100, 1000),
      tokenMetric(70, 1000, { attrs: { 'session.id': 's2', type: 'input' } }),
    ]);
    store.addEvent({ type: 'correction', sessionId: 's2', summary: 'c2', t: 1 });
    const filtered = store.summary({ sessionId: 's2' });
    expect(filtered.sessions.map((s) => s.sessionId)).toEqual(['s2']);
    expect(filtered.totals.tokens.input).toBe(70);
    expect(filtered.corrections).toHaveLength(1);
    expect(store.summary({ sessionId: 's1' }).corrections).toHaveLength(0);
  });

  it('excludes sessions whose lifetime is outside the range', () => {
    const store = new Store(tmpDir());
    store.upsertSession({ sessionId: 'old', pid: 1, startedAt: 1000, endedAt: 2000 });
    store.upsertSession({ sessionId: 'current', pid: 2, startedAt: 5000 });
    const sessions = store.summary({ from: 4000 }).sessions.map((s) => s.sessionId);
    expect(sessions).toEqual(['current']);
  });

  it('persists structured retro sections', () => {
    const dir = tmpDir();
    new Store(dir).addEvent({
      type: 'retro',
      sessionId: 's1',
      summary: 'Overall fine',
      whatWorked: 'Tests first',
      whatDidnt: 'Too many barriers',
      changeNext: 'Pipeline by default',
      t: 1,
    });
    const retro = new Store(dir).summary().retros[0];
    expect(retro.whatWorked).toBe('Tests first');
    expect(retro.changeNext).toBe('Pipeline by default');
  });

  it('records spec feedback, surfacing it in summaries', () => {
    const store = new Store(tmpDir());
    store.upsertSession({ sessionId: 's1', startedAt: 500 });
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'spec A', t: 1000 });
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'spec B', t: 2000 });
    store.addEvent({ type: 'correction', sessionId: 's1', summary: 'not a spec', t: 3000 });
    expect(store.setSpecFeedback(1000, 'dispute')).toBe(true);
    expect(store.setSpecFeedback(999, 'dispute')).toBe(false); // unknown timestamp
    expect(store.setSpecFeedback(3000, 'dispute')).toBe(false); // not a specification
    const summary = store.summary();
    expect(summary.specifications.map((e) => e.feedback)).toEqual(['dispute', undefined]);
    const s = summary.sessions.find((x) => x.sessionId === 's1')!;
    expect(s.specifications.map((e) => e.feedback)).toEqual(['dispute', undefined]);
  });

  it('persists spec feedback across reload, last write wins, null clears', () => {
    const dir = tmpDir();
    const store = new Store(dir);
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'spec A', t: 1000 });
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'spec B', t: 2000 });
    store.setSpecFeedback(1000, 'contentious');
    store.setSpecFeedback(1000, 'too much detail');
    store.setSpecFeedback(2000, 'dispute');
    store.setSpecFeedback(2000, null);
    const specs = new Store(dir).summary().specifications;
    expect(specs[0].feedback).toBe('too much detail');
    expect(specs[1].feedback).toBeUndefined();
  });

  it('reports whether a window contains data', () => {
    const store = new Store(tmpDir());
    store.addOtel([tokenMetric(100, 5000)]);
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'spec', t: 9000 });
    expect(store.hasDataBetween(4000, 6000)).toBe(true); // metric increment
    expect(store.hasDataBetween(8000, 9500)).toBe(true); // logged event
    expect(store.hasDataBetween(6000, 8000)).toBe(false);
  });

  it('tracks the extended spec status lifecycle and clears back to complete', () => {
    const dir = tmpDir();
    const store = new Store(dir);
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'spec A', t: 1000 });
    // logged specs start complete (no status)
    expect(store.summary().specifications[0].status).toBeUndefined();
    expect(store.annotateSpec(1000, { status: 'ready' })).toBe(true);
    expect(store.summary().specifications[0].status).toBe('ready');
    store.annotateSpec(1000, { status: 'in_progress' });
    expect(store.summary().specifications[0].status).toBe('in_progress');
    // dragging to Complete clears the status, and that survives a reload
    store.annotateSpec(1000, { status: null });
    expect(new Store(dir).summary().specifications[0].status).toBeUndefined();
  });

  it('preserves an extended status across herbert.json import', () => {
    const store = new Store(tmpDir());
    expect(store.importSpec({ t: 5, summary: 'ready spec', status: 'ready' })).toBe(true);
    expect(store.importSpec({ t: 6, summary: 'bogus status', status: 'nonsense' })).toBe(true);
    const specs = store.summary().specifications;
    expect(specs.find((e) => e.t === 5)!.status).toBe('ready');
    expect(specs.find((e) => e.t === 6)!.status).toBeUndefined(); // unknown status dropped
  });

  it('annotates specs with an evolving component and deps', () => {
    const dir = tmpDir();
    const store = new Store(dir);
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'spec A', context: 'server', t: 1000 });
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'spec B', t: 2000 });
    expect(store.annotateSpec(1000, { context: 'dashboard', deps: ['store'] })).toBe(true);
    expect(store.annotateSpec(999, { context: 'x' })).toBe(false);
    const specs = store.summary().specifications;
    expect(specs[0].context).toBe('dashboard'); // annotation overrides logged context
    expect(specs[0].deps).toEqual(['store']);
    expect(specs[1].context).toBeUndefined();
  });

  it('overrides summaries and soft-deletes specs via annotations', () => {
    const dir = tmpDir();
    const store = new Store(dir);
    store.upsertSession({ sessionId: 's1', startedAt: 500 });
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'rough draft', t: 1000 });
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'keeper', t: 2000 });
    store.annotateSpec(1000, { summary: 'polished draft' });
    expect(store.summary().specifications[0].summary).toBe('polished draft');
    store.annotateSpec(1000, { deleted: true });
    const reloaded = new Store(dir).summary();
    expect(reloaded.specifications.map((e) => e.summary)).toEqual(['keeper']);
    expect(reloaded.sessions.find((x) => x.sessionId === 's1')!.specifications).toHaveLength(1);
  });

  it('persists annotations across reload; clearing falls back to the logged context', () => {
    const dir = tmpDir();
    const store = new Store(dir);
    store.addEvent({ type: 'specification', sessionId: 's1', summary: 'spec A', context: 'server', t: 1000 });
    store.annotateSpec(1000, { context: 'dashboard', deps: ['store'] });
    store.annotateSpec(1000, { context: null }); // clear override, keep deps
    const spec = new Store(dir).summary().specifications[0];
    expect(spec.context).toBe('server');
    expect(spec.deps).toEqual(['store']);
  });

  it('stores PRD docs per component, empty markdown deletes, persists across reload', () => {
    const dir = tmpDir();
    const store = new Store(dir);
    store.setPrdDoc('', '', '# Herbert\nLocal analytics.');
    store.setPrdDoc('', 'dashboard', '- must work behind a proxy');
    store.setPrdDoc('', 'reports', 'draft');
    store.setPrdDoc('', 'reports', ''); // delete
    const prd = new Store(dir).prd();
    expect(prd.summary?.md).toBe('# Herbert\nLocal analytics.');
    expect(Object.keys(prd.components)).toEqual(['dashboard']);
    expect(prd.components.dashboard.md).toBe('- must work behind a proxy');
  });

  it('keeps PRD docs and specs separate per repo, and lists the repos', () => {
    const dir = tmpDir();
    const store = new Store(dir);
    store.setPrdDoc('/dev/alpha', '', '# Alpha');
    store.setPrdDoc('/dev/alpha', 'server', '- alpha server');
    store.setPrdDoc('/dev/beta', '', '# Beta');
    store.addEvent({ type: 'specification', sessionId: null, repo: '/dev/alpha', summary: 'alpha spec', t: 1 });
    store.addEvent({ type: 'specification', sessionId: null, repo: '/dev/beta', summary: 'beta spec', t: 2 });

    // each repo sees only its own summary + component docs
    const alpha = new Store(dir).prd('/dev/alpha');
    expect(alpha.summary?.md).toBe('# Alpha');
    expect(Object.keys(alpha.components)).toEqual(['server']);
    const beta = store.prd('/dev/beta');
    expect(beta.summary?.md).toBe('# Beta');
    expect(Object.keys(beta.components)).toEqual([]);

    // specs export is repo-scoped
    expect(store.specs('/dev/alpha').map((s) => s.summary)).toEqual(['alpha spec']);
    expect(store.specs('/dev/beta').map((s) => s.summary)).toEqual(['beta spec']);
    // the picker sees both repos
    expect(store.prdRepos()).toEqual(['/dev/alpha', '/dev/beta']);
  });

  it('files legacy repo-less docs under the unassigned bucket, and assigns imported specs to a repo', () => {
    const dir = tmpDir();
    // simulate a doc written before repo-scoping (no repo field on the line)
    fs.writeFileSync(path.join(dir, 'prd.jsonl'), JSON.stringify({ component: '', md: '# Legacy', t: 1 }) + '\n');
    const store = new Store(dir);
    expect(store.prd('').summary?.md).toBe('# Legacy'); // '' = unassigned bucket
    expect(store.prd('/dev/x').summary).toBeNull(); // not visible under a real repo

    store.importSpec({ t: 9, summary: 'from a clone' }, '/dev/x');
    expect(store.specs('/dev/x').map((s) => s.summary)).toEqual(['from a clone']);
    expect(store.specs('').map((s) => s.summary)).toEqual([]);
  });

  it('stores a preview URL per session and surfaces it on that session only', () => {
    const dir = tmpDir();
    const store = new Store(dir);
    store.upsertSession({ sessionId: 's1', cwd: '/dev/app', startedAt: 1 });
    store.upsertSession({ sessionId: 's2', cwd: '/dev/app', startedAt: 2 }); // same repo, own preview
    store.setPreviewUrl('s1', 'http://localhost:16399');

    const reloaded = new Store(dir);
    expect(reloaded.previewUrl('s1')).toBe('http://localhost:16399');
    const sessions = reloaded.summary().sessions;
    expect(sessions.find((s) => s.sessionId === 's1')!.previewUrl).toBe('http://localhost:16399');
    // a different session of the same repo does NOT inherit it
    expect(sessions.find((s) => s.sessionId === 's2')!.previewUrl).toBeUndefined();

    // empty url clears it
    store.setPreviewUrl('s1', '');
    expect(new Store(dir).previewUrl('s1')).toBeUndefined();
  });

  it('persists the report window config across reload', () => {
    const dir = tmpDir();
    const store = new Store(dir);
    expect(store.reportWindow()).toEqual({ period: 'daily', weekday: 5, hour: 0, utcOffset: 0, costPerWindow: 0 });
    store.setReportWindow({ period: 'weekly', hour: 16, utcOffset: -5, costPerWindow: 25 });
    expect(new Store(dir).reportWindow()).toEqual({ period: 'weekly', weekday: 5, hour: 16, utcOffset: -5, costPerWindow: 25 });
  });

  it('sums standard-API cost within a window', () => {
    const store = new Store(tmpDir());
    const cost = (value: number, t: number): MetricRecord => ({
      kind: 'metric', t, name: 'claude_code.cost.usage', value, temporality: 'delta',
      attrs: { 'session.id': 's1' },
    });
    store.addOtel([cost(1.5, 1000), cost(2, 2000), cost(4, 9000), tokenMetric(100, 1500)]);
    expect(store.costBetween(0, 5000)).toBeCloseTo(3.5);
    expect(store.costBetween(5000, 10000)).toBe(4);
    expect(store.costBetween(10000, 20000)).toBe(0);
  });

  it('resolves the latest session for a pid', () => {
    const store = new Store(tmpDir());
    store.upsertSession({ sessionId: 'old', pid: 42, startedAt: 1 });
    store.upsertSession({ sessionId: 'new', pid: 42, startedAt: 2 });
    store.upsertSession({ sessionId: 'other', pid: 7, startedAt: 3 });
    expect(store.resolveSessionByPid(42)?.sessionId).toBe('new');
    expect(store.resolveSessionByPid(999)).toBeUndefined();
  });
});
