/**
 * WI-10004116 guard: a physical-drill work-item created only to be observed (a FIXTURE) must
 * never outlive the run as an open, claimable item in the drill pot. Until 2026-09-30 phase J
 * leaked its writes A and B on every run — three were found open and unowned in
 * hello-world-3-pot, claimable by any agent working that pot.
 *
 * 1. Structural: every `work_items:create` the scenario issues is followed, in the same
 *    function, by `drill_fixture_register`, and that function arms an EXIT trap that drops the
 *    registered set BEFORE the first create and disarms it only AFTER the success-path drop. A
 *    new create site therefore cannot skip disposal on either path.
 * 2. Behavioural: the REAL helpers, extracted from the scenario and run in bash against a fake
 *    ptool, drop exactly the registered ids (success path and a dying phase), keep the ids
 *    registered when the drop is refused (ptool exits 0 on ok:false), and never mask the
 *    phase's own exit code.
 *
 * The subject path is overridable (DRILL_SCENARIO_UNDER_TEST) so scripts/mutation-probe.sh can
 * point this guard at a mutated COPY instead of the shared tree.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'vm-rig', 'hive-git-physical-scenario.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate papercusp-desktop/bin/vm-rig/hive-git-physical-scenario.sh');
}

const scenarioPath =
  process.env.DRILL_SCENARIO_UNDER_TEST ??
  join(repoRoot(), 'papercusp-desktop', 'bin', 'vm-rig', 'hive-git-physical-scenario.sh');
const scenario = readFileSync(scenarioPath, 'utf8');

/** Top-level `name() { ... }` from the scenario (closing `}` at column 0), or '' when absent. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`);
  if (start < 0) return '';
  const end = source.indexOf('\n}\n', start + 1);
  return end < 0 ? '' : source.slice(start + 1, end + 3);
}

/**
 * An actual `work_items:create` invocation: every host call in the scenario goes through one of
 * its two drivers ($TOWER_CALL on the tower, $VM_CALL over ssh). Contract JSON and comments that
 * merely NAME the verb are not creates.
 */
const CREATE_CALL = /\b(?:TOWER_CALL|VM_CALL)\b\S*\s+work_items:create\b/;

/** Every top-level function whose body invokes `work_items:create`, with that body. */
function createSites(source: string): Array<{ name: string; body: string }> {
  const sites: Array<{ name: string; body: string }> = [];
  for (const m of source.matchAll(/^([a-z_][a-z0-9_]*)\(\) \{$/gm)) {
    const body = extractFunction(source, m[1]);
    if (body.split('\n').some((l) => CREATE_CALL.test(l) && !/^\s*#/.test(l))) sites.push({ name: m[1], body });
  }
  return sites;
}

/** Offset of the first create invocation in a function body. */
function firstCreate(body: string): number {
  const m = CREATE_CALL.exec(body);
  return m ? m.index : -1;
}

/**
 * Why `name` (a function that creates work-items) could leak a fixture, as named problems; []
 * when every created item is registered, an EXIT trap that drops the registered set is armed
 * before the first create, the success path drops them, and the trap stays armed until then.
 */
function disposalProblems(source: string, name: string): string[] {
  const body = extractFunction(source, name);
  const createAt = firstCreate(body);
  if (createAt < 0) return ['no create site'];
  const problems: string[] = [];
  if (body.indexOf('drill_fixture_register', createAt) < 0) problems.push('create not registered');
  const armed = /\n\s*trap ([a-z_][a-z0-9_]*) EXIT\n/.exec(body);
  if (!armed || armed.index > createAt) problems.push('no EXIT trap armed before the first create');
  else if (!extractFunction(source, armed[1]).includes('drill_fixtures_drop')) problems.push('EXIT trap handler does not drop fixtures');
  const successDrop = body.lastIndexOf('drill_fixtures_drop');
  if (successDrop < createAt) problems.push('success path does not drop fixtures');
  else if (body.lastIndexOf('trap - EXIT') < successDrop) problems.push('EXIT trap disarmed before the success-path drop');
  return problems;
}

const tmp = mkdtempSync(join(tmpdir(), 'drill-fixture-disposal-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let caseNo = 0;

type Outcome = { status: number | null; stdout: string; stderr: string; calls: Array<{ args: string; stdin: unknown }> };

/**
 * Run `body` in bash with the scenario's real helpers loaded and `$TOWER_CALL` pointing at a
 * fake ptool that records each call and answers with `response`.
 */
function runWithHelpers(body: string, response: unknown): Outcome {
  const dir = join(tmp, `case-${++caseNo}`);
  mkdirSync(join(dir, 'run', 'phase-j'), { recursive: true });
  const log = join(dir, 'ptool.log');
  const responseFile = join(dir, 'response.json');
  writeFileSync(responseFile, JSON.stringify(response));
  const fake = join(dir, 'ptool');
  writeFileSync(
    fake,
    `#!/usr/bin/env bash\nstdin="$(cat)"\nnode -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(3).join(" "), stdin: JSON.parse(process.argv[2]) }) + "\\n")' ${JSON.stringify(log)} "$stdin" "$@"\ncat ${JSON.stringify(responseFile)}\n`,
  );
  chmodSync(fake, 0o755);
  const helpers = ['fail', 'ptool_result_ok', 'drill_fixture_register', 'drill_fixtures_drop', 'phase_j_remove_fault', 'phase_j_restore_on_exit']
    .map((n) => {
      const fn = extractFunction(scenario, n);
      expect(fn, `${n}() must exist in the scenario`).not.toBe('');
      return fn;
    })
    .join('\n');
  const script = [
    'set -euo pipefail',
    `TOWER_CALL=${JSON.stringify(fake)}`,
    "PHASE_A_POT_HOME='hello-world-3-pot'",
    "physical_run_id='20260930T000000Z-1'",
    `run_dir=${JSON.stringify(join(dir, 'run'))}`,
    "PHASE_J_FAULT_RUN=''",
    'DRILL_FIXTURES=()',
    helpers,
    body,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: dir });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Outcome['calls'][number])
    : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

/** A saved work_items:create result, shaped like ptool writes it. */
function createResult(name: string, id: string | null): string {
  const file = join(tmp, `${name}-${++caseNo}.json`);
  const result = id === null ? { ok: true, results: [{ ok: true }] } : { ok: true, results: [{ ok: true, id }] };
  writeFileSync(file, JSON.stringify(result));
  return file;
}

const DROPPED = { ok: true, results: [{ ok: true, id: 'WI-1', appliedState: 'dropped' }, { ok: true, id: 'WI-2', appliedState: 'dropped' }] };

describe('physical drill fixtures are dropped, never left claimable (WI-10004116) — structure', () => {
  const sites = createSites(scenario);

  it('finds the real create sites and ignores text that only names the verb (calibration)', () => {
    expect(sites.map((s) => s.name)).toContain('phase_j_apply_outage_replay');
    expect(extractFunction(scenario, 'phase_j_contract')).toContain('work_items:create');
    expect(sites.map((s) => s.name)).not.toContain('phase_j_contract');
  });

  it.each(sites.map((s) => [s.name] as const))('%s registers, traps and drops every fixture it creates', (name) => {
    expect(disposalProblems(scenario, name)).toEqual([]);
  });

  const phaseJ = extractFunction(scenario, 'phase_j_apply_outage_replay');
  const mutate = (from: string | RegExp, to: string): string => {
    const mutant = scenario.replace(phaseJ, phaseJ.replace(from, to));
    expect(mutant, `mutation ${String(from)} must change the scenario`).not.toBe(scenario);
    return mutant;
  };

  it('a create with no registration fails the guard (falsifiability control)', () => {
    expect(disposalProblems(mutate(/drill_fixture_register/g, 'true'), 'phase_j_apply_outage_replay')).toContain('create not registered');
  });
  it('a success path with no drop fails the guard (falsifiability control)', () => {
    expect(disposalProblems(mutate(/\n  drill_fixtures_drop "\$phase_dir\/fixtures-drop\.json" \\\n[^\n]*\n/, '\n'), 'phase_j_apply_outage_replay')).toContain(
      'success path does not drop fixtures',
    );
  });
  it('disarming the trap before the success-path drop fails the guard (falsifiability control)', () => {
    const early = phaseJ
      .replace('  # The EXIT trap stays armed until the fixtures are dropped below.\n', '  trap - EXIT\n')
      .replace(/\n  trap - EXIT\n\}\n$/, '\n}\n');
    expect(early.match(/trap - EXIT/g)).toHaveLength(1);
    const mutant = scenario.replace(phaseJ, early);
    expect(disposalProblems(mutant, 'phase_j_apply_outage_replay')).toContain('EXIT trap disarmed before the success-path drop');
  });
  it('an EXIT trap that does not drop fixtures fails the guard (falsifiability control)', () => {
    const handler = extractFunction(scenario, 'phase_j_restore_on_exit');
    const mutant = scenario.replace(handler, handler.replace(/drill_fixtures_drop/g, 'true'));
    expect(mutant).not.toBe(scenario);
    expect(disposalProblems(mutant, 'phase_j_apply_outage_replay')).toContain('EXIT trap handler does not drop fixtures');
  });
});

describe('physical drill fixtures are dropped, never left claimable (WI-10004116) — behaviour', () => {
  it('drops exactly the registered ids in one set_state call, then forgets them', () => {
    const a = createResult('create-A', 'WI-1');
    const b = createResult('create-B', 'WI-2');
    const r = runWithHelpers(
      `drill_fixture_register ${JSON.stringify(a)}\ndrill_fixture_register ${JSON.stringify(b)}\ndrill_fixtures_drop "$run_dir/drop.json"\necho "left=\${#DRILL_FIXTURES[@]}"\ndrill_fixtures_drop "$run_dir/drop-again.json"`,
      DROPPED,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('left=0');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].args).toContain('work_items:set_state');
    expect(r.calls[0].args).toContain('--harness=hello-world-3-pot');
    expect(r.calls[0].stdin).toMatchObject({ ids: ['WI-1', 'WI-2'], state: 'dropped', assumptions: 'none' });
    expect((r.calls[0].stdin as { reason: string }).reason).toContain('20260930T000000Z-1');
  });

  it('treats a refused drop as a failure and keeps the ids registered for the EXIT retry', () => {
    const a = createResult('create-A', 'WI-1');
    const r = runWithHelpers(
      `drill_fixture_register ${JSON.stringify(a)}\nif drill_fixtures_drop "$run_dir/drop.json"; then echo DROPPED; else echo REFUSED; fi\necho "left=\${#DRILL_FIXTURES[@]}"`,
      { ok: true, results: [{ ok: false, error: 'refused' }] },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('REFUSED');
    expect(r.stdout).toContain('left=1');
  });

  it('refuses to register a create result that names no work-item id', () => {
    const none = createResult('create-none', null);
    const r = runWithHelpers(`if drill_fixture_register ${JSON.stringify(none)}; then echo REGISTERED; else echo NO_ID; fi`, DROPPED);
    expect(r.stdout).toContain('NO_ID');
    expect(r.calls).toHaveLength(0);
  });

  it('drops the fixtures when the phase dies, without masking its exit code', () => {
    const a = createResult('create-A', 'WI-1');
    const r = runWithHelpers(
      `trap phase_j_restore_on_exit EXIT\ndrill_fixture_register ${JSON.stringify(a)}\nfail 'phase J died mid-run'`,
      DROPPED,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('phase J died mid-run');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].stdin).toMatchObject({ ids: ['WI-1'], state: 'dropped' });
  });

  it('warns with the leaked ids when the EXIT drop is refused, still exiting with the phase failure', () => {
    const a = createResult('create-A', 'WI-7');
    const r = runWithHelpers(
      `trap phase_j_restore_on_exit EXIT\ndrill_fixture_register ${JSON.stringify(a)}\nfail 'phase J died mid-run'`,
      { ok: false, results: [] },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/WARNING phase J could not drop its fixture work-items WI-7 in hello-world-3-pot/);
  });
});
