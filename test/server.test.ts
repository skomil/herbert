import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHerbertUp } from '../src/ensure.js';
import { startServer, type RunningServer } from '../src/server.js';

const PORT = 45747;
let dir: string;
let running: RunningServer;
const url = (p: string) => `http://127.0.0.1:${PORT}${p}`;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herbert-server-test-'));
  running = await startServer(PORT, dir);
});

afterAll(async () => {
  await running.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('server', () => {
  it('answers the health probe with the herbert signature', async () => {
    const body: any = await (await fetch(url('/health'))).json();
    expect(body.service).toBe('herbert');
    await expect(isHerbertUp(PORT)).resolves.toBe(true);
  });

  it('registers sessions and resolves them by pid', async () => {
    const res = await fetch(url('/api/sessions'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'sess-1', pid: 1234, cwd: '/proj', startedAt: 5 }),
    });
    expect(res.status).toBe(200);
    const resolved: any = await (await fetch(url('/api/resolve-session?pid=1234'))).json();
    expect(resolved.session.sessionId).toBe('sess-1');
  });

  it('accepts OTLP metrics and logs and reflects them in the summary', async () => {
    const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } });
    await fetch(url('/v1/metrics'), {
      method: 'POST',
      body: JSON.stringify({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'claude_code.token.usage',
                    sum: {
                      aggregationTemporality: 1,
                      dataPoints: [
                        {
                          timeUnixNano: '1000000000',
                          asInt: '500',
                          attributes: [attr('session.id', 'sess-1'), attr('type', 'output')],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    await fetch(url('/v1/logs'), {
      method: 'POST',
      body: JSON.stringify({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: '1000000000',
                    attributes: [
                      attr('event.name', 'claude_code.user_prompt'),
                      attr('session.id', 'sess-1'),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    const summary: any = await (await fetch(url('/api/summary'))).json();
    const s = summary.sessions.find((x: any) => x.sessionId === 'sess-1');
    expect(s.tokens.output).toBe(500);
    expect(s.prompts).toBe(1);
  });

  it('stores events, resolving the session from the pid', async () => {
    const res = await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'correction', summary: 'Prefer pipeline over parallel', pid: 1234 }),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.event.sessionId).toBe('sess-1');
    // repo falls back to the resolved session's cwd when the client sent none
    expect(body.event.repo).toBe('/proj');
    const summary: any = await (await fetch(url('/api/summary'))).json();
    expect(summary.corrections).toHaveLength(1);
  });

  it('captures the repo the event was logged from', async () => {
    const res = await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', summary: 'Capture repo', cwd: '/repos/other' }),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.event.repo).toBe('/repos/other');
  });

  it('filters the summary by date range and session via query params', async () => {
    const scoped: any = await (await fetch(url('/api/summary?session=sess-1'))).json();
    expect(scoped.sessions.map((s: any) => s.sessionId)).toEqual(['sess-1']);
    // all test telemetry is at t=1000ms epoch, far before this window
    const future: any = await (await fetch(url(`/api/summary?from=${Date.now()}`))).json();
    expect(future.totals.prompts).toBe(0);
    expect(Object.keys(future.totals.tokens)).toHaveLength(0);
  });

  it('accepts structured retro sections and validates their length', async () => {
    const ok = await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({
        type: 'retro',
        summary: 'Overall good',
        whatWorked: 'Leader election',
        changeNext: 'Log specs earlier',
        sessionId: 'sess-1',
      }),
    });
    expect(ok.status).toBe(200);
    const summary: any = await (await fetch(url('/api/summary'))).json();
    expect(summary.retros.at(-1).whatWorked).toBe('Leader election');

    const bad = await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'retro', summary: 'ok', whatDidnt: 'x'.repeat(600) }),
    });
    expect(bad.status).toBe(400);
    const err: any = await bad.json();
    expect(err.error).toMatch(/whatDidnt/);
  });

  it('rejects summaries over 599 characters', async () => {
    const res = await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', summary: 'x'.repeat(600) }),
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toMatch(/limit is 599/);
  });

  it('rejects unknown event types', async () => {
    const res = await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'note', summary: 'hi' }),
    });
    expect(res.status).toBe(400);
  });

  it('stores a context label on specifications and rejects invalid ones', async () => {
    const created: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', sessionId: 'sess-1', summary: 'Bind loopback only', context: 'MCP server' }),
    })).json();
    expect(created.event.context).toBe('MCP server');
    const summary: any = await (await fetch(url('/api/summary'))).json();
    expect(summary.specifications.find((e: any) => e.t === created.event.t).context).toBe('MCP server');

    const bad = await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', sessionId: 'sess-1', summary: 'ok', context: 42 }),
    });
    expect(bad.status).toBe(400);
  });

  it('lets proposed specs be edited and removed, but not implemented ones', async () => {
    const created: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', summary: 'Draft idea', status: 'proposed' }),
    })).json();
    const t = created.event.t;

    // edit while proposed
    const edited = await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: t, summary: 'Sharper idea' }),
    });
    expect(edited.status).toBe(200);
    let summary: any = await (await fetch(url('/api/summary'))).json();
    expect(summary.specifications.find((e: any) => e.t === t).summary).toBe('Sharper idea');

    // a non-proposed spec rejects edit/remove
    const normal: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', summary: 'Shipped behavior' }),
    })).json();
    const denied = await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: normal.event.t, deleted: true }),
    });
    expect(denied.status).toBe(400);

    // remove hides the proposed spec from summaries
    await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: t, deleted: true }),
    });
    summary = await (await fetch(url('/api/summary'))).json();
    expect(summary.specifications.find((e: any) => e.t === t)).toBeUndefined();
  });

  it('revision comments reopen a spec, then fold into the summary on re-implementation', async () => {
    const created: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', summary: 'Windows are weekly' }),
    })).json();
    const t = created.event.t;

    await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: t, revision: 'also support monthly' }),
    });
    let spec: any = (await (await fetch(url('/api/summary'))).json())
      .specifications.find((e: any) => e.t === t);
    expect(spec.status).toBe('proposed'); // reopened
    expect(spec.revision).toBe('also support monthly');

    await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: t, status: '' }),
    });
    spec = (await (await fetch(url('/api/summary'))).json())
      .specifications.find((e: any) => e.t === t);
    expect(spec.status).toBe('complete');
    expect(spec.revision).toBeUndefined();
    expect(spec.summary).toBe('Windows are weekly — Revised: also support monthly');
  });

  it('creates proposed specs and lets them be marked implemented', async () => {
    const created: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', summary: 'Dark mode toggle', context: 'dashboard', status: 'proposed' }),
    })).json();
    const t = created.event.t;
    let summary: any = await (await fetch(url('/api/summary'))).json();
    expect(summary.specifications.find((e: any) => e.t === t).status).toBe('proposed');

    await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: t, status: '' }),
    });
    summary = await (await fetch(url('/api/summary'))).json();
    expect(summary.specifications.find((e: any) => e.t === t).status).toBe('complete');

    const bad = await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'correction', summary: 'nope', status: 'proposed' }),
    });
    expect(bad.status).toBe(400);
  });

  it('moves a spec across kanban statuses and completes it on drop into Complete', async () => {
    const created: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', sessionId: 'sess-1', summary: 'Board me' }),
    })).json();
    const t = created.event.t;
    const statusOf = async () =>
      (await (await fetch(url('/api/summary'))).json()).specifications.find((e: any) => e.t === t).status;

    for (const status of ['proposed', 'ready', 'in_progress', 'complete']) {
      const res = await fetch(url('/api/specs/annotate'), {
        method: 'POST',
        body: JSON.stringify({ spec: t, status }),
      });
      expect(res.status).toBe(200);
      expect(await statusOf()).toBe(status);
    }
    // the legacy empty-string signal still resolves to complete (never statusless)
    await fetch(url('/api/specs/annotate'), { method: 'POST', body: JSON.stringify({ spec: t, status: '' }) });
    expect(await statusOf()).toBe('complete');

    // an unknown status is rejected
    const bad = await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: t, status: 'doing' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/proposed, ready, in_progress/);
  });

  it('exports and imports the PRD as herbert.json', async () => {
    await fetch(url('/api/prd'), { method: 'POST', body: JSON.stringify({ component: 'mcp', md: '- six tools' }) });
    const res = await fetch(url('/api/prd/export'));
    expect(res.headers.get('content-disposition')).toContain('herbert.json');
    const file: any = await res.json();
    expect(file.version).toBe(1);
    expect(file.components.mcp).toBe('- six tools');
    expect(Array.isArray(file.specifications)).toBe(true);

    // replace mode overwrites; fill mode only adds missing docs
    file.components.mcp = '- rewritten';
    file.components.brandnew = '- from the file';
    let imp: any = await (await fetch(url('/api/prd/import'), { method: 'POST', body: JSON.stringify(file) })).json();
    expect(imp.imported).toBeGreaterThanOrEqual(2);
    let prd: any = await (await fetch(url('/api/prd'))).json();
    expect(prd.components.mcp.md).toBe('- rewritten');

    imp = await (await fetch(url('/api/prd/import'), {
      method: 'POST',
      body: JSON.stringify({ components: { mcp: '- must not win', another: '- fills in' }, mode: 'fill' }),
    })).json();
    expect(imp.imported).toBe(1);
    prd = await (await fetch(url('/api/prd'))).json();
    expect(prd.components.mcp.md).toBe('- rewritten');
    expect(prd.components.another.md).toBe('- fills in');

    const bad = await fetch(url('/api/prd/import'), { method: 'POST', body: JSON.stringify({ components: { x: 7 } }) });
    expect(bad.status).toBe(400);
  });

  it('exports full specs (proposed included) and re-imports them without duplicating', async () => {
    const impl: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', sessionId: 'sess-x', summary: 'Shipped rule', context: 'server' }),
    })).json();
    const prop: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', summary: 'Draft rule', status: 'proposed' }),
    })).json();

    const file: any = await (await fetch(url('/api/prd/export'))).json();
    const exported = file.specifications.filter((s: any) => s.t === impl.event.t || s.t === prop.event.t);
    expect(exported).toHaveLength(2);
    expect(exported.find((s: any) => s.t === impl.event.t).context).toBe('server');
    expect(exported.find((s: any) => s.t === prop.event.t).status).toBe('proposed');

    // re-importing into the same store adds nothing (deduped by timestamp)
    let imp: any = await (await fetch(url('/api/prd/import'), { method: 'POST', body: JSON.stringify(file) })).json();
    expect(imp.importedSpecs).toBe(0);

    // a spec from another repo (fresh timestamp) is added, with its proposed status preserved and editable
    const fresh = { t: 1234567890, summary: 'From a clone', context: 'mcp', status: 'proposed' };
    imp = await (await fetch(url('/api/prd/import'), {
      method: 'POST',
      body: JSON.stringify({ specifications: [fresh] }),
    })).json();
    expect(imp.importedSpecs).toBe(1);
    const summary: any = await (await fetch(url('/api/summary'))).json();
    const landed = summary.specifications.find((e: any) => e.t === fresh.t);
    expect(landed.status).toBe('proposed');
    expect(landed.context).toBe('mcp');
    const edit = await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: fresh.t, summary: 'Edited after import' }),
    });
    expect(edit.status).toBe(200); // proposed → editable in the receiving clone

    const badSpecs = await fetch(url('/api/prd/import'), { method: 'POST', body: JSON.stringify({ specifications: {} }) });
    expect(badSpecs.status).toBe(400);
  });

  it('scopes PRD docs and export by repo, and lists the repos for the picker', async () => {
    await fetch(url('/api/prd'), { method: 'POST', body: JSON.stringify({ repo: '/dev/alpha', md: '# Alpha' }) });
    await fetch(url('/api/prd'), { method: 'POST', body: JSON.stringify({ repo: '/dev/alpha', component: 'api', md: '- alpha api' }) });
    await fetch(url('/api/prd'), { method: 'POST', body: JSON.stringify({ repo: '/dev/beta', md: '# Beta' }) });
    await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', summary: 'alpha only spec', context: 'api', cwd: '/dev/alpha' }),
    });

    // each repo sees only its own docs
    const alpha: any = await (await fetch(url('/api/prd?repo=' + encodeURIComponent('/dev/alpha')))).json();
    expect(alpha.summary.md).toBe('# Alpha');
    expect(alpha.components.api.md).toBe('- alpha api');
    const beta: any = await (await fetch(url('/api/prd?repo=' + encodeURIComponent('/dev/beta')))).json();
    expect(beta.summary.md).toBe('# Beta');
    expect(beta.components.api).toBeUndefined();
    // the repo list surfaces both (plus any others from earlier tests)
    expect(alpha.repos).toContain('/dev/alpha');
    expect(alpha.repos).toContain('/dev/beta');

    // export is scoped to one repo — beta's file carries neither alpha's docs nor alpha's spec
    const file: any = await (await fetch(url('/api/prd/export?repo=' + encodeURIComponent('/dev/beta')))).json();
    expect(file.summary).toBe('# Beta');
    expect(file.components.api).toBeUndefined();
    expect(file.specifications.some((s: any) => s.summary === 'alpha only spec')).toBe(false);

    // importing into a target repo files the content there
    const imp: any = await (await fetch(url('/api/prd/import'), {
      method: 'POST',
      body: JSON.stringify({ repo: '/dev/beta', components: { ui: '- beta ui' }, specifications: [{ t: 778899, summary: 'imported beta spec' }] }),
    })).json();
    expect(imp.importedSpecs).toBe(1);
    const beta2: any = await (await fetch(url('/api/prd?repo=' + encodeURIComponent('/dev/beta')))).json();
    expect(beta2.components.ui.md).toBe('- beta ui');
    const betaSpecs: any = await (await fetch(url('/api/summary'))).json();
    expect(betaSpecs.specifications.find((e: any) => e.t === 778899).repo).toBe('/dev/beta');
  });

  it('saves and serves PRD docs', async () => {
    const bad = await fetch(url('/api/prd'), { method: 'POST', body: JSON.stringify({ md: 42 }) });
    expect(bad.status).toBe(400);
    await fetch(url('/api/prd'), { method: 'POST', body: JSON.stringify({ md: '# The product' }) });
    await fetch(url('/api/prd'), {
      method: 'POST',
      body: JSON.stringify({ component: 'dashboard', md: '- renders offline' }),
    });
    const prd: any = await (await fetch(url('/api/prd'))).json();
    expect(prd.summary.md).toBe('# The product');
    expect(prd.components.dashboard.md).toBe('- renders offline');
  });

  it('accepts a past timestamp on events for history backfills', async () => {
    const past = Date.now() - 30 * 864e5;
    const created: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', sessionId: 'sess-1', summary: 'From an old commit', t: past }),
    })).json();
    expect(created.event.t).toBe(past);
    // future timestamps are ignored, not honored
    const future: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', sessionId: 'sess-1', summary: 'Time traveler', t: Date.now() + 864e5 }),
    })).json();
    expect(future.event.t).toBeLessThanOrEqual(Date.now());
  });

  it('annotates specs with component and deps via the API', async () => {
    const created: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', sessionId: 'sess-1', summary: 'Graph the specs' }),
    })).json();
    const t = created.event.t;

    const ok = await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: t, context: 'dashboard', deps: ['store', 'server'] }),
    });
    expect(ok.status).toBe(200);
    const summary: any = await (await fetch(url('/api/summary'))).json();
    const spec = summary.specifications.find((e: any) => e.t === t);
    expect(spec.context).toBe('dashboard');
    expect(spec.deps).toEqual(['store', 'server']);

    const badDeps = await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: t, deps: 'store' }),
    });
    expect(badDeps.status).toBe(400);
    const missing = await fetch(url('/api/specs/annotate'), {
      method: 'POST',
      body: JSON.stringify({ spec: 1, context: 'x' }),
    });
    expect(missing.status).toBe(404);
  });

  it('records spec feedback and reflects it in the summary', async () => {
    const created: any = await (await fetch(url('/api/events'), {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', sessionId: 'sess-1', summary: 'Use tabs' }),
    })).json();
    const t = created.event.t;

    const ok = await fetch(url('/api/specs/feedback'), {
      method: 'POST',
      body: JSON.stringify({ spec: t, feedback: 'too much detail' }),
    });
    expect(ok.status).toBe(200);
    let summary: any = await (await fetch(url('/api/summary'))).json();
    expect(summary.specifications.find((e: any) => e.t === t).feedback).toBe('too much detail');

    // empty feedback clears it
    await fetch(url('/api/specs/feedback'), {
      method: 'POST',
      body: JSON.stringify({ spec: t, feedback: '' }),
    });
    summary = await (await fetch(url('/api/summary'))).json();
    expect(summary.specifications.find((e: any) => e.t === t).feedback).toBeUndefined();
  });

  it('rejects unknown feedback values and unknown specs', async () => {
    const bad = await fetch(url('/api/specs/feedback'), {
      method: 'POST',
      body: JSON.stringify({ spec: 1, feedback: 'meh' }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(url('/api/specs/feedback'), {
      method: 'POST',
      body: JSON.stringify({ spec: 1, feedback: 'dispute' }),
    });
    expect(missing.status).toBe(404);
  });

  it('sets a per-session preview URL, surfaces it on that session, and rejects non-http URLs', async () => {
    await fetch(url('/api/sessions'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'prev-sess', cwd: '/dev/app', startedAt: 10 }),
    });
    const ok = await fetch(url('/api/preview'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'prev-sess', url: 'http://localhost:5173' }),
    });
    expect(ok.status).toBe(200);
    const summary: any = await (await fetch(url('/api/summary?session=prev-sess'))).json();
    expect(summary.sessions.find((s: any) => s.sessionId === 'prev-sess').previewUrl).toBe('http://localhost:5173');

    // a javascript: URL is rejected (it would be rendered as an href)
    const bad = await fetch(url('/api/preview'), {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'prev-sess', url: 'javascript:alert(1)' }),
    });
    expect(bad.status).toBe(400);
    // sessionId is required
    const noSess = await fetch(url('/api/preview'), { method: 'POST', body: JSON.stringify({ url: 'http://x' }) });
    expect(noSess.status).toBe(400);

    // empty url clears it
    await fetch(url('/api/preview'), { method: 'POST', body: JSON.stringify({ sessionId: 'prev-sess', url: '' }) });
    const cleared: any = await (await fetch(url('/api/summary?session=prev-sess'))).json();
    expect(cleared.sessions.find((s: any) => s.sessionId === 'prev-sess').previewUrl).toBeUndefined();
  });

  it('serves and updates the report window config', async () => {
    let body: any = await (await fetch(url('/api/report-window'))).json();
    expect(body.config).toEqual({ period: 'daily', weekday: 5, hour: 0, utcOffset: 0, costPerWindow: 0 });
    expect(body.windows).toHaveLength(26);
    expect(body.windows[0].to - body.windows[0].from).toBe(864e5);
    // events logged by earlier tests land in the current window; old windows are empty
    expect(body.windows[0].hasData).toBe(true);
    expect(body.windows[25].hasData).toBe(false);
    expect(typeof body.windows[0].cost).toBe('number');
    expect(body.pid).toBe(process.pid); // page uses this to reload itself after a server restart

    const res = await fetch(url('/api/report-window'), {
      method: 'POST',
      body: JSON.stringify({ period: 'weekly', weekday: 5, hour: 16, utcOffset: -5, costPerWindow: 12.5 }),
    });
    expect(res.status).toBe(200);
    body = await (await fetch(url('/api/report-window'))).json();
    expect(body.config).toEqual({ period: 'weekly', weekday: 5, hour: 16, utcOffset: -5, costPerWindow: 12.5 });
    expect(body.windows[0].to - body.windows[0].from).toBe(7 * 864e5);

    const bad = await fetch(url('/api/report-window'), {
      method: 'POST',
      body: JSON.stringify({ hour: 99 }),
    });
    expect(bad.status).toBe(400);
    const badCost = await fetch(url('/api/report-window'), {
      method: 'POST',
      body: JSON.stringify({ costPerWindow: -5 }),
    });
    expect(badCost.status).toBe(400);
  });

  it('exports a usage CSV report for a window', async () => {
    const res = await fetch(url('/api/report.csv?from=0&to=' + Date.now()));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('herbert-usage-');
    const lines = (await res.text()).trim().split('\n');
    expect(lines[0]).toBe(
      'session_id,project,started,ended,prompts,tool_calls,input_tokens,output_tokens,' +
      'cache_read_tokens,cache_creation_tokens,total_tokens,cost_usd,lines_added,lines_removed,' +
      'active_time_sec,commits,pull_requests',
    );
    const sess = lines.find((l) => l.startsWith('sess-1'));
    expect(sess).toBeTruthy();
    expect(sess!.split(',')[7]).toBe('500'); // output tokens ingested earlier via OTLP
    expect(lines[lines.length - 1]).toMatch(/^TOTAL,/);

    expect((await fetch(url('/api/report.csv'))).status).toBe(400); // window required
  });

  it('serves the dashboard', async () => {
    const res = await fetch(url('/'));
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('herbert');
    // relative URL (resolved against document.baseURI) so proxies/vhosts work
    expect(html).toContain("'api/summary?'");
    expect(html).not.toContain("fetch('/api/summary");
    // specification feedback combo box wired to the feedback endpoint,
    // including the session-level bulk box that fans out over data-specs
    expect(html).toContain('select class="feedback"');
    expect(html).toContain("'api/specs/feedback'");
    expect(html).toContain('data-specs=');
    // report window controls + per-window CSV download links
    expect(html).toContain("'api/report-window'");
    expect(html).toContain('api/report.csv?from=');
    // spec hierarchy DAG whose nodes filter by repo / component / spec
    expect(html).toContain('specdag');
    expect(html).toContain('data-sspec=');
    expect(html).toContain('data-sctx=');
    // evolving classification inputs + dependency edges
    expect(html).toContain("'api/specs/annotate'");
    expect(html).toContain('known-components');
    expect(html).toContain('gdeps');
    // PRD page: markdown docs per component, edited in place
    expect(html).toContain("'api/prd'");
    expect(html).toContain('renderPrd');
    expect(html).toContain('prd-doc');
    // top-level net-vs-plan tile driven by the user-entered window cost
    expect(html).toContain('Net vs plan');
    // combined PRD & specs page: filterable specs section (shared with the map), edit/remove, propose form
    expect(html).toContain('specsSection');
    expect(html).toContain('filterSpecs');
    expect(html).toContain('spec-prop-filter');
    expect(html).toContain('data-remove-spec');
    expect(html).toContain('data-edit-spec');
    // spec map relationship toggles (hide/show spec nodes and dependency edges)
    expect(html).toContain('data-mtoggle');
    // filtered graphs keep dep edges by rendering external dep targets as dimmed nodes
    expect(html).toContain('gext');
    // proposed specs + herbert.json import/export
    expect(html).toContain('data-propose');
    expect(html).toContain('data-impl');
    expect(html).toContain('api/prd/export');
    expect(html).toContain('gproposed');
    // single-session kanban board: drag-and-drop cards across status columns, hide-complete toggle
    expect(html).toContain('renderKanban');
    expect(html).toContain('data-kcard');
    expect(html).toContain('data-lane');
    expect(html).toContain('dragstart');
    expect(html).toContain('khide');
    // per-session preview link on the session page (read-only; the URL is set via the MCP tool)
    expect(html).toContain('previewUrl');
    expect(html).toContain('set_preview_url');
    // repo-scoped PRD page: repo picker scopes docs + specs + export
    expect(html).toContain('prd-repo');
    expect(html).toContain('api/prd/export?repo=');
  });

  it('renders session selection at the top of the overall view', async () => {
    const html = await (await fetch(url('/'))).text();
    const overall = html.slice(html.indexOf('function renderOverall'));
    expect(overall.indexOf("card('Sessions'")).toBeGreaterThan(-1);
    expect(overall.indexOf("card('Sessions'")).toBeLessThan(overall.indexOf('tiles(d)'));
  });
});
