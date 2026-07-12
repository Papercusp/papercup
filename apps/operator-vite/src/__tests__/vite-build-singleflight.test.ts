// vite-build-singleflight (EI-9836) — two ONE-SHOT `vite build` invocations
// must not race the same dist/: the second invocation BLOCKS (bounded wait)
// until the first finishes, then proceeds — unlike vite-watch-singleton
// (EI-306), which REFUSES a second watcher outright. Exercised through the
// VITE_BUILD_CMD test seam (a harmless sleep/echo stands in for vite).
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../bin/vite-build-singleflight');

let tmp: string;
const children: ChildProcess[] = [];

function launch(env: Record<string, string>): ChildProcess {
  const child = spawn(SCRIPT, [], {
    env: { ...process.env, VITE_BUILD_LOCK: join(tmp, 'build.lock'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

function collect(child: ChildProcess): { stdout: () => string; stderr: () => string; exited: Promise<number | null> } {
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => (out += String(d)));
  child.stderr?.on('data', (d) => (err += String(d)));
  const exited = new Promise<number | null>((res) => child.once('exit', (code) => res(code)));
  return { stdout: () => out, stderr: () => err, exited };
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

describe('vite-build-singleflight (EI-9836)', () => {
  it('a second one-shot build WAITS for the first, then runs — never races or refuses', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const first = launch({ VITE_BUILD_CMD: 'sleep 1.5 && echo first-done' });
    const firstRes = collect(first);
    await sleep(200); // let it acquire the lock

    const second = launch({ VITE_BUILD_CMD: 'echo second-done' });
    const secondRes = collect(second);

    // The second invocation must not have exited (refused) immediately —
    // it should still be blocked waiting on the first's lock.
    await sleep(200);
    expect(second.exitCode).toBeNull();

    expect(await firstRes.exited).toBe(0);
    expect(firstRes.stdout()).toContain('first-done');

    expect(await secondRes.exited).toBe(0);
    expect(secondRes.stdout()).toContain('second-done');
  }, 15_000);

  it('a fresh lock is acquired uncontested and the command exit status propagates', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const ok = launch({ VITE_BUILD_CMD: 'true' });
    const { exited } = collect(ok);
    expect(await exited).toBe(0);
  }, 10_000);

  it('propagates a failing build command status instead of masking it', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const failing = launch({ VITE_BUILD_CMD: 'exit 7' });
    const { exited } = collect(failing);
    expect(await exited).toBe(7);
  }, 10_000);

  it('a waiter that TIMES OUT reports the holder pid and does not hang', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const holder = launch({ VITE_BUILD_CMD: 'sleep 30' });
    const holderRes = collect(holder);
    await sleep(200); // let it acquire the lock

    const waiter = launch({ VITE_BUILD_CMD: 'echo unreachable', VITE_BUILD_WAIT_SECS: '1' });
    const { stderr, exited } = collect(waiter);
    expect(await exited).toBe(1);
    expect(stderr()).toContain('TIMED OUT');
    expect(stderr()).toContain('EI-9836');

    // The holder is untouched by the waiter's timeout — still running.
    expect(holder.exitCode).toBeNull();
    process.kill(holder.pid!, 'SIGKILL');
    await holderRes.exited;
  }, 15_000);
});
