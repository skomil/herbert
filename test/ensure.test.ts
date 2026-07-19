import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION } from '../src/config.js';
import { ensureServer, isHerbertUp } from '../src/ensure.js';

// The real built server; ensureServer spawns it, and we spawn "stale" leaders with it too.
const SERVER = path.resolve('dist/server.js');

async function waitFor(p: number, want = true): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if ((await isHerbertUp(p)) === want) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function healthPid(p: number): Promise<number | undefined> {
  try {
    const b: any = await (await fetch(`http://127.0.0.1:${p}/health`)).json();
    return b.pid;
  } catch {
    return undefined;
  }
}

/** Spawn a real herbert server as a separate process (its /health pid is safe to kill). */
function spawnLeader(p: number, dir: string): ChildProcess {
  return spawn(process.execPath, [SERVER], {
    stdio: 'ignore',
    env: { ...process.env, HERBERT_PORT: String(p), HERBERT_DATA_DIR: dir },
  });
}

describe('ensureServer (version-aware leader)', () => {
  const cleanup: Array<() => void> = [];
  afterEach(async () => {
    // Kill whatever server ended up on each test port, then remove temp dirs.
    for (const fn of cleanup.splice(0)) fn();
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herbert-ensure-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }
  function reapPort(p: number): void {
    cleanup.push(() => {
      healthPid(p).then((pid) => {
        if (pid) {
          try {
            process.kill(pid);
          } catch {
            /* already gone */
          }
        }
      });
    });
  }

  it('leaves a server whose version matches the plugin untouched', async () => {
    const PORT = 45811;
    const dir = tmpDir();
    reapPort(PORT);
    spawnLeader(PORT, dir);
    expect(await waitFor(PORT, true)).toBe(true);
    const pid = await healthPid(PORT);

    const res = await ensureServer(SERVER, PORT, VERSION);

    expect(res).toBe('already-running');
    expect(await healthPid(PORT)).toBe(pid); // same process, never signalled
  });

  it('restarts a stale-version leader and binds a fresh one', async () => {
    const PORT = 45812;
    const dir = tmpDir();
    reapPort(PORT);
    process.env.HERBERT_DATA_DIR = dir; // ensureServer's respawn inherits this
    try {
      spawnLeader(PORT, dir);
      expect(await waitFor(PORT, true)).toBe(true);
      const stalePid = await healthPid(PORT);

      const res = await ensureServer(SERVER, PORT, `${VERSION}-stale`);

      expect(res).toBe('restarted');
      expect(await isHerbertUp(PORT)).toBe(true);
      expect(await healthPid(PORT)).not.toBe(stalePid); // old leader replaced
    } finally {
      delete process.env.HERBERT_DATA_DIR;
    }
  });

  it('starts a server when the port is free', async () => {
    const PORT = 45813;
    const dir = tmpDir();
    reapPort(PORT);
    process.env.HERBERT_DATA_DIR = dir;
    try {
      const res = await ensureServer(SERVER, PORT, VERSION);
      expect(res).toBe('started');
      expect(await isHerbertUp(PORT)).toBe(true);
    } finally {
      delete process.env.HERBERT_DATA_DIR;
    }
  });
});
