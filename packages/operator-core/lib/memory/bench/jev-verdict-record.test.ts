import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { JEV_MEMORY_ADMIT_THRESHOLD, JEV_MEMORY_VARIANT } from '../jev-memory-gate';
import { checkVerdictRecord, type VerdictRecordInput } from './jev-verdict-record';

// jev-performance-improvements-2026-09-30, bar R-1 (P-007): a plan Decision records a
// same-run verdict against D-001 for every variant built in P-003 to P-006.

const EVIDENCE =
  process.env.JEV_VERDICT_EVIDENCE ??
  fileURLToPath(new URL('../../../../../docs/evidence/jev-verdict-d004-2026-09-30.json', import.meta.url));

interface Snapshot extends VerdictRecordInput {
  readonly decisionId: string;
  readonly planVersion: number;
}

const snapshot = JSON.parse(readFileSync(EVIDENCE, 'utf8')) as Snapshot;

const GOOD_BODY = [
  'Variants built: alpha (P-003); beta (P-004) was dropped before measuring (D-003). same-run v1 baselines.',
  'Runs: admission: v1 jev-admission-T10-00-00-000Z, alpha T10-01-00-000Z. Robustness: v1 jev-robustness-T11-00-00-000Z, alpha T11-01-00-000Z.',
  'alpha at its selected t: better on every measure. PASS.',
  'Outcome: production adopts alpha at threshold 0.4 (P-008).',
].join('\n\n');

const good: VerdictRecordInput = {
  body: GOOD_BODY,
  itemsInScope: ['P-003', 'P-004'],
  built: [{ variant: 'alpha', item: 'P-003' }],
  dropped: [{ item: 'P-004', decisionId: 'D-003' }],
};

describe('checkVerdictRecord — calibration', () => {
  it('passes a Decision that covers every in-scope item and reads the adopted variant and threshold', () => {
    expect(checkVerdictRecord(good)).toEqual({ pass: true, reasons: [], adoptedVariant: 'alpha', adoptedThreshold: 0.4 });
  });

  it('fails when an in-scope item is neither built nor dropped', () => {
    const v = checkVerdictRecord({ ...good, itemsInScope: [...good.itemsInScope, 'P-005'] });
    expect(v.pass).toBe(false);
    expect(v.reasons).toContain('P-005 is neither a built variant nor a dropped item');
  });

  it('fails when a built variant has no verdict paragraph', () => {
    const body = GOOD_BODY.replace('alpha at its selected t: better on every measure. PASS.', 'Nothing more to say.');
    expect(checkVerdictRecord({ ...good, body }).reasons).toContain('no verdict paragraph for alpha');
  });

  it('fails when the verdict paragraph states no pass or fail', () => {
    const body = GOOD_BODY.replace('better on every measure. PASS.', 'numbers above.');
    expect(checkVerdictRecord({ ...good, body }).reasons).toContain('the alpha paragraph states no pass/fail verdict');
  });

  it('fails when v1 is not measured in the same runs', () => {
    const noBaseline = GOOD_BODY.replace('same-run v1 baselines.', 'v1 from last week.').replace(
      'v1 jev-admission-T10-00-00-000Z, ',
      '',
    );
    const reasons = checkVerdictRecord({ ...good, body: noBaseline }).reasons;
    expect(reasons).toContain('the Decision does not say its v1 baselines come from the same runs');
    expect(reasons).toContain('no admission report cited for v1');
  });

  it('fails when a dropped item is not tied to the Decision that dropped it', () => {
    const body = GOOD_BODY.replace('(D-003)', '');
    expect(checkVerdictRecord({ ...good, body }).reasons).toContain('dropped P-004 is not named with D-003');
  });

  it('fails when the Outcome adopts something that was not built', () => {
    const body = GOOD_BODY.replace('adopts alpha', 'adopts gamma');
    expect(checkVerdictRecord({ ...good, body }).reasons).toContain('adopted variant gamma is not one of the built variants');
  });
});

describe('Decision D-004 (plan snapshot) — R-1', () => {
  it('is the pinned plan Decision', () => {
    expect(snapshot.decisionId).toBe('D-004');
    expect(snapshot.planVersion).toBe(35);
    expect(snapshot.itemsInScope).toEqual(['P-003', 'P-004', 'P-005', 'P-006']);
  });

  it('records a same-run verdict for every variant built in P-003 to P-006', () => {
    const v = checkVerdictRecord(snapshot);
    expect(v.reasons).toEqual([]);
    expect(v.pass).toBe(true);
  });

  it('adopts the variant and threshold production runs', () => {
    const v = checkVerdictRecord(snapshot);
    expect(v.adoptedVariant).toBe(JEV_MEMORY_VARIANT);
    expect(v.adoptedThreshold).toBe(JEV_MEMORY_ADMIT_THRESHOLD);
  });
});
