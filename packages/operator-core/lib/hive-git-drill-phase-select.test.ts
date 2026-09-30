/**
 * physical-drill-iteration-speed-2026-09-29 P-002 (R-3): a fix to one phase of the physical
 * hive-git scenario is verified by re-running just that phase against the rig state the last
 * run left behind — `hive-git-drill.sh --only-phase D` / `--from-phase D` — in minutes rather
 * than a full 18-26 minute run, and such a partial run can never become release evidence.
 *
 * Every case runs the REAL scripts (the shared selection lib, the scenario's offline plan and
 * its real run_all_phases, the whole drill). The drill runs inside a temp tree whose physical
 * probe is a stub, so nothing here can reach the physical rig.
 *
 * Subject paths are overridable so scripts/mutation-probe.sh can point this guard at a mutated
 * COPY (copy-out tier) instead of mutating the shared tree.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const desktopBin = join(root, 'papercusp-desktop', 'bin');
const selectLib = process.env.PHASE_SELECT_LIB_UNDER_TEST ?? join(desktopBin, 'lib', 'physical-phase-select.sh');
const drillPath = process.env.DRILL_SCRIPT_UNDER_TEST ?? join(desktopBin, 'hive-git-drill.sh');
const scenarioPath =
  process.env.DRILL_SCENARIO_UNDER_TEST ?? join(desktopBin, 'vm-rig', 'hive-git-physical-scenario.sh');
const probePath = process.env.PHYSICAL_PROBE_UNDER_TEST ?? join(desktopBin, 'vm-rig', 'hive-git-physical-probe.sh');
const tsx = join(root, 'node_modules', '.bin', 'tsx');

const scratch = mkdtempSync(join(tmpdir(), 'hive-git-phase-select-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let seq = 0;

/** Child env without anything that could point a script at the real rig. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    'HIVE_GIT_PHYSICAL_PROBE_CMD',
    'HIVE_GIT_PHYSICAL_PHASES',
    'HIVE_GIT_PHYSICAL_EXECUTE',
    'HIVE_GIT_PHYSICAL_PLAN',
    'REQUIRE_ZERO_SKIPS',
    'PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID',
  ]) {
    delete env[k];
  }
  return { ...env, ...extra };
}

function lib(call: string) {
  return spawnSync('bash', ['-c', `. ${JSON.stringify(selectLib)}; ${call}`], { encoding: 'utf8' });
}

/** Extract `name() { ... }` from a bash script (top-level function, closing `}` at column 0). */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`);
  expect(start, `${name}() must exist`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start + 1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start + 1, end + 3);
}

describe('physical-phase-select.sh — the one parser the drill, probe and scenario share', () => {
  it('canonicalises --only-phase (order, case, duplicates) and expands --from-phase', () => {
    expect(lib('physical_phase_select only-phase "e,d,E"').stdout.trim()).toBe('D,E');
    expect(lib('physical_phase_select only-phase h').stdout.trim()).toBe('H');
    expect(lib('physical_phase_select from-phase f').stdout.trim()).toBe('F,G,H');
    expect(lib('physical_phase_list ""').stdout.trim()).toBe('A,B,C,D,E,F,G,H');
  });

  it('refuses anything that is not a phase selection, with exit 2', () => {
    for (const call of [
      'physical_phase_select only-phase Z',
      'physical_phase_select only-phase ""',
      'physical_phase_select from-phase D,E',
      'physical_phase_select sideways D',
    ]) {
      const r = lib(call);
      expect(r.status, call).toBe(2);
      expect(r.stdout, call).toBe('');
    }
  });

  it('only a selection of every phase is a full (evidence-eligible) run', () => {
    expect(lib('physical_phase_is_full ""').status).toBe(0);
    expect(lib('physical_phase_is_full "H,G,F,E,D,C,B,A"').status).toBe(0);
    expect(lib('physical_phase_is_full D').status).toBe(1);
    expect(lib('physical_phase_is_full "$(physical_phase_select from-phase B)"').status).toBe(1);
  });
});

describe('the scenario honours the selection', () => {
  const scenario = readFileSync(scenarioPath, 'utf8');

  it('--phase-plan reports the phases and that a partial run carries no release evidence (offline)', () => {
    const plan = (phases?: string) =>
      spawnSync('bash', [scenarioPath, '--phase-plan'], {
        encoding: 'utf8',
        env: cleanEnv(phases === undefined ? {} : { HIVE_GIT_PHYSICAL_PHASES: phases }),
      });
    const partial = plan('d,b');
    expect(partial.status).toBe(0);
    expect(JSON.parse(partial.stdout)).toEqual({
      schemaVersion: 'hive-git-physical-phase-plan/v1',
      phases: 'B,D',
      fullRun: false,
      releaseEvidence: false,
    });
    expect(JSON.parse(plan().stdout)).toMatchObject({ phases: 'A,B,C,D,E,F,G,H', fullRun: true, releaseEvidence: true });
    expect(plan('Z').status).not.toBe(0);
  });

  it('the real run_all_phases starts only the selected phase and announces every other as PHASE_SKIP', () => {
    const body = extractFunction(scenario, 'run_all_phases');
    const fns = [...body.matchAll(/phase_start ([A-H]) (phase_[a-h]_[a-z_]+)/g)].map(([, letter, fn]) => ({ letter, fn }));
    expect(fns.map((f) => f.letter)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    const script = [
      'set -euo pipefail',
      extractFunction(scenario, 'now_iso'),
      extractFunction(scenario, 'fail'),
      extractFunction(scenario, 'phase_start'),
      body,
      ...fns.map(({ letter, fn }) => `${fn}() { echo "RAN ${letter}"; }`),
      'SCENARIO_PHASES=D',
      'run_all_phases',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('RAN D\n');
    expect(r.stderr).toMatch(/PHASE_START D phase_d_/);
    for (const { letter } of fns.filter((f) => f.letter !== 'D')) {
      expect(r.stderr).toMatch(new RegExp(`PHASE_SKIP ${letter} phase_${letter.toLowerCase()}_\\w+ \\(not selected\\)`));
    }
  });
});

describe('hive-git-drill.sh --only-phase / --from-phase', () => {
  function drillEarly(args: string[], extra: Record<string, string> = {}) {
    const work = join(scratch, `early-work-${seq++}`);
    const r = spawnSync('bash', [drillPath, ...args], {
      encoding: 'utf8',
      env: cleanEnv({ PAPERCUSP_DRILL_WORK: work, HIVE_GIT_DRILL_EVIDENCE_ROOT: join(work, 'ev'), ...extra }),
      timeout: 60_000,
    });
    return { ...r, out: `${r.stdout}${r.stderr}`, workCreated: existsSync(work) };
  }

  it('refuses a bad or unusable selection up front, before any work (exit 2, no work dir)', () => {
    const cases: [string[], Record<string, string>, RegExp][] = [
      [['--only-phase', 'Z'], {}, /--only-phase wants A-H letters/],
      [['--only-phase'], {}, /--only-phase wants A-H letters/],
      [['--only-phase=D'], {}, /needs HIVE_GIT_PHYSICAL_PROBE_CMD/],
      [['--from-phase', 'A'], { HIVE_GIT_PHYSICAL_PROBE_CMD: '/bin/false' }, /every physical phase .* full release run/],
      [['--from-phase', 'D'], { HIVE_GIT_PHYSICAL_PROBE_CMD: '/bin/false', REQUIRE_ZERO_SKIPS: '1' }, /partial re-run can never satisfy it/],
    ];
    for (const [args, extra, message] of cases) {
      const r = drillEarly(args, extra);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.out, args.join(' ')).toMatch(message);
      expect(r.workCreated, args.join(' ')).toBe(false);
    }
  });

  /** The real drill in a temp tree whose canonical probe path holds a stub. */
  function drillPartial(mode: 'pass' | 'fail', args: string[]) {
    const t = join(scratch, `tree-${seq++}`);
    mkdirSync(join(t, 'desk', 'bin', 'vm-rig'), { recursive: true });
    mkdirSync(join(t, 'libs', 'generic'), { recursive: true });
    copyFileSync(drillPath, join(t, 'desk', 'bin', 'hive-git-drill.sh'));
    symlinkSync(join(desktopBin, 'lib'), join(t, 'desk', 'bin', 'lib'));
    symlinkSync(join(root, 'libs', 'generic', 'verification-harness'), join(t, 'libs', 'generic', 'verification-harness'));
    const saw = join(t, 'probe-saw');
    const stub = join(t, 'desk', 'bin', 'vm-rig', 'hive-git-physical-probe.sh');
    const outcome =
      mode === 'pass'
        ? `printf '{"schemaVersion":"hive-git-physical-partial/v1","phases":"%s","releaseEvidence":false}\\n' "$HIVE_GIT_PHYSICAL_PHASES"; exit 0`
        : `echo "hive-git-physical-scenario: PHASE_START D phase_d_worktree_materialization 2026-09-30T00:00:00Z" >&2
echo "hive-git-physical-scenario: stub: VM worktree did not converge" >&2; exit 1`;
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\nprintf '%s|%s|%s|%s\\n' "\${HIVE_GIT_PHYSICAL_PHASES:-}" "\${HIVE_GIT_PHYSICAL_PLAN:-}" "$#" "\${1##*/}" >${JSON.stringify(saw)}\n${outcome}\n`,
      { mode: 0o755 },
    );
    const r = spawnSync('bash', [join(t, 'desk', 'bin', 'hive-git-drill.sh'), ...args], {
      encoding: 'utf8',
      env: cleanEnv({
        PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'stub-task',
        HIVE_GIT_PHYSICAL_PROBE_CMD: stub,
        HIVE_GIT_PHYSICAL_RUNS_DIR: join(t, 'runs'),
        PAPERCUSP_DRILL_WORK: join(t, 'work'),
        HIVE_GIT_DRILL_EVIDENCE_ROOT: join(t, 'ev'),
        PAPERCUSP_REPO_DIR: root,
        VH_TSX: tsx,
        KEEP_UP: '1',
      }),
      timeout: 120_000,
    });
    return { ...r, probeSaw: existsSync(saw) ? readFileSync(saw, 'utf8').trim() : null };
  }

  it('a passing partial run runs only the physical phase, hands the probe the selection, and is not evidence', () => {
    const r = drillPartial('pass', ['--only-phase', 'd']);
    expect(r.stderr).not.toMatch(/was not declared/);
    expect(r.status).toBe(0);
    expect(r.probeSaw).toBe('D|p2p-git-live-activation-2026-07-09|2|hive-git-physical-evidence.json');
    expect(r.stdout).toMatch(/PHYSICAL_PARTIAL phases=D /);
    expect(r.stdout).not.toMatch(/=== extract /); // no local leg ran
    expect(r.stdout).toMatch(/OVERALL: PASS — physical phases D only; NOT release evidence/);
    expect(r.stdout).not.toMatch(/physical evidence accepted/);
    expect(r.stdout).toMatch(
      /HARNESS_RESULT harness=hive-git-drill verdict=pass .*first_failure=none passed=1 failed=0 blocked=0 skipped=7/,
    );
  });

  it('a failing partial run names the physical phase and keeps its output, with the rest not-selected', () => {
    const r = drillPartial('fail', ['--from-phase=d']);
    expect(r.status).toBe(1);
    expect(r.probeSaw?.split('|')[0]).toBe('D,E,F,G,H');
    expect(r.stdout).toMatch(/physical E\/G adapter failed \(exit 1\) in phase D/);
    expect(r.stdout).toMatch(/OVERALL: FAIL/);
    expect(r.stdout).toMatch(
      /HARNESS_RESULT harness=hive-git-drill verdict=fail .*first_failure=physical\/[^ ]*\/adapter-exit-1 passed=0 failed=1 blocked=0 skipped=7/,
    );
  });
});

describe('hive-git-physical-probe.sh — a partial run can never be signed', () => {
  const probe = readFileSync(probePath, 'utf8');
  const firstSsh = probe.indexOf('ssh "${SSH_OPTS[@]}"');

  it('validates the selection before the first ssh', () => {
    const validate = probe.indexOf('physical_phase_list "${HIVE_GIT_PHYSICAL_PHASES:-}"');
    expect(validate).toBeGreaterThan(-1);
    expect(firstSsh).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(firstSsh);
  });

  it('exits with a partial record after the scenario and before anything is signed or finalized', () => {
    const scenarioCall = probe.indexOf('"$SCENARIO" "$unsigned_evidence"');
    const partialExit = probe.indexOf('PARTIAL-RUN-EXIT');
    const sign = probe.indexOf('"$TSX" "$PRODUCER" sign');
    expect(scenarioCall).toBeGreaterThan(-1);
    expect(partialExit).toBeGreaterThan(scenarioCall);
    expect(sign).toBeGreaterThan(partialExit);
    const branch = probe.slice(partialExit, sign);
    expect(branch).toMatch(/if \[ "\$physical_full_run" != 1 \]; then/);
    expect(branch).toMatch(/"releaseEvidence":false/);
    expect(branch).toMatch(/exit 0/);
  });

  it('runs the GitHub (Phase E) preflight only when E is selected', () => {
    const preflight = probe.indexOf('"$TSX" "$PRODUCER" phase-e-preflight');
    expect(preflight).toBeGreaterThan(-1);
    const gate = probe.lastIndexOf('case ",$physical_phases," in', preflight);
    expect(gate).toBeGreaterThan(-1);
    expect(probe.slice(gate, preflight)).toMatch(/\*,E,\*\)/);
  });
});
