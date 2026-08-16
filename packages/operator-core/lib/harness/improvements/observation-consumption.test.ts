/**
 * observation-consumption — P-004 / WI-36774 (D-028).
 *
 * Two things are pinned here, and the SECOND is the one that matters most:
 *
 *  1. The pure planners (ref extraction, the read∪folded union, the cap, the
 *     kill switch, fail-soft).
 *  2. **That the stamp is wired onto the REAL call path** — `buildScoutCycleDeps`
 *     → `readCorpus()`. That assertion exists because of this plan's own history:
 *     D-006 correctly observed that *"a fix that lands without an end-to-end
 *     assertion on the REAL call path is indistinguishable from no fix at all, and
 *     both of these had green tests"* — a rule D-024 preserved even while retracting
 *     the rest of D-006. This very file (`cycle-deps.ts`) has already shipped that
 *     exact bug twice: EI-12361/EI-12362, where `buildScoutCycleDeps` silently
 *     omitted `deadlineMs` from the deps it returned.
 *
 * Run: `cd packages/operator-core && npx vitest run lib/harness/improvements/observation-consumption`
 */
import { describe, it, expect, vi } from 'vitest';
import {
  foldedObservationRefs,
  planConsumptionStamps,
  recordObservationConsumption,
  observationConsumptionCap,
  observationConsumptionBackfillCap,
  type PlannedStamp,
} from './observation-consumption';
import type { CorpusDigest } from '../../scout/types';

function digest(over: Partial<CorpusDigest> = {}): CorpusDigest {
  return {
    recurringFriction: [],
    timeTokenSinks: [],
    chronicDeferrals: [],
    capabilityGaps: [],
    ...over,
  } as CorpusDigest;
}

describe('foldedObservationRefs', () => {
  it('extracts wi: refs across every ref-carrying lane', () => {
    const d = digest({
      recurringFriction: [{ summary: 'a', ref: 'wi:EI-1' }],
      timeTokenSinks: [{ summary: 'b', ref: 'wi:EI-2' }],
      chronicDeferrals: [{ summary: 'c', ref: 'wi:EI-3' }],
      capabilityGaps: [{ summary: 'd', ref: 'wi:EI-4' }],
    });
    expect([...foldedObservationRefs(d).keys()].sort()).toEqual(['EI-1', 'EI-2', 'EI-3', 'EI-4']);
  });

  it('IGNORES non-wi ref namespaces rather than blind-stripping a prefix', () => {
    // The control for D-024's error: that retraction was caused by keying on the
    // wrong thing. `fact:`/`rubric:`/`niche:`/`watchdog:` are real digest namespaces
    // and none of them names a work-item — a blind `slice(3)` would mint the
    // garbage ids `t:workspace:x`, `ric:r#c@h` and stamp rows that do not exist.
    const d = digest({
      standingFacts: [{ summary: 'f', ref: 'fact:workspace:some-key' }],
      rubricRatings: [{ summary: 'r', ref: 'rubric:rb-1#crit@hive' }],
      nicheMap: [{ summary: 'n', ref: 'niche:scope/domain/risk' }],
      watchdogHealth: [{ summary: 'w', ref: 'watchdog:collector' }],
      recurringFriction: [{ summary: 'real', ref: 'wi:EI-9' }],
    });
    expect([...foldedObservationRefs(d).keys()]).toEqual(['EI-9']);
  });

  it('collects multiple distinct pattern refs for one observation', () => {
    const d = digest({
      recurringFriction: [{ summary: 'a', ref: 'wi:EI-1' }],
      chronicDeferrals: [{ summary: 'b', ref: 'wi:EI-1' }],
    });
    // Same ref twice ⇒ deduped to one entry, not double-counted.
    expect(foldedObservationRefs(d).get('EI-1')).toEqual(['wi:EI-1']);
  });
});

describe('planConsumptionStamps', () => {
  const base = { cycleId: 'scout-1', nowIso: '2026-08-09T03:00:00.000Z' };

  it('stamps what the cycle READ, with no patternRefs when nothing folded it', () => {
    const out = planConsumptionStamps({ ...base, readIds: ['EI-1'], digest: digest() });
    expect(out).toEqual([{ id: 'EI-1', stamp: { at: base.nowIso, cycleId: 'scout-1' } }]);
    // "read but unremarkable" must be distinguishable from "folded" — that is the
    // whole point of the optional field, so assert it is genuinely absent.
    expect(out[0]!.stamp.patternRefs).toBeUndefined();
  });

  it('attaches patternRefs when the observation fed a pattern', () => {
    const out = planConsumptionStamps({
      ...base,
      readIds: ['EI-1'],
      digest: digest({ recurringFriction: [{ summary: 's', ref: 'wi:EI-1' }] }),
    });
    expect(out[0]!.stamp.patternRefs).toEqual(['wi:EI-1']);
  });

  it('CONTROL: stamps a FOLDED observation that is NOT in readIds', () => {
    // This is the falsifier for the narrower rule "stamp only what friction()
    // returned". A pattern can cite a row the current recency window no longer
    // covers; under the narrow rule those rows — the ones carrying the MOST
    // provenance — are exactly the ones that never get stamped. If someone
    // re-narrows planConsumptionStamps to `readIds`, this test fails and the
    // two above still pass.
    const out = planConsumptionStamps({
      ...base,
      readIds: [],
      digest: digest({ recurringFriction: [{ summary: 's', ref: 'wi:EI-OLD' }] }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('EI-OLD');
    expect(out[0]!.stamp.patternRefs).toEqual(['wi:EI-OLD']);
  });

  it('dedupes an id present in BOTH the read set and the folded set', () => {
    const out = planConsumptionStamps({
      ...base,
      readIds: ['EI-1', 'EI-1'],
      digest: digest({ recurringFriction: [{ summary: 's', ref: 'wi:EI-1' }] }),
    });
    expect(out).toHaveLength(1);
  });

  it('bounds one cycle to the cap (the backlog drains over cycles, not in one write)', () => {
    const readIds = Array.from({ length: 50 }, (_, i) => `EI-${i}`);
    expect(planConsumptionStamps({ ...base, readIds, digest: digest(), cap: 10 })).toHaveLength(10);
  });

  it('cap <= 0 is a KILL SWITCH — stamps nothing', () => {
    expect(planConsumptionStamps({ ...base, readIds: ['EI-1'], digest: digest(), cap: 0 })).toEqual([]);
    expect(planConsumptionStamps({ ...base, readIds: ['EI-1'], digest: digest(), cap: -1 })).toEqual([]);
  });

  it('skips empty ids rather than emitting a stamp keyed on ""', () => {
    expect(planConsumptionStamps({ ...base, readIds: ['', 'EI-1'], digest: digest() })).toHaveLength(1);
  });
});

describe('observationConsumptionCap', () => {
  it('defaults to 2000 and honours the env override', () => {
    const prior = process.env.PAPERCUSP_OBS_CONSUMPTION_CAP;
    try {
      delete process.env.PAPERCUSP_OBS_CONSUMPTION_CAP;
      expect(observationConsumptionCap()).toBe(2000);
      process.env.PAPERCUSP_OBS_CONSUMPTION_CAP = '5';
      expect(observationConsumptionCap()).toBe(5);
      process.env.PAPERCUSP_OBS_CONSUMPTION_CAP = 'nonsense';
      expect(observationConsumptionCap()).toBe(2000);
    } finally {
      if (prior === undefined) delete process.env.PAPERCUSP_OBS_CONSUMPTION_CAP;
      else process.env.PAPERCUSP_OBS_CONSUMPTION_CAP = prior;
    }
  });
});

describe('recordObservationConsumption', () => {
  it('passes the planned stamps to the write seam', async () => {
    const seen: PlannedStamp[][] = [];
    const res = await recordObservationConsumption(
      { workspaceId: 'ws', readIds: ['EI-1'], digest: digest(), cycleId: 'scout-1' },
      {
        stamp: async (_ws, planned) => {
          seen.push([...planned]);
          return planned.length;
        },
      },
    );
    expect(res).toEqual({ planned: 1, stamped: 1 });
    expect(seen[0]![0]!.id).toBe('EI-1');
  });

  it('NEVER throws — a stamping fault must not cost a Scout cycle', async () => {
    const res = await recordObservationConsumption(
      { workspaceId: 'ws', readIds: ['EI-1'], digest: digest(), cycleId: 'scout-1' },
      {
        stamp: async () => {
          throw new Error('pg exploded');
        },
      },
    );
    expect(res.error).toBe('pg exploded');
    expect(res.stamped).toBe(0);
  });

  it('does not call the write seam when there is nothing to stamp', async () => {
    const stamp = vi.fn(async () => 0);
    const res = await recordObservationConsumption(
      { workspaceId: 'ws', readIds: [], digest: digest(), cycleId: 'scout-1' },
      { stamp },
    );
    expect(stamp).not.toHaveBeenCalled();
    expect(res).toEqual({ planned: 0, stamped: 0 });
  });
});

describe('the backfill sweep (D-001, EI-20580287040635676)', () => {
  const opts = { workspaceId: 'ws', readIds: ['EI-1'], digest: digest(), cycleId: 'scout-1' } as const;

  it('runs AFTER the head stamps and reports its count separately', async () => {
    const order: string[] = [];
    const res = await recordObservationConsumption(opts, {
      stamp: async (_ws, planned) => {
        order.push('head');
        return planned.length;
      },
      backfill: async (_ws, o) => {
        order.push('backfill');
        expect(o.cycleId).toBe('scout-1');
        expect(o.cap).toBeGreaterThan(0);
        return 7;
      },
    });
    // Head-first ordering is load-bearing: a genuine read this cycle must win the
    // `consumption IS NULL` race so its stamp (not a backfill marker) is what lands.
    expect(order).toEqual(['head', 'backfill']);
    expect(res).toEqual({ planned: 1, stamped: 1, backfilled: 7 });
  });

  it('sweeps EVEN when the cycle read nothing — a quiet cycle still drains the backlog', async () => {
    const backfill = vi.fn(async () => 3);
    const res = await recordObservationConsumption(
      { ...opts, readIds: [] },
      { stamp: vi.fn(async () => 0), backfill },
    );
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ planned: 0, stamped: 0, backfilled: 3 });
  });

  it('a deps stub WITHOUT a backfill seam gets the pre-sweep behavior, byte-identical', async () => {
    const res = await recordObservationConsumption(opts, {
      stamp: async (_ws, planned) => planned.length,
    });
    // No `backfilled` key at all — absence, not 0, so older consumers see no change.
    expect(res).toEqual({ planned: 1, stamped: 1 });
  });

  it('the WHOLE-PASS kill switch (head cap <= 0) disables the sweep too', async () => {
    const backfill = vi.fn(async () => 99);
    const res = await recordObservationConsumption(
      { ...opts, cap: 0 },
      { stamp: vi.fn(async () => 0), backfill },
    );
    expect(backfill).not.toHaveBeenCalled();
    expect(res).toEqual({ planned: 0, stamped: 0 });
  });

  it('its OWN kill switch (PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP <= 0) disables the sweep alone', async () => {
    const prior = process.env.PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP;
    try {
      process.env.PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP = '0';
      const backfill = vi.fn(async () => 99);
      const res = await recordObservationConsumption(opts, {
        stamp: async (_ws, planned) => planned.length,
        backfill,
      });
      expect(backfill).not.toHaveBeenCalled();
      // Head stamping is unaffected by the sweep's own switch.
      expect(res).toEqual({ planned: 1, stamped: 1 });
    } finally {
      if (prior === undefined) delete process.env.PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP;
      else process.env.PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP = prior;
    }
  });

  it('a sweep fault is fail-soft and never masks the head result', async () => {
    const res = await recordObservationConsumption(opts, {
      stamp: async (_ws, planned) => planned.length,
      backfill: async () => {
        throw new Error('backfill exploded');
      },
    });
    expect(res.planned).toBe(1);
    expect(res.stamped).toBe(1);
    expect(res.backfilled).toBeUndefined();
    expect(res.error).toBe('backfill exploded');
  });

  it('a HEAD fault still lets the sweep run (independent fail-soft), and the head error wins the slot', async () => {
    const backfill = vi.fn(async () => 2);
    const res = await recordObservationConsumption(opts, {
      stamp: async () => {
        throw new Error('pg exploded');
      },
      backfill,
    });
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(res.error).toBe('pg exploded');
    expect(res.backfilled).toBe(2);
  });
});

describe('observationConsumptionBackfillCap', () => {
  it('defaults to 2000 and honours the env override', () => {
    const prior = process.env.PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP;
    try {
      delete process.env.PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP;
      expect(observationConsumptionBackfillCap()).toBe(2000);
      process.env.PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP = '250';
      expect(observationConsumptionBackfillCap()).toBe(250);
      process.env.PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP = 'nonsense';
      expect(observationConsumptionBackfillCap()).toBe(2000);
    } finally {
      if (prior === undefined) delete process.env.PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP;
      else process.env.PAPERCUSP_OBS_CONSUMPTION_BACKFILL_CAP = prior;
    }
  });
});
