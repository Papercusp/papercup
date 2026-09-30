/**
 * Plan physical-drill-iteration-speed-2026-09-29 P-001 (WI-10003891).
 *
 * The P-505 physical drill printed the SAME generic failure line for 14
 * consecutive failed runs, each with a different real cause, and deleted the
 * adapter stderr that held the cause at the start of the next run. This guard
 * pins the fix:
 *
 *  - the scenario announces each phase on stderr before running it;
 *  - bin/lib/physical-failure-summary.sh turns that stderr into one line naming
 *    the failing phase and the reason it reported; and
 *  - the drill puts that line in its summary and archives the adapter output
 *    outside the $WORK directory it wipes at start.
 *
 * Nothing here executes the probe or the scenario's rig code: the real
 * phase_start / run_all_phases functions are extracted and run with stub phase
 * functions, so no ssh/scp can reach the rig VM.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'hive-git-drill.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate papercusp-desktop/bin/hive-git-drill.sh');
}

const root = repoRoot();
// Subject paths are overridable so scripts/mutation-probe.sh can point the guard
// at a mutated COPY (copy-out tier) instead of mutating the shared tree.
const helper =
  process.env.DRILL_FAILURE_SUMMARY_UNDER_TEST ??
  join(root, 'papercusp-desktop', 'bin', 'lib', 'physical-failure-summary.sh');
const drill = readFileSync(
  process.env.DRILL_SCRIPT_UNDER_TEST ?? join(root, 'papercusp-desktop', 'bin', 'hive-git-drill.sh'),
  'utf8',
);
const scenario = readFileSync(
  process.env.DRILL_SCENARIO_UNDER_TEST ??
    join(root, 'papercusp-desktop', 'bin', 'vm-rig', 'hive-git-physical-scenario.sh'),
  'utf8',
);
// The scenario's phase_start reads PHYSICAL_PHASES_ALL from this lib, which is the single
// source of the phase list; the tests below derive the expected phases from it instead of
// hand-listing them (a hand list went stale the moment legs I and J were appended).
const phaseSelect = join(root, 'papercusp-desktop', 'bin', 'lib', 'physical-phase-select.sh');
function declaredPhases(): string[] {
  const all = readFileSync(phaseSelect, 'utf8').match(/^PHYSICAL_PHASES_ALL='([A-Z](?:,[A-Z])*)'$/m)?.[1];
  expect(all, 'physical-phase-select.sh must declare PHYSICAL_PHASES_ALL').toBeTruthy();
  return all!.split(',');
}
/** The evidence schema's legs, read from source (ALL_LEGS is module-private). */
function evidenceLegs(): string[] {
  const source = readFileSync(
    join(root, 'packages', 'operator-core', 'lib', 'sync', 'pot-git', 'physical-drill-evidence.ts'),
    'utf8',
  );
  const list = source.match(/const ALL_LEGS = \[([^\]]*)\] as const;/)?.[1];
  expect(list, 'physical-drill-evidence.ts must declare ALL_LEGS').toBeTruthy();
  return [...list!.matchAll(/'([A-Z])'/g)].map(([, leg]) => leg!);
}

const scratch = mkdtempSync(join(tmpdir(), 'hive-git-failure-summary-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let fixtureSeq = 0;
function summarize(stderr: string | null): string {
  const file = join(scratch, `stderr-${fixtureSeq++}.txt`);
  if (stderr !== null) writeFileSync(file, stderr);
  const run = spawnSync('bash', [helper, file], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  return run.stdout.trim();
}

/** Extract `name() { ... }` from a bash script (top-level function, closing `}` at column 0). */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`);
  expect(start, `${name}() must exist`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start + 1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start + 1, end + 3);
}

describe('physical-failure-summary.sh', () => {
  it('names the last phase started and the last prefixed reason', () => {
    const out = summarize(
      [
        'hive-git-physical-scenario: PHASE_START A phase_a_storage_join 2026-09-29T03:07:00.000Z',
        'hive-git-physical-scenario: tower git-sync:run refused (request-only-host); re-firing on http://127.0.0.1:3271',
        'papercusp defineTool CLI (ptool): launcher',
        'hive-git-physical-scenario: PHASE_START D phase_d_worktree_materialization 2026-09-29T03:12:00.000Z',
        'some unprefixed tool noise',
        'hive-git-physical-scenario: Phase D VM worktree did not converge to the integrator head within 180s',
        '',
      ].join('\n'),
    );
    expect(out).toBe(
      'phase D (phase_d_worktree_materialization): Phase D VM worktree did not converge to the integrator head within 180s',
    );
  });

  it('attributes a probe failure before any phase to setup', () => {
    const out = summarize(
      'hive-git-physical-probe: VM host key preflight failed: fingerprint mismatch\n',
    );
    expect(out).toBe('before any phase: VM host key preflight failed: fingerprint mismatch');
  });

  it('says so when a phase died without a prefixed reason (errexit, not fail())', () => {
    const out = summarize(
      'hive-git-physical-scenario: PHASE_START E phase_e_github_bridge 2026-09-29T03:15:00.000Z\nssh: connect to host 172.31.44.2 port 22: Connection timed out\n',
    );
    expect(out).toBe('phase E (phase_e_github_bridge): no prefixed reason line (exit without fail())');
  });

  it('reports a missing stderr file instead of failing', () => {
    expect(summarize(null)).toMatch(/^no adapter stderr at /);
  });

  // Both shapes below are the tails of REAL archived runs (~/.papercusp-drill-physical-runs,
  // 2026-09-30). The first summary shipped for each named a line that is not the cause.
  it('skips the diagnostics line the EXIT trap prints after fail() (run 20260930T014309Z)', () => {
    const out = summarize(
      [
        'Node.js v24.18.1',
        'hive-git-physical-probe: could not build the VM run-source dependency overlay',
        'hive-git-physical-probe: preserved failed-run diagnostics at /home/u/.papercusp-drill-p301/hive-git-physical-evidence.json.failure-diagnostics',
        '',
      ].join('\n'),
    );
    expect(out).toBe('before any phase: could not build the VM run-source dependency overlay');
  });

  it('names the refusing preflight CHECK, not the pointer line (run 20260930T020324Z)', () => {
    const out = summarize(
      [
        ' M packages/operator-core/lib/sync/pot-git/physical-drill-phase-d.ts',
        'PHYSICAL_PREFLIGHT_FAILED drill-source-committed: uncommitted drill source: physical-drill-phase-d.ts',
        'PHYSICAL_PREFLIGHT_FAILED hosts-answering: tower :3070/api/health answered 503',
        'hive-git-physical-probe: rig preflight refused the run (the PHYSICAL_PREFLIGHT_FAILED line above names the check)',
        '',
      ].join('\n'),
    );
    expect(out).toBe(
      'before any phase: rig preflight refused the run: PHYSICAL_PREFLIGHT_FAILED drill-source-committed: uncommitted drill source: physical-drill-phase-d.ts',
    );
  });

  it('names a producer error when the probe exited under set -e without fail() (same-box run 20260930T043830Z)', () => {
    const out = summarize(
      [
        'RIG_PROFILE rig=same-box vm=same-box-vm tower_port=18471 vm_port=18571 pot=hello-world-pot dir=/rig',
        'hive-git-physical-run: pinned source ffd3a468 (+37 submodules) on tower and VM',
        'physical-drill-host-receipt: cached announce identity/keychain mismatch at /rig/tower-home/x/local-announce-identity.json',
        'hive-git-physical-probe: preserved failed-run diagnostics at /evidence.json.failure-diagnostics',
        '',
      ].join('\n'),
    );
    expect(out).toBe(
      'before any phase: physical-drill-host-receipt: cached announce identity/keychain mismatch at /rig/tower-home/x/local-announce-identity.json',
    );
  });

  it('names a thrown producer error inside a phase, stripping the Error: prefix', () => {
    const out = summarize(
      'hive-git-physical-scenario: PHASE_START D phase_d_steered 2026-09-30T04:00:00.000Z\nError: physical-drill-phase-d: steer hold never reached below\n    at main (physical-drill-producer.ts:1:1)\n',
    );
    expect(out).toBe('phase D (phase_d_steered): physical-drill-phase-d: steer hold never reached below');
  });

  it('keeps a prefixed fail() reason ahead of an earlier producer line', () => {
    const out = summarize(
      'hive-git-physical-scenario: PHASE_START B phase_b_commit 2026-09-30T04:00:00.000Z\nphysical-drill-phase-b: retrying observe\nhive-git-physical-scenario: phase B commit never reached the VM\n',
    );
    expect(out).toBe('phase B (phase_b_commit): phase B commit never reached the VM');
  });
});

describe('the real scenario feeds the summary', () => {
  it('announces every phase before running it, in order, on stderr', () => {
    const body = extractFunction(scenario, 'run_all_phases');
    // `phase_start X fn && fn`: phase_start returns 1 for a phase a selective run skips (P-002).
    const calls = [...body.matchAll(/phase_start ([A-Z]) (phase_[a-z]_[a-z_]+)\s+&&\s+(phase_[a-z]_[a-z_]+)/g)];
    // Every declared phase, in order — and the declared list is the evidence schema's legs.
    expect(calls.map(([, letter]) => letter)).toEqual(declaredPhases());
    expect(declaredPhases()).toEqual(evidenceLegs());
    for (const [, letter, announced, invoked] of calls) {
      expect(announced).toBe(invoked);
      expect(invoked.startsWith(`phase_${letter.toLowerCase()}_`)).toBe(true);
    }
    // No phase function is called from run_all_phases without its announcement.
    const bareCalls = body.split('\n').filter((line) => /^\s*phase_[a-z]_/.test(line));
    expect(bareCalls).toEqual([]);
  });

  it('end to end: a stub Phase D failure through the real phase_start/run_all_phases/fail is named', () => {
    const script = [
      'set -euo pipefail',
      // phase_start reads PHYSICAL_PHASES_ALL; the real scenario gets it from this lib.
      `. '${phaseSelect.replace(/'/g, `'\\''`)}'`,
      extractFunction(scenario, 'now_iso'),
      extractFunction(scenario, 'fail'),
      extractFunction(scenario, 'phase_start'),
      extractFunction(scenario, 'run_all_phases'),
      'phase_a_storage_join() { :; }',
      'phase_b_ref_announce() { :; }',
      'phase_c_trust_negative_controls() { :; }',
      'phase_d_worktree_materialization() { fail "stub: VM worktree did not converge"; }',
      'phase_e_github_bridge() { echo "phase E must not run" >&2; }',
      'phase_f_lifecycle_safety() { :; }',
      'phase_g_owner_authority_chaos() { :; }',
      'run_all_phases',
    ].join('\n');
    const run = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).not.toContain('phase E must not run');
    expect(summarize(run.stderr)).toBe(
      'phase D (phase_d_worktree_materialization): stub: VM worktree did not converge',
    );
  });
});

describe('the drill wiring', () => {
  const block = drill.slice(
    drill.indexOf('physical_probe_rc=0'),
    drill.indexOf('if [ -n "$physical_evidence_file" ] && [ -f "$physical_evidence_file" ]'),
  );

  it('puts the named phase and reason in the failure line, not the generic one', () => {
    expect(block.length).toBeGreaterThan(0);
    expect(drill).not.toContain('physical E/G adapter command failed — see');
    expect(block).toContain('. "$DESKTOP_DIR/bin/lib/physical-failure-summary.sh"');
    expect(block).toContain('physical_failure="$(physical_failure_summary "$WORK/physical-probe.stderr")"');
    expect(block).toMatch(/bad "physical E\/G adapter failed \(exit \$physical_probe_rc\) in \$physical_failure/);
    expect(block).toContain('tail -n 25 "$WORK/physical-probe.stderr"');
  });

  it('archives adapter output outside the $WORK directory the drill wipes at start', () => {
    expect(drill).toContain('rm -rf "$WORK"');
    const runsDefault = block.match(/physical_runs_dir="\$\{HIVE_GIT_PHYSICAL_RUNS_DIR:-([^}]+)\}"/);
    expect(runsDefault).not.toBeNull();
    expect(runsDefault![1]).not.toContain('$WORK');
    expect(runsDefault![1]).not.toContain('.papercusp-drill-p301');
    expect(block).toContain('cp -p "$WORK/physical-probe.stdout" "$WORK/physical-probe.stderr" "$physical_run_dir/"');
    // The archive happens for every run, before the pass/fail branch.
    expect(block.indexOf('cp -p')).toBeLessThan(block.indexOf('if [ "$physical_probe_rc" -ne 0 ]'));
  });

  // R-2 (plan physical-drill-iteration-speed-2026-09-29): two physical runs in sequence leave two
  // distinct per-run directories, and the second does not overwrite the first's adapter output.
  // Runs the drill's REAL archive block (extracted, not re-typed) twice, as two processes, the
  // way two drill attempts run, with stub adapter output. No probe, no rig.
  it('two sequential runs keep separate evidence; the second never overwrites the first (R-2)', () => {
    const archive = block.slice(
      block.indexOf('physical_runs_dir="${HIVE_GIT_PHYSICAL_RUNS_DIR'),
      block.indexOf('if [ "$physical_probe_rc" -ne 0 ]'),
    );
    expect(archive).toContain('mkdir -p "$physical_run_dir"');
    const runs = join(scratch, 'physical-runs');
    const runOnce = (n: number, rc: number): string => {
      const work = join(scratch, `work-${n}`);
      const script = [
        'set -u',
        `WORK=${JSON.stringify(work)}`,
        'mkdir -p "$WORK"',
        `echo "adapter stdout of run ${n}" > "$WORK/physical-probe.stdout"`,
        `echo "adapter stderr of run ${n}" > "$WORK/physical-probe.stderr"`,
        `physical_probe_rc=${rc}`,
        archive,
        'echo "RUN_DIR=$physical_run_dir"',
      ].join('\n');
      const res = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, HIVE_GIT_PHYSICAL_RUNS_DIR: runs, HOME: scratch },
      });
      expect(res.status, res.stderr).toBe(0);
      const dir = res.stdout.match(/^RUN_DIR=(.+)$/m)?.[1];
      expect(dir, res.stdout).toBeDefined();
      return dir!;
    };
    const first = runOnce(1, 3);
    const second = runOnce(2, 0);
    expect(second).not.toBe(first);
    expect(dirname(first)).toBe(runs);
    expect(dirname(second)).toBe(runs);
    // The first run's evidence survives the second run intact.
    expect(readFileSync(join(first, 'physical-probe.stdout'), 'utf8')).toBe('adapter stdout of run 1\n');
    expect(readFileSync(join(first, 'physical-probe.stderr'), 'utf8')).toBe('adapter stderr of run 1\n');
    expect(readFileSync(join(second, 'physical-probe.stderr'), 'utf8')).toBe('adapter stderr of run 2\n');
  });
});
