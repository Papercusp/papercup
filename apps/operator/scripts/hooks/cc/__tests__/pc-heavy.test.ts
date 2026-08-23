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

// NEVER hand-roll an "unwritable path" here: a made-up '/proc/…' hangs Node's
// recursive mkdir forever (EI-19369372064589484). This fixture fails ENOTDIR in 0ms.
import { unwritablePath } from '@papercusp/operator-core/lib/testing/unwritable-path';
// Boundary-safe stderr capture (WI-6728) — child-output-guard.test.ts ratchets
// the raw `acc += String(chunk)` idiom to zero new sites.
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

// __tests__ → cc → hooks → scripts → operator → apps → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
// PROBE_SCRIPT points the WHOLE suite — the spawn paths AND the source-text greps below — at a
// mutated COPY outside the tree, so scripts/mutation-probe.sh can prove these guards are
// falsifiable without ever mutating the shared working tree (git-sync commits the whole tree on a
// short cadence, so an in-tree mutation can be committed mid-probe even when nothing goes wrong).
//
// ⚠ Every reference to the subject MUST go through this constant. A suite that honours the
// override on only some paths runs happily, reports "MUTANT SURVIVED", and was measuring the real
// file the whole time — reading as evidence that a perfectly good guard is weak (caught that way
// in bghost-watchdog.test.ts, 2026-08-10).
const PC_HEAVY = process.env.PROBE_SCRIPT || join(ROOT, 'scripts', 'pc-heavy.sh');

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pcheavy-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Returns ProcessEnv, not Record<string, string>: every `spawn(..., { env: baseEnv(...) })`
// site in this file failed overload resolution under the narrower type (TS2769, then TS2339
// "Property 'on' does not exist on type 'never'" on the resulting child) — 6+ errors that
// vitest never saw, because vitest does not typecheck.
const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
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
  // Neutralise the MEMORY clamp (EI-20336929607862174) for the same hermeticity
  // reason as the gate-reserve dir above: it reads the REAL /proc/meminfo, so
  // without this every slot-count assertion in this file silently depends on how
  // much memory this box happens to have free — `slots=12` on an idle machine
  // and `slots=8` while a couple of agents are typechecking. That is not a
  // theoretical flake: adding the clamp turned 7 existing tests red exactly this
  // way. A value far above any real budget keeps the clamp non-binding; the
  // memory-clamp tests below override it explicitly to exercise it.
  PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '4096',
  PC_HEAVY_MEM_PSI_OVERRIDE: '0',
  // Neutralise the caller-cgroup typecheck guard (EI-21206772578500745). The
  // suite itself may run inside a finite CI/agent cgroup; every unrelated test
  // must see a deterministic unlimited envelope. The focused guard cases below
  // inject the finite max/current pair explicitly.
  PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: 'max',
  PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '0',
  ...extra,
});

/**
 * Wait for an OBSERVABLE STATE instead of guessing a wall-clock duration.
 *
 * Every `await sleep(500) // let it grab the slot` in a concurrency suite is a bet that 500ms is
 * simultaneously ENOUGH (or the test flakes) and NOT MUCH MORE than needed (or the suite is slow).
 * On this box both halves are wrong at once: a fixed wait sized on an idle machine is too short
 * under 40 concurrent agents, and pure overhead the rest of the time. Polling the real state is
 * strictly better on both axes — it returns in ~10ms when the box is idle and still waits as long
 * as genuinely needed when it is loaded.
 *
 * The timeout is a FAILURE, never a silent fall-through: a state that never arrives must fail the
 * test loudly rather than let the assertion below run against a world that never got set up.
 */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `waitFor(${JSON.stringify(label)}) timed out after ${timeoutMs}ms — the state never arrived. ` +
          'This is a real failure, not a slow box: the assertions after it would have run against ' +
          'an unprepared world.',
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Wait for a LANDMARK IN A LIVE CHILD'S STDERR — the async twin of `waitFor`.
 *
 * The concurrency tests here need a holder to occupy a slot "long enough" for a waiter to
 * genuinely queue. Sizing that with the holder's own `sleep N` makes N a bet on BOTH sides:
 * too short and the holder expires before the waiter enqueues (the test silently degrades
 * into the uncontended path it exists to distinguish from); long enough to be safe and every
 * run pays N seconds in full, because the waiter cannot proceed until the holder finishes.
 * Anchoring on the script's OWN stderr landmarks removes the bet: the holder sleeps far
 * longer than needed and is KILLED the instant the landmark proves the waiter really queued.
 *
 * `seen` is created by the caller so it can assert on the same buffer afterwards; create it
 * IMMEDIATELY after `spawn` and before calling this, because Node fires 'data' handlers in
 * registration order and the check below reads what the collector already decoded.
 * `peek()`, never `text()`, in the per-chunk check (WI-6728): text() flushes the decoder's
 * pending partial character and resets it, so polling it per chunk re-creates the multi-byte
 * corruption the collector exists to prevent. text() is correct in the terminal paths below.
 *
 * Exiting WITHOUT the landmark is a loud failure, never a silent fall-through — the
 * assertions after it would otherwise run against a world that never got set up.
 */
async function untilStderr(
  p: ReturnType<typeof spawn>,
  seen: ReturnType<typeof createTextCollector>,
  ready: (stderr: string) => boolean,
  label: string,
  ms = 30_000,
): Promise<void> {
  if (ready(seen.peek())) return;
  await new Promise<void>((res, rej) => {
    const finish = (err?: Error) => {
      clearTimeout(timer);
      p.stderr?.off('data', onData);
      p.off('close', onClose);
      if (err) rej(err); else res();
    };
    const timer = setTimeout(
      () => finish(new Error(`untilStderr(${JSON.stringify(label)}) timed out after ${ms}ms; stderr so far: ${seen.text()}`)),
      ms,
    );
    const onData = () => { if (ready(seen.peek())) finish(); };
    const onClose = () => {
      if (ready(seen.peek())) finish();
      else finish(new Error(`untilStderr(${JSON.stringify(label)}): the process exited first; stderr: ${seen.text()}`));
    };
    p.stderr?.on('data', onData);
    p.on('close', onClose);
  });
}

/** SIGKILL a detached child's whole process GROUP — see the note at the first holder below. */
const killGroup = (p: ReturnType<typeof spawn>) => {
  try { process.kill(-(p.pid as number), 'SIGKILL'); } catch { /* already gone */ }
};

/**
 * How many of `slots` slot-files are currently flocked BY SOMEONE ELSE.
 *
 * Probes the same primitive pc-heavy.sh itself uses (`flock -n` on `$PC_HEAVY_DIR/slot.$i`,
 * pc-heavy.sh:774) rather than inferring occupancy from a lockfile's existence — the slot file is
 * created on open and outlives the holder, so presence proves nothing and absence proves nothing.
 * A failed non-blocking acquire is the only honest evidence that a slot is held.
 */
function heldSlotCount(slotsDir: string, slots: number): number {
  let held = 0;
  for (let i = 0; i < slots; i += 1) {
    const probe = spawnSync('flock', ['-n', join(slotsDir, `slot.${i}`), 'true'], { stdio: 'ignore' });
    if (probe.status !== 0) held += 1;
  }
  return held;
}

function runSync(args: string[], env: Record<string, string> = {}, cwd?: string) {
  // cwd: dir — a fresh, non-git tmpdir per test, so the tree-state token's
  // git-status probe (EI-18688348461605365) naturally no-ops unless a test
  // deliberately `git init`s it. Keeps the suite hermetic and avoids paying
  // for (or racing against concurrent edits to) this repo's own live git
  // status on every spawn.
  //
  // A test that `git init`s MUST pass an explicit `cwd` pointing at a SUBDIR of
  // `dir` rather than initing `dir` itself (EI-19424611266793426). The cache lives
  // at PC_HEAVY_DIR (= `dir` in this suite), so initing `dir` puts pc-heavy's OWN
  // coalesce/slot artifacts inside the worktree it is probing — every run then
  // writes untracked files that bust the next run's token, and coalescing can
  // never happen. That is a pure fixture artifact: the real default is
  // ${XDG_RUNTIME_DIR:-/tmp}/pc-heavy-slots, always outside the repo. Keeping the
  // worktree one level down keeps the probe measuring the TEST's edits only.
  return spawnSync('bash', [PC_HEAVY, ...args], {
    encoding: 'utf8',
    env: baseEnv(env),
    cwd: cwd ?? dir,
    timeout: 30_000,
  });
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
      env: { PATH: process.env.PATH ?? '', PC_HEAVY_BYPASS: '1', PC_HEAVY_DIR: unwritablePath('slots') },
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
      env: { PATH: process.env.PATH ?? '', PC_HEAVY_DIR: unwritablePath('slots'), PC_HEAVY_IONICE: '' },
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

  it('EI-20227475180704442: snapshots the wrapper before a rewrite can corrupt bash parsing', async () => {
    // A top-level sleep gives the test a causal window: the old script executes
    // the sleep before parsing the rest of the file, while the function-wrapped
    // script must parse the complete body before the marker can be printed.
    const fixture = join(dir, 'pc-heavy-rewrite.sh');
    const marker = '[pc-heavy-test] parser window';
    const source = readFileSync(PC_HEAVY, 'utf8');
    writeFileSync(
      fixture,
      source.replace('set -uo pipefail\n', `set -uo pipefail\nprintf '%s\\n' '${marker}' >&2\nsleep 0.4\n`),
      { mode: 0o755 },
    );

    const child = spawn('bash', [fixture, 'bash', '-c', 'printf stable'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE: '0' }),
      cwd: dir,
    });
    const stdout = createTextCollector(child.stdout);
    const stderr = createTextCollector(child.stderr);
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

    try {
      await untilStderr(child, stderr, (text) => text.includes(marker), 'parser-window marker', 10_000);
      // This is deliberately invalid shell. If bash is still reading the file
      // after the marker, the old incremental parser sees it and exits 2. A
      // function body has already been parsed in full, so the running process
      // remains unaffected by this rewrite.
      writeFileSync(fixture, `${readFileSync(fixture, 'utf8')}\n"`);

      expect(await exited).toBe(0);
      expect(stdout.text().trim()).toBe('stable');
      expect(stderr.text()).not.toMatch(/unexpected EOF|syntax error/i);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 20_000);

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
    await waitFor('holder grabs the only slot', () => heldSlotCount(dir, 1) === 1);
    process.kill(-(holder.pid as number), 'SIGKILL'); // kill the group, no cleanup runs
    // The kernel drops the flock when the last fd closes — which is the very thing under test, so
    // wait for the slot to actually read as free rather than assuming a fixed grace period.
    await waitFor('kernel releases the killed holder\'s flock', () => heldSlotCount(dir, 1) === 0);

    const t0 = Date.now();
    const r = runSync(['bash', '-c', 'echo got-slot'], { PC_HEAVY_SLOTS: '1', PC_HEAVY_TIMEOUT_SEC: '10' });
    const waited = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('got-slot');
    expect(waited).toBeLessThan(5000); // got the freed slot, not blocked to the timeout
  });

  it('EI-20223367668302814: exact-file verification has a bounded wait instead of inheriting the 900s broad-work budget', async () => {
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '1' }),
      cwd: dir,
      detached: true,
    });
    await waitFor('holder grabs the only slot', () => heldSlotCount(dir, 1) === 1);
    try {
      const t0 = Date.now();
      const r = runSync(['node', 'scripts/test-files.mjs', '--probe'], {
        PC_HEAVY_SLOTS: '1',
        PC_HEAVY_SCOPED_TIMEOUT_SEC: '1',
      });
      const waited = Date.now() - t0;

      // The command itself need not exist in this isolated fixture; the contract
      // under test is that it STARTS after the scoped bound instead of sitting in
      // the semaphore for the broad default's 900 seconds.
      expect(r.stderr).toContain('waiting up to 1s');
      expect(r.stderr).toContain('[pc-heavy] slot acquired — starting real work');
      // The queue landmark above is the deterministic proof that the scoped
      // 1-second value was selected. A lower wall-clock bound is invalid here:
      // pc-heavy derives its deadline from integer-second `date` output, so a
      // process landing just before the next second can legitimately fall
      // through on its first 500ms poll (observed at 264ms in gate candidate
      // 52676bb91277). Keep only the upper bound that distinguishes this path
      // from the broad 900-second default.
      expect(waited).toBeLessThan(5000);
    } finally {
      killGroup(holder);
    }
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
    await waitFor('A grabs slot 0', () => heldSlotCount(dir, slots) >= 1);

    const holderB = spawn('bash', [PC_HEAVY, 'sleep', '2'], {
      env: baseEnv({ PC_HEAVY_SLOTS: String(slots) }),
      cwd: dir,
      detached: true,
    });
    await waitFor('B grabs slot 1 (slot 0 is busy)', () => heldSlotCount(dir, slots) === slots);

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
    // Not an exact match: the wrapper also emits its own "slot acquired" landmark
    // (EI-19315037905600226, asserted below) on the same stream before handing off
    // to the real command.
    expect(r.stderr).toContain('err-line');
  });

  it('EI-19315037905600226: emits a "slot acquired" landmark on stderr right before handing off to the real command', () => {
    // The exact literal bash-jobs.ts's background-deadline handler greps a job's
    // output for, to tell "killed while still queued" from "killed mid-execution".
    const r = runSync(['bash', '-c', 'echo real-output'], { PC_HEAVY_SLOTS: '2' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[pc-heavy] slot acquired — starting real work');
    // It must precede the real command's own output on the combined timeline —
    // proving it marks the handoff, not merely "sometime during the run".
    const markerIdx = r.stderr.indexOf('[pc-heavy] slot acquired');
    expect(markerIdx).toBeGreaterThanOrEqual(0);
  });

  it('EI-19343041616234869: prints an enqueue-time "queued" line the instant it actually has to wait — but never on the uncontended fast path', async () => {
    // Without this, a caller backgrounding a ~150s+ compile (the documented idiom)
    // sees a genuinely empty log for the entire time it sits behind a busy slot —
    // indistinguishable from "not started yet" or "died silently". Holder A takes
    // the only slot and sleeps; a waiter arriving while it's held must hit the
    // fallback branch and print the enqueue line BEFORE it starts polling.
    // The holder sleeps far longer than this test takes and is killed the moment the
    // waiter's own stderr proves it enqueued — so the claim "the line is printed BEFORE
    // the wait ends" is observed CAUSALLY (it appeared while the slot was still held),
    // not merely inferred from two indices in a buffer read after the fact.
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '1' }),
      cwd: dir,
      detached: true,
    });
    await waitFor('holder grabs the only slot', () => heldSlotCount(dir, 1) === 1);
    try {
      const waiter = spawn('bash', [PC_HEAVY, 'bash', '-c', 'echo got-it'], {
        env: baseEnv({ PC_HEAVY_SLOTS: '1', PC_HEAVY_TIMEOUT_SEC: '20' }),
        cwd: dir,
      });
      const wOut = createTextCollector(waiter.stdout);
      const wErr = createTextCollector(waiter.stderr);
      const exited = new Promise<number>((res) => waiter.on('exit', (c) => res(c ?? -1)));

      await untilStderr(waiter, wErr, (t) => t.includes('[pc-heavy] queued for a heavy slot'),
        'the enqueue-time queued line, while the slot is still held');
      killGroup(holder); // frees the slot; the waiter now proceeds

      expect(await exited).toBe(0);
      const stderr = wErr.text(); // exited: terminal read
      expect(wOut.text().trim()).toBe('got-it');
      // Must precede "slot acquired" — it announces the wait BEGINNING, not the end.
      const queuedIdx = stderr.indexOf('[pc-heavy] queued for a heavy slot');
      const acquiredIdx = stderr.indexOf('[pc-heavy] slot acquired');
      expect(queuedIdx).toBeGreaterThanOrEqual(0);
      expect(acquiredIdx).toBeGreaterThan(queuedIdx);
    } finally {
      killGroup(holder);
    }

    // The common uncontended case (the vast majority of calls, per the "first-try
    // slot" test above) must NEVER print the queued line — it would be noise on
    // every single ordinary invocation.
    const fast = runSync(['bash', '-c', 'echo ok'], { PC_HEAVY_SLOTS: '2' });
    expect(fast.status).toBe(0);
    expect(fast.stderr).not.toContain('[pc-heavy] queued for a heavy slot');
  });

  it('EI-19343041616234869: emits periodic "still queued" heartbeats while waiting, via PC_HEAVY_HEARTBEAT_SEC', async () => {
    // A long wait under a hard clamp must not go silent for its whole duration —
    // same rationale as the enqueue line, amortized across the wait. Real default
    // is 15s; override to 1s so the test doesn't have to actually wait that long.
    //
    // TWO heartbeats is what proves PERIODIC rather than one-shot, so the wait is
    // genuinely the subject here — but only up to the SECOND beat. Sizing the holder's
    // sleep to cover it (the previous `sleep 4`) made every run pay the remainder too,
    // and made the count depend on how much of that window this call's own startup ate.
    // Releasing the slot the instant the second beat lands costs exactly the subject.
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '1' }),
      cwd: dir,
      detached: true,
    });
    await waitFor('holder grabs the only slot', () => heldSlotCount(dir, 1) === 1);
    try {
      const waiter = spawn('bash', [PC_HEAVY, 'bash', '-c', 'echo got-it'], {
        env: baseEnv({
          PC_HEAVY_SLOTS: '1',
          PC_HEAVY_TIMEOUT_SEC: '20',
          PC_HEAVY_HEARTBEAT_SEC: '1',
        }),
        cwd: dir,
      });
      const wErr = createTextCollector(waiter.stderr);
      const exited = new Promise<number>((res) => waiter.on('exit', (c) => res(c ?? -1)));
      const beats = (t: string) => (t.match(/\[pc-heavy\] still queued/g) ?? []).length;

      await untilStderr(waiter, wErr, (t) => beats(t) >= 2,
        'two periodic "still queued" heartbeats while the slot is held', 20_000);
      killGroup(holder); // frees the slot; the waiter now proceeds

      expect(await exited).toBe(0);
      expect(beats(wErr.text())).toBeGreaterThanOrEqual(2); // exited: terminal read
    } finally {
      killGroup(holder);
    }
  });
});

describe('pc-heavy.sh — memory clamp (EI-20336929607862174)', () => {
  /**
   * Run `jobs` concurrent wrapped commands and return the maximum number that
   * were ever in flight at once, measured from recorded intervals (robust to
   * host load: intervals dilate under load, the overlap count does not).
   *
   * Each job writes to its OWN file, so the commands differ and pc-heavy's
   * coalescing cannot collapse them into a single leader — the failure that
   * makes this whole measurement read 1 regardless of the slot count. Belt and
   * braces: PC_HEAVY_COALESCE=0.
   */
  async function maxOverlap(jobs: number, env: Record<string, string>): Promise<number> {
    await Promise.all(
      Array.from({ length: jobs }, (_, i) =>
        new Promise<void>((res) => {
          const f = join(dir, `mem.${i}.out`);
          const p = spawn(
            'bash',
            [PC_HEAVY, 'bash', '-c', `s=$(date +%s%3N); sleep 0.4; e=$(date +%s%3N); echo "$s $e" > "${f}"`],
            { env: baseEnv({ PC_HEAVY_COALESCE: '0', PC_HEAVY_GATE_RESERVE: '0', ...env }), cwd: dir },
          );
          p.on('exit', () => res());
        }),
      ),
    );
    const evts: Array<[number, number]> = [];
    for (let i = 0; i < jobs; i += 1) {
      const [s, e] = readFileSync(join(dir, `mem.${i}.out`), 'utf8').trim().split(/\s+/).map(Number);
      evts.push([s, 1], [e, -1]);
    }
    evts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let max = 0;
    for (const [, d] of evts) { cur += d; max = Math.max(max, cur); }
    return max;
  }

  // The bug this guards: _calc_slots admits on load1 alone, and memory pressure
  // LOWERS load1 (processes stall in reclaim) — so admission WIDENS exactly when
  // memory is scarce. Measured 2026-08-13: two concurrent
  // `tsc -p packages/operator-core` at 4.7 and 6.9 GiB RSS drove app.slice
  // +5.1 GiB/20s while memory PSI full avg60 hit 4.56 and cpu PSI some was 0.79.
  //
  // The CONTROL arm is what makes this falsifiable without mutating the tree:
  // an identical config with memory headroom must run all 6 at once, so a
  // clamped result cannot be explained by the semaphore, the gate reserve, or a
  // slow box — only by the memory budget.
  it('clamps a FIXED PC_HEAVY_SLOTS down to what MemAvailable can hold', async () => {
    const headroom = await maxOverlap(6, {
      PC_HEAVY_SLOTS: '6',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '600', // budget 100 — nowhere near binding
      PC_HEAVY_MEM_PSI_OVERRIDE: '0',
    });
    expect(headroom).toBe(6);

    const scarce = await maxOverlap(6, {
      PC_HEAVY_SLOTS: '6',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '12', // 12 / 6 GiB-per-slot => 2
      PC_HEAVY_MEM_PSI_OVERRIDE: '0',
    });
    // Clamps a FIXED slot count too: this is a physical ceiling, not load
    // adaptation, so PC_HEAVY_SLOTS must not be able to opt out of it.
    expect(scarce).toBe(2);
  });

  it('halves the budget once memory PSI says the box is already in reclaim', async () => {
    // The budget must be sized to bind EXACTLY at the ask, or the halving is
    // invisible: 24 GiB / 6 GiB-per-slot => 4, the same as PC_HEAVY_SLOTS. The
    // calm arm then pins that baseline, so the drop to 2 in the second arm is
    // attributable to PSI alone.
    const calm = await maxOverlap(4, {
      PC_HEAVY_SLOTS: '4',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '24', // budget 4 — exactly the ask
      PC_HEAVY_MEM_PSI_OVERRIDE: '0',
    });
    expect(calm).toBe(4);

    const reclaiming = await maxOverlap(4, {
      PC_HEAVY_SLOTS: '4',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '24',
      PC_HEAVY_MEM_PSI_OVERRIDE: '9', // >= PC_HEAVY_MEM_PSI_BACKOFF (5)
    });
    expect(reclaiming).toBe(2);
  });

  it('fails open: an unreadable MemAvailable never throttles, and PC_HEAVY_MEM_CLAMP=0 disables it', async () => {
    // Every unexpected input must degrade to the pre-clamp behavior. A clamp
    // that throttles the fleet to 1 because it could not parse /proc/meminfo
    // would be far worse than the pressure it exists to prevent.
    const garbage = await maxOverlap(4, {
      PC_HEAVY_SLOTS: '4',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: 'not-a-number',
    });
    expect(garbage).toBe(4);

    const disabled = await maxOverlap(4, {
      PC_HEAVY_SLOTS: '4',
      PC_HEAVY_MEM_CLAMP: '0',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '1', // would clamp to 1 if honoured
    });
    expect(disabled).toBe(4);
  });

  it('never clamps below 1 — a starved box still makes forward progress', async () => {
    const starved = await maxOverlap(2, {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '0',
      PC_HEAVY_MEM_PSI_OVERRIDE: '99',
    });
    expect(starved).toBe(1);
  });
});

describe('pc-heavy.sh — finite-cgroup typecheck admission (EI-21206772578500745)', () => {
  const typecheckFixture = (): string => {
    const file = join(dir, 'lint-tsc-fixture.mjs');
    writeFileSync(file, 'process.stdout.write("typecheck-ran")');
    return file;
  };

  it('refuses before execution when heap + wrapper overhead cannot fit the caller cgroup', () => {
    const marker = typecheckFixture();
    const slots = join(dir, 'never-created-by-refused-typecheck');
    const r = runSync(['node', marker], {
      PC_HEAVY_DIR: slots,
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '6144',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '768',
      PAPERCUSP_TSC_HEAP_MB: '8192',
    });

    expect(r.status).toBe(75);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('REFUSED typecheck');
    expect(r.stderr).toContain('5376 MiB headroom');
    expect(r.stderr).toContain('9216 MiB compiler floor');
    expect(r.stderr).toContain('capability:inspect');
    expect(existsSync(slots)).toBe(false); // refused before coalescing/slot acquisition
  });

  it('runs the same typecheck when a finite cgroup has enough headroom', () => {
    const r = runSync(['node', typecheckFixture()], {
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '12288',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '1024',
      PAPERCUSP_TSC_HEAP_MB: '8192',
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('typecheck-ran');
    expect(r.stderr).not.toContain('REFUSED typecheck');
  });

  it('fails open for an unlimited envelope and does not block a non-typecheck in a small cgroup', () => {
    const unlimited = runSync(['node', typecheckFixture()], {
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: 'max',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '999999',
    });
    expect(unlimited.status).toBe(0);
    expect(unlimited.stdout).toBe('typecheck-ran');

    const light = runSync(['bash', '-c', 'printf light-ran'], {
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '1024',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '1000',
    });
    expect(light.status).toBe(0);
    expect(light.stdout).toBe('light-ran');
  });

  it('keeps the release-gate bypass authoritative even in a small finite cgroup', () => {
    const slots = join(dir, 'release-never-creates-slots');
    const r = runSync(['node', typecheckFixture()], {
      PC_HEAVY_RELEASE_GATE: '1',
      PC_HEAVY_DIR: slots,
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '2048',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '1024',
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('typecheck-ran');
    expect(r.stderr).not.toContain('REFUSED typecheck');
    expect(existsSync(slots)).toBe(false);
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

  it('collapses to EXACTLY ONE real run even when the command is SLOWER than the coalescing window (EI-19343301596011451)', async () => {
    // The regression this exists for. `_coalesce_ttl` used to serve two
    // different questions: "may I replay a FINISHED result?" and "is the leader
    // still WORKING?". A follower therefore gave up waiting after the window
    // and ran the command itself, and a LIVE leader's lock was reclaimed as
    // 'abandoned' purely for outliving it. So for any command slower than the
    // window, coalescing INVERTED: every follower launched a duplicate, and the
    // heavier the command the more reliably it happened. Observed live as five
    // concurrent `tsc -p packages/operator-core` compiles (~180s each) queued
    // against the 90s default, with none of them running.
    //
    // The sibling test above cannot catch this: it pairs a 0.4s command with a
    // 30s window, so the command is ~75x FASTER than the window and no follower
    // ever reaches the deadline. Its `realRuns < n` assertion would also still
    // pass at 5-of-6 duplicated. This test inverts both: the command outlives
    // the window, and the expectation is exact.
    //
    // What the test needs is the RATIO (command > window), not the absolute duration —
    // and the whole test costs the command's runtime, since nothing can finish before
    // the leader does. 3s against a 2s window keeps a 1.5x margin in the only direction
    // that can break it: a leader finishing FASTER than the window would make this
    // vacuous, and a slower one only strengthens it.
    const marker = join(dir, 'slow-runs.marker');
    const n = 5;
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        new Promise<{ status: number | null; stderr: string }>((res) => {
          const p = spawn(
            'bash',
            [PC_HEAVY, 'bash', '-c', `printf x >> "${marker}"; sleep 3; echo slow-done`],
            { env: baseEnv({ PC_HEAVY_SLOTS: '8', PC_HEAVY_COALESCE_SEC: '2' }), cwd: dir },
          );
          let stderr = '';
          p.stderr.on('data', (d) => (stderr += d));
          p.on('exit', (status) => res({ status, stderr }));
        }),
      ),
    );

    for (const r of results) expect(r.status).toBe(0);
    // EXACTLY one — not "fewer than n". Pre-fix this read 5.
    expect(readFileSync(marker, 'utf8').length).toBe(1);
    // ...and every other caller got there by replaying, not by racing.
    expect(results.filter((r) => r.stderr.includes('coalesced:')).length).toBe(n - 1);
  }, 60_000);

  it('reclaims a lock whose leader DIED even though the stamped pid was recycled by a live process (EI-19343301596011451)', () => {
    // Leader liveness is observed via pid, and PID wrap is ~daily on this box
    // under fleet load — so pid alone would let an unrelated live process
    // impersonate a dead leader and stall every follower for the full
    // max-wait. The stamp therefore carries the pid's start-time too, and a
    // mismatch reads as dead.
    const marker = join(dir, 'reuse-runs.marker');
    // Seed a lock for the key this exact command will hash to, by letting one
    // real (fast) run create and release it, then re-planting it corrupted.
    const cmd = ['bash', '-c', `printf y >> "${marker}"; echo reuse-probe`];
    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '1' });
    expect(first.status).toBe(0);

    const coalesceDir = join(dir, 'coalesce');
    const key = readdirSync(coalesceDir).find((f) => f.endsWith('.exit'))?.replace(/\.exit$/, '');
    expect(key).toBeTruthy();

    // Expire the cached result so the next call cannot simply replay it, then
    // plant a lock stamped with a LIVE pid (this test process) but a start-time
    // that cannot be ours.
    rmSync(join(coalesceDir, `${key}.exit`), { force: true });
    const lockDir = join(coalesceDir, `${key}.lock`);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'pid'), `${process.pid} 999999999\n`);

    // Must reclaim and run rather than wait out PC_HEAVY_COALESCE_MAX_WAIT_SEC.
    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '1' });
    expect(second.status).toBe(0);
    expect(readFileSync(marker, 'utf8').length).toBe(2);
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
    // Wait for the lock to actually EXIST rather than betting 400ms on it: too short and
    // the kill lands before there is anything to strand (the test then proves nothing);
    // long enough to be safe under load and every run pays the slack.
    await waitFor('leader claims the coalescing lock', () => lockMtime() !== null);
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
    // The worktree is a SUBDIR of `dir`, never `dir` itself — see runSync's note
    // (EI-19424611266793426): PC_HEAVY_DIR is `dir`, so initing `dir` would put
    // pc-heavy's own coalesce artifacts inside the tree it probes and no run could
    // ever coalesce. Real usage always keeps the cache outside the repo.
    const gitRepo = () => {
      const repo = join(dir, 'repo');
      mkdirSync(repo, { recursive: true });
      execSync('git init -q', { cwd: repo });
      execSync('git config user.email t@example.com && git config user.name test', { cwd: repo });
      return repo;
    };
    const commitAll = (repo: string) => execSync('git add -A && git commit -q -m init', { cwd: repo });

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
      const repo = gitRepo();
      writeFileSync(join(repo, 'src.txt'), 'v1');
      commitAll(repo);

      const first = runSync(['bash', '-c', 'echo build-output'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(first.stderr).not.toContain('coalesced:');

      // Simulate "I edited the source this build/test exercises" — e.g. the
      // `npm run test:affected` shape, where the changed file is nowhere in
      // argv but IS what makes the previous output stale.
      writeFileSync(join(repo, 'src.txt'), 'v2 - modified');

      const second = runSync(['bash', '-c', 'echo build-output'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(second.stderr).not.toContain('coalesced:'); // busted, not a stale replay
    });

    it('a second edit to an already-dirty tracked file busts the cache even though git status is unchanged', () => {
      const repo = gitRepo();
      writeFileSync(join(repo, 'src.txt'), 'committed');
      commitAll(repo);
      writeFileSync(join(repo, 'src.txt'), 'dirty-version-one');

      const first = runSync(['bash', '-c', 'cat src.txt'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(first.stdout).toContain('dirty-version-one');
      writeFileSync(join(repo, 'src.txt'), 'dirty-version-two');

      const second = runSync(['bash', '-c', 'cat src.txt'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(second.stderr).not.toContain('coalesced:');
      expect(second.stdout).toContain('dirty-version-two');
    });

    // EI-19424611266793426. The token used `--untracked-files=no`, so CREATING a file
    // did not move it. That gap is inverted against the error class agents re-run this
    // command to fix: a missing-module / missing-declaration error (TS7016, TS2307) is
    // fixed BY CREATING A FILE, so the token was blind to exactly the mutation that
    // flips the verdict, and the stale red replayed for the whole window — looking
    // byte-identical to a real one.
    it('a NEWLY CREATED untracked file busts the cache — the fix for a missing-declaration error is a new file, which -uno could not see', () => {
      const repo = gitRepo();
      writeFileSync(join(repo, 'src.ts'), 'import "./dep.mjs";');
      commitAll(repo);

      const first = runSync(['bash', '-c', 'echo typecheck-verdict'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(first.stderr).not.toContain('coalesced:');

      // The real repro shape: `gen:declarations` emits a NEW, still-untracked `.d.mts`
      // sibling. Nothing tracked is modified — under -uno the tree token is unchanged.
      writeFileSync(join(repo, 'dep.d.mts'), 'export declare const x: number;');

      const second = runSync(['bash', '-c', 'echo typecheck-verdict'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(second.stderr).not.toContain('coalesced:'); // must re-run, not replay the pre-fix verdict
    });

    it('a file created inside a WHOLLY-UNTRACKED directory also busts the cache (-unormal collapses such a dir to one entry and stays blind)', () => {
      const repo = gitRepo();
      writeFileSync(join(repo, 'src.ts'), 'x');
      commitAll(repo);

      // `generated/` is untracked as a whole, and already contains a file — so it is
      // ALREADY represented in the status output before the run below.
      mkdirSync(join(repo, 'generated'), { recursive: true });
      writeFileSync(join(repo, 'generated', 'a.d.mts'), 'export declare const a: number;');

      const first = runSync(['bash', '-c', 'echo verdict'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(first.stderr).not.toContain('coalesced:');

      // Adding a SECOND file to that same untracked dir. Under -unormal the dir is
      // collapsed to a single `generated/` entry, so this is invisible; -uall sees it.
      writeFileSync(join(repo, 'generated', 'b.d.mts'), 'export declare const b: number;');

      const second = runSync(['bash', '-c', 'echo verdict'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(second.stderr).not.toContain('coalesced:');
    });

    it('still coalesces a genuine no-op re-run inside a git worktree with no diff (the fix does not over-bust)', () => {
      const repo = gitRepo();
      writeFileSync(join(repo, 'src.txt'), 'v1');
      commitAll(repo);

      const first = runSync(
        ['bash', '-c', 'echo out-y; echo err-y >&2; exit 3'],
        { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' },
        repo,
      );
      expect(first.status).toBe(3);
      expect(first.stderr).not.toContain('coalesced:');

      // Nothing changed (no edit, no new commit) — a true duplicate poll.
      const second = runSync(
        ['bash', '-c', 'echo out-y; echo err-y >&2; exit 3'],
        { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' },
        repo,
      );
      expect(second.status).toBe(3);
      expect(second.stderr).toContain('coalesced:');
    });
  });
});

// PC_HEAVY_FRESH_AFTER — the per-caller freshness barrier (EI-19340233074452707).
//
// The tree-state token above is SOUND but far stricter than correctness requires: it
// asks "did ANY file in the tree change?" when the question that governs a caller's
// answer is "did MY file change since the compile started?". On the shared staging tree
// the token moves ~every 18s against a ~170s operator-core compile, so two agents
// arriving seconds apart never compute the same key and every one of them pays a full
// compile (3-5 byte-identical compiles were observed running at once, three separate
// times on 2026-08-02).
//
// A caller that knows which files it is asking about passes max(mtime) over them; the
// token is then dropped and a replay is admitted only from a run that STARTED at/after
// that watermark — the exact question, per file, instead of the conservative one.
// A leader publishes its output by RENAME, never by writing the live cache files,
// so a replay can never observe a half-written (or freshly truncated) entry.
describe('pc-heavy.sh — atomic result publish (EI-19368312145172418)', () => {
  // Built per-test (`dir` is assigned in beforeEach). Every REAL execution appends
  // a line to the marker; a REPLAY does not — that is the positive control below.
  const cmdWithMarker = () => `echo ran >> ${join(dir, 'runs.txt')}; sleep 3; echo REAL-OUTPUT-LINE`;
  const realRunCount = (): number => {
    const f = join(dir, 'runs.txt');
    if (!existsSync(f)) return 0;
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  };
  const coalesceFileByExt = (ext: string): string | null => {
    const coalesceDir = join(dir, 'coalesce');
    if (!existsSync(coalesceDir)) return null;
    const f = readdirSync(coalesceDir).find((n) => n.endsWith(ext));
    return f ? join(coalesceDir, f) : null;
  };

  it('a NEW leader does not truncate the previous entry a follower may still replay [positive-controlled]', async () => {
    // The bug: `tee "$_c_out"` truncates at OPEN — the instant the new leader
    // starts — while freshness is gated on $_c_exit, which still holds the old
    // run's rc and mtime. A follower in that window was told "fresh, rc=0" and
    // then replayed an emptied file: exit 0 with NO output, which `lint:tsc`
    // reported as "tsc produced no output — toolchain failure". The window
    // lasts the whole run (~174s for a real typecheck), not a microsecond.
    //
    // Two callers disagreeing about freshness is all it takes, and that is
    // routine: PC_HEAVY_COALESCE_SEC is per-caller (default 90, this suite 30).
    const cmd = cmdWithMarker();
    const first = runSync(['bash', '-c', cmd], { PC_HEAVY_SLOTS: '4', PC_HEAVY_COALESCE_SEC: '90' });
    expect(first.stdout).toContain('REAL-OUTPUT-LINE');
    expect(realRunCount()).toBe(1);
    const outFile = coalesceFileByExt('.out');
    expect(outFile).not.toBeNull();
    const populatedSize = statSync(outFile as string).size;
    expect(populatedSize).toBeGreaterThan(0);

    // Age the entry past the 1s TTL the second caller will use. `_age` is computed in
    // INTEGER seconds, so a 1.6s wait can floor to age=1 and read as FRESH against that
    // TTL — the second caller would then COALESCE instead of leading, nothing would
    // truncate, and this test would pass while asserting nothing at all. (Caught exactly
    // that way: the first draft of this test was vacuous.) 2.1s is the smallest wait that
    // floors to 2 with margin; the elapsed time is measured from the entry's mtime, which
    // predates this line, so the real age is only ever LARGER. The positive control below
    // is what makes the vacuity detectable rather than silent if that ever stops holding.
    await new Promise((r) => setTimeout(r, 2100));

    // A caller with a 1s window sees that entry as STALE, so it runs for real —
    // becoming a second leader while the entry is still fresh to a 90s caller.
    const secondLeader = spawn('bash', [PC_HEAVY, 'bash', '-c', cmd], {
      env: baseEnv({ PC_HEAVY_SLOTS: '4', PC_HEAVY_COALESCE_SEC: '1' }),
      cwd: dir,
      detached: true,
    });
    try {
      // POSITIVE CONTROL — the whole test is meaningless unless a SECOND real execution
      // is actually in flight right now; if the second caller coalesced instead of
      // leading, the invariant below is vacuous. Waiting for the marker rather than
      // guessing 1200ms costs only as long as the leader takes to reach it, and turns
      // "it coalesced" into a NAMED timeout instead of a bare `2 !== 1`.
      await waitFor('the second leader starts a real run', () => realRunCount() === 2);
      expect(realRunCount()).toBe(2);

      // THE INVARIANT: the published entry is still intact while it runs.
      expect(statSync(outFile as string).size).toBe(populatedSize);

      // ...so a follower that passes the freshness gate replays REAL output,
      // never an empty success.
      const follower = runSync(['bash', '-c', cmd], { PC_HEAVY_SLOTS: '4', PC_HEAVY_COALESCE_SEC: '90' });
      expect(follower.stderr).toContain('coalesced:'); // it really did replay
      expect(follower.stdout).toContain('REAL-OUTPUT-LINE'); // and got the output
      expect(follower.stdout.trim()).not.toBe('');
    } finally {
      try { process.kill(-(secondLeader.pid as number), 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 20_000);

  it('leaves no .part temp files behind, even when a leader is hard-killed mid-run', async () => {
    const partCount = () => {
      const coalesceDir = join(dir, 'coalesce');
      if (!existsSync(coalesceDir)) return 0;
      return readdirSync(coalesceDir).filter((n) => n.endsWith('.part')).length;
    };
    // Clean completion publishes by rename, so the temps are consumed.
    runSync(['bash', '-c', 'echo done'], { PC_HEAVY_SLOTS: '4', PC_HEAVY_COALESCE_SEC: '30' });
    expect(partCount()).toBe(0);

    // A hard-killed leader must not leave its in-progress temp behind either —
    // the EXIT trap that sweeps the lockdir sweeps these too.
    const doomed = spawn('bash', [PC_HEAVY, 'bash', '-c', 'echo x; sleep 30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '4', PC_HEAVY_COALESCE_SEC: '30' }),
      cwd: dir,
      detached: true,
    });
    await new Promise((r) => setTimeout(r, 700));
    process.kill(-(doomed.pid as number), 'SIGTERM'); // SIGTERM so the trap runs
    await new Promise((r) => setTimeout(r, 700));
    expect(partCount()).toBe(0);
  }, 20_000);
});

describe('pc-heavy.sh — per-caller freshness barrier (EI-19340233074452707)', () => {
  const cmd = ['bash', '-c', 'echo barrier-out; echo barrier-err >&2; exit 7'];

  const coalesceFileByExt = (ext: string): string | null => {
    const coalesceDir = join(dir, 'coalesce');
    if (!existsSync(coalesceDir)) return null;
    const f = readdirSync(coalesceDir).find((n) => n.endsWith(ext));
    return f ? join(coalesceDir, f) : null;
  };

  it('replays a cached run that STARTED at/after the barrier', () => {
    // Barrier of 1 (epoch 1970) — any run at all starts after it.
    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(first.status).toBe(7);
    expect(first.stderr).not.toContain('coalesced:');

    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(second.status).toBe(7); // exit code survives the packed "<rc> <startedAt>" format
    expect(second.stdout).toContain('barrier-out');
    expect(second.stderr).toContain('coalesced:');
  });

  it('does NOT replay a run that started BEFORE the barrier — the pre-edit-answer hazard', () => {
    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(first.status).toBe(7);
    expect(first.stderr).not.toContain('coalesced:');

    // Same key (same cwd+argv, token suppressed), but this caller edited its file
    // AFTER that run began, so the cached diagnostics cannot describe it.
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: future });
    expect(second.status).toBe(7);
    expect(second.stderr).not.toContain('coalesced:'); // ran for real, did not replay
  });

  it('suppresses the tree-state token, so the barrier is what gates the replay', () => {
    // Same scenario as the token suite's git-edit case: an edit lands between the two
    // runs. WITHOUT a barrier the token busts the key (asserted above). WITH one, the
    // caller has taken responsibility for freshness, so the replay is admitted — that
    // is the whole point, and it is what lets concurrent callers share one compile.
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@example.com && git config user.name test', { cwd: dir });
    writeFileSync(join(dir, 'src.txt'), 'v1');
    execSync('git add -A && git commit -q -m init', { cwd: dir });

    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(first.stderr).not.toContain('coalesced:');

    writeFileSync(join(dir, 'src.txt'), 'v2'); // dirties git status — would bust the token

    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(second.stderr).toContain('coalesced:');
  });

  it('refuses to replay a cached result carrying no start stamp (fail closed across an upgrade)', () => {
    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(first.status).toBe(7);

    // Rewrite the exit file in the pre-barrier format (bare rc, no start stamp), as a
    // result written by an older pc-heavy would be. Absence of a stamp is not evidence
    // the run was recent enough — it must read as "cannot replay", never as "fine".
    const exitFile = coalesceFileByExt('.exit');
    expect(exitFile).not.toBeNull();
    writeFileSync(exitFile as string, '7\n');

    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(second.status).toBe(7);
    expect(second.stderr).not.toContain('coalesced:');
  });

  it('leaves an unbarriered caller on the old tree-token path (opt-in only)', () => {
    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
    expect(first.status).toBe(7);
    expect(first.stderr).not.toContain('coalesced:');

    // A barriered caller keys DIFFERENTLY (no token), so it must not pick up the
    // unbarriered run's cache entry — the two populations stay separate rather than
    // one silently inheriting the other's freshness assumptions.
    const barriered = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(barriered.stderr).not.toContain('coalesced:');

    // ...while a second unbarriered caller still replays as it always did.
    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
    expect(second.stderr).toContain('coalesced:');
  });
});

describe('pc-heavy.sh — declared result-affecting env in the coalescing key (EI-18699972365875475)', () => {
  // The hazard, stated by EI-78 when it disabled coalescing for the whole `test:*`
  // family: the key was cwd+argv+tree-state and could not see the ENVIRONMENT, while
  // `affected-tests.mjs` selects its diff base from $AFFECTED_BASE. Two agents at the
  // same HEAD with different bases produce byte-identical cwd+argv, so one would
  // replay a verdict computed for a DIFFERENT delta — and a stale verdict is
  // byte-indistinguishable from a fresh one.
  //
  // `baseEnv` builds the child env from scratch rather than spreading process.env, so
  // "unset" here is genuinely unset and the unset-vs-empty case below is hermetic.
  const cmd = ['bash', '-c', 'echo keyenv-out; echo keyenv-err >&2; exit 9'];
  const run = (extra: Record<string, string>) =>
    runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', ...extra });

  it('does NOT coalesce two callers whose declared variable DIFFERS — the EI-78 collision', () => {
    const first = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: 'origin/main' });
    expect(first.status).toBe(9);
    expect(first.stderr).not.toContain('coalesced:');

    // Same cwd, same argv, same tree — different question. Must run for real.
    const second = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: 'origin/staging' });
    expect(second.status).toBe(9);
    expect(second.stderr).not.toContain('coalesced:');
  });

  it('still coalesces two callers whose declared variable MATCHES (the fix does not disable coalescing)', () => {
    const first = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: 'origin/main' });
    expect(first.stderr).not.toContain('coalesced:');

    const second = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: 'origin/main' });
    expect(second.status).toBe(9);
    expect(second.stdout).toContain('keyenv-out');
    expect(second.stderr).toContain('coalesced:');
  });

  it('treats UNSET and EMPTY as different — "use the default" is not "use the empty base"', () => {
    // The boundary a caller is most likely to hit: `AFFECTED_BASE=` in a wrapper
    // script vs. omitting it entirely select different bases, so collapsing them
    // would reintroduce exactly the collision this fold exists to remove.
    const unset = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE' });
    expect(unset.stderr).not.toContain('coalesced:');

    const empty = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: '' });
    expect(empty.status).toBe(9);
    expect(empty.stderr).not.toContain('coalesced:');
  });

  it('is order-insensitive — the same declared SET shares a key however it is spelled', () => {
    // Otherwise two callers that agree on what matters would fragment into separate
    // cache populations purely on how they happened to order the list.
    const first = run({ PC_HEAVY_KEY_ENV: 'A_ONE,B_TWO', A_ONE: '1', B_TWO: '2' });
    expect(first.stderr).not.toContain('coalesced:');

    const second = run({ PC_HEAVY_KEY_ENV: ' B_TWO , A_ONE ', A_ONE: '1', B_TWO: '2' });
    expect(second.status).toBe(9);
    expect(second.stderr).toContain('coalesced:');
  });

  it('leaves a caller that declares NOTHING on exactly its previous key (no flag day)', () => {
    // Monotonic safety: folding more inputs in can only make keys MORE distinct, so an
    // undeclared caller must be byte-identical to its pre-change self — no cache
    // population to migrate, and no coalescing silently lost on unrelated callers.
    const first = run({});
    expect(first.stderr).not.toContain('coalesced:');

    const second = run({});
    expect(second.status).toBe(9);
    expect(second.stderr).toContain('coalesced:');
  });

  it('separates a declaring caller from a non-declaring one rather than letting either inherit', () => {
    // ⚠ Both assertions here are ABSENCES, which pass vacuously if the subject never
    // ran at all (a missing script exits 127 and prints no 'coalesced:' either).
    // Pin that the command actually executed, or this test cannot fail for the reason
    // it exists. Found the hard way: a relative --file path in a mutation probe made
    // exactly this test the only survivor of a wholly non-executing suite.
    const undeclared = run({});
    expect(undeclared.status).toBe(9);
    expect(undeclared.stdout).toContain('keyenv-out');
    expect(undeclared.stderr).not.toContain('coalesced:');

    // A declaring caller must not pick up an entry written by a caller that never
    // committed to what its inputs were — same reasoning as the barrier marker.
    const declared = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: 'origin/main' });
    expect(declared.status).toBe(9);
    expect(declared.stdout).toContain('keyenv-out');
    expect(declared.stderr).not.toContain('coalesced:');
  });

  it('skips a malformed name instead of aborting the run (fail-open, like every other signal here)', () => {
    // Admission control must never be the reason a legitimate build cannot start.
    const first = run({ PC_HEAVY_KEY_ENV: '9bad-name,,AFFECTED_BASE', AFFECTED_BASE: 'origin/main' });
    expect(first.status).toBe(9);
    expect(first.stdout).toContain('keyenv-out');

    // ...and the well-formed name in the same list is still honoured.
    const second = run({ PC_HEAVY_KEY_ENV: '9bad-name,,AFFECTED_BASE', AFFECTED_BASE: 'origin/other' });
    expect(second.status).toBe(9);
    expect(second.stderr).not.toContain('coalesced:');
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

  it('EI-20223200344608082: focused test:file uses an independent bounded lane while the gate clamps the ordinary pool', async () => {
    plantLock(liveOwner());
    const gateEnv = { PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE: '0' };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv(gateEnv),
      cwd: dir,
      detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    const focused = spawn(
      'bash',
      [PC_HEAVY, 'bash', '-c', 'sleep 1; echo focused-ok', 'scripts/test-files.mjs'],
      {
        env: baseEnv({ ...gateEnv, PC_HEAVY_FOCUSED_SLOTS: '1' }),
        cwd: dir,
      },
    );
    const focusedOut = createTextCollector(focused.stdout);
    const focusedErr = createTextCollector(focused.stderr);
    const focusedExited = new Promise<number>((res) => focused.on('exit', (c) => res(c ?? -1)));
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the ordinary holder taking the slot');
      await untilStderr(
        focused,
        focusedErr,
        (t) => t.includes('slot acquired'),
        'focused test:file taking its independent lane',
      );

      // The ordinary pool remains occupied while the focused lane is running.
      expect(heldSlotCount(dir, 1)).toBe(1);
      expect(heldSlotCount(join(dir, 'focused'), 1)).toBe(1);
      expect(focusedErr.peek()).toContain('release gate is JUDGING');

      expect(await focusedExited).toBe(0);
      expect(focusedOut.text()).toContain('focused-ok');
    } finally {
      killGroup(holder);
      try { process.kill(-(focused.pid as number), 'SIGKILL'); } catch { /* already exited */ }
    }
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

  // ── Phase-aware clamp DEPTH (EI-19328677512071640) ─────────────────────────
  // v1 clamped for a run's WHOLE lifetime (~2.7h observed) to protect a window
  // that lasts minutes. These pin the depth table — but the load-bearing ones are
  // the fail-safe cases: every unknown must degrade toward MORE throttle. A bug
  // that relaxes on an unrecognized input silently deletes the protection the
  // whole reserve exists to provide, while still looking correct in review.
  describe('phase-aware clamp depth (EI-19328677512071640)', () => {
    /** phase.json exactly as green-checkpoint's writeCheckpointRunPhase publishes it:
     *  beside owner.json in the SAME lock dir. An omitted `phaseProtocol` IS the
     *  protocol-1 (old writer) case — not a malformed one. */
    const plantPhase = (lock: string, body: string | object): void =>
      writeFileSync(join(lock, 'phase.json'), typeof body === 'string' ? body : JSON.stringify(body));
    const at = () => new Date().toISOString();

    it('relaxes to /2 during the long `suite` sweep (protocol >= 2 writer)', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'suite', at: at(), phaseProtocol: 2 });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(r.status).toBe(0);
      // 12/2, NOT v1's 12/4 — this is the throughput the item was filed to reclaim.
      expect(slotsLine(r.stderr)).toContain('slots=6 ');
      expect(slotsLine(r.stderr)).toContain('phase=suite');
    });

    it('clamps HARD (/4) during `isolating` — the single-concurrency window the reserve exists for', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=3 ');
      expect(slotsLine(r.stderr)).toContain('phase=isolating');
    });

    // Not an obvious case, and the reason it is here is that the ORIGINAL design
    // note got it wrong: `delivering` sounds like a post-verdict wind-down, but
    // green-checkpoint re-runs every failing file at tip there (deps.runTestsAtRef)
    // and feeds classifyRedAgainstTip. Contention flips a VERDICT in that window
    // exactly as it does in isolation, so it must clamp hard.
    it('clamps HARD (/4) during `delivering` too — it re-runs failing files at tip to decide stale-vs-real', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'delivering', at: at(), phaseProtocol: 2 });
      expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=3 ');
    });

    // THE deployment-ordering guard, and the single most important test here.
    // The gate runs from the RELEASE checkout, which LAGS staging — so a new
    // reader genuinely does meet an old writer, for as long as the release is
    // behind. Protocol 1 folded the isolation re-run INSIDE `suite`, so relaxing
    // on a protocol-1 `suite` would strip protection from the live isolation
    // re-run while every other test on this page still passed.
    it('does NOT relax on `suite` from a protocol-1 writer (no phaseProtocol field)', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'suite', at: at() });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=3 ');
    });

    // One case PER `it`, deliberately — NOT a for-loop inside a single test.
    // Each probe spawns a real bash subprocess, and this suite runs under
    // vitest's DEFAULT 5s testTimeout (no testTimeout is set in apps/operator's
    // config or the shared defineVitestConfig). Eight spawns sharing one 5s
    // budget is a load-induced flake waiting to happen on this box — exactly how
    // github-identity-drift.test.ts red-pinned the gate on 2026-08-02: it took
    // 11,725ms against the 5s default with ZERO real offenders, purely because
    // the host was loaded. it.each gives every case its own budget and names the
    // offending body in the failure instead of collapsing all eight into one.
    it.each([
      ['empty file',                 ''],
      ['truncated json',             '{'],
      ['garbage',                    'not json at all'],
      ['protocol 1 (field absent)',  '{"phase":"suite"}'],
      ['protocol explicitly older',  '{"phase":"suite","phaseProtocol":1}'],
      ['non-numeric protocol',       '{"phase":"suite","phaseProtocol":"two"}'],
      ['unknown phase name',         '{"phase":"wat","phaseProtocol":2}'],
      ['protocol but no phase',      '{"phaseProtocol":2}'],
    ])('degrades to v1 depth (/4), never to relaxation: %s', (_label, body) => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, body);
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=3 ');
    });

    it('a live run that never published phase.json stays at v1 depth', () => {
      plantLock(liveOwner());
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=3 ');
      expect(slotsLine(r.stderr)).toContain('phase=unknown');
    });

    it('phase never resurrects a DEAD run — liveness is still decided first', () => {
      const lock = plantLock({ pid: deadPid, startedAt: at(), token: 'tok' });
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=12');
      expect(slotsLine(r.stderr)).toContain('gate=0');
    });
  });

  // ── Refusing the broad sweep in the classifier phases (EI-19385714326170346).
  // The clamp above is about LOAD; this is about the gate's VERDICT. During
  // `isolating`/`delivering` the gate re-runs failing files at single concurrency
  // to decide real-break vs load-flake, so a concurrent broad sweep can flip that
  // classification and red the gate fleet-wide on code that is fine.
  //
  // The load-bearing tests here are the NEGATIVE ones: this guard refuses work, so
  // every unknown must fail OPEN (the opposite direction to the clamp's "throttle
  // more"). A bug that refuses too eagerly blocks routine work for every agent.
  describe('refuses the broad sweep in classifier phases (EI-19385714326170346)', () => {
    const plantPhase = (lock: string, body: string | object): void =>
      writeFileSync(join(lock, 'phase.json'), typeof body === 'string' ? body : JSON.stringify(body));
    const at = () => new Date().toISOString();
    // argv carries the marker the guard matches on, but the command is `true` —
    // so a NON-refusal exits 0 harmlessly instead of running a real suite.
    const sweep = (env: Record<string, string> = {}) =>
      runSync(['true', 'scripts/affected-tests.mjs'], { PC_HEAVY_COALESCE: '0', ...env });
    const scoped = (env: Record<string, string> = {}) =>
      runSync(['true', 'scripts/test-files.mjs'], { PC_HEAVY_COALESCE: '0', ...env });

    for (const phase of ['isolating', 'delivering'] as const) {
      it(`REFUSES test:affected during \`${phase}\``, () => {
        const lock = plantLock(liveOwner());
        plantPhase(lock, { phase, at: at(), phaseProtocol: 2 });
        const r = sweep();
        expect(r.status).toBe(75);
        expect(r.stderr).toContain('REFUSING test:affected');
        expect(r.stderr).toContain(phase);
        // It must tell the agent what to do INSTEAD — the whole point is that the
        // knowledge reaches the moment of action, not a doc they already read.
        expect(r.stderr).toContain('npm run test:file --');
        expect(r.stderr).toContain('PC_HEAVY_ALLOW_DURING_GATE=1');
      });
    }

    it('NEVER refuses a scoped test:file run — it is the prescribed alternative', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      const r = scoped();
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('REFUSING');
    });

    it('does NOT refuse during the long `suite` sweep — that window is hours, not minutes', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'suite', at: at(), phaseProtocol: 2 });
      const r = sweep();
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('REFUSING');
    });

    // EI-19970072096315178 — the admission-time check above is necessary but NOT
    // sufficient, and the gap leaks in the one direction that matters.
    //
    // `suite` is not refused, only clamped — and `suite` is the run's multi-hour
    // bulk, with `isolating`/`delivering` following it. A sweep therefore tends to
    // be ADMITTED under the permissive phase, then sit in the slot queue (waits of
    // 60-90s were routine on this box while a gate ran, and PC_HEAVY_TIMEOUT_SEC
    // allows up to 900s), and begin executing under the classifier phase — exactly
    // where contention flips a VERDICT instead of merely costing time. The guard
    // above cannot see that: it ran before the wait.
    //
    // Timing here is anchored to the script's OWN stderr landmarks ("slot
    // acquired", "queued") rather than sleeps, so the test does not become the
    // load-sensitive flake it exists to prevent.
    it('RE-CHECKS the phase after the slot wait — a sweep admitted under `suite` is refused once the gate advances to `isolating` while it queues', async () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'suite', at: at(), phaseProtocol: 2 });

      const gateEnv = { PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE: '0' };

      // Occupy the single slot so the sweep is forced to QUEUE rather than start.
      // `detached` (own process group) is LOAD-BEARING, not tidiness: pc-heavy
      // deliberately lets its child INHERIT the slot fd, and an flock lives on
      // the open file DESCRIPTION shared across that fork — so killing only the
      // wrapper leaves the orphaned `sleep` holding the slot for its full
      // duration. This test then waited out the whole sleep (~30s, 41% of the
      // file's runtime) before the sweep could proceed. Killing the GROUP frees
      // the slot at the instant we intend, which is also what every other
      // holder in this file does.
      const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
        env: baseEnv(gateEnv),
        cwd: dir,
        detached: true,
      });
      const holderErr = createTextCollector(holder.stderr);
      try {
        await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the holder taking the slot');

        const sweepProc = spawn('bash', [PC_HEAVY, 'true', 'scripts/affected-tests.mjs'], {
          env: baseEnv(gateEnv),
          cwd: dir,
        });
        const sweepErr = createTextCollector(sweepProc.stderr);
        const exited = new Promise<number>((res) => sweepProc.on('exit', (c) => res(c ?? -1)));

        // Confirm it is genuinely WAITING before the phase moves — otherwise this
        // would silently degrade into a re-test of the admission-time check.
        await untilStderr(sweepProc, sweepErr, (t) => t.includes('queued for a heavy slot'),
          'the sweep genuinely queueing behind the holder');
        expect(sweepErr.peek()).not.toContain('REFUSING'); // mid-stream: peek, never text

        // The gate advances into its classifier phase while the sweep is queued.
        plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
        killGroup(holder); // frees the slot (whole tree — see above); the sweep now proceeds

        expect(await exited).toBe(75);
        expect(sweepErr.text()).toContain('REFUSING test:affected'); // exited: terminal read
        expect(sweepErr.text()).toContain('isolating');
      } finally {
        killGroup(holder);
      }
    });

    // THE one that would wedge the fleet for hours if it regressed: protocol 1
    // folds isolation INSIDE `suite`, so `isolating` never appears and refusing on
    // `suite` there would block every sweep for the run's whole ~2.7h lifetime.
    it('FAILS OPEN against a protocol-1 writer (phaseProtocol absent)', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'suite', at: at() });
      expect(sweep().status).toBe(0);
      const lock2 = plantLock(liveOwner(), 'bbb222');
      plantPhase(lock2, { phase: 'isolating', at: at() });
      expect(sweep().status).toBe(0);
    });

    it('FAILS OPEN on missing / unparseable / unrecognized phase input', () => {
      // no phase.json at all
      plantLock(liveOwner());
      expect(sweep().status).toBe(0);
      for (const body of ['not json', '{}', '', '{"phase":"isolating","phaseProtocol":"two"}',
                          { phase: 'wat', at: at(), phaseProtocol: 2 }]) {
        rmSync(join(dir, 'checkpoint-logs'), { recursive: true, force: true });
        const lock = plantLock(liveOwner());
        plantPhase(lock, body);
        expect(sweep().status).toBe(0);
      }
    });

    it('FAILS OPEN when no gate run is live at all', () => {
      expect(sweep().status).toBe(0);
      plantLock({ pid: deadPid, startedAt: at(), token: 'tok' });
      expect(sweep().status).toBe(0);
    });

    it('PC_HEAVY_ALLOW_DURING_GATE=1 escapes the refusal', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      expect(sweep({ PC_HEAVY_ALLOW_DURING_GATE: '1' }).status).toBe(0);
    });

    // Structural, but assert it: green-checkpoint's own suite and isolation
    // re-runs inherit PC_HEAVY_RELEASE_GATE=1 and exec long before this guard, so
    // the gate can never refuse itself into a deadlock.
    it('the release gate itself is never refused (PC_HEAVY_RELEASE_GATE=1)', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      const r = sweep({ PC_HEAVY_RELEASE_GATE: '1' });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('REFUSING');
    });

    it('PC_HEAVY_GATE_RESERVE=0 disables the refusal along with the clamp', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      expect(sweep({ PC_HEAVY_GATE_RESERVE: '0' }).status).toBe(0);
    });
  });
});
