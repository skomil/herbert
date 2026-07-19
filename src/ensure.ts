import { spawn } from 'node:child_process';
import { VERSION, baseUrl, port } from './config.js';

type Health = { version?: string; pid?: number };

async function health(p: number): Promise<Health | null> {
  try {
    const res = await fetch(`${baseUrl(p)}/health`, { signal: AbortSignal.timeout(700) });
    if (!res.ok) return null;
    const body: any = await res.json();
    return body?.service === 'herbert' ? { version: body.version, pid: body.pid } : null;
  } catch {
    return null;
  }
}

/**
 * Leader election: the server binds the port, so "is a herbert server
 * already listening" is the whole check. First session to find the port
 * free becomes the server; everyone else is a client.
 */
export async function isHerbertUp(p: number = port()): Promise<boolean> {
  return (await health(p)) !== null;
}

export type EnsureResult = 'already-running' | 'started' | 'restarted' | 'failed';

function spawnDetached(serverPath: string, p: number): void {
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HERBERT_PORT: String(p) },
  });
  child.unref();
}

/** Poll /health until it reaches `want` (up/down), or give up after ~5s. */
async function waitFor(p: number, want: boolean): Promise<boolean> {
  for (let i = 0; i < 25; i++) {
    if ((await isHerbertUp(p)) === want) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Make sure a herbert server matching this plugin's version is running,
 * spawning one (detached, so it outlives this session) if the port is free.
 *
 * The leader is long-lived and nothing else cycles it, so a plugin update
 * would otherwise keep being served by the old process. If the listening
 * server reports a different version, kill it and bind a fresh one, so the
 * update takes effect without a manual restart. Safe to race from several
 * sessions: losers of the port bind detect the winner and exit cleanly.
 */
export async function ensureServer(
  serverPath: string,
  p: number = port(),
  expectedVersion: string = VERSION,
): Promise<EnsureResult> {
  const running = await health(p);
  if (running) {
    if (running.version === expectedVersion || !running.pid) return 'already-running';
    // Stale leader: cycle it so the running code matches the installed plugin.
    try {
      process.kill(running.pid);
    } catch {
      return 'already-running'; // can't signal it (already gone, or not ours) — leave it be
    }
    if (!(await waitFor(p, false))) return 'already-running'; // never freed the port — don't pile on
    spawnDetached(serverPath, p);
    return (await waitFor(p, true)) ? 'restarted' : 'failed';
  }
  spawnDetached(serverPath, p);
  return (await waitFor(p, true)) ? 'started' : 'failed';
}
