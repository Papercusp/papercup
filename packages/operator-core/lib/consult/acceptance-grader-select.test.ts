/**
 * acceptance-grader-select.test.ts — D-009 grader-discovery semantics (P-011).
 *
 * The contract under test: exclusions apply EVEN ABOVE-FLOOR (independence
 * outranks familiarity), the floor asymmetry (below-floor → fresh, never a
 * stalled gate), and the liveness refinement (an unreachable top candidate is
 * skipped; all-dead → fresh). Route + sql are stubbed; the router itself is
 * covered by relevance-router.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { ConsultRouteParams, RouteResult, RoutingCandidate } from './relevance-router';
import {
  buildGraderQuery,
  computeGraderExclusions,
  GRADER_QUERY_MAX_CHARS,
  selectAcceptanceGrader,
} from './acceptance-grader-select';

function candidate(ownerId: string, liveness: string, score = 0.7): RoutingCandidate {
  return {
    ownerId,
    score,
    signals: { similarity: 0.6, recency: 0.5, verification: 0.2, authorship: 0 },
    evidence: [{ session_id: `s-${ownerId}`, turn_idx: 1, ts: null, sim: 0.6 }],
    liveness,
  };
}

function routed(cands: RoutingCandidate[], degraded = false): RouteResult {
  return {
    verdict: cands.length > 0 ? 'routed' : 'no_qualified_responder',
    qualified: cands,
    snapshot: {
      query: 'q',
      floor: 0.5,
      simFloor: 0.4,
      weights: { similarity: 0.55, recency: 0.15, verification: 0.15, authorship: 0.15 },
      candidates: cands,
      computedAt: '2026-08-16T00:00:00.000Z',
      ...(degraded ? { degraded: 'embed-unavailable' as const } : {}),
    },
    queryVec: degraded ? null : [0.1],
  };
}

/** Tagged-template stub: every sql`...` call resolves to `rows`. */
function fakeSql(rows: Array<{ owner: string }>): Sql {
  return (async () => rows) as unknown as Sql;
}

const params = {
  workspaceId: 'ws',
  planSlug: 'a-plan',
  planContent: 'plan body',
  rubricText: 'rubric: outcome works',
};

describe('selectAcceptanceGrader (D-009)', () => {
  it('assigns the top reachable qualified candidate and threads the exclusion set to the router', async () => {
    const route = vi.fn(async (_p: ConsultRouteParams) => routed([candidate('su-expert', 'parked')]));
    const out = await selectAcceptanceGrader(
      { ...params, extraExclusions: ['su-author', null, 'su-shipper'] },
      { getSql: () => fakeSql([{ owner: 'su-implementer' }]), route },
    );
    expect(out.verdict).toBe('assigned');
    expect(out.grader?.ownerId).toBe('su-expert');
    // The router received the FULL exclusion set: computed + extras, no nulls.
    const call = route.mock.calls[0][0];
    expect(call.excludeOwners).toEqual(
      expect.arrayContaining(['su-implementer', 'su-author', 'su-shipper']),
    );
    expect(call.excludeOwners).not.toContain(null);
    // Synthetic requester — never a real owner id.
    expect(call.requesterId).toBe('acceptance-gate:a-plan');
    expect(out.excluded).toEqual(expect.arrayContaining(['su-implementer', 'su-author', 'su-shipper']));
  });

  it('below floor / all-excluded → fresh (the floor asymmetry: the gate never stalls)', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      route: async () => routed([]),
    });
    expect(out).toMatchObject({ verdict: 'fresh', freshReason: 'no_qualified_non_excluded' });
  });

  it('skips a dead top candidate toward the next reachable one', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      route: async () => routed([candidate('su-dead', 'ended', 0.9), candidate('su-live', 'live', 0.6)]),
    });
    expect(out.verdict).toBe('assigned');
    expect(out.grader?.ownerId).toBe('su-live');
  });

  it('ALL qualified dead → fresh with all_qualified_dead', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      route: async () => routed([candidate('su-dead', 'ended'), candidate('su-rec', 'recorded')]),
    });
    expect(out).toMatchObject({ verdict: 'fresh', freshReason: 'all_qualified_dead' });
  });

  it('degraded embedder → fresh with degraded (cannot measure ≠ measured nothing)', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      route: async () => routed([], true),
    });
    expect(out).toMatchObject({ verdict: 'fresh', freshReason: 'degraded' });
  });
});

describe('computeGraderExclusions', () => {
  it('dedupes computed rows with extras and drops null/undefined extras', async () => {
    const out = await computeGraderExclusions(
      fakeSql([{ owner: 'su-a' }, { owner: 'su-b' }]),
      'ws',
      'a-plan',
      ['su-b', 'su-c', null, undefined],
    );
    expect([...out].sort()).toEqual(['su-a', 'su-b', 'su-c']);
  });
});

describe('buildGraderQuery', () => {
  it('leads with the rubric (the definition of done) and caps the total', () => {
    const q = buildGraderQuery('a-plan', 'RUBRIC TEXT', 'x'.repeat(100_000));
    expect(q.startsWith('acceptance grading for plan a-plan\n\nRUBRIC TEXT')).toBe(true);
    expect(q.length).toBe(GRADER_QUERY_MAX_CHARS);
  });
});
