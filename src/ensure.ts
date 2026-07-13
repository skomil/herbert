import { spawn } from 'node:child_process';
import { baseUrl, port } from './config.js';

/**
 * Leader election: the server binds the port, so "is a herbert server
 * already listening" is the whole check. First session to find the port
 * free becomes the server; everyone else is a client.
 */
export async function isHerbertUp(p: number = port()): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(p)}/health`, { signal: AbortSignal.timeout(700) });
    if (!res.ok) return false;
    const body: any = await res.json();
    return body?.service === 'herbert';
  } catch {
    return false;
  }
}

export type EnsureResult = 'already-running' | 'started' | 'failed';

/**
 * Make sure a herbert server is running, spawning one (detached, so it
 * outlives this session) if the port is free. Safe to race from several
 * sessions: losers of the port bind detect the winner and exit cleanly.
 */
export async function ensureServer(serverPath: string, p: number = port()): Promise<EnsureResult> {
  if (await isHerbertUp(p)) return 'already-running';
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HERBERT_PORT: String(p) },
  });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isHerbertUp(p)) return 'started';
  }
  return 'failed';
}
