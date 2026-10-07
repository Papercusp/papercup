/**
 * Runner-backed R-2 pickup evidence. Reuses the read-only live ledger probe;
 * the maintained e2e config supplies the measured layer, never the probe JSON.
 * Enable with PAPERCUSP_GOAL_BRIEF_LIVE=1 npm run test:file -- <this file>.
 * A skipped default run is not acceptance evidence. No ledger writes or launches.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const probe = resolve(root, 'docs/evidence/goal-brief-r2-live-probe-2026-09-29.mts');
type Assertion = { id: string; passed: boolean; evidence: string };
type Evidence = {
  kind: string;
  exitCode: number;
  assertions: Assertion[];
  residualUnknowns: string[];
  observations: { lineages: Array<{ goal: string; verdict: string }> };
};

async function observe(counterexample: boolean, kind: 'R2' | 'R4' | 'R10' = 'R2'): Promise<{ status: number; evidence: Evidence }> {
  const env = { ...process.env };
  delete env.R2_COUNTEREXAMPLE;
  delete env.R4_COUNTEREXAMPLE;
  delete env.R10_COUNTEREXAMPLE;
  if (counterexample) env[`${kind}_COUNTEREXAMPLE`] = kind === 'R2' ? 'scope-mismatch'
    : kind === 'R4' ? 'duplicate-launch-in-refusal-window' : 'wrong-holder';
  const selectedProbe = kind === 'R2' ? probe
    : resolve(root, kind === 'R4'
      ? 'docs/evidence/goal-brief-r4-behavioral-probe-2026-09-29.mts'
      : 'docs/evidence/goal-brief-r10-goal-feedback-live-probe-2026-09-29.mts');
  let stdout: string;
  let status = 0;
  try {
    ({ stdout } = await execute(process.execPath, ['--import', 'tsx', selectedProbe], {
      cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; killed?: boolean };
    // Only a completed assertion failure is negative evidence. Timeout, signals,
    // missing binaries and malformed output must fail this test.
    if (failure.code !== 1 || failure.killed || !failure.stdout) throw error;
    stdout = failure.stdout;
    status = 1;
  }
  const evidence = JSON.parse(stdout) as Evidence;
  expect(evidence.kind).toBe('operational-test-evidence');
  expect(evidence.exitCode).toBe(status);
  expect(evidence.assertions.length).toBeGreaterThan(0);
  return { status, evidence };
}

describe.skipIf(process.env.PAPERCUSP_GOAL_BRIEF_LIVE !== '1')('goal brief live pickup', () => {
  it('R-2 observes valid delegated pickup or a current typed blocker', async () => {
    const { status, evidence } = await observe(false);
    expect(status, JSON.stringify(evidence)).toBe(0);
    // The probe's residualUnknowns also carries methodology disclosures. Judge
    // the measured lineage verdicts, rather than treating that prose as a count.
    for (const lineage of evidence.observations.lineages) {
      expect(['pass', 'no-goal-stamped-plan-work'], JSON.stringify(lineage)).toContain(lineage.verdict);
    }
    for (const id of ['auto-bar-r-2-p-003', 'auto-bar-r-2-p-007']) {
      expect(evidence.assertions.find((assertion) => assertion.id === id)?.passed, id).toBe(true);
    }
    expect(evidence.assertions.every((assertion) => assertion.passed)).toBe(true);
  }, 70_000);

  it('R-2 rejects a fleet scope mismatch against the same live ledger', async () => {
    const { status, evidence } = await observe(true);
    expect(status).toBe(1);
    for (const id of ['r2-clean-lineage-exists', 'auto-bar-r-2-p-003', 'auto-bar-r-2-p-007']) {
      const assertion = evidence.assertions.find((entry) => entry.id === id);
      expect(assertion, id).toBeDefined();
      expect(assertion?.passed, id).toBe(false);
    }
  }, 70_000);

  it('R-10 preserves original feedback attribution and revision history', async () => {
    const { status, evidence } = await observe(false, 'R10');
    expect(status, JSON.stringify(evidence)).toBe(0);
    for (const id of ['auto-bar-r-10-p-007', 'auto-bar-r-10-p-009']) {
      expect(evidence.assertions.find((assertion) => assertion.id === id)?.passed, id).toBe(true);
    }
    expect(evidence.assertions.every((assertion) => assertion.passed), JSON.stringify(evidence)).toBe(true);
  }, 70_000);

  it('R-10 rejects feedback attributed to the wrong goal holder', async () => {
    const { status, evidence } = await observe(true, 'R10');
    expect(status).toBe(1);
    const assertion = evidence.assertions.find((entry) => entry.id === 'r10-arm-a-feedback-credited-to-goal-holder');
    expect(assertion).toBeDefined();
    expect(assertion?.passed).toBe(false);
  }, 70_000);

  it('R-4 detects a duplicate launch in an observed refusal window', async () => {
    const { status, evidence } = await observe(true, 'R4');
    expect(status).toBe(1);
    const assertion = evidence.assertions.find((entry) => entry.id === 'r4-no-duplicate-launch');
    expect(assertion).toBeDefined();
    expect(assertion?.passed).toBe(false);
    expect((assertion as Assertion & { status: string }).status).toBe('fail');
  }, 70_000);
});
