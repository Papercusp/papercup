import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type HarnessContract, HarnessContractError, validateContract } from './contract.js';
import { formatSummaryLine, loadRunResult, parseSummaryLine, runHarness } from './runner.js';
import { parseSelectionArgs, planSelection } from './select.js';

const contract: HarnessContract = {
  name: 'drill',
  phases: [
    { id: 'setup', reusable: true },
    { id: 'leg-a', dependsOn: ['setup'] },
    { id: 'leg-b', dependsOn: ['setup'] },
    { id: 'leg-c', dependsOn: ['leg-a'] },
  ],
};

const tmp = () => mkdtempSync(path.join(tmpdir(), 'vh-'));

describe('validateContract', () => {
  it('rejects a forward dependency, an unknown one and a duplicate id', () => {
    expect(() => validateContract({ name: 'x', phases: [{ id: 'a', dependsOn: ['b'] }, { id: 'b' }] })).toThrow(/declared later/);
    expect(() => validateContract({ name: 'x', phases: [{ id: 'a', dependsOn: ['z'] }] })).toThrow(/unknown phase z/);
    expect(() => validateContract({ name: 'x', phases: [{ id: 'a' }, { id: 'a' }] })).toThrow(HarnessContractError);
  });
});

describe('runHarness', () => {
  it('never aborts: a failed phase blocks only its dependents, and the first failure is named', async () => {
    const root = tmp();
    const ran: string[] = [];
    const result = await runHarness({
      contract,
      evidenceRoot: root,
      runId: 'r1',
      runPhase: async ({ phase, markStep }) => {
        ran.push(phase);
        if (phase === 'leg-a') {
          markStep('clone');
          return { ok: false, reasonCode: 'clone-timeout', detail: 'no refs after 60s' };
        }
        return { ok: true };
      },
    });
    expect(ran).toEqual(['setup', 'leg-a', 'leg-b']);
    expect(result.phases.map((p) => [p.phase, p.status, p.reasonCode])).toEqual([
      ['setup', 'passed', null],
      ['leg-a', 'failed', 'clone-timeout'],
      ['leg-b', 'passed', null],
      ['leg-c', 'blocked', 'dependency:leg-a:failed'],
    ]);
    expect(result.verdict).toBe('fail');
    expect(result.firstFailure).toEqual({ phase: 'leg-a', step: 'clone', reasonCode: 'clone-timeout' });
    expect(formatSummaryLine(result)).toContain('first_failure=leg-a/clone/clone-timeout passed=2 failed=1 blocked=1');
    // The line has one owner: what formatSummaryLine writes, parseSummaryLine reads back.
    expect(parseSummaryLine(formatSummaryLine(result))).toEqual({
      harness: 'drill',
      verdict: 'fail',
      runId: 'r1',
      firstFailure: { phase: 'leg-a', step: 'clone', reasonCode: 'clone-timeout' },
    });
    expect((await loadRunResult(path.join(root, 'r1'))).verdict).toBe('fail');
    expect(readlinkSync(path.join(root, 'latest'))).toBe('r1');
  });

  it('records a throwing phase as failed with its last marked step', async () => {
    const result = await runHarness({
      contract: { name: 't', phases: [{ id: 'only' }] },
      evidenceRoot: tmp(),
      runPhase: async ({ markStep }) => {
        markStep('boot');
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result.phases[0]).toMatchObject({ status: 'failed', step: 'boot', reasonCode: 'threw', detail: 'ECONNREFUSED' });
  });

  it('a failed preflight blocks every phase and runs none', async () => {
    const ran: string[] = [];
    const result = await runHarness({
      contract,
      evidenceRoot: tmp(),
      preflight: async () => ({ ok: false, reasonCode: 'rig-daemon-loaded' }),
      runPhase: async ({ phase }) => { ran.push(phase); return { ok: true }; },
    });
    expect(ran).toEqual([]);
    expect(result.verdict).toBe('preflight-failed');
    expect(result.phases.every((p) => p.status === 'blocked' && p.reasonCode === 'preflight-failed')).toBe(true);
  });

  it('--only re-runs one phase and reuses passed setup from the prior run', async () => {
    const root = tmp();
    await runHarness({ contract, evidenceRoot: root, runId: 'first', runPhase: async () => ({ ok: true }) });
    const ran: string[] = [];
    const result = await runHarness({
      contract,
      evidenceRoot: root,
      runId: 'second',
      selection: { only: ['leg-c'], from: null },
      reuseFrom: path.join(root, 'first'),
      runPhase: async ({ phase }) => { ran.push(phase); return { ok: true }; },
    });
    // setup is reusable → reused; leg-a is not reusable → it must run again for leg-c.
    expect(ran).toEqual(['leg-a', 'leg-c']);
    expect(result.phases.map((p) => [p.phase, p.status])).toEqual([
      ['setup', 'reused'],
      ['leg-a', 'passed'],
      ['leg-b', 'skipped'],
      ['leg-c', 'passed'],
    ]);
    expect(result.phases[0]!.reusedFromRunId).toBe('first');
    expect(result.verdict).toBe('pass');
  });
});

describe('parseSummaryLine', () => {
  const line = (first: string) =>
    `  HARNESS_RESULT harness=h verdict=fail run=20260930T000000Z-42 first_failure=${first} passed=0 failed=1 evidence=/x`;

  it('reads no failure, placeholder steps, a step containing "/" and a guard-rail reason', () => {
    expect(parseSummaryLine(line('none'))?.firstFailure).toBeNull();
    expect(parseSummaryLine(line('build/-/exit-1'))?.firstFailure).toEqual({ phase: 'build', step: null, reasonCode: 'exit-1' });
    expect(parseSummaryLine(line('leg/a/b/timeout'))?.firstFailure).toEqual({ phase: 'leg', step: 'a/b', reasonCode: 'timeout' });
    expect(parseSummaryLine(line('preflight/guard-rails/guard-rail:daemon-up'))?.firstFailure).toEqual({
      phase: 'preflight',
      step: 'guard-rails',
      reasonCode: 'guard-rail:daemon-up',
    });
    expect(parseSummaryLine(line('x'))?.firstFailure).toBeNull();
  });

  it('returns null for any other line', () => {
    expect(parseSummaryLine('VH_RUN harness=h run=r evidence=/x')).toBeNull();
    expect(parseSummaryLine('')).toBeNull();
  });
});

describe('planSelection', () => {
  it('--from runs that phase and everything after it, running setup when there is nothing to reuse', () => {
    const plan = planSelection(contract, { only: null, from: 'leg-b' }, null);
    expect(plan.map((p) => [p.phase, p.action])).toEqual([
      ['setup', 'run'],
      ['leg-a', 'run'],
      ['leg-b', 'run'],
      ['leg-c', 'run'],
    ]);
  });

  it('does not reuse a setup the prior run failed', () => {
    const prior = { runId: 'p', phases: [{ phase: 'setup', status: 'failed' }] } as never;
    expect(planSelection(contract, { only: ['leg-b'], from: null }, prior)[0]).toMatchObject({ phase: 'setup', action: 'run' });
  });

  it('rejects an unknown phase and --only together with --from', () => {
    expect(() => planSelection(contract, { only: ['nope'], from: null }, null)).toThrow(/unknown phase nope/);
    expect(() => planSelection(contract, { only: ['leg-a'], from: 'leg-b' }, null)).toThrow(/mutually exclusive/);
  });

  it('parses the shared flags and leaves the rest alone', () => {
    expect(parseSelectionArgs(['x.deb', '--only-phase', 'leg-a,leg-b', '--reuse=/r/1'])).toEqual({
      only: ['leg-a', 'leg-b'],
      from: null,
      reuse: '/r/1',
      rest: ['x.deb'],
    });
  });
});

describe('bin/vh.sh (shell harness)', () => {
  const vh = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin/vh.sh');
  const script = (root: string) => `
set -u
source ${JSON.stringify(vh)}
vh_phase setup "" 1
vh_phase leg-a setup
vh_phase leg-b setup
vh_phase leg-c leg-a
phase_setup() { vh_step seed; echo seeded > "$VH_PHASE_DIR/out.txt"; }
phase_leg_a() { vh_step clone; vh_fail clone-timeout "no refs"; return 1; }
phase_leg_b() { false; }
phase_leg_c() { :; }
vh_init shell-drill ${JSON.stringify(root)} "$@" || exit 2
vh_run setup phase_setup
vh_run leg-a phase_leg_a
vh_run leg-b phase_leg_b
vh_run leg-c phase_leg_c
vh_finish
`;

  it('records the same result schema as the TS runner, continuing past failures', () => {
    const root = tmp();
    const file = path.join(root, 'h.sh');
    writeFileSync(file, script(root));
    let out = '';
    let code = 0;
    try {
      out = execFileSync('bash', [file], { encoding: 'utf8' });
    } catch (err) {
      const e = err as { status: number; stdout: string };
      code = e.status;
      out = e.stdout;
    }
    expect(code).toBe(1);
    expect(out).toMatch(/HARNESS_RESULT harness=shell-drill verdict=fail .*first_failure=leg-a\/clone\/clone-timeout passed=1 failed=2 blocked=1/);
    // The shell half prints the same line the parser reads (the attempt ledger's fingerprint input).
    const summary = out.split('\n').find((l) => l.includes('HARNESS_RESULT')) ?? '';
    expect(parseSummaryLine(summary)?.firstFailure).toEqual({ phase: 'leg-a', step: 'clone', reasonCode: 'clone-timeout' });
    const result = JSON.parse(readFileSync(path.join(root, 'latest', 'result.json'), 'utf8'));
    expect(result.phases.map((p: { phase: string; status: string; reasonCode: string | null }) => [p.phase, p.status, p.reasonCode])).toEqual([
      ['setup', 'passed', null],
      ['leg-a', 'failed', 'clone-timeout'],
      ['leg-b', 'failed', 'exit-1'],
      ['leg-c', 'blocked', 'dependency:leg-a:failed'],
    ]);
    expect(readFileSync(path.join(root, 'latest', 'phases', 'setup', 'out.txt'), 'utf8')).toBe('seeded\n');
  });

  it('--only with --reuse latest reuses setup and skips unselected phases', () => {
    const root = tmp();
    const file = path.join(root, 'h.sh');
    writeFileSync(file, script(root));
    try { execFileSync('bash', [file], { encoding: 'utf8' }); } catch { /* first run fails by design */ }
    let out = '';
    try {
      out = execFileSync('bash', [file, '--only', 'leg-b', '--reuse', 'latest'], { encoding: 'utf8' });
    } catch (err) {
      out = (err as { stdout: string }).stdout;
    }
    expect(out).toMatch(/plan=setup:reuse,leg-a:skip,leg-b:run,leg-c:skip/);
    expect(out).toMatch(/VH_PHASE phase=setup status=reused/);
    expect(out).toMatch(/passed=0 failed=1 blocked=0 skipped=2 reused=1/);
  });

  it('a planned phase the harness never reported is a failure, not a pass', () => {
    const root = tmp();
    const file = path.join(root, 'h.sh');
    writeFileSync(
      file,
      `source ${JSON.stringify(vh)}\nvh_phase a\nvh_phase b\nvh_init early ${JSON.stringify(root)} || exit 2\nvh_run a true\nvh_finish\n`,
    );
    let out = '';
    try { out = execFileSync('bash', [file], { encoding: 'utf8' }); } catch (err) { out = (err as { stdout: string }).stdout; }
    expect(out).toMatch(/verdict=fail .*first_failure=b\/-\/not-reported/);
  });
});
