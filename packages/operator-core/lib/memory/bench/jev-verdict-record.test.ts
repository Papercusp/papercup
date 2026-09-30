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

// D-006 reopened P-004 and P-006 (dropped in D-004 via D-003); D-008 records their verdict
// against the production variant D-004 adopted. R-1 is met by the two Decisions together.
const EVIDENCE_D008 =
  process.env.JEV_VERDICT_EVIDENCE_D008 ??
  fileURLToPath(new URL('../../../../../docs/evidence/jev-verdict-d008-2026-09-30.json', import.meta.url));
const snapshotD008 = JSON.parse(readFileSync(EVIDENCE_D008, 'utf8')) as Snapshot;

const KEEP_BODY = [
  'Variants built: gamma (P-006), measured against production alpha with same-run v1 baselines.',
  'Runs: admission: v1 jev-admission-T12-00-00-000Z, alpha T12-01-00-000Z, gamma T12-02-00-000Z. Robustness: v1 jev-robustness-T13-00-00-000Z, alpha T13-01-00-000Z, gamma T13-02-00-000Z.',
  'gamma at its selected t: more hard negatives admitted than alpha. FAIL.',
  'Outcome: production keeps alpha at threshold 0.4.',
].join('\n\n');

const keep: VerdictRecordInput = {
  body: KEEP_BODY,
  itemsInScope: ['P-006'],
  built: [{ variant: 'gamma', item: 'P-006' }],
  dropped: [],
  baseline: 'alpha',
};

describe('checkVerdictRecord — a Decision that keeps its baseline', () => {
  it('passes and reads the kept variant and threshold', () => {
    const v = checkVerdictRecord(keep);
    expect(v.reasons).toEqual([]);
    expect(v.adoptedVariant).toBe('alpha');
    expect(v.adoptedThreshold).toBe(0.4);
  });

  it('fails when it keeps a variant that is not the baseline', () => {
    const body = KEEP_BODY.replace('keeps alpha', 'keeps gamma');
    expect(checkVerdictRecord({ ...keep, body }).reasons).toContain('kept variant gamma is not the baseline alpha');
  });

  it('fails when the baseline reports are not cited', () => {
    const body = KEEP_BODY.replace('alpha T12-01-00-000Z, ', '');
    expect(checkVerdictRecord({ ...keep, body }).reasons).toContain('no admission report cited for alpha');
  });

  it('without a baseline, keeping anything but v1 fails', () => {
    const { baseline: _omit, ...noBaseline } = keep;
    expect(checkVerdictRecord(noBaseline).reasons).toContain('kept variant alpha is not the baseline v1');
  });
});

describe('Decision D-008 (plan snapshot) — R-1 for the reopened items', () => {
  it('is the pinned plan Decision', () => {
    expect(snapshotD008.decisionId).toBe('D-008');
    expect(snapshotD008.planVersion).toBe(55);
    expect(snapshotD008.itemsInScope).toEqual(['P-004', 'P-006']);
    expect(snapshotD008.baseline).toBe('v2-content');
  });

  it('records a same-run verdict for both reopened variants', () => {
    const v = checkVerdictRecord(snapshotD008);
    expect(v.reasons).toEqual([]);
    expect(v.pass).toBe(true);
  });

  it('keeps the variant and threshold production runs', () => {
    const v = checkVerdictRecord(snapshotD008);
    expect(v.adoptedVariant).toBe(JEV_MEMORY_VARIANT);
    expect(v.adoptedThreshold).toBe(JEV_MEMORY_ADMIT_THRESHOLD);
  });
});

describe('R-1 across D-004 and D-008', () => {
  it('every variant item P-003 to P-006 is built with a verdict, and every D-004 drop was measured in D-008', () => {
    const builtBy = new Map<string, string>();
    for (const r of [snapshot, snapshotD008]) for (const b of r.built) builtBy.set(b.item, r.decisionId);
    expect([...builtBy.keys()].sort()).toEqual(['P-003', 'P-004', 'P-005', 'P-006']);
    for (const d of snapshot.dropped) expect(builtBy.get(d.item)).toBe('D-008');
  });
});
