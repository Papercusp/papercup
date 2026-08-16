/**
 * parallel-leg-supervisor.test — EI-20549139616021387.
 *
 * release-local.sh launches its release legs in PARALLEL but used to JOIN them in a
 * FIXED ORDER (linux → win → mac → android), each join blocking on that one leg. Two
 * defects fell out of the ordering:
 *
 *   1. A leg that died at minute 1 was not OBSERVED at minute 1 — the parent blocked on
 *      `joining linux leg` and surfaced nothing until the join pointer reached the
 *      corpse. Observed on the 0.0.17 cut: ~10 minutes, during which every cheap health
 *      signal read healthy (parent log, `release:cut status`, a cgroup CPU probe — "three
 *      healthy legs" and "three healthy legs plus one corpse" are the same 20-cores-busy
 *      reading).
 *   2. Reaching the corpse then did `exit 1`, whose EXIT trap SIGTERMs every still-running
 *      build descendant. That was about to destroy a SIGNED 3.34 GB linux .deb minutes
 *      from completion, killed by a win leg dead for ~10 minutes.
 *
 * This test drives the REAL supervisor bytes — extracted from release-local.sh and
 * sourced into a harness — with stub legs. That matters: a test that read the script as
 * text could assert `wait -n` appears and still pass against a loop that never reaches
 * it. Everything asserted below is a measurement of what the shipped code DOES.
 *
 * The two discriminators are deliberately different scenarios, because each one isolates
 * a defect the other would still pass:
 *
 *   • FAIL-FAST is an ORDERING claim, so the failing leg is registered LAST. Under the
 *     old sequential join its death is reported AFTER both siblings succeed; under the
 *     supervisor it is reported FIRST. Timing is not asserted — output order is, which is
 *     the property and is not flaky.
 *   • SALVAGE is a SURVIVAL claim, so the failing leg is registered FIRST. Under the old
 *     join the cut exits at ~0.5s and the siblings are reaped mid-write; under the
 *     supervisor they finish and their artifacts exist AT THE MOMENT THE CUT EXITS. That
 *     last clause is why the harness reports artifact presence from its own EXIT trap: a
 *     stub leg orphaned by an early exit keeps running and would touch its artifact a
 *     second later, so checking the directory afterwards would pass against the bug.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'release-local.sh'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate a repo root containing papercusp-desktop/bin/release-local.sh');
}

// PROBE_RELEASE_LOCAL points this at a COPY so falsifiability can be proven without
// mutating the shared tree — git-sync sweeps the whole tree every few minutes and would
// happily commit a mutant that a probe legitimately holds in place for the length of a
// run. That one line is what makes the copy-out tier available at all.
const RELEASE_LOCAL =
  process.env.PROBE_RELEASE_LOCAL ?? join(repoRoot(), 'papercusp-desktop', 'bin', 'release-local.sh');
const SCRIPT = readFileSync(RELEASE_LOCAL, 'utf8');

// The supervisor block, by its real anchors. Both must be found: if a refactor renames
// them this test FAILS rather than silently extracting nothing and passing vacuously.
const BLOCK_START = /^LEG_NAMES=\(\); LEG_PIDS=/m;
const BLOCK_END = /^supervise_legs$/m;

function extractSupervisor(): string {
  const startMatch = BLOCK_START.exec(SCRIPT);
  const endMatch = BLOCK_END.exec(SCRIPT);
  if (!startMatch || startMatch.index === undefined) {
    throw new Error('release-local.sh: leg-registration block (LEG_NAMES=(); LEG_PIDS=…) not found');
  }
  if (!endMatch || endMatch.index === undefined || endMatch.index < startMatch.index) {
    throw new Error('release-local.sh: `supervise_legs` invocation not found after the leg-registration block');
  }
  return SCRIPT.slice(startMatch.index, endMatch.index + endMatch[0].length);
}

// The harness is scaffolding; the SUBJECT is supervisor.inc, sourced verbatim. The four
// *_PID vars are pre-declared empty so the real registration lines evaluate (to false)
// under `set -u` instead of aborting — stub legs are registered by the scenario instead.
const HARNESS = `#!/usr/bin/env bash
set -euo pipefail
WORK="\${WORK:?}"
START_MS="$(date +%s%3N)"
LINUX_PID=""; WIN_PID=""; MAC_PID=""; ANDROID_PID=""

report() {
  local a
  echo "ELAPSED_MS=$(( $(date +%s%3N) - START_MS ))"
  for a in "$WORK"/*.artifact; do [[ -f "$a" ]] && echo "ARTIFACT_PRESENT=$(basename "$a")"; done
  kill $(jobs -p) 2>/dev/null || true
}
trap report EXIT

# shellcheck disable=SC1090
source "$WORK/supervisor.inc"

mk_leg() { # name ticks rc artifact?
  local name="$1" ticks="$2" rc="$3" art="\${4:-}" i
  local log="$WORK/$name.log"
  (
    for (( i=1; i<=ticks; i++ )); do echo "[$name] tick $i" >>"$log"; sleep 0.25; done
    [[ -n "$art" ]] && : >"$WORK/$art"
    exit "$rc"
  ) >/dev/null 2>&1 &
  register_leg "$name" "$!" "$log"
}

eval "\${SCENARIO:?}"
if [[ "\${STORM:-0}" == "1" ]]; then
  HPID=$$
  trap 'true' USR1
  ( for _ in $(seq 1 200); do kill -USR1 "$HPID" 2>/dev/null || exit 0; sleep 0.02; done ) &
  STORM_PID=$!
fi
supervise_legs
# BOUND THE STORM TO ITS SUBJECT. The storm runs ~4s (200 x 0.02s) but the legs
# finish in ~2s, so it used to OUTLIVE supervise_legs and keep signalling this
# shell through its own teardown (trap report EXIT). Signals arriving after
# supervise_legs has returned test NOTHING — the wait is over — they only race the
# harness's shutdown, and that race made this test flake on the shared gate: on
# the identical candidate 7eb6e188 it failed at 10:59 and 11:10 and passed twice
# at 11:12, freezing main for the whole fleet. Reproduced locally at 2/6 under
# load. Killing the storm here keeps ALL of the intended coverage (the storm still
# spans the entire wait) and removes only the untested tail.
if [[ -n "\${STORM_PID:-}" ]]; then
  kill "$STORM_PID" 2>/dev/null || true
  wait "$STORM_PID" 2>/dev/null || true
fi
echo "SUPERVISOR_RETURNED_OK"
`;

const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

type Run = { status: number | null; out: string; lines: string[] };

function runSupervisor(scenario: string, env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'pc-legsup-'));
  workspaces.push(dir);
  writeFileSync(join(dir, 'supervisor.inc'), extractSupervisor());
  writeFileSync(join(dir, 'harness.sh'), HARNESS);
  const res = spawnSync('bash', [join(dir, 'harness.sh')], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, WORK: dir, SCENARIO: scenario, RELEASE_LEG_HEARTBEAT_S: '0', ...env },
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { status: res.status, out, lines: out.split('\n') };
}

const firstIndex = (lines: string[], needle: string): number =>
  lines.findIndex((l) => l.includes(needle));

describe('release-local.sh supervises parallel legs concurrently (EI-20549139616021387)', () => {
  it('extracts a supervisor block that actually contains the concurrent wait', () => {
    // Calibration: if this fails, every behavioural assertion below is testing the wrong
    // bytes, and a green result from them would mean nothing.
    const block = extractSupervisor();
    expect(block).toContain('wait -n -p finished');
    expect(block).toContain('supervise_legs() {');
    expect(block).toContain('register_leg() {');
  });

  it('reports the FIRST leg death immediately, not at its join-order position', () => {
    // The failing leg is registered LAST. A sequential join reports it only after both
    // siblings have succeeded; that ordering IS the ~10-minute blind spot.
    const run = runSupervisor(`
mk_leg slow_a 10 0 a.artifact
mk_leg slow_b 10 0 b.artifact
mk_leg dead 2 1`);

    const death = firstIndex(run.lines, 'FIRST LEG DEATH: dead');
    const firstSuccess = firstIndex(run.lines, 'leg SUCCEEDED');
    expect(death).toBeGreaterThanOrEqual(0);
    expect(firstSuccess).toBeGreaterThanOrEqual(0);
    expect(death).toBeLessThan(firstSuccess);
    expect(run.status).toBe(1);
  }, 45_000);

  it('SALVAGES healthy siblings instead of reaping them, and says so', () => {
    // The failing leg is registered FIRST — the shape that used to exit at ~0.5s and
    // SIGTERM the siblings mid-write. Artifact presence is reported by the harness's own
    // EXIT trap, so it is a claim about the moment the cut ended.
    const run = runSupervisor(`
mk_leg dead 2 1
mk_leg slow_a 10 0 a.artifact
mk_leg slow_b 10 0 b.artifact`);

    expect(run.status).toBe(1);
    expect(run.out).toContain('ARTIFACT_PRESENT=a.artifact');
    expect(run.out).toContain('ARTIFACT_PRESENT=b.artifact');
    expect(run.out).toContain('SALVAGED');
    expect(run.out).toMatch(/SALVAGED[^\n]*slow_a[\s\S]*slow_b|SALVAGED[^\n]*slow_a slow_b/);
    // and the cut is still FAILED — salvage must never be mistaken for success
    expect(run.out).toContain('ERROR: release cut FAILED');
    expect(run.out).not.toContain('SUPERVISOR_RETURNED_OK');
  }, 45_000);

  it('RELEASE_ABORT_ON_LEG_FAILURE=1 restores immediate teardown', () => {
    const run = runSupervisor(
      `
mk_leg dead 2 1
mk_leg slow_a 20 0 a.artifact`,
      { RELEASE_ABORT_ON_LEG_FAILURE: '1' },
    );

    expect(run.status).toBe(1);
    expect(run.out).toContain('tearing down 1 still-running leg(s) NOW');
    expect(run.out).not.toContain('ARTIFACT_PRESENT=a.artifact');
    const elapsed = Number(/ELAPSED_MS=(\d+)/.exec(run.out)?.[1] ?? '999999');
    expect(elapsed).toBeLessThan(4_000); // the sibling needed ~5s; it was not waited for
  }, 45_000);

  it('RELEASE_SALVAGE_GRACE_S bounds the salvage wait for an automated caller', () => {
    const run = runSupervisor(
      `
mk_leg dead 2 1
mk_leg slow_a 40 0 a.artifact`,
      { RELEASE_SALVAGE_GRACE_S: '1' },
    );

    expect(run.status).toBe(1);
    expect(run.out).toContain('SALVAGE GRACE (1s) EXPIRED');
    const elapsed = Number(/ELAPSED_MS=(\d+)/.exec(run.out)?.[1] ?? '0');
    expect(elapsed).toBeLessThan(6_000); // the sibling needed ~10s
  }, 45_000);

  it('succeeds and emits a per-leg heartbeat when every leg is green', () => {
    const run = runSupervisor(
      `
mk_leg a 8 0 a.artifact
mk_leg b 4 0 b.artifact`,
      { RELEASE_LEG_HEARTBEAT_S: '1' },
    );

    expect(run.status).toBe(0);
    expect(run.out).toContain('SUPERVISOR_RETURNED_OK');
    expect(run.out).not.toContain('FAILED');
    // The heartbeat grades a leg by liveness + log mtime, never by grepping the leg log
    // for "error" — that regex produced 12 false hits across the win and mac legs of the
    // 0.0.17 cut (the identity gate's own prose, and `error: &NSError,` in a warning).
    expect(run.out).toMatch(/==> \[legs\].*alive\(log\+\d+s\)/);
    const ticks = run.lines.filter((l) => l.includes('==> [legs]')).length;
    expect(ticks).toBeGreaterThan(2);
  }, 45_000);

  it('does not false-FAIL a healthy leg when a trapped signal interrupts the wait (WI-4230)', () => {
    // A trapped signal makes `wait` return >128 IMMEDIATELY while every leg is still
    // running — that is what made the 0.0.8 cut declare a healthy linux leg FAILED
    // mid-appimagetool. It also exposed a second trap here: `wait -n -p VAR` UNSETS VAR
    // when it collected no child, which under `set -u` aborts the supervisor on the
    // first interruption. Both are only reachable with a real signal storm.
    const run = runSupervisor(
      `
mk_leg a 8 0 a.artifact
mk_leg b 4 0 b.artifact`,
      { STORM: '1' },
    );

    expect(run.status).toBe(0);
    expect(run.out).toContain('SUPERVISOR_RETURNED_OK');
    expect(run.out).not.toContain('FAILED');
    expect(run.out).not.toContain('unbound variable');
  }, 45_000);

  it('registers EVERY launched leg with the supervisor', () => {
    // The supervisor only watches legs passed to register_leg. A fifth leg added later
    // and launched with `<NAME>_PID=$!` but never registered would build unsupervised:
    // its death would be invisible and the cut would report success without it. This is
    // the drift the concurrent join cannot protect itself from.
    const launched = [...SCRIPT.matchAll(/^\s*([A-Z_]+)_PID=\$!\s*$/gm)].map((m) => m[1]);
    expect(launched.length).toBeGreaterThanOrEqual(4);
    const registered = new Set(
      [...SCRIPT.matchAll(/register_leg\s+\w+\s+"\$([A-Z_]+)_PID"/g)].map((m) => m[1]),
    );
    for (const name of launched) {
      expect(
        registered.has(name),
        `${name}_PID is launched as a background leg but never passed to register_leg — it would build unsupervised`,
      ).toBe(true);
    }
  });
});
