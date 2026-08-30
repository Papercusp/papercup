/**
 * acceptance-grader-select.test.ts — grader-discovery semantics.
 *
 * The contract under test: exclusions apply EVEN ABOVE-FLOOR (D-009 —
 * independence outranks familiarity); the menu is bounded by the SHARED
 * ACCEPTANCE_GRADING_POLICY (min 1 / max 2) rather than by a number written in
 * the module; below-floor MINIMUM-FILLS instead of minting a fresh session
 * (unified-responder-selection-critique-and-grading-2026-08-30 D-002 [owner],
 * which SUPERSEDES D-009's floor asymmetry — the reversal is asserted here
 * explicitly, so re-introducing the old behaviour fails a test that names it);
 * and the liveness gate applies to floor picks AND fills alike, so an all-dead
 * pool yields an empty menu rather than an unwakeable grader.
 *
 * Route + sql are stubbed; the router itself is covered by
 * relevance-router.integration.test.ts.
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

function unqualified(cands: RoutingCandidate[]): RouteResult {
  const result = routed([]);
  return { ...result, snapshot: { ...result.snapshot, candidates: cands } };
}

/** Tagged-template stub: every sql`...` call resolves to `rows`. */
function fakeSql(rows: Array<{ owner: string }>): Sql {
  return (async () => rows) as unknown as Sql;
}

function roleLookup(roles: Record<string, string | null | undefined>) {
  return async (_workspaceId: string, ownerIds: string[]) =>
    new Map(
      ownerIds.flatMap((ownerId) => {
        const role = roles[ownerId];
        return role == null ? [] : ([[ownerId, role]] as const);
      }),
    );
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
      {
        getSql: () => fakeSql([{ owner: 'su-implementer' }]),
        getCandidateRoles: roleLookup({ 'su-expert': 'reviewer' }),
        route,
      },
    );
    expect(out.verdict).toBe('assigned');
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-expert']);
    expect(out.graders[0].via).toBe('floor');
    expect(out.eligibility).toEqual({ eligibleCount: 1, qualifiedCount: 1, measured: true });
    expect(out.escalation).toBeUndefined();
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

  it('selects up to the policy MAX (2), best first, all via floor', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getCandidateRoles: roleLookup({ 'su-a': 'reviewer', 'su-b': 'reviewer', 'su-c': 'reviewer' }),
      route: async () =>
        routed([candidate('su-a', 'live', 0.9), candidate('su-b', 'live', 0.8), candidate('su-c', 'live', 0.7)]),
    });
    expect(out.verdict).toBe('assigned');
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-a', 'su-b']);
    expect(out.graders.every((g) => g.via === 'floor')).toBe(true);
    // The bound is the REGISTERED policy, not a number in this module: the menu
    // is capped at 2 with a third qualified candidate available.
    expect(out.routing?.selection).toMatchObject({ min: 1, max: 2 });
  });

  it('D-002 REVERSAL: a below-floor pool MINIMUM-FILLS instead of minting fresh', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getCandidateRoles: roleLookup({ 'su-below-floor': 'reviewer' }),
      route: async () => unqualified([candidate('su-below-floor', 'live')]),
    });
    // Pre-D-002 this asserted verdict:'fresh' / no_qualified_non_excluded.
    expect(out.verdict).toBe('assigned');
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-below-floor']);
    expect(out.graders[0].via).toBe('minimum');
    expect(out.eligibility).toMatchObject({ eligibleCount: 1, qualifiedCount: 0, measured: true });
    expect(out.escalation).toBeUndefined();
  });

  it('fills to MIN (1), never to MAX — a cap must not become a quota', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getCandidateRoles: roleLookup({ 'su-x': 'reviewer', 'su-y': 'reviewer' }),
      route: async () => unqualified([candidate('su-x', 'live', 0.4), candidate('su-y', 'live', 0.3)]),
    });
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-x']);
  });

  it('a qualified pick plus a below-floor fill is impossible — the fill only runs below MIN', async () => {
    // One qualified candidate already satisfies min:1, so the below-floor
    // candidate is NOT pulled in to reach max:2. Filling to max would convert a
    // cap into a quota and silently seat an unqualified second grader.
    const qualified = candidate('su-good', 'live', 0.9);
    const below = candidate('su-weak', 'live', 0.3);
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getCandidateRoles: roleLookup({ 'su-good': 'reviewer', 'su-weak': 'reviewer' }),
      route: async () => ({ ...routed([qualified]), snapshot: { ...routed([qualified]).snapshot, candidates: [qualified, below] } }),
    });
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-good']);
  });

  it('zero eligible actors → fresh with no_eligible_non_excluded + escalation', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getCandidateRoles: roleLookup({}),
      route: async () => routed([]),
    });
    expect(out).toMatchObject({
      verdict: 'fresh',
      graders: [],
      freshReason: 'no_eligible_non_excluded',
      eligibility: { eligibleCount: 0, qualifiedCount: 0, measured: true, reason: 'zero_eligible' },
      escalation: { code: 'zero_eligible' },
    });
    expect(out.routing).toBeUndefined();
  });

  it('skips a dead top candidate toward the next reachable one', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getCandidateRoles: roleLookup({ 'su-dead': 'reviewer', 'su-live': 'reviewer' }),
      route: async () => routed([candidate('su-dead', 'ended', 0.9), candidate('su-live', 'live', 0.6)]),
    });
    expect(out.verdict).toBe('assigned');
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-live']);
  });

  it('ALL eligible dead → fresh; the liveness gate blocks the minimum-fill too', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getCandidateRoles: roleLookup({ 'su-dead': 'reviewer', 'su-rec': 'reviewer' }),
      route: async () => routed([candidate('su-dead', 'ended'), candidate('su-rec', 'recorded')]),
    });
    // A populated-but-unreachable pool is NOT the same as an empty one, and it
    // must not be rescued by the fill: an unwakeable grader stalls the gate
    // exactly like no grader.
    expect(out).toMatchObject({ verdict: 'fresh', graders: [], freshReason: 'all_eligible_unselectable' });
  });

  it('degraded embedder → fresh with degraded (cannot measure ≠ measured nothing)', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getCandidateRoles: roleLookup({}),
      route: async () => routed([], true),
    });
    expect(out).toMatchObject({ verdict: 'fresh', freshReason: 'degraded' });
  });

  it('skips a higher-scored judge and missing-role candidate for a coord-capable grader', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getCandidateRoles: roleLookup({ 'su-judge': 'judge', 'su-reviewer': 'reviewer' }),
      route: async () =>
        routed([
          candidate('su-judge', 'live', 0.95),
          candidate('su-missing-role', 'live', 0.9),
          candidate('su-reviewer', 'live', 0.8),
        ]),
    });

    expect(out.verdict).toBe('assigned');
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-reviewer']);
    expect(out.eligibility).toEqual({ eligibleCount: 1, qualifiedCount: 1, measured: true });
    // The PERSISTED pool is the coord-capable one too. cascade-core's refill leg
    // extends an exhausted menu from `candidates`, so persisting the router's
    // unfiltered list would let a refill wake the judge this test just refused.
    expect(out.routing?.candidates.map((c) => c.ownerId)).toEqual(['su-reviewer']);
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
