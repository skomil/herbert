import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS, callTool, handleRequest } from '../src/mcp.js';
import { startServer, type RunningServer } from '../src/server.js';

// mcp.ts talks to the server at config.port(); point it at a scratch server.
const PORT = 45748;
process.env.HERBERT_PORT = String(PORT);
delete process.env.CLAUDE_CODE_SESSION_ID;

let dir: string;
let running: RunningServer;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herbert-mcp-test-'));
  running = await startServer(PORT, dir);
});

afterAll(async () => {
  await running.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MCP protocol', () => {
  it('answers initialize with server info and tools capability', async () => {
    const res = await handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(res.result.serverInfo.name).toBe('herbert');
    expect(res.result.protocolVersion).toBe('2025-06-18');
  });

  it('lists the seven tools', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.result.tools.map((t: any) => t.name)).toEqual([
      'log_specification',
      'log_correction',
      'save_retro',
      'get_prd',
      'get_session_data',
      'dashboard_info',
      'set_preview_url',
    ]);
    for (const tool of TOOLS) expect(tool.description.length).toBeGreaterThan(20);
  });

  it('sets the current session\'s preview URL via the MCP tool', async () => {
    // the MCP resolves the session from CLAUDE_CODE_SESSION_ID (overridden below) or the ppid
    const prev = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'mcp-prev-sess';
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/sessions`, {
        method: 'POST',
        body: JSON.stringify({ sessionId: 'mcp-prev-sess', startedAt: 1 }),
      });
      const res = await callTool('set_preview_url', { url: 'http://localhost:16399' });
      expect(res.isError).toBeUndefined();
      const summary: any = await (await fetch(`http://127.0.0.1:${PORT}/api/summary?session=mcp-prev-sess`)).json();
      expect(summary.sessions.find((s: any) => s.sessionId === 'mcp-prev-sess').previewUrl).toBe('http://localhost:16399');

      // a non-http URL is rejected by the server; handleRequest wraps the error into an isError result
      const bad = await handleRequest({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'set_preview_url', arguments: { url: 'javascript:alert(1)' } },
      });
      expect(bad.result.isError).toBe(true);
      expect(bad.result.content[0].text).toMatch(/http/);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prev;
    }
  });

  it('ignores notifications', async () => {
    const res = await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res).toBeNull();
  });
});

describe('MCP tools', () => {
  it('rejects over-limit summaries before hitting the server', async () => {
    const res = await callTool('log_specification', { summary: 'x'.repeat(600) });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/limit is 599/);
  });

  it('logs a specification and reads it back via get_session_data', async () => {
    const logged = await callTool('log_specification', { summary: 'The plugin must be self-contained' });
    expect(logged.isError).toBeUndefined();

    const data = await callTool('get_session_data', { scope: 'all' });
    const parsed = JSON.parse(data.content[0].text);
    expect(parsed.specifications.map((s: any) => s.summary)).toContain(
      'The plugin must be self-contained',
    );
  });

  it('logs a specification with a context label', async () => {
    const logged = await callTool('log_specification', {
      summary: 'Sessions sort newest-first',
      context: 'session page',
    });
    expect(logged.isError).toBeUndefined();

    const data = await callTool('get_session_data', { scope: 'all' });
    const parsed = JSON.parse(data.content[0].text);
    const spec = parsed.specifications.find((s: any) => s.summary === 'Sessions sort newest-first');
    expect(spec.context).toBe('session page');
  });

  it('attributes events to the session id from the environment', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'env-sess';
    try {
      const res = await callTool('log_correction', { summary: 'Use the env session id' });
      expect(res.content[0].text).toContain('session env-sess');

      const data = await callTool('get_session_data', {});
      const parsed = JSON.parse(data.content[0].text);
      expect(parsed.currentSessionId).toBe('env-sess');
      expect(parsed.corrections.map((e: any) => e.summary)).toEqual(['Use the env session id']);
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });

  it('assembles the PRD from docs and specs grouped by component, scoped to the calling repo', async () => {
    // get_prd and log_specification both scope to process.cwd(); docs must be filed there too
    const repo = process.cwd();
    await fetch(`http://127.0.0.1:${PORT}/api/prd`, {
      method: 'POST',
      body: JSON.stringify({ repo, md: 'Local analytics for Claude Code.' }),
    });
    await fetch(`http://127.0.0.1:${PORT}/api/prd`, {
      method: 'POST',
      body: JSON.stringify({ repo, component: 'dashboard', md: '- single page, hash routing' }),
    });
    await callTool('log_specification', { summary: 'Charts refresh every 5s', context: 'dashboard' });
    // a spec belonging to another repo must NOT leak into this repo's PRD
    await fetch(`http://127.0.0.1:${PORT}/api/events`, {
      method: 'POST',
      body: JSON.stringify({ type: 'specification', summary: 'Other repo secret', context: 'dashboard', cwd: '/some/other/repo' }),
    });

    const res = await callTool('get_prd', {});
    const out = res.content[0].text;
    expect(out).toContain('Local analytics for Claude Code.');
    expect(out).toContain('## Component: dashboard');
    expect(out).toContain('- single page, hash routing');
    expect(out).toContain('- Charts refresh every 5s');
    expect(out).not.toContain('Other repo secret'); // cross-repo bleed is the bug being fixed
  });

  it('saves retros', async () => {
    await callTool('save_retro', { summary: 'Worked: tests-first. Change: log specs earlier.' });
    const data = await callTool('get_session_data', { scope: 'all' });
    const parsed = JSON.parse(data.content[0].text);
    expect(parsed.retros).toHaveLength(1);
  });

  it('reports the dashboard url', async () => {
    const res = await callTool('dashboard_info', {});
    expect(res.content[0].text).toContain(`http://127.0.0.1:${PORT}`);
  });
});
