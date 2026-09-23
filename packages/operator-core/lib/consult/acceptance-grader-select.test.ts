/**
 * acceptance-grader-select.test.ts — grader-discovery semantics.
 *
 * The contract under test: exclusions apply EVEN ABOVE-FLOOR (D-009 —
 * independence outranks familiarity); the menu is bounded by the SHARED
 * ACCEPTANCE_GRADING_POLICY rather than by a number written in the module (the
 * bound itself is deliberately NOT restated here — the assertions below read it
 * from the registry, so this comment cannot go stale when it moves);
 * below-floor MINIMUM-FILLS instead of minting a fresh session
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
  collapseToDistinctParties,
  computeGraderExclusions,
  GRADER_QUERY_MAX_CHARS,
  selectAcceptanceGrader,
} from './acceptance-grader-select';

function candidate(ownerId: string, liveness: string, score = 0.7): RoutingCandidate {
  return {
    ownerId,
    score,
    relevance: score,
    relativeAgeDays: 0,
    signals: { similarity: 0.6, verification: 0.2, authorship: 0, freshness: 1 },
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
      relevanceFloor: 0.41,
      simFloor: 0.4,
      weights: { similarity: 0.55, verification: 0.15, authorship: 0.15 },
      recencyHalfLifeDays: 7,
      candidates: cands,
      computedAt: '2026-08-16T00:00:00.000Z',
      ...(degraded ? { degraded: 'embed-unavailable' as const } : {}),
    },
    queryVec: degraded ? null : [0.1],
    queryProfile: null,
    queryMode: null,
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

/** No two candidates are the same party — every id is its own party key. */
const noParties = async (_workspaceId: string, ownerIds: string[]) =>
  new Map(ownerIds.map((ownerId) => [ownerId, ownerId] as const));

/** D-008: `groups` lists sets of ownerIds that are ONE party; every id not named
 * is its own party. The key is the group's first member, matching the
 * caller-order rule `lineagePartyKeys` uses in production. */
function partyLookup(groups: string[][]) {
  const keys = new Map<string, string>();
  for (const group of groups) for (const ownerId of group) keys.set(ownerId, group[0]!);
  return async (_workspaceId: string, ownerIds: string[]) =>
    new Map(ownerIds.map((ownerId) => [ownerId, keys.get(ownerId) ?? ownerId] as const));
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
        getPartyKeys: noParties,
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
    expect(call.excludeOwners).toEqual(expect.arrayContaining(['su-implementer', 'su-author', 'su-shipper']));
    expect(call.excludeOwners).not.toContain(null);
    // Synthetic requester — never a real owner id.
    expect(call.requesterId).toBe('acceptance-gate:a-plan');
    expect(out.excluded).toEqual(expect.arrayContaining(['su-implementer', 'su-author', 'su-shipper']));
  });

  it('excludes a candidate in the same party as a work-item vetting critic while retaining an unrelated grader', async () => {
    const criticAlias = candidate('su-critic-respawn', 'live', 0.95);
    const independent = candidate('su-independent', 'live', 0.8);
    const out = await selectAcceptanceGrader(
      { ...params, extraExclusions: ['su-work-item-critic'] },
      {
        getSql: () => fakeSql([]),
        getPartyKeys: partyLookup([['su-work-item-critic', 'su-critic-respawn']]),
        getCandidateRoles: roleLookup({ 'su-critic-respawn': 'reviewer', 'su-independent': 'reviewer' }),
        // The routing stub deliberately returns the critic's rebound identity:
        // raw excludeOwners cannot recognize it, so the party filter must.
        route: async () => routed([criticAlias, independent]),
      },
    );

    expect(out.graders.map((grader) => grader.candidate.ownerId)).toEqual(['su-independent']);
    expect(out.excluded).toEqual(expect.arrayContaining(['su-work-item-critic', 'su-critic-respawn']));
    expect(out.routing?.candidates.map((candidate) => candidate.ownerId)).toEqual(['su-independent']);
  });

  it('selects up to the policy MAX (2), best first, all via floor', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: noParties,
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
      getPartyKeys: noParties,
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
      getPartyKeys: noParties,
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
      getPartyKeys: noParties,
      getCandidateRoles: roleLookup({ 'su-good': 'reviewer', 'su-weak': 'reviewer' }),
      route: async () => ({
        ...routed([qualified]),
        snapshot: { ...routed([qualified]).snapshot, candidates: [qualified, below] },
      }),
    });
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-good']);
  });

  it('zero eligible actors → fresh with no_eligible_non_excluded + escalation', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: noParties,
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

  it('a DEAD top candidate KEEPS the top slot — grading dispatches, so deadness is not unreachability (R-2)', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: noParties,
      getCandidateRoles: roleLookup({ 'su-dead': 'reviewer', 'su-live': 'reviewer' }),
      route: async () => routed([candidate('su-dead', 'ended', 0.9), candidate('su-live', 'live', 0.6)]),
    });
    expect(out.verdict).toBe('assigned');
    // This used to be ['su-live'] — the gate skipped the better-matched judge
    // because a dead session could not be WOKEN. Acceptance grading now forks
    // or converts the transcript (D-013), so the 0.9 match leads and the live
    // 0.6 follows it on the cascade menu instead of displacing it.
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-dead', 'su-live']);
  });

  it('ALL eligible dead → a FULL menu, not a fresh mint: nothing is unselectable any more', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: noParties,
      getCandidateRoles: roleLookup({ 'su-dead': 'reviewer', 'su-rec': 'reviewer' }),
      route: async () => routed([candidate('su-dead', 'ended'), candidate('su-rec', 'recorded')]),
    });
    // The falsifier for D-013's coupling: if a liveness gate is ever put back
    // while acceptance-grader.ts still dispatches, this flips to a fresh mint
    // and fails here — rather than silently paying for a brand-new judge boot
    // whenever the best-matched graders happen to have ended.
    expect(out.verdict).toBe('assigned');
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-dead', 'su-rec']);
  });

  it('an EMPTY eligible pool is the only fresh mint left — and it says no_eligible_non_excluded', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: noParties,
      getCandidateRoles: roleLookup({}),
      route: async () => routed([]),
    });
    expect(out).toMatchObject({ verdict: 'fresh', graders: [], freshReason: 'no_eligible_non_excluded' });
  });

  it('degraded embedder → fresh with degraded (cannot measure ≠ measured nothing)', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: noParties,
      getCandidateRoles: roleLookup({}),
      route: async () => routed([], true),
    });
    expect(out).toMatchObject({ verdict: 'fresh', freshReason: 'degraded' });
  });

  it('skips a higher-scored judge and missing-role candidate for a coord-capable grader', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: noParties,
      getCandidateRoles: roleLookup({ 'su-judge': 'judge', 'su-reviewer': 'reviewer' }),
      route: async () =>
        routed([
          candidate('su-judge', 'live', 0.95),
          candidate('su-missing-role', 'live', 0.9),
          candidate('su-reviewer', 'live', 0.8),
        ]),
    });

    expect(out.verdict).toBe('assigned');
    // The judge is refused by role. The MISSING-ROLE candidate is NOT: role
    // eligibility is a denylist (plan D-003). It used to be a COORD_ROLES
    // allowlist, and because roles are read from the TTL-reaped coord_presence
    // projection, "no row" is the normal case for a live agent — that exclusion
    // rejected 100% of real candidates and kept the grading cascade from ever
    // opening. Admitting the unknown-role candidate here IS the regression this
    // test now pins.
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-missing-role', 'su-reviewer']);
    expect(out.eligibility).toEqual({ eligibleCount: 2, qualifiedCount: 2, measured: true });
    // The PERSISTED pool is the grader-eligible one too. cascade-core's refill leg
    // extends an exhausted menu from `candidates`, so persisting the router's
    // unfiltered list would let a refill wake the judge this test just refused.
    expect(out.routing?.candidates.map((c) => c.ownerId)).toEqual(['su-missing-role', 'su-reviewer']);
  });

  it('CONTROL: a live su-role candidate — the only role that actually exists in production — is selectable', async () => {
    // The falsifying control for the allowlist regression. Across the WHOLE
    // database coord_presence carries only agent_role='su' and NULL; 'su' is
    // absent from COORD_ROLES. Under the old allowlist this fixture returned
    // zero eligible and freshReason 'no_eligible_non_excluded' — which is
    // exactly what production did, silently, for every plan.
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: noParties,
      getCandidateRoles: roleLookup({ 'su-real': 'su' }),
      route: async () => routed([candidate('su-real', 'live', 0.8)]),
    });

    expect(out.verdict).toBe('assigned');
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-real']);
    expect(out.eligibility).toMatchObject({ eligibleCount: 1, qualifiedCount: 1, measured: true });
    expect(out.freshReason).toBeUndefined();
  });
});

/**
 * P-005 / D-008 — the independence invariants at n=2.
 *
 * Every rule below is followed by its CONTROL PAIR: the identical fixture with
 * the one input flipped that should reverse the verdict (D-007's tier-2
 * falsifiability discipline). A guard whose control also passes is not a guard.
 */
describe('independence invariants hold for the whole MENU, not the head (P-005)', () => {
  it('the D-009 exclusion set covers the MINIMUM-FILL slot — the fill does not re-route unexcluded', async () => {
    // The fill pool is `route.snapshot.candidates`, so it is only exclusion-safe
    // while it comes from the SAME excluded route call the qualified pick uses.
    // A future fill that routed again for a wider pool would pass every other
    // test in this file and silently seat an implementer as grader 2.
    const route = vi.fn(async (_p: ConsultRouteParams) => unqualified([candidate('su-below', 'live')]));
    const out = await selectAcceptanceGrader(
      { ...params, extraExclusions: ['su-author'] },
      {
        getSql: () => fakeSql([{ owner: 'su-implementer' }]),
        getPartyKeys: noParties,
        getCandidateRoles: roleLookup({ 'su-below': 'reviewer' }),
        route,
      },
    );
    expect(out.graders[0]?.via).toBe('minimum');
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0][0].excludeOwners).toEqual(expect.arrayContaining(['su-implementer', 'su-author']));
  });

  it('two ownerIds of ONE party yield ONE menu entry, not a two-grader menu', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      // su-child is what su-parent launched: two ids, one party.
      getPartyKeys: partyLookup([['su-parent', 'su-child']]),
      getCandidateRoles: roleLookup({ 'su-parent': 'reviewer', 'su-child': 'reviewer' }),
      route: async () => routed([candidate('su-parent', 'live', 0.9), candidate('su-child', 'live', 0.8)]),
    });
    // Under D-003 grader 2 reviews grader 1's carried card; one party twice makes
    // that a self-review the gate then ranks as the better-informed card (D-007).
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-parent']);
    expect(out.partyCollapsed).toEqual(['su-child']);
  });

  it('CONTROL: the identical menu with the two candidates UNRELATED selects both', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: noParties,
      getCandidateRoles: roleLookup({ 'su-parent': 'reviewer', 'su-child': 'reviewer' }),
      route: async () => routed([candidate('su-parent', 'live', 0.9), candidate('su-child', 'live', 0.8)]),
    });
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-parent', 'su-child']);
    expect(out.partyCollapsed).toEqual([]);
  });

  it("a party's representative is its QUALIFIED face, not merely its top-ranked one", async () => {
    // su-weak outranks su-strong but is below the floor. Collapsing on rank
    // alone would keep su-weak and drop the party's only above-floor face,
    // turning an independence guard into a silent floor demotion.
    const weak = candidate('su-weak', 'live', 0.9);
    const strong = candidate('su-strong', 'live', 0.8);
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: partyLookup([['su-weak', 'su-strong']]),
      getCandidateRoles: roleLookup({ 'su-weak': 'reviewer', 'su-strong': 'reviewer' }),
      route: async () => ({
        ...routed([strong]),
        snapshot: { ...routed([strong]).snapshot, candidates: [weak, strong] },
      }),
    });
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-strong']);
    expect(out.graders[0].via).toBe('floor');
    expect(out.partyCollapsed).toEqual(['su-weak']);
  });

  it('the collapse narrows the PERSISTED refill pool, not just the menu', async () => {
    // cascade-core's refill and revival legs extend an exhausted menu from
    // `routing.candidates`. Collapsing only the menu would leave the same party
    // reachable through the refill — the exact hole D-007 warned about.
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: partyLookup([['su-a', 'su-a-alias']]),
      getCandidateRoles: roleLookup({ 'su-a': 'reviewer', 'su-a-alias': 'reviewer', 'su-b': 'reviewer' }),
      route: async () =>
        routed([candidate('su-a', 'live', 0.9), candidate('su-a-alias', 'live', 0.85), candidate('su-b', 'live', 0.8)]),
    });
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-a', 'su-b']);
    expect(out.routing?.candidates.map((c) => c.ownerId)).toEqual(['su-a', 'su-b']);
    expect(out.eligibility.eligibleCount).toBe(2);
  });

  it('FAIL-SOFT (D-008): a party-lookup fault degrades to id-distinctness and says so by OMITTING partyCollapsed', async () => {
    const out = await selectAcceptanceGrader(params, {
      getSql: () => fakeSql([]),
      getPartyKeys: async () => {
        throw new Error('pg down');
      },
      getCandidateRoles: roleLookup({ 'su-parent': 'reviewer', 'su-child': 'reviewer' }),
      route: async () => routed([candidate('su-parent', 'live', 0.9), candidate('su-child', 'live', 0.8)]),
    });
    // Pre-D-008 behaviour, deliberately: refusing every ship in the workspace on
    // a transient PG fault is worse than a menu that may hold one party twice.
    expect(out.verdict).toBe('assigned');
    expect(out.graders.map((g) => g.candidate.ownerId)).toEqual(['su-parent', 'su-child']);
    // ABSENT, not []: a reader must be able to tell "no duplicates found" from
    // "never checked", which an empty array cannot say.
    expect('partyCollapsed' in out).toBe(false);
  });
});

describe('collapseToDistinctParties', () => {
  it('over-merges siblings through a shared candidate, and that is the disclosed direction (D-008)', () => {
    // A→B and B→C are related pairs; A and C are siblings the pairwise helper
    // calls UNRELATED. Union-find merges them anyway because B is in the set.
    // Recorded as a test so the over-exclusion is a known property, not a bug
    // someone later "fixes" into an under-exclusion.
    const a = candidate('su-a', 'live', 0.9);
    const b = candidate('su-b', 'live', 0.8);
    const c = candidate('su-c', 'live', 0.7);
    const keys = new Map([
      ['su-a', 'su-a'],
      ['su-b', 'su-a'],
      ['su-c', 'su-a'],
    ]);
    const out = collapseToDistinctParties([a, b, c], [a, b, c], keys);
    expect(out.eligible.map((x) => x.ownerId)).toEqual(['su-a']);
    expect(out.collapsed).toEqual(['su-b', 'su-c']);
  });

  it('CALIBRATION + CONTROL: the pre-D-008 rule keeps the pair the real subject collapses', () => {
    // The repo's falsifiability tier for an imported module: keep the
    // deliberately-wrong implementation as a permanent control beside a
    // calibration the real subject must pass. If these two ever agree, the
    // fixture stopped exercising the guard and every assertion above went
    // vacuous — which a passing suite would otherwise never reveal.
    const parent = candidate('su-parent', 'live', 0.9);
    const child = candidate('su-child', 'live', 0.8);
    const pool = [parent, child];
    const oneParty = new Map([
      ['su-parent', 'su-parent'],
      ['su-child', 'su-parent'],
    ]);
    expect(collapseToDistinctParties(pool, pool, oneParty).eligible.map((c) => c.ownerId)).toEqual(['su-parent']);
    // `selectRanked`'s pre-D-008 identity rule, applied to the SAME fixture.
    const idOnly = new Map([...oneParty.keys()].map((id) => [id, id] as const));
    expect(collapseToDistinctParties(pool, pool, idOnly).eligible.map((c) => c.ownerId)).toEqual([
      'su-parent',
      'su-child',
    ]);
  });

  it('an unknown ownerId is its own party — a partial key map never merges by accident', () => {
    const a = candidate('su-a', 'live', 0.9);
    const b = candidate('su-b', 'live', 0.8);
    const out = collapseToDistinctParties([a, b], [a, b], new Map([['su-a', 'su-a']]));
    expect(out.eligible.map((x) => x.ownerId)).toEqual(['su-a', 'su-b']);
    expect(out.collapsed).toEqual([]);
  });
});

describe('computeGraderExclusions', () => {
  it('dedupes computed rows with extras and drops null/undefined extras', async () => {
    const out = await computeGraderExclusions(fakeSql([{ owner: 'su-a' }, { owner: 'su-b' }]), 'ws', 'a-plan', [
      'su-b',
      'su-c',
      null,
      undefined,
    ]);
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
