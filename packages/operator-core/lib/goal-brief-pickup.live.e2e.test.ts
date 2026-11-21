/**
 * Runner-backed R-2 pickup evidence. Reuses the read-only live ledger probe;
 * the maintained e2e config supplies the measured layer, never the probe JSON.
 * Enable with PAPERCUSP_GOAL_BRIEF_LIVE=1 npm run test:file -- <this file>.
 * Report delivery uses the scoped goal and edition named in
 * PAPERCUSP_GOAL_REPORT_ACCEPTANCE_GOAL and PAPERCUSP_GOAL_REPORT_ACCEPTANCE_EDITION.
 * The live cases read the existing launches and receipts.
 */
import { describe, expect, it } from 'vitest';
import { observe } from './goal-brief-live-probe.test-helper';

it('checks the issued report lookup and rejects a different edition mentioned outside the delivered history', async () => {
  const { deliveredEdition } = await import('./goal-report-delivery-live.test-helper');
  const goal = 'report-acceptance-fixture';
  const edition = 'rpt_391bff92-8ef3-4894-a0d1-16eb60d66539';
  const other = 'rpt_c7aed224-ff1f-4790-9833-a0252de93233';
  const entry = { title: 'Résumé', reportId: edition, sourceRef: goal, relationship: 'cited by goal',
    finding: 'The work has a dated finding.', findingTruncated: false, disposition: 'current',
    publishedAt: '2026-11-01T12:00:00.000Z', read: { tool: 'reports:get', args: { id: edition } } };
  const history = { recovery: { tool: 'goals:get', args: { id: goal } }, relatedReports: { status: 'available',
    deliveryToken: 'db2a23b3-566a-4be4-ab4e-202666e44ac0', entries: [entry] } };
  const prompt = () => [other, 'GOAL HISTORY — own and bounded descendant evidence', JSON.stringify(history)].join('\n');
  const proof = deliveredEdition(prompt(), goal, edition);
  expect(proof.entry).toEqual(entry);
  expect(proof.fragment.bodyBytes).toBe(Buffer.byteLength(JSON.stringify(entry)));
  expect(() => deliveredEdition(prompt(), goal, other)).toThrow('Expected exactly one delivered copy');
  entry.read.args.id = other;
  expect(() => deliveredEdition(prompt(), goal, edition)).toThrow('issued library operation');
});

describe.skipIf(process.env.PAPERCUSP_GOAL_BRIEF_LIVE !== '1')('goal brief live pickup', () => {
  it('verifies delivered report editions at deployed GOAL kickoff and holder recovery', async () => {
    const { observeReleasedGoalReport } = await import('./goal-report-delivery-live.test-helper');
    const proof = await observeReleasedGoalReport();
    expect(proof.deliveries[0].ref).not.toBe(proof.deliveries[1].ref);
    expect(proof.deliveries[0].lookup).not.toBe(proof.deliveries[1].lookup);
    console.info('GOAL_REPORT_RELEASE_PROOF', JSON.stringify(proof));
  }, 90_000);

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

  it('R-4 detects a duplicate launch in an observed refusal window', async () => {
    const { status, evidence } = await observe(true, 'R4');
    expect(status).toBe(1);
    const assertion = evidence.assertions.find((entry) => entry.id === 'r4-no-duplicate-launch');
    expect(assertion).toBeDefined();
    expect(assertion?.passed).toBe(false);
    expect(assertion?.status).toBe('fail');
  }, 70_000);
});
