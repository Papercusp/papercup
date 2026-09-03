/**
 * Unit tests for the code-intelligence resource CONTRACT — specifically the
 * index-disk budget grader added by WI-2142942.
 *
 * These need no language server, no backend and no disk. What they guard is
 * that `indexDiskMbMax` can now actually FAIL, and — the half that matters
 * more — that it cannot fabricate a PASS. The defect being fixed was a budget
 * declared, valued, and compared in zero places: it could not fail, so it read
 * as a standing guarantee while the selected backend sat at 3.2x it.
 *
 * A grader that merely exists would recreate that defect one level up, so the
 * suite includes a falsifiability CONTROL: an injected budget must flip the
 * verdict. If that control ever passes trivially, the guard is measuring
 * nothing.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RESOURCE_BUDGET,
  KNOWN_INDEX_DISK_EXCEEDANCES,
  classifyIndexDisk,
  type KnownIndexDiskExceedance,
} from './contracts';

const ALLOWANCE: readonly KnownIndexDiskExceedance[] = [
  { backend: 'testbed', observedMb: 3_000, observedCeilingMb: 4_000, why: 'fixture' },
];

describe('classifyIndexDisk', () => {
  it('grades a footprint inside the budget as within-budget', () => {
    const v = classifyIndexDisk('testbed', 100, { budgetMb: 2_048, exceedances: [] });
    expect(v.status).toBe('within-budget');
  });

  it('grades a breach with no recorded allowance as over-ceiling', () => {
    const v = classifyIndexDisk('testbed', 5_000, { budgetMb: 2_048, exceedances: [] });
    expect(v.status).toBe('over-ceiling');
    expect(v).toMatchObject({ measuredMb: 5_000, acceptedCeilingMb: null });
  });

  it('accepts a MEASURED breach that is inside its bounded allowance', () => {
    const v = classifyIndexDisk('testbed', 3_500, { budgetMb: 2_048, exceedances: ALLOWANCE });
    expect(v.status).toBe('accepted-exceedance');
    expect(v).toMatchObject({ acceptedCeilingMb: 4_000 });
  });

  it('still FAILS once the accepted exceedance grows past its ceiling', () => {
    // The whole point of a bounded exceedance: accepting today's footprint is
    // not accepting unbounded growth.
    const v = classifyIndexDisk('testbed', 4_001, { budgetMb: 2_048, exceedances: ALLOWANCE });
    expect(v.status).toBe('over-ceiling');
  });

  it("does not apply one backend's allowance to another backend", () => {
    const v = classifyIndexDisk('other', 3_500, { budgetMb: 2_048, exceedances: ALLOWANCE });
    expect(v.status).toBe('over-ceiling');
    expect(v).toMatchObject({ acceptedCeilingMb: null });
  });

  describe('refuses to fabricate a pass', () => {
    it('grades an unmeasured backend not-measured, NOT within-budget', () => {
      // An in-memory-index backend (the LSP adapter) has no subject here.
      // Reporting "0MB, within budget" would be a false guarantee with
      // evidence attached — strictly worse than the dead field this replaced.
      const v = classifyIndexDisk('lsp', null, { budgetMb: 2_048 });
      expect(v.status).toBe('not-measured');
      expect(v.status).not.toBe('within-budget');
      expect(v).toMatchObject({ reason: expect.stringContaining('lsp') });
    });

    it('grades a TRUNCATED walk not-measured even when the partial total looks fine', () => {
      // `dirSizeBytes` returns a partial total when it hits maxEntries or its
      // wall-clock deadline. A partial can only UNDER-count, so a truncated
      // walk that "fits" the budget is exactly how a real breach would read as
      // clean. This is the case a naive grader gets wrong.
      const v = classifyIndexDisk('gitnexus', 10, { truncated: true, budgetMb: 2_048 });
      expect(v.status).toBe('not-measured');
      expect(v).toMatchObject({ reason: expect.stringContaining('partial') });
    });

    it('does not let a truncated walk mask a breach either', () => {
      const v = classifyIndexDisk('gitnexus', 99_999, { truncated: true, budgetMb: 2_048 });
      expect(v.status).toBe('not-measured');
    });
  });

  it('CONTROL: the guard can fail — an injected budget flips the verdict', () => {
    // Falsifiability. Same measurement, two budgets, opposite verdicts. If
    // these ever agree, the grader is not reading the budget at all.
    const measuredMb = 1_000;
    const lenient = classifyIndexDisk('testbed', measuredMb, {
      budgetMb: 2_048,
      exceedances: [],
    });
    const strict = classifyIndexDisk('testbed', measuredMb, { budgetMb: 500, exceedances: [] });
    expect(lenient.status).toBe('within-budget');
    expect(strict.status).toBe('over-ceiling');
    expect(lenient.status).not.toBe(strict.status);
  });
});

describe('KNOWN_INDEX_DISK_EXCEEDANCES', () => {
  it('bounds every recorded exceedance above what was observed', () => {
    // A ceiling at or below the observation would be red on day one — the
    // permanently-failing gauge everyone learns to ignore, which is how the
    // budget got ignored the first time.
    for (const e of KNOWN_INDEX_DISK_EXCEEDANCES) {
      expect(e.observedCeilingMb).toBeGreaterThan(e.observedMb);
      expect(e.why.length).toBeGreaterThan(40);
    }
  });

  it('only records exceedances that actually exceed the budget', () => {
    // A record for a backend already inside the budget would be an allowance
    // for a breach that does not exist — decorative, and it would silently
    // widen the budget if the footprint later grew into it.
    for (const e of KNOWN_INDEX_DISK_EXCEEDANCES) {
      expect(e.observedMb).toBeGreaterThan(DEFAULT_RESOURCE_BUDGET.indexDiskMbMax);
    }
  });

  it('grades the recorded gitnexus footprint as an accepted, bounded exceedance', () => {
    const gitnexus = KNOWN_INDEX_DISK_EXCEEDANCES.find((e) => e.backend === 'gitnexus');
    expect(gitnexus).toBeDefined();
    const v = classifyIndexDisk('gitnexus', (gitnexus as KnownIndexDiskExceedance).observedMb);
    expect(v.status).toBe('accepted-exceedance');
  });
});
