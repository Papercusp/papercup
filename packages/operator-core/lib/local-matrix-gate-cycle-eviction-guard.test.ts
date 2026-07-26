/**
 * local-matrix-gate-cycle-eviction-guard.test.ts — regression guard for EI-18723401175637819.
 *
 * THE BUG (structural hazard, mechanism verified in source): local-matrix.sh's single-tenant
 * flock covers the RIG. It does NOT cover HOST CORES — and rig_frame_exclusive() escalates past
 * mere `--cpuset-cpus` affinity to a cgroup-v2 exclusive partition that, per the script's own
 * startup line, "genuinely evicts every other cgroup from the frame's cores" (16 cores for 2
 * frames, 24 for 3).
 *
 * live-federation-gate.sh runs a multi-phase cycle in which the two colliding phases take
 * DIFFERENT locks:
 *   two-instance-content-matrix-smoke.sh -> "${WORK}.flock"          (host-side, per-work-dir)
 *   local-matrix.sh                      -> /tmp/pcusp-local-rig.lock (the rig, per-NET)
 * So during the gate's HOST-SIDE content-matrix phase the rig lock is legitimately FREE, a
 * targeted `local-matrix.sh --only=...` acquires it correctly (even with RIG_LOCK_WAIT_S=0,
 * which is what a careful agent passes), and the eviction lands on a gate phase with no
 * protection from it. `pgrep -f 'local-matrix.sh'` is no better — it is EMPTY during exactly
 * that window, so both the process probe and the rig lock read "free" and both are wrong about
 * the question that matters.
 *
 * THE FIX — and the shape it must NOT take. Making the gate hold the rig lock for its whole
 * ~30min hourly cycle would close the hazard by starving every agent's targeted run for half of
 * every hour; the gate's own §0z block already names that failure class (EI-18657324526667507).
 * The real invariant is "a host-wide core eviction is in effect", a different and much
 * shorter-lived resource than "the rig". So local-matrix.sh instead runs a NON-BLOCKING probe of
 * the lock the gate ALREADY holds for its whole cycle (/tmp/pcusp-live-fed-gate.lock, the
 * GATE_SINGLETON lock) — reuse, not a parallel lock; the exact inverse of the gate's own
 * non-blocking rig probe — and on a hit WARNS with the holder and degrades ITSELF to
 * affinity-only. Never queues, never fails the run.
 *
 * STATIC leg: pins the cross-file contract (same lock path/env as the gate; the gate takes it
 * before its content-matrix phase, so the probe can actually see that window), that the probe is
 * non-blocking and cannot exit, and that it runs before the exclusive-partition escalation.
 * BEHAVIORAL leg: evals the REAL probe + advisory block out of the shipping script under bash
 * against a scratch lock, proving idle/in-flight detection and each degrade decision.
 *
 *   cd packages/operator-core && npx vitest run lib/local-matrix-gate-cycle-eviction-guard.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'local-matrix.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the repo root (no papercusp-desktop/bin/local-matrix.sh above this test)');
}

const ROOT = repoRoot();
const MATRIX_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'local-matrix.sh');
const GATE_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'live-federation-gate.sh');
const matrix = readFileSync(MATRIX_PATH, 'utf8');
const gate = readFileSync(GATE_PATH, 'utf8');

/** Extract a whole multi-line shell function (terminated by a `}` at column 0). */
function extractFn(src: string, name: string): string {
  const m = src.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}$`, 'm'));
  expect(m?.[0], `could not extract ${name}() from local-matrix.sh`).toBeTruthy();
  return m![0];
}

/** The advisory block: `GATE_CYCLE_HOLDER=""` through its terminating `fi` at column 0. */
function extractAdvisoryBlock(): string {
  const m = matrix.match(/^GATE_CYCLE_HOLDER=""[\s\S]*?\nfi$/m);
  expect(m?.[0], 'could not extract the gate-cycle advisory block from local-matrix.sh').toBeTruthy();
  return m![0];
}

const PROBE_FN = extractFn(matrix, 'rig_gate_cycle_holder');
const HOLDER_PID_FN = extractFn(matrix, 'rig_gate_holder_pid');
const ANCESTOR_FN = extractFn(matrix, 'rig_pid_is_self_or_ancestor');
const ADVISORY = extractAdvisoryBlock();

/**
 * A pid that can NEVER be one of our ancestors: above the kernel's pid_max ceiling
 * (4194304 on Linux), so no such process can exist. Using a small literal here would
 * make the "peer cycle" cases flaky on a busy box — a real ancestor could happen to
 * own that pid, and the run would silently assert the self-exemption path instead.
 */
const NON_ANCESTOR_PID = '4194305';

// ── BEHAVIORAL harness ────────────────────────────────────────────────────────
// Runs the REAL extracted shell out of the shipping script, with stderr folded into stdout so
// the WARN lines are assertable. `hold` starts a genuine competing flock holder (a separate
// process, so the lock conflict is unambiguous) and waits until it is actually held before the
// probe runs.
function runProbeCombined(opts: {
  hold: boolean;
  createLock?: boolean;
  env?: Record<string, string>;
  /** Shell text for the holder pid. Default: a pid that cannot exist, so the probe
   *  treats the cycle as a PEER. Pass `'$PPID'` to simulate our OWN parent cycle. */
  holderPid?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lm-gate-probe-'));
  const lock = join(dir, 'pcusp-live-fed-gate.lock');
  const holderPid = opts.holderPid ?? NON_ANCESTOR_PID;
  const script = `
exec 2>&1
set -uo pipefail
log() { echo "[log] $*" >&2; }
GATE_LOCK_PATH=${JSON.stringify(lock)}
${opts.createLock === false ? '' : `: >"$GATE_LOCK_PATH"
printf '%s\\n' "2026-07-26T00:00:00 pid=${holderPid} ci:live-federation-gate" >"$GATE_LOCK_PATH.holder"`}
${
  opts.hold
    ? // stdio MUST be detached from our pipe: execFileSync waits for stdout EOF, and an
      // inherited pipe in the (possibly orphaned) holder would hang the harness, not the probe.
      `flock -x "$GATE_LOCK_PATH" -c 'sleep 10' >/dev/null 2>&1 </dev/null &
HOLDER_PID=$!
for _ in $(seq 1 100); do
  flock -n "$GATE_LOCK_PATH" -c true 2>/dev/null || break
  sleep 0.05
done`
    : 'HOLDER_PID=""'
}
${PROBE_FN}
${HOLDER_PID_FN}
${ANCESTOR_FN}
RIG_EXCLUSIVE="\${PCUSP_RIG_EXCLUSIVE:-1}"
${ADVISORY}
echo "RIG_EXCLUSIVE=$RIG_EXCLUSIVE"
echo "HOLDER=$GATE_CYCLE_HOLDER"
[ -n "$HOLDER_PID" ] && { pkill -P "$HOLDER_PID" 2>/dev/null; kill "$HOLDER_PID" 2>/dev/null; wait "$HOLDER_PID" 2>/dev/null; }
exit 0
`;
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
}

describe('local-matrix.sh: a targeted run cannot silently evict host cores out from under an in-flight gate cycle', () => {
  // ── STATIC leg: the cross-file contract ─────────────────────────────────────
  it('probes the SAME lock the gate holds, by the same default path and env override', () => {
    const gateAssign = gate.match(/^\s*GATE_LOCK="\$\{PCUSP_GATE_LOCK:-([^"}]+)\}"$/m);
    expect(gateAssign?.[1], 'could not read GATE_LOCK from live-federation-gate.sh').toBeTruthy();
    const gateLockDefault = gateAssign![1];

    const probeAssign = matrix.match(/^GATE_LOCK_PATH="\$\{PCUSP_GATE_LOCK:-([^"}]+)\}"$/m);
    expect(probeAssign?.[1], 'local-matrix.sh must derive the gate lock path the same way').toBeTruthy();
    expect(
      probeAssign![1],
      'the probe must point at the gate lock the gate actually takes — a drifted path is a DEAD probe that silently never fires',
    ).toBe(gateLockDefault);
  });

  it('the gate takes that lock BEFORE its host-side content-matrix phase (the window the probe must see)', () => {
    const idxLock = gate.indexOf('GATE_LOCK="${PCUSP_GATE_LOCK:-');
    const idxSmoke = gate.indexOf('run_smoke content-matrix two-instance-content-matrix-smoke.sh');
    expect(idxLock).toBeGreaterThan(0);
    expect(idxSmoke).toBeGreaterThan(0);
    expect(
      idxLock,
      'the gate must already hold its singleton lock during the content-matrix phase, else the probe cannot detect that window at all',
    ).toBeLessThan(idxSmoke);
  });

  it('the probe is NON-BLOCKING and can never fail the run (no waiting flock, no exit in the advisory)', () => {
    expect(PROBE_FN, 'the probe must use a non-blocking flock').toContain('flock -n 8');
    expect(PROBE_FN, 'the probe must never WAIT on the gate lock — that would re-introduce the starvation it exists to avoid').not.toMatch(/flock\s+-w/);
    expect(ADVISORY, 'a gate cycle in flight must never abort a targeted run').not.toMatch(/\bexit\b/);
    expect(ADVISORY).not.toMatch(/\bflock\s+-w/);
  });

  it('runs before the exclusive-partition escalation, and only for a run that brings frames up', () => {
    const idxTeardownExit = matrix.indexOf('if [ "$MODE" = teardown ]; then rig_local_teardown;');
    const idxAdvisory = matrix.indexOf('GATE_CYCLE_HOLDER=""');
    const idxEscalate = matrix.indexOf('if rig_enable_exclusive; then');
    expect(idxTeardownExit).toBeGreaterThan(0);
    expect(idxEscalate).toBeGreaterThan(0);
    expect(idxAdvisory, 'the advisory must not fire for --teardown, which evicts nothing').toBeGreaterThan(idxTeardownExit);
    expect(idxAdvisory, 'the degrade decision is useless after the cores are already taken').toBeLessThan(idxEscalate);
  });

  // ── BEHAVIORAL leg: the real shell, against a real lock ─────────────────────
  it('reports IDLE and keeps exclusive cores when no gate cycle is in flight', () => {
    const out = runProbeCombined({ hold: false });
    expect(out).toContain('RIG_EXCLUSIVE=1');
    expect(out).toContain('HOLDER=');
    expect(out).not.toContain('CYCLE IS IN FLIGHT');
  });

  it('reports IDLE when the gate has never run here (no lock file at all)', () => {
    const out = runProbeCombined({ hold: false, createLock: false });
    expect(out).toContain('RIG_EXCLUSIVE=1');
    expect(out).not.toContain('CYCLE IS IN FLIGHT');
  });

  it('DETECTS an in-flight cycle, names the holder, and degrades itself to affinity-only', () => {
    const out = runProbeCombined({ hold: true });
    expect(out, 'a held gate lock must be detected').toContain('CYCLE IS IN FLIGHT');
    expect(out, 'the warning must name the holder, not just say "busy"').toContain('ci:live-federation-gate');
    expect(out, 'the eviction — not the rig — is the harm, so it must be dropped').toContain('AFFINITY-ONLY');
    expect(out).toContain('RIG_EXCLUSIVE=0');
    // Non-blocking: the run continues rather than queueing or failing.
    expect(out).not.toContain('FATAL');
  });

  // ── SELF-EXEMPTION leg (WI-6133) ────────────────────────────────────────────
  // The probe shipped detecting its OWN parent. live-federation-gate.sh holds this
  // lock for its whole cycle and then runs its local-matrix leg as a CHILD, so the
  // gate stripped its own exclusive partition and ran its most timing-sensitive
  // scenarios on a shared, loaded box — turning the gate into a false-red generator
  // whose reds got misattributed to whatever code the run happened to carry.
  it('does NOT degrade when the in-flight cycle is our OWN ancestor (it launched us)', () => {
    const out = runProbeCombined({ hold: true, holderPid: '$PPID' });
    expect(out, 'our own parent cycle is not a peer to yield to').toContain("is THIS run's own ancestor");
    expect(
      out,
      'degrading here strips the exclusive cores from the very run the gate launched to measure',
    ).not.toContain('AFFINITY-ONLY');
    expect(out, 'the gate must keep the isolation its own verdict depends on').toContain('RIG_EXCLUSIVE=1');
  });

  it('still degrades for a genuine PEER cycle — the self-exemption must not disarm the guard', () => {
    const out = runProbeCombined({ hold: true, holderPid: NON_ANCESTOR_PID });
    expect(out).toContain('CYCLE IS IN FLIGHT');
    expect(out).toContain('AFFINITY-ONLY');
    expect(out).toContain('RIG_EXCLUSIVE=0');
  });

  it('degrades (fail-safe) when the holder line carries no parseable pid', () => {
    // An unknown/legacy holder must fall back to the original EI behaviour rather
    // than being optimistically treated as "probably ours".
    const out = runProbeCombined({ hold: true, holderPid: 'not-a-pid' });
    expect(out, 'an unparseable holder must not be assumed to be our own cycle').toContain('AFFINITY-ONLY');
    expect(out).toContain('RIG_EXCLUSIVE=0');
  });

  it('honours an EXPLICIT PCUSP_RIG_EXCLUSIVE=1 instead of silently overriding the caller', () => {
    const out = runProbeCombined({ hold: true, env: { PCUSP_RIG_EXCLUSIVE: '1' } });
    expect(out).toContain('CYCLE IS IN FLIGHT');
    expect(out).toContain('honouring it');
    expect(out, 'an explicit opt-in must not be auto-degraded').toContain('RIG_EXCLUSIVE=1');
  });

  it('PCUSP_RIG_GATE_PROBE=0 restores the pre-EI behaviour exactly (no probe, no warn, no degrade)', () => {
    const out = runProbeCombined({ hold: true, env: { PCUSP_RIG_GATE_PROBE: '0' } });
    expect(out).not.toContain('CYCLE IS IN FLIGHT');
    expect(out).toContain('RIG_EXCLUSIVE=1');
  });
});
