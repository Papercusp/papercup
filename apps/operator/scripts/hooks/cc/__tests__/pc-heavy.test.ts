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
import { spawn, spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
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
  // cwd: dir — a fresh, non-git tmpdir per test, so the tree-state token's
  // git-status probe (EI-18688348461605365) naturally no-ops unless a test
  // deliberately `git init`s it. Keeps the suite hermetic and avoids paying
  // for (or racing against concurrent edits to) this repo's own live git
  // status on every spawn.
  return spawnSync('bash', [PC_HEAVY, ...args], { encoding: 'utf8', env: baseEnv(env), cwd: dir, timeout: 30_000 });
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

  it('propagates the real child\'s stderr on the uncontested (first-try slot) path', () => {
    // Regression test (EI-18685262961418231 investigation): `exec {fd}>file
    // 2>/dev/null` with NO command applies ALL its redirections PERSISTENTLY
    // to the invoking shell, so the ORIGINAL script silently redirected its
    // own stderr to /dev/null forever the instant a slot was free on the
    // first try — the common, uncontended case. Every heavy command's real
    // stderr (build/type errors) was being dropped on the floor.
    const r = runSync(['bash', '-c', 'echo out-line; echo err-line >&2; exit 5'], { PC_HEAVY_SLOTS: '2' });
    expect(r.status).toBe(5);
    expect(r.stdout.trim()).toBe('out-line');
    expect(r.stderr.trim()).toBe('err-line');
  });
});

describe('pc-heavy.sh — coalescing (EI-18685262961418231)', () => {
  it('collapses N genuinely-concurrent IDENTICAL invocations into far fewer real runs, replaying the rest', async () => {
    // A burst of agents all running the exact same command (same cwd+argv) —
    // e.g. many agents confirming the same gate at once — should not each pay
    // for their own full run. One (or a small handful, bounded by the
    // unavoidable startup race before any lock file exists yet) becomes the
    // leader and actually executes; the rest replay its captured output.
    const marker = join(dir, 'runs.marker');
    const n = 6;
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
          const p = spawn(
            'bash',
            [PC_HEAVY, 'bash', '-c', `printf x >> "${marker}"; sleep 0.4; echo same-output`],
            { env: baseEnv({ PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE_SEC: '30' }) },
          );
          let stdout = '';
          let stderr = '';
          p.stdout.on('data', (d) => (stdout += d));
          p.stderr.on('data', (d) => (stderr += d));
          p.on('exit', (status) => res({ status, stdout, stderr }));
        }),
      ),
    );
    // Every caller still sees correct output and a success exit code.
    for (const r of results) {
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('same-output');
    }
    // At least most callers coalesced onto a shared result rather than each
    // spawning their own run.
    const realRuns = readFileSync(marker, 'utf8').length;
    expect(realRuns).toBeLessThan(n);
    const coalescedCount = results.filter((r) => r.stderr.includes('coalesced:')).length;
    expect(coalescedCount).toBeGreaterThan(0);
  });

  it('a later (non-concurrent) identical call within the window reuses the cached result, including stderr + exit code', () => {
    const first = runSync(['bash', '-c', 'echo out-x; echo err-x >&2; exit 4'], {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE_SEC: '30',
    });
    expect(first.status).toBe(4);
    expect(first.stderr).not.toContain('coalesced:');

    const second = runSync(['bash', '-c', 'echo out-x; echo err-x >&2; exit 4'], {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE_SEC: '30',
    });
    expect(second.status).toBe(4);
    expect(second.stdout.trim()).toBe('out-x');
    expect(second.stderr).toContain('err-x');
    expect(second.stderr).toContain('coalesced:');
  });

  it('does NOT coalesce different commands (different argv → different key)', () => {
    const a = runSync(['bash', '-c', 'echo aaa'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
    const b = runSync(['bash', '-c', 'echo bbb'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
    expect(a.stdout.trim()).toBe('aaa');
    expect(b.stdout.trim()).toBe('bbb');
    expect(b.stderr).not.toContain('coalesced:');
  });

  it('PC_HEAVY_COALESCE=0 disables coalescing entirely — every call is a real run', () => {
    const first = runSync(['bash', '-c', 'echo same; exit 0'], {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE: '0',
    });
    const second = runSync(['bash', '-c', 'echo same; exit 0'], {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE: '0',
    });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain('coalesced:');
    // No coalesce cache dir should even be created when disabled.
    expect(existsSync(join(dir, 'coalesce'))).toBe(false);
  });

  it('reclaims an ABANDONED lock (leader killed before writing a result) instead of making a follower wait out the whole window', async () => {
    // A plain mkdir lock (unlike the flock slots) has no kernel-level
    // auto-release — a SIGKILL'd leader (never trappable) would otherwise
    // strand the lock forever, taxing every future identical call with a
    // full wait before it gives up. Same command text for the "leader" and
    // the follow-up so they share a coalescing key; both are long-running
    // (sleep 30) so we can observe the LOCK being reclaimed (via `spawn` +
    // polling its mtime) without blocking the test on the full 30s.
    const cmd = 'sleep 30; echo never';
    const coalesceDir = join(dir, 'coalesce');
    const lockMtime = () => {
      let names: string[] = [];
      try { names = readdirSync(coalesceDir); } catch { return null; }
      const f = names.find((n) => n.endsWith('.lock'));
      return f ? statSync(join(coalesceDir, f)).mtimeMs : null;
    };

    const leader = spawn('bash', [PC_HEAVY, 'bash', '-c', cmd], {
      env: baseEnv({ PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '2' }),
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 400)); // let it claim the coalescing lock
    process.kill(-(leader.pid as number), 'SIGKILL'); // hard-kill: no trap/cleanup runs
    const staleMtime = lockMtime();
    expect(staleMtime).not.toBeNull();

    await new Promise((r) => setTimeout(r, 2300)); // past the 2s coalescing window — lock now stale

    const follower = spawn('bash', [PC_HEAVY, 'bash', '-c', cmd], {
      env: baseEnv({ PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '2' }),
      detached: true,
    });
    try {
      // Poll briefly for the lock to be RECREATED (a fresh mtime) — proving
      // the stale lock was reclaimed promptly, not waited-out for the full
      // window (which would itself eventually also just run uncached, but
      // only after paying the whole PC_HEAVY_COALESCE_SEC again).
      const t0 = Date.now();
      let reclaimed = false;
      while (Date.now() - t0 < 1500) {
        const mt = lockMtime();
        if (mt !== null && mt > (staleMtime as number)) { reclaimed = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(reclaimed).toBe(true);
    } finally {
      process.kill(-(follower.pid as number), 'SIGKILL'); // cleanup, don't let it run 30s
    }
  });
});
