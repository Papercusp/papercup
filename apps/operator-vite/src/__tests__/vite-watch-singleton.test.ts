// vite-watch-singleton (EI-306) — the dist watcher must be a singleton: a
// second `vite build --watch` invocation REFUSES while one runs (instead of
// silently racing the shared dist/), and VITE_WATCH_REPLACE=1 takes over by
// killing the holder. Exercised through the VITE_WATCH_CMD test seam (a
// harmless sleep stands in for vite).
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../bin/vite-watch-singleton');

let tmp: string;
const children: ChildProcess[] = [];

function launch(env: Record<string, string>): ChildProcess {
  const child = spawn(SCRIPT, [], {
    env: { ...process.env, VITE_WATCH_LOCK: join(tmp, 'watch.lock'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

function collect(child: ChildProcess): { stderr: () => string; exited: Promise<number | null> } {
  let err = '';
  child.stderr?.on('data', (d) => (err += String(d)));
  const exited = new Promise<number | null>((res) => child.once('exit', (code) => res(code)));
  return { stderr: () => err, exited };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      if (c.pid && c.exitCode === null) process.kill(c.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('vite-watch-singleton (EI-306)', () => {
  it('a second watcher REFUSES while the first holds the lock', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vws-'));
    const first = launch({ VITE_WATCH_CMD: 'sleep 30' });
    await sleep(700); // let it acquire + exec
    expect(first.exitCode).toBeNull(); // still running

    const second = launch({ VITE_WATCH_CMD: 'sleep 30' });
    const { stderr, exited } = collect(second);
    expect(await exited).toBe(1);
    expect(stderr()).toContain('REFUSING');
    expect(stderr()).toContain('EI-306');
    expect(first.exitCode).toBeNull(); // the holder is untouched
  }, 15_000);

  it('VITE_WATCH_REPLACE=1 kills the holder and takes over', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vws-'));
    const first = launch({ VITE_WATCH_CMD: 'sleep 30' });
    const firstExit = new Promise<number | null>((res) =>
      first.once('exit', (_code, sig) => res(_code ?? (sig ? 143 : null))),
    );
    await sleep(700);
    expect(first.exitCode).toBeNull();

    const replacer = launch({ VITE_WATCH_CMD: 'sleep 30', VITE_WATCH_REPLACE: '1' });
    await firstExit; // the holder dies
    await sleep(700);
    expect(replacer.exitCode).toBeNull(); // the replacer is now the watcher
  }, 20_000);

  it('a fresh lock is acquired uncontested', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vws-'));
    const only = launch({ VITE_WATCH_CMD: 'sleep 1' });
    const { exited } = collect(only);
    expect(await exited).toBe(0); // ran the seam cmd to completion
  }, 15_000);
});
