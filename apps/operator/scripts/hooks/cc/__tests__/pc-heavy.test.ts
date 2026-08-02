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
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
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
  // Point the release-gate reserve (EI-19315056231449472) at an empty per-test
  // dir. Without this the suite reads the REAL ~/.papercusp/checkpoint-logs, so
  // every slot-count assertion below would silently depend on whether this box
  // happens to be running a green-checkpoint at the time — passing at 03:00 and
  // failing mid-gate. Same hermeticity reasoning as `cwd: dir` for the git probe.
  // Tests that WANT the clamp plant a lock dir under here explicitly.
  PAPERCUSP_CHECKPOINT_LOG_DIR: join(dir, 'checkpoint-logs'),
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

  // WI-6140: green-checkpoint's greenCmd IS `npm run test:affected`, which now routes
  // through this wrapper. The release gate must never QUEUE behind ad-hoc agent sweeps —
  // it races a 60-min wall-clock reaper measured from workflow CREATION, so a slot wait
  // (up to PC_HEAVY_TIMEOUT_SEC=900s) comes straight off that budget and resurfaces as a
  // "stale routine" reap that reads as an infra flake.
  it('exempts the release gate (PC_HEAVY_RELEASE_GATE=1) from the semaphore entirely', () => {
    // A slot dir path that does NOT exist yet but IS creatable: a non-exempt run would
    // mkdir it and take a slot, so "never created" proves we exec'd before the slot
    // machinery — and distinguishes this from the fail-open path below, which only
    // triggers when the dir CANNOT be made.
    const slots = join(dir, 'never-created');
    const r = spawnSync('bash', [PC_HEAVY, 'bash', '-c', 'printf %s "$PC_HEAVY_BYPASS"'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', PC_HEAVY_DIR: slots, PC_HEAVY_RELEASE_GATE: '1' },
      cwd: dir,
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    // still marked bypassed, so nested heavy children don't re-queue either
    expect(r.stdout).toBe('1');
    expect(existsSync(slots)).toBe(false);
  });

  // WI-6140 hole (caught in review by su-055aef7f): GREEN_CHECKPOINT is DOUBLE-DUTY — it
  // also drives describe.skipIf in load-/network-sensitive tests, so agents legitimately
  // export it by hand to reproduce the gate's skip-set. If it ALSO granted admission,
  // `GREEN_CHECKPOINT=1 npm run test:affected` would bypass the semaphore at nice 0 and
  // re-open the unadmitted-sweep hole this wrapper exists to close. Keep the two keys
  // separate; this test fails if anyone merges them back.
  it('does NOT exempt on the double-duty GREEN_CHECKPOINT marker — only the dedicated key', () => {
    const slots = join(dir, 'made-despite-green-checkpoint');
    const r = spawnSync('bash', [PC_HEAVY, 'bash', '-c', 'echo ok'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        PC_HEAVY_DIR: slots,
        PC_HEAVY_IONICE: '',
        PC_HEAVY_SLOTS: '2',
        GREEN_CHECKPOINT: '1', // the skip-marker alone must NOT buy admission
      },
      cwd: dir,
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    // it went through the slot machinery like any other sweep
    expect(existsSync(slots)).toBe(true);
  });

  it('still throttles an ordinary sweep when GREEN_CHECKPOINT is unset', () => {
    // The other half of the invariant above: the exemption must be keyed to the release
    // gate, not accidentally open to everyone.
    const slots = join(dir, 'made-by-ordinary-run');
    const r = spawnSync('bash', [PC_HEAVY, 'bash', '-c', 'echo ok'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', PC_HEAVY_DIR: slots, PC_HEAVY_IONICE: '', PC_HEAVY_SLOTS: '2' },
      cwd: dir,
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(existsSync(slots)).toBe(true);
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
            { env: baseEnv({ PC_HEAVY_SLOTS: String(slots) }), cwd: dir },
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
      cwd: dir,
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

  it('a waiter grabs a DIFFERENT slot that frees, instead of convoying on slot 0 alone (regression: pc-heavy slot-0 convoy)', async () => {
    // 2 slots. Holder A takes slot 0 (the natural first pick with no
    // contention) and sleeps long (30s). The ORIGINAL fallback blocked an
    // all-slots-busy waiter specifically on slot 0's flock
    // (`flock -w "$_timeout" "$_fd"` against slot.0 alone), so it would sit
    // stuck behind A for up to the full PC_HEAVY_TIMEOUT_SEC even while
    // slot 1 sat completely free — observed live: ~20 waiters queued on
    // slot 0 while slots 2/3 had zero holders on a 4-slot host. Holder B
    // takes slot 1 (naturally, since slot 0 is busy) and finishes quickly.
    // A third caller arriving while BOTH slots are busy must grab slot 1
    // promptly once B releases it, not wait out the (much longer) timeout.
    const slots = 2;
    const holderA = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: String(slots) }),
      cwd: dir,
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 500)); // let A grab slot 0

    const holderB = spawn('bash', [PC_HEAVY, 'sleep', '2'], {
      env: baseEnv({ PC_HEAVY_SLOTS: String(slots) }),
      cwd: dir,
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 500)); // let B grab slot 1 (slot 0 is busy)

    const t0 = Date.now();
    const r = runSync(['bash', '-c', 'echo got-a-free-slot'], {
      PC_HEAVY_SLOTS: String(slots),
      PC_HEAVY_TIMEOUT_SEC: '25', // much longer than B's remaining ~1s sleep
    });
    const waited = Date.now() - t0;

    try {
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('got-a-free-slot');
      // Got slot 1 promptly after B released it, not the full 25s timeout
      // the old slot-0-only fallback would have waited out (A holds slot 0
      // for 30s, well past the timeout).
      expect(waited).toBeLessThan(10_000);
    } finally {
      process.kill(-(holderA.pid as number), 'SIGKILL');
      try { process.kill(-(holderB.pid as number), 'SIGKILL'); } catch { /* likely already exited */ }
    }
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
            { env: baseEnv({ PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE_SEC: '30' }), cwd: dir },
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
      cwd: dir,
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 400)); // let it claim the coalescing lock
    process.kill(-(leader.pid as number), 'SIGKILL'); // hard-kill: no trap/cleanup runs
    const staleMtime = lockMtime();
    expect(staleMtime).not.toBeNull();

    await new Promise((r) => setTimeout(r, 2300)); // past the 2s coalescing window — lock now stale

    const follower = spawn('bash', [PC_HEAVY, 'bash', '-c', cmd], {
      env: baseEnv({ PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '2' }),
      cwd: dir,
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

  // Regression suite for EI-18688348461605365: cwd+argv alone is a STALE key
  // whenever the SOURCE the command exercises changed between two identical
  // invocations (edit, then re-run to check) — the coalescer replayed a
  // pre-edit result as if it were fresh. The fix folds a cheap tree-state
  // token (referenced-file mtime+size, plus a git-status hash when inside a
  // worktree) into the key so an edit busts the cache while a genuine
  // no-op re-run still coalesces.
  describe('tree-state token busts the cache on a real edit (EI-18688348461605365)', () => {
    it('a referenced file argument changing between runs busts the cache — even OUTSIDE the git tree (the exact reported repro: a /tmp script)', () => {
      // The script path must be its own argv TOKEN (not embedded inside a
      // `-c '...'` shell string) — the fix stats each literal argv token
      // that resolves to an existing file, matching how a real caller
      // invokes e.g. `npx tsx /tmp/genfix.mts` (the reported repro).
      const script = join(dir, 'genfix.mts');
      writeFileSync(script, 'console.log("version-one")');
      const first = runSync(['cat', script], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
      expect(first.stderr).not.toContain('coalesced:');
      expect(first.stdout).toContain('version-one');

      // Edit the referenced file — deliberately a different LENGTH so the
      // size component of the token changes even if the filesystem's mtime
      // resolution is coarse enough to collide within the same test.
      writeFileSync(script, 'console.log("version-two-longer")');
      const second = runSync(['cat', script], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
      expect(second.stderr).not.toContain('coalesced:'); // must NOT replay the stale version-one result
      expect(second.stdout).toContain('version-two-longer');
    });

    it('a git-tracked source file changing between runs busts the cache, even when the command does not name it directly', () => {
      execSync('git init -q', { cwd: dir });
      execSync('git config user.email t@example.com && git config user.name test', { cwd: dir });
      writeFileSync(join(dir, 'src.txt'), 'v1');
      execSync('git add -A && git commit -q -m init', { cwd: dir });

      const first = runSync(['bash', '-c', 'echo build-output'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
      expect(first.stderr).not.toContain('coalesced:');

      // Simulate "I edited the source this build/test exercises" — e.g. the
      // `npm run test:affected` shape, where the changed file is nowhere in
      // argv but IS what makes the previous output stale.
      writeFileSync(join(dir, 'src.txt'), 'v2 - modified');

      const second = runSync(['bash', '-c', 'echo build-output'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
      expect(second.stderr).not.toContain('coalesced:'); // busted, not a stale replay
    });

    it('still coalesces a genuine no-op re-run inside a git worktree with no diff (the fix does not over-bust)', () => {
      execSync('git init -q', { cwd: dir });
      execSync('git config user.email t@example.com && git config user.name test', { cwd: dir });
      writeFileSync(join(dir, 'src.txt'), 'v1');
      execSync('git add -A && git commit -q -m init', { cwd: dir });

      const first = runSync(['bash', '-c', 'echo out-y; echo err-y >&2; exit 3'], {
        PC_HEAVY_SLOTS: '2',
        PC_HEAVY_COALESCE_SEC: '30',
      });
      expect(first.status).toBe(3);
      expect(first.stderr).not.toContain('coalesced:');

      // Nothing changed (no edit, no new commit) — a true duplicate poll.
      const second = runSync(['bash', '-c', 'echo out-y; echo err-y >&2; exit 3'], {
        PC_HEAVY_SLOTS: '2',
        PC_HEAVY_COALESCE_SEC: '30',
      });
      expect(second.status).toBe(3);
      expect(second.stderr).toContain('coalesced:');
    });
  });
});

describe('pc-heavy.sh — load-adaptive slot count (EI-19313096203661357)', () => {
  // A PATH-shimmed `nproc` pins the core count so the formula asserts the same
  // numbers on any host; PC_HEAVY_LOAD1_OVERRIDE pins load1 (same convention as
  // the admission gate in pretooluse-bash-resource-gate.sh).
  const fakeNprocPath = (cores: number): string => {
    const bin = join(dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'nproc'), `#!/usr/bin/env bash\necho ${cores}\n`, { mode: 0o755 });
    return `${bin}:${process.env.PATH ?? ''}`;
  };
  const slotsLine = (stderr: string) =>
    stderr.split('\n').find((l) => l.includes('[pc-heavy] slots=')) ?? '';
  const probe = (cores: number, extra: Record<string, string>) =>
    runSync(['true'], { PC_HEAVY_DEBUG: '1', PC_HEAVY_COALESCE: '0', PATH: fakeNprocPath(cores), ...extra });

  it('saturated box (load1 >= cores) stays at the floor — exactly the pre-adaptive count', () => {
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '128' });
    expect(r.status).toBe(0);
    expect(slotsLine(r.stderr)).toContain('slots=4 fixed=0 cores=128 floor=4 ceil=16');
    const over = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '300' });
    expect(slotsLine(over.stderr)).toContain('slots=4');
  });

  it('widens by one slot per 16 cores of load1 headroom (the filed 128-core/load-76 case → 7, not 4)', () => {
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '76' }).stderr)).toContain('slots=7');
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
  });

  it('caps at cores/8, which never drops below the max(2, cores/32) floor on small boxes', () => {
    const r = probe(16, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
    expect(slotsLine(r.stderr)).toContain('slots=2 fixed=0 cores=16 floor=2 ceil=2');
  });

  it('an explicit PC_HEAVY_SLOTS is FIXED — load adaptation never overrides the operator', () => {
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0', PC_HEAVY_SLOTS: '3' });
    expect(slotsLine(r.stderr)).toContain('slots=3 fixed=1');
  });

  it('non-numeric load fails conservative, to the floor', () => {
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: 'banana' });
    expect(slotsLine(r.stderr)).toContain('slots=4');
  });

  it('the computed (not env) slot count actually gates admission [adaptive]', async () => {
    // 64 fake cores at load 64 → computed floor of 2. Three 0.4s sleepers must
    // never overlap more than 2 at a time — same interval-sweep as the cap test.
    const jobs = 3;
    const path = fakeNprocPath(64);
    await Promise.all(
      Array.from({ length: jobs }, (_, i) =>
        new Promise<void>((res) => {
          const f = join(dir, `adaptive.${i}.out`);
          const p = spawn(
            'bash',
            [PC_HEAVY, 'bash', '-c', `s=$(date +%s%3N); sleep 0.4; e=$(date +%s%3N); echo "$s $e" > "${f}"`],
            { env: baseEnv({ PC_HEAVY_LOAD1_OVERRIDE: '64', PC_HEAVY_COALESCE: '0', PATH: path }), cwd: dir },
          );
          p.on('exit', () => res());
        }),
      ),
    );
    const intervals = Array.from({ length: jobs }, (_, i) => {
      const [s, e] = readFileSync(join(dir, `adaptive.${i}.out`), 'utf8').trim().split(/\s+/).map(Number);
      return { s, e };
    });
    const evts: Array<[number, number]> = [];
    for (const { s, e } of intervals) { evts.push([s, 1]); evts.push([e, -1]); }
    evts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let max = 0;
    for (const [, d] of evts) { cur += d; max = Math.max(max, cur); }
    expect(max).toBe(2);
  });
});

// ── Release-gate reserve (EI-19315056231449472) ─────────────────────────────
// While green-checkpoint is judging, the steady-state slot target is the wrong
// target: the gate's quiet cut is exactly when the box looks idle, so the
// load-adaptive count is at its most generous precisely when the gate's
// isolation re-run (which decides load-flake vs real break, and so decides the
// VERDICT) most needs headroom. These assert the clamp and — more importantly —
// every fail-open path, because a clamp that misfires wedges the whole fleet's
// heavy runs, which is strictly worse than the false red it prevents.
describe('pc-heavy.sh — release-gate reserve (EI-19315056231449472)', () => {
  const fakeNprocPath = (cores: number): string => {
    const bin = join(dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'nproc'), `#!/usr/bin/env bash\necho ${cores}\n`, { mode: 0o755 });
    return `${bin}:${process.env.PATH ?? ''}`;
  };
  const slotsLine = (stderr: string) =>
    stderr.split('\n').find((l) => l.includes('[pc-heavy] slots=')) ?? '';
  const probe = (cores: number, extra: Record<string, string> = {}) =>
    runSync(['true'], { PC_HEAVY_DEBUG: '1', PC_HEAVY_COALESCE: '0', PATH: fakeNprocPath(cores), ...extra });

  /** Publish a run-lock in the same shape green-checkpoint's checkpointRunLockDir does:
   *  a `.green-checkpoint-run-<hash>.lock/` DIRECTORY holding owner.json with the run pid. */
  const plantLock = (owner: string | object, name = 'aaa111'): string => {
    const lock = join(dir, 'checkpoint-logs', `.green-checkpoint-run-${name}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner));
    return lock;
  };
  const liveOwner = () => ({ pid: process.pid, startedAt: new Date().toISOString(), token: 'tok' });
  // pid_max is documented as ONE GREATER than the maximum allocatable pid, so it
  // is never a live process — deterministic, unlike reusing a just-reaped pid on
  // a box where PID wrap happens ~daily under fleet load.
  const deadPid = (() => {
    try { return Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()); } catch { return 0x7ffffff0; }
  })();

  it('clamps the effective slot count to a quarter while a run is LIVE', () => {
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
    plantLock(liveOwner());
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
    expect(r.status).toBe(0);
    expect(slotsLine(r.stderr)).toContain('slots=3 fixed=0');
    expect(slotsLine(r.stderr)).toContain('gate=1');
  });

  it('never clamps below 1 — a saturated box at the floor goes to 1, not 0', () => {
    plantLock(liveOwner());
    // floor is 4 on a 128-core box; 4/4 = 1. A 16-core box floors at 2 → also 1.
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '128' }).stderr)).toContain('slots=1 ');
    expect(slotsLine(probe(16, { PC_HEAVY_LOAD1_OVERRIDE: '99' }).stderr)).toContain('slots=1 ');
  });

  it('announces the clamp on stderr even without PC_HEAVY_DEBUG, so a slow run explains itself', () => {
    plantLock(liveOwner());
    const r = runSync(['true'], { PC_HEAVY_COALESCE: '0' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('release gate is JUDGING');
    expect(r.stderr).toContain('PC_HEAVY_GATE_RESERVE=0');
  });

  // ── Fail-open paths. Each of these leaving the clamp ON would wedge every
  // heavy run on the box into 1 slot indefinitely.
  it("FAILS OPEN when the lock is stale — a crashed run's leftover lock has a DEAD pid", () => {
    plantLock({ pid: deadPid, startedAt: new Date().toISOString(), token: 'tok' });
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
    expect(slotsLine(r.stderr)).toContain('slots=12');
    expect(slotsLine(r.stderr)).toContain('gate=0');
    expect(r.stderr).not.toContain('release gate is JUDGING');
  });

  it('FAILS OPEN on an unparseable / pid-less / empty owner.json', () => {
    for (const body of ['not json at all', '{}', '', '{"pid":"banana"}', '{"pid":null}']) {
      rmSync(join(dir, 'checkpoint-logs'), { recursive: true, force: true });
      plantLock(body);
      expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
    }
  });

  it('FAILS OPEN when the checkpoint log dir is absent, or present but holds no lock', () => {
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
    mkdirSync(join(dir, 'checkpoint-logs'), { recursive: true });
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
    // A lock DIRECTORY with no owner.json yet (the run is mid-publish) is also not a clamp.
    mkdirSync(join(dir, 'checkpoint-logs', '.green-checkpoint-run-bbb.lock'), { recursive: true });
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
  });

  it('PC_HEAVY_GATE_RESERVE=0 escapes the clamp entirely', () => {
    plantLock(liveOwner());
    for (const off of ['0', 'off', 'false', 'no']) {
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0', PC_HEAVY_GATE_RESERVE: off });
      expect(slotsLine(r.stderr)).toContain('slots=12');
      expect(r.stderr).not.toContain('release gate is JUDGING');
    }
  });

  it('scans ALL per-root lock dirs — one live run among several dead ones still clamps', () => {
    plantLock({ pid: deadPid }, 'dead1');
    plantLock({ pid: deadPid }, 'dead2');
    plantLock(liveOwner(), 'live1');
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=3');
  });

  it('clamps an explicit PC_HEAVY_SLOTS too — it is a safety reserve, not load adaptation', () => {
    plantLock(liveOwner());
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0', PC_HEAVY_SLOTS: '8' });
    expect(slotsLine(r.stderr)).toContain('slots=2 fixed=1');
  });

  // The ordering property: the exemption at the top of the script returns before
  // any of this, so the gate's OWN suite (and its isolation re-runs, which
  // inherit the env) can never clamp itself down to 1 slot.
  it("never clamps the release gate's own suite (PC_HEAVY_RELEASE_GATE=1)", () => {
    plantLock(liveOwner());
    const marker = join(dir, 'gate-ran');
    const r = runSync(['bash', '-c', `echo "$PC_HEAVY_BYPASS" > "${marker}"`], { PC_HEAVY_RELEASE_GATE: '1' });
    expect(r.status).toBe(0);
    expect(readFileSync(marker, 'utf8').trim()).toBe('1');
    expect(r.stderr).not.toContain('release gate is JUDGING');
    // exempt = no slot machinery touched at all
    expect(existsSync(join(dir, 'slot.0'))).toBe(false);
  });

  it('the clamp actually GATES ADMISSION, not just the reported number', async () => {
    // 128 fake cores at load1 128 → base 4, clamped to 1 by the live lock.
    // Three 0.4s sleepers must therefore never overlap.
    plantLock(liveOwner());
    const jobs = 3;
    const path = fakeNprocPath(128);
    await Promise.all(
      Array.from({ length: jobs }, (_, i) =>
        new Promise<void>((res) => {
          const f = join(dir, `gate.${i}.out`);
          const p = spawn(
            'bash',
            [PC_HEAVY, 'bash', '-c', `s=$(date +%s%3N); sleep 0.4; e=$(date +%s%3N); echo "$s $e" > "${f}"`],
            { env: baseEnv({ PC_HEAVY_LOAD1_OVERRIDE: '128', PC_HEAVY_COALESCE: '0', PATH: path }), cwd: dir },
          );
          p.on('exit', () => res());
        }),
      ),
    );
    const evts: Array<[number, number]> = [];
    for (let i = 0; i < jobs; i++) {
      const [s, e] = readFileSync(join(dir, `gate.${i}.out`), 'utf8').trim().split(/\s+/).map(Number);
      evts.push([s, 1], [e, -1]);
    }
    evts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let max = 0;
    for (const [, d] of evts) { cur += d; max = Math.max(max, cur); }
    expect(max).toBe(1);
  });
});
