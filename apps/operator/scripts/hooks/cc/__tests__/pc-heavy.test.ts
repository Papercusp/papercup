/**
 * scripts/pc-heavy.sh — the flock COUNTING-semaphore wrapper for heavy
 * build/test commands (WI-3821). Companion to the heavy-command admission gate
 * in pretooluse-bash-resource-gate.sh; this suite proves the wrapper's
 * invariants: it caps concurrency at PC_HEAVY_SLOTS, frees a slot the instant a
 * holder dies (kernel flock, crash-safe), exports PC_HEAVY_BYPASS=1 into the
 * child so the admission gate doesn't also deny it, and short-circuits when the
 * caller already bypassed.
 *
 * ionice is disabled in-suite (PC_HEAVY_IONICE='') so an ionice-permission
 * quirk on CI can't flake the timing; `nice` (always allowed for a positive
 * increment) still exercises the runner path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// __tests__ → cc → hooks → scripts → operator → apps → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const PC_HEAVY = join(ROOT, 'scripts', 'pc-heavy.sh');

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pcheavy-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  PC_HEAVY_DIR: dir,
  PC_HEAVY_IONICE: '', // skip ionice in tests (nice still applies)
  ...extra,
});

function runSync(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [PC_HEAVY, ...args], { encoding: 'utf8', env: baseEnv(env), timeout: 30_000 });
}

describe('pc-heavy.sh — flock counting semaphore (WI-3821)', () => {
  it('exports PC_HEAVY_BYPASS=1 into the child', () => {
    const r = runSync(['bash', '-c', 'printf %s "$PC_HEAVY_BYPASS"'], { PC_HEAVY_SLOTS: '2' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('1');
  });

  it('short-circuits (exec) when the caller already set PC_HEAVY_BYPASS=1 — no slot dir touched', () => {
    const r = spawnSync('bash', [PC_HEAVY, 'bash', '-c', 'echo ok'], {
      encoding: 'utf8',
      // an unwritable slot dir proves the bypass path never tries to lock
      env: { PATH: process.env.PATH ?? '', PC_HEAVY_BYPASS: '1', PC_HEAVY_DIR: '/proc/nonexistent/slots' },
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ok');
  });

  it('runs unthrottled (fail-open) when the slot dir cannot be created', () => {
    const r = spawnSync('bash', [PC_HEAVY, 'bash', '-c', 'echo ran'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', PC_HEAVY_DIR: '/proc/nonexistent/slots', PC_HEAVY_IONICE: '' },
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ran');
  });

  it('propagates the child exit code', () => {
    const r = runSync(['bash', '-c', 'exit 7'], { PC_HEAVY_SLOTS: '2' });
    expect(r.status).toBe(7);
  });

  it('errors (exit 2) when given no command', () => {
    const r = runSync([]);
    expect(r.status).toBe(2);
  });

  it('caps concurrency at PC_HEAVY_SLOTS (2 slots, 4 jobs → max 2 simultaneous)', async () => {
    const jobs = 4;
    const slots = 2;
    // Each job records "<startMs> <endMs>"; the semaphore must never let more
    // than `slots` run at once — asserted from the intervals, which is robust
    // to host load (intervals dilate under load; the overlap count does not).
    await Promise.all(
      Array.from({ length: jobs }, (_, i) =>
        new Promise<void>((res) => {
          const f = join(dir, `job.${i}.out`);
          const p = spawn(
            'bash',
            [PC_HEAVY, 'bash', '-c', `s=$(date +%s%3N); sleep 0.4; e=$(date +%s%3N); echo "$s $e" > "${f}"`],
            { env: baseEnv({ PC_HEAVY_SLOTS: String(slots) }) },
          );
          p.on('exit', () => res());
        }),
      ),
    );

    const intervals = Array.from({ length: jobs }, (_, i) => {
      const [s, e] = readFileSync(join(dir, `job.${i}.out`), 'utf8').trim().split(/\s+/).map(Number);
      return { s, e };
    });
    // Sweep for the maximum simultaneous overlap. Ends (-1) sort before starts
    // (+1) at a tie so back-to-back intervals don't count as overlapping.
    const evts: Array<[number, number]> = [];
    for (const { s, e } of intervals) { evts.push([s, 1]); evts.push([e, -1]); }
    evts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let max = 0;
    for (const [, d] of evts) { cur += d; max = Math.max(max, cur); }
    // Exactly the cap: proves it is a COUNTING semaphore (2 run together, not 1
    // like a mutex) AND that it never exceeds the cap (not unbounded).
    expect(max).toBe(slots);
  });

  it('frees a slot when the whole holder tree is killed (kernel flock crash-safety)', async () => {
    // 1 slot. A holder grabs it and sleeps long; SIGKILL its entire process
    // GROUP (the wrapper + its niced child) so NO cleanup code can run; a fresh
    // acquire must then succeed promptly (well under its wait timeout), proving
    // the slot is freed by the kernel dropping the closed fds' flock — not by
    // any manual lockfile removal. (The child deliberately INHERITS the lock,
    // so a slot stays held while orphaned work runs; killing the tree is what
    // frees it — exactly the crash we care about.)
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '1' }),
      detached: true, // own process group, so -pid kills the whole tree
    });
    await new Promise((r) => setTimeout(r, 500)); // let it grab the only slot
    process.kill(-(holder.pid as number), 'SIGKILL'); // kill the group, no cleanup runs
    await new Promise((r) => setTimeout(r, 300)); // let the kernel release the lock

    const t0 = Date.now();
    const r = runSync(['bash', '-c', 'echo got-slot'], { PC_HEAVY_SLOTS: '1', PC_HEAVY_TIMEOUT_SEC: '10' });
    const waited = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('got-slot');
    expect(waited).toBeLessThan(5000); // got the freed slot, not blocked to the timeout
  });
});
