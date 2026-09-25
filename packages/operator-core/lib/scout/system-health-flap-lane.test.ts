import { describe, expect, it } from 'vitest';
import { buildSystemHealthFlapPatterns, type CriticalHealthEntry } from './system-health-flap-lane';
import { flattenDigest } from './lenses';
import type { CorpusDigest } from './types';

const entry = (
  id: string, panel: string, at: string, recoveryId: string | null, recoveryAt: string | null,
): CriticalHealthEntry => ({ id, panel, at, recoveryId, recoveryAt });

describe('system health flap patterns', () => {
  it('counts critical transitions, measures returns to OK, and marks open episodes incomplete', () => {
    const lane = buildSystemHealthFlapPatterns([
      entry('1', 'infrastructure', '2026-09-25T10:00:00Z', '11', '2026-09-25T10:10:00Z'),
      entry('2', 'infrastructure', '2026-09-25T12:00:00Z', '12', '2026-09-25T12:30:00Z'),
      entry('3', 'infrastructure', '2026-09-25T14:00:00Z', null, null),
    ]);
    const digest = {
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      systemHealthFlaps: lane,
    } satisfies CorpusDigest;
    const flat = flattenDigest(digest);
    expect(flat.map((pattern) => pattern.ref)).toEqual(['health-transition:3']);
    expect(flat[0]).toMatchObject({ category: 'system-health-flap' });
    expect(flat[0]?.summary).toContain('3 time(s) in 14d; 1 return(s) to OK not observed');
    expect(flat[0]?.detail).toContain('median 20 min to OK');
    expect(flat[0]?.detail).toContain('latest OK transition id=12');
    expect(flat[0]?.detail).toContain('not unique incidents');
  });

  it('reports unread critical transitions and panels beyond the pattern cap', () => {
    const lane = buildSystemHealthFlapPatterns([
      entry('1', 'infrastructure', '2026-09-25T10:00:00Z', null, null),
      entry('2', 'release', '2026-09-25T11:00:00Z', null, null),
    ], { limit: 1, totalCritical: 5 });
    expect(lane.at(-1)?.ref).toBe('health-transition:coverage-residue');
    expect(lane.at(-1)?.summary).toContain('3 critical transition(s)');
  });
});
