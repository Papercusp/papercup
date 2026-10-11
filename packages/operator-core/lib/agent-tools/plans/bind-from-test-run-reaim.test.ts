/**
 * Bind-time re-aim detection (plan mutation-probe-evidence-value-2026-10-11,
 * P-004 / BARs R-4 and R-6).
 *
 * R-4: a caught mutant on a test file that, unchanged, had a surviving mutant in
 *      the preceding 4 h is refused mutation_reaim_unjustified without a reason.
 * R-6: with reaimJustification it binds, and the justification is persisted.
 */

import { describe, expect, it } from 'vitest';
import {
  MUTATION_REAIM_WINDOW_MS,
  decideMutationReaim,
  testRunBindingSchema,
} from './bind-from-test-run';

const SURVIVORS = [
  { id: 101, startedAt: '2026-10-11T10:00:00.000Z' },
  { id: 102, startedAt: '2026-10-11T11:00:00.000Z' },
];

describe('decideMutationReaim (R-4 refusal)', () => {
  it('refuses a caught mutant on an unchanged test file that had survivors, without a justification', () => {
    const r = decideMutationReaim({
      testRunId: 200,
      caughtMutant: true,
      survivors: SURVIVORS,
      testFileChangedSinceSurvivor: false,
      justification: undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('mutation_reaim_unjustified');
    expect(r.testRunId).toBe(200);
    expect(r.message).toContain('101, 102');
    expect(r.message).toContain('reaimJustification');
  });

  it('CONTROL: a test file changed since the latest survivor is a stronger guard, not a re-aim', () => {
    const r = decideMutationReaim({
      testRunId: 200,
      caughtMutant: true,
      survivors: SURVIVORS,
      testFileChangedSinceSurvivor: true,
      justification: undefined,
    });
    expect(r).toEqual({ ok: true, record: null });
  });

  it('CONTROL: no survivor in the window binds as before', () => {
    const r = decideMutationReaim({
      testRunId: 200,
      caughtMutant: true,
      survivors: [],
      testFileChangedSinceSurvivor: false,
      justification: undefined,
    });
    expect(r).toEqual({ ok: true, record: null });
  });

  it('CONTROL: a non-caught row is never a re-aim', () => {
    const r = decideMutationReaim({
      testRunId: 200,
      caughtMutant: false,
      survivors: SURVIVORS,
      testFileChangedSinceSurvivor: false,
      justification: undefined,
    });
    expect(r).toEqual({ ok: true, record: null });
  });

  it('uses a 4-hour window', () => {
    expect(MUTATION_REAIM_WINDOW_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe('decideMutationReaim (R-6 justified re-aim)', () => {
  it('binds with a justification and records it with the survivor ids', () => {
    const r = decideMutationReaim({
      testRunId: 200,
      caughtMutant: true,
      survivors: SURVIVORS,
      testFileChangedSinceSurvivor: false,
      justification: 'First mutation hit dead code; the re-aimed one targets the live branch.',
    });
    expect(r).toEqual({
      ok: true,
      record: {
        justification: 'First mutation hit dead code; the re-aimed one targets the live branch.',
        survivorTestRunIds: [101, 102],
      },
    });
  });

  it('the binding schema accepts reaimJustification and rejects an empty one', () => {
    const base = { workItemId: 'WI-1', specId: 'S-1', fromTestRun: 200 };
    expect(testRunBindingSchema.safeParse({ ...base, reaimJustification: 'reason' }).success).toBe(true);
    expect(testRunBindingSchema.safeParse({ ...base, reaimJustification: '   ' }).success).toBe(false);
  });
});
