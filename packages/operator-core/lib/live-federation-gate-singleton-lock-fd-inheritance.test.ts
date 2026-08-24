/**
 * live-federation-gate-singleton-lock-fd-inheritance.test.ts — recurrence guard for WI-40387.
 *
 * THE BUG. The gate's singleton lock was taken in the DRIVER's own fd table:
 *
 *     exec 7>>"$GATE_LOCK"; flock -n 7
 *
 * bash cannot set FD_CLOEXEC on an exec-assigned fd — probed on the shipping bash 5.2.21,
 * NEITHER `exec 7>` NOR the newer `exec {var}>` form is close-on-exec — so fd 7 was inherited
 * by every descendant. The content-matrix leg *deliberately* leaves its instance pair running
 * on exit (see the §0y comment in the gate), so the gate is guaranteed to spawn inheritors
 * that outlive it. A flock lives on the open file DESCRIPTION, so those survivors kept holding
 * the gate lock after the driver died.
 *
 * MEASURED 2026-08-22 (the filing evidence): the 2026-08-21 13:47 run's orphans (Xvfb :250,
 * a hyperdht testnet, 2 wedged smoke shells — scope pc-0mt38rqhgmpzjmb1qkz) were still
 * resident 7h12m after that run finished, and the 00:46Z window banked
 * SKIPPED-GATE-IN-FLIGHT against holder pid 3847345, dead for hours. An inherited fd has NO
 * expiry: every subsequent window would have skipped identically, forever, while the gate
 * looked healthy (timer green, Result=success, exit 0). "Never runs and nobody notices",
 * reached through the lock rather than through a TTL.
 *
 * THE FIX has two independent halves and this suite pins BOTH, because either one alone
 * leaves a hole:
 *   1. ROOT CAUSE — the lock fd lives only inside a background helper subshell, so the
 *      driver's fd table never contains it and nothing the driver spawns can inherit it.
 *      Without this, the wedge keeps being CREATED.
 *   2. SELF-HEAL — an un-takeable lock whose recorded holder is PROVABLY dead is rotated
 *      aside and retaken. Without this, orphans created before the fix (or after a rollback)
 *      still wedge the gate forever.
 * Half 2 is FAIL-CLOSED on purpose: a missing, unparseable or still-live holder record means
 * NOT-proven-stale and the window skips exactly as before. Absence of evidence must never
 * break a lock, because a broken lock re-creates the two-concurrent-runs collision (corrupt
 * content-matrix verdict) that the singleton exists to prevent. Cases 4 and 5 below are that
 * leg, and they are the ones that matter most: a self-heal that fires on "I could not tell"
 * is strictly worse than the bug it replaces.
 *
 * STATIC leg: pins the absence of the inheritable form, the subshell-scoped fd, the three
 * fail-closed premises inside the break, and the asymmetry between the busy path (skip, which
 * is safe) and the unreadable-lock path (PROCEED, because a lock we cannot read must not be
 * able to silence the gate).
 * BEHAVIORAL leg: extracts the REAL block out of the shipping script and drives it under bash
 * against scratch lock files — including a child that genuinely outlives its driver, with the
 * child's continued liveness asserted so "the lock freed" cannot be an artifact of the child
 * having simply died.
 *
 *   cd packages/operator-core && npx vitest run lib/live-federation-gate-singleton-lock-fd-inheritance.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'live-federation-gate.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'could not locate the repo root (no papercusp-desktop/bin/live-federation-gate.sh above this test)',
  );
}

const ROOT = repoRoot();
// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a MUTATED COPY outside the
// tree (tier 2), so proving the guard falsifiable never dirties the shared checkout.
const GATE_PATH =
  process.env.PROBE_SCRIPT || join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const gate = readFileSync(GATE_PATH, 'utf8');

const BEGIN = '# ── GATE-SINGLETON-LOCK (WI-40387) ── BEGIN gate_singleton_lock';
const END = '# ── END gate_singleton_lock';

function lockBlock(): string {
  const start = gate.indexOf(BEGIN);
  const end = gate.indexOf(END);
  expect(
    start,
    'the gate must carry a delimited gate_singleton_lock block — this suite drives the REAL code, so losing the markers silently turns the behavioral leg into a test of nothing',
  ).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return gate.slice(start, end);
}

describe('WI-40387 static: the singleton lock fd is not in the driver, and the break is fail-closed', () => {
  const block = lockBlock();

  it('does not reopen the inheritable form in the driver shell', () => {
    // The exact regression: any `exec <n>>` of the gate lock at driver scope is inherited by
    // every descendant, including the smoke pair the gate deliberately leaves running.
    //
    // Comments are stripped first, and that is not cosmetic: the fix's own root-cause comment
    // QUOTES the old `exec 7>>"$GATE_LOCK"` form, so a naive whole-file match fires on the
    // explanation rather than on live code — a false red that would train the next reader to
    // weaken this assertion. Stripping comments keeps it pointed at executable text only.
    const code = gate
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/exec\s+\d+>>?"\$GATE_LOCK"/);
    expect(code).not.toMatch(/exec\s+\{[A-Za-z_]\w*\}>>?"\$GATE_LOCK"/);
    // ...and the driver must not flock a bare numeric fd of its own for the gate lock.
    const driverSection = code.slice(code.indexOf('if [ "${GATE_SINGLETON:-1}" = 1 ]'));
    expect(driverSection).not.toMatch(/flock\s+-n\s+7\b/);
  });

  it('opens the lock fd inside the backgrounded helper subshell', () => {
    // The fd open must sit between `(` and `) &` — that subshell IS the fix.
    const helper = block.slice(block.indexOf('gate_singleton_lock_take'));
    const open = helper.indexOf('exec 9>>"$__lock"');
    const bg = helper.indexOf(') &');
    expect(open, 'the helper must open the lock fd itself').toBeGreaterThan(-1);
    expect(bg, 'the helper must be backgrounded').toBeGreaterThan(open);
  });

  it('releases when the driver dies, and cannot be fooled by a recycled pid', () => {
    expect(block).toMatch(/while\s+kill\s+-0\s+"\$__drv"/);
    // A daily-PID-wrap box makes bare `kill -0` insufficient on its own: a recycled pid would
    // keep the helper (and the lock) alive for a stranger's lifetime.
    expect(block).toMatch(/stat\s+-c\s+%Y\s+"\/proc\/\$__drv"/);
  });

  it('breaks a stale lock ONLY on proof, never on absence of evidence', () => {
    const brk = block.slice(
      block.indexOf('gate_singleton_lock_break_stale'),
      block.indexOf('gate_singleton_lock_take'),
    );
    // premise 1: no parseable holder record ⇒ do not break
    expect(brk).toMatch(/\[\s+-n\s+"\$\{__hpid:-\}"\s+\]\s+\|\|\s+exit\s+1/);
    // premise 2: holder still alive ⇒ do not break
    expect(brk).toMatch(/kill\s+-0\s+"\$__hpid"\s+2>\/dev\/null\s+&&\s+exit\s+1/);
    // premise 3: lock already free ⇒ nothing to break
    expect(brk).toMatch(/flock\s+-n\s+7\s+7>>"\$__lock"\s+2>\/dev\/null\s+&&\s+exit\s+1/);
    // the break is serialized, so two racing drivers cannot both rotate
    expect(brk).toMatch(/flock\s+-w\s+"\$\{GATE_LOCK_BREAK_WAIT_S:-10\}"\s+8/);
    // the holder record is rotated away WITH the lock — a racing driver then reads
    // "no holder record" and takes the fail-closed branch above instead of breaking too
    expect(brk).toMatch(/mv\s+-f\s+"\$__lock\.holder"/);
  });

  it('skips on a live holder but PROCEEDS when the lock is unreadable', () => {
    const callSite = gate.slice(gate.indexOf(END));
    // busy ⇒ skip (safe: another driver really is running)
    expect(callSite).toMatch(/busy\)[\s\S]*?SKIPPED-GATE-IN-FLIGHT[\s\S]*?exit 0/);
    // unreadable ⇒ proceed. The `*)` arm must NOT exit: silence is the failure mode this
    // whole item is about, so an unevaluable lock may not be allowed to produce it.
    const fallthrough = callSite.slice(callSite.indexOf('*)'), callSite.indexOf('esac'));
    expect(fallthrough).toMatch(/proceeding UNLOCKED/);
    expect(fallthrough).not.toMatch(/\bexit 0\b/);
  });
});

describe('WI-40387 behavioral: drive the real block under bash', () => {
  let dir = '';
  let blockPath = '';
  const spawned: number[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pcusp-gate-lock-guard-'));
    blockPath = join(dir, 'lockblock.sh');
    writeFileSync(blockPath, lockBlock(), 'utf8');
    // A block that does not even parse would make every case below fail for the wrong reason.
    const syntax = spawnSync('bash', ['-n', blockPath], {
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(syntax.status, `extracted block is not valid bash: ${syntax.stderr}`).toBe(0);
  });

  afterAll(() => {
    for (const pid of spawned) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Run a driver that takes the lock, then returns its reported state. */
  function take(lockPath: string, env: Record<string, string> = {}): string {
    const script = `
      set -uo pipefail
      . ${JSON.stringify(blockPath)}
      gate_singleton_lock_take ${JSON.stringify(lockPath)} "$$" "probe:driver"
      echo "STATE=$GATE_SINGLETON_LOCK_STATE"
      echo "HOLDER=$GATE_SINGLETON_LOCK_HOLDER"
      echo "STALE=$GATE_SINGLETON_LOCK_STALE_HOLDER"
    `;
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, GATE_LOCK_POLL_S: '1', ...env },
      timeout: 60_000,
    });
    return `${r.stdout ?? ''}${r.stderr ?? ''}`;
  }

  function stateOf(out: string): string {
    return /STATE=([a-z-]+)/.exec(out)?.[1] ?? `<none: ${out.trim()}>`;
  }

  /** An orphan process holding the lock the OLD way — the shape the bug produced. */
  function orphanHolder(lockPath: string): number {
    const child = spawn(
      'bash',
      ['-c', `exec 9>>${JSON.stringify(lockPath)}; flock -n 9 || exit 1; sleep 120`],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    spawned.push(child.pid!);
    return child.pid!;
  }

  function lockIsFree(lockPath: string): boolean {
    return (
      spawnSync('flock', ['-n', lockPath, '-c', 'true'], { timeout: 10_000 }).status === 0
    );
  }

  it('THE GUARD: a child that outlives the driver does NOT hold the gate lock', async () => {
    const lockPath = join(dir, 'outlive.lock');
    // The driver takes the lock, then forks a child that survives it — exactly what the
    // content-matrix leg does by design.
    const markerPath = join(dir, 'outlive.marker');
    const script = `
      set -uo pipefail
      . ${JSON.stringify(blockPath)}
      gate_singleton_lock_take ${JSON.stringify(lockPath)} "$$" "probe:driver"
      echo "STATE=$GATE_SINGLETON_LOCK_STATE"
      setsid bash -c 'echo $$ > ${JSON.stringify(markerPath)}; sleep 120' >/dev/null 2>&1 &
      exit 0
    `;
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, GATE_LOCK_POLL_S: '1' },
      timeout: 60_000,
    });
    expect(stateOf(r.stdout ?? '')).toBe('acquired');

    // Wait for the helper to notice the driver is gone (poll interval + slack).
    let free = false;
    for (let i = 0; i < 40 && !free; i++) {
      free = lockIsFree(lockPath);
      if (!free) await new Promise((res) => setTimeout(res, 500));
    }

    // POSITIVE CONTROL, and the whole reason this assertion is trustworthy: the outliving
    // child must still be alive at the moment the lock read free. Without this, a child that
    // simply exited early would produce an identical "lock is free" and the guard would pass
    // while the bug was fully intact.
    let childPid = 0;
    for (let i = 0; i < 20 && !childPid; i++) {
      if (existsSync(markerPath)) childPid = Number(readFileSync(markerPath, 'utf8').trim());
      if (!childPid) await new Promise((res) => setTimeout(res, 100));
    }
    expect(childPid, 'the outliving child never recorded its pid').toBeGreaterThan(0);
    spawned.push(childPid);
    let childAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    expect(childAlive, 'the outliving child died, so this case proves nothing').toBe(true);
    expect(free, 'a child outliving the driver is still holding the gate lock (WI-40387)').toBe(
      true,
    );
  }, 60_000);

  it('SELF-HEAL: an orphan-held lock with a DEAD recorded holder is broken and retaken', () => {
    const lockPath = join(dir, 'stale.lock');
    orphanHolder(lockPath);
    spawnSync('sleep', ['1'], { timeout: 5_000, killSignal: 'SIGKILL' });
    // A pid that is guaranteed not to exist: /proc has no entry for it.
    let deadPid = 4_194_303;
    while (existsSync(`/proc/${deadPid}`)) deadPid--;
    writeFileSync(
      `${lockPath}.holder`,
      `2026-08-21T13:47:07-04:00 pid=${deadPid} probe-user:live-federation-gate (GATE_FORCE)\n`,
      'utf8',
    );
    const out = take(lockPath);
    expect(stateOf(out)).toBe('stale-broken-acquired');
    expect(out).toMatch(new RegExp(`STALE=.*pid=${deadPid}`));
  }, 60_000);

  it('FAIL-CLOSED: a LIVE recorded holder is never broken', () => {
    const lockPath = join(dir, 'live-holder.lock');
    orphanHolder(lockPath);
    spawnSync('sleep', ['1'], { timeout: 5_000, killSignal: 'SIGKILL' });
    writeFileSync(
      `${lockPath}.holder`,
      `2026-08-22T00:00:00-04:00 pid=${process.pid} probe-user:live-federation-gate\n`,
      'utf8',
    );
    expect(stateOf(take(lockPath))).toBe('busy');
  }, 60_000);

  it('FAIL-CLOSED: no holder record at all is never treated as proof of staleness', () => {
    const lockPath = join(dir, 'no-holder.lock');
    orphanHolder(lockPath);
    spawnSync('sleep', ['1'], { timeout: 5_000, killSignal: 'SIGKILL' });
    if (existsSync(`${lockPath}.holder`)) rmSync(`${lockPath}.holder`);
    expect(stateOf(take(lockPath))).toBe('busy');
  }, 60_000);

  it('CALIBRATION: with self-heal disabled, the same dead holder does NOT heal', () => {
    // Without this case, the three above would all still pass if `gate_singleton_lock_take`
    // simply never consulted the holder record and always retook the lock — the self-heal
    // assertion needs a control proving half 2 is what produced the difference.
    const lockPath = join(dir, 'noheal.lock');
    orphanHolder(lockPath);
    spawnSync('sleep', ['1'], { timeout: 5_000, killSignal: 'SIGKILL' });
    let deadPid = 4_194_303;
    while (existsSync(`/proc/${deadPid}`)) deadPid--;
    writeFileSync(`${lockPath}.holder`, `x pid=${deadPid} y\n`, 'utf8');
    expect(stateOf(take(lockPath, { GATE_LOCK_SELF_HEAL: '0' }))).toBe('busy');
  }, 60_000);
});
