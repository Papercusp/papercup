/**
 * markEliteFederatable (F1-4 / P-012, federated-scout-gym) — hermetic tests for
 * the WI-1564-guarded elite SEND seam: a non-eligible elite is not stamped; an
 * eligible elite REFUSES LOUDLY under the non-federating coordination/'*'
 * partition (the strand combo — the twin of assertFact's shareable-fact guard);
 * an eligible elite in a real workspace stamps the LOCAL row.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { markEliteFederatable } from './federate-elite';

/** Tagged-template sql fake capturing interpolated values per call. */
function fakeSql(rowsToReturn: unknown[] = []): { sql: Sql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    return Promise.resolve(rowsToReturn);
  };
  return { sql: fn as unknown as Sql, calls };
}

const base = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', nicheKey: 'v1:loop/guard/r2/size-m' };

describe('markEliteFederatable — eligibility (D-002)', () => {
  it('does NOT stamp a non-eligible elite (no SQL, no error)', async () => {
    const { sql, calls } = fakeSql([{ niche_key: base.nicheKey }]);
    const res = await markEliteFederatable({ ...base, eligibility: { outcome: 'lost', grade: 2 } }, sql);
    expect(res).toEqual({ federatable: false, reason: 'not-eligible' });
    expect(calls).toHaveLength(0);
  });

  it('accepts outcome=won OR grade>=4', async () => {
    const { sql: s1 } = fakeSql([{ niche_key: base.nicheKey }]);
    expect((await markEliteFederatable({ ...base, eligibility: { outcome: 'won' } }, s1)).federatable).toBe(true);
    const { sql: s2 } = fakeSql([{ niche_key: base.nicheKey }]);
    expect((await markEliteFederatable({ ...base, eligibility: { grade: 4 } }, s2)).federatable).toBe(true);
  });
});

describe('markEliteFederatable — WI-1564 strand guard', () => {
  it('REFUSES LOUDLY when an eligible elite would federate from a non-federating partition', async () => {
    for (const ws of ['default', '*', '']) {
      const { sql, calls } = fakeSql([{ niche_key: base.nicheKey }]);
      await expect(
        markEliteFederatable({ ...base, workspaceId: ws, eligibility: { outcome: 'won' } }, sql),
      ).rejects.toThrow(/WI-1564/);
      expect(calls).toHaveLength(0); // never even reaches the UPDATE
    }
  });
});

describe('markEliteFederatable — stamp the local row', () => {
  it('UPDATEs the local (source_hive NULL) row for the (ws, harness, niche)', async () => {
    const { sql, calls } = fakeSql([{ niche_key: base.nicheKey }]);
    const res = await markEliteFederatable({ ...base, eligibility: { outcome: 'won' } }, sql);
    expect(res).toEqual({ federatable: true, reason: 'stamped' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['papercusp-workspace', 'papercusp', base.nicheKey]);
  });

  it('reports no-row when the niche has no local elite', async () => {
    const { sql } = fakeSql([]);
    const res = await markEliteFederatable({ ...base, eligibility: { grade: 5 } }, sql);
    expect(res).toEqual({ federatable: false, reason: 'no-row' });
  });
});
