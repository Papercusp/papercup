/**
 * plan-start-consult.test.ts — D-006 partition semantics (P-010).
 *
 * The three-way verdict is the contract: below-floor → silent proceed;
 * above-floor with ANY wakeable candidate → nudge; above-floor all-dead →
 * proceed with transcript excerpts. Route + excerpt deps are stubbed — the
 * router itself is covered by relevance-router.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { RouteResult, RoutingCandidate } from './relevance-router';
import { DEAD_RESPONDER_STATES } from './get-feedback-core';
import {
  buildPlanStartQuery,
  PLAN_START_QUERY_MAX_CHARS,
  planStartConsult,
  type PlanStartConsultDeps,
  type PlanStartExcerpt,
} from './plan-start-consult';

function candidate(ownerId: string, liveness: string, score = 0.7): RoutingCandidate {
  return {
    ownerId,
    score,
    signals: { similarity: 0.6, recency: 0.5, verification: 0.2, authorship: 0 },
    evidence: [{ session_id: `s-${ownerId}`, turn_idx: 1, ts: '2026-08-16T00:00:00.000Z', sim: 0.6 }],
    liveness,
  };
}

function routed(cands: RoutingCandidate[]): RouteResult {
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
    },
    queryVec: [0.1],
  };
}

function deps(
  route: RouteResult,
  excerpts: PlanStartExcerpt[] | Error = [],
): PlanStartConsultDeps & { excerptCalls: Array<Array<{ ownerId: string }>> } {
  const excerptCalls: Array<Array<{ ownerId: string }>> = [];
  return {
    excerptCalls,
    route: async () => route,
    getExcerpts: async (refs) => {
      excerptCalls.push(refs.map((r) => ({ ownerId: r.ownerId })));
      if (excerpts instanceof Error) throw excerpts;
      return excerpts;
    },
  };
}

const params = {
  workspaceId: 'ws',
  requesterId: 'su-me',
  planSlug: 'a-plan-2026-08-16',
  planContent: '# a plan\n\nbody',
};

describe('planStartConsult (D-006 partition)', () => {
  it('below the floor → silent proceed', async () => {
    const out = await planStartConsult(params, deps(routed([])));
    expect(out).toEqual({ outcome: 'proceed', verdict: 'no_qualified_responder' });
  });

  it('degraded instrument → proceed, degrade carried honestly', async () => {
    const r = routed([]);
    r.snapshot.degraded = 'embed-unavailable';
    r.queryVec = null;
    const out = await planStartConsult(params, deps(r));
    expect(out).toEqual({
      outcome: 'proceed',
      verdict: 'no_qualified_responder',
      degraded: 'embed-unavailable',
    });
  });

  it('any LIVE candidate → nudge with the full qualified set (dead ones included as evidence)', async () => {
    const live = candidate('su-live', 'live');
    const dead = candidate('su-dead', 'ended');
    const d = deps(routed([live, dead]));
    const out = await planStartConsult(params, d);
    expect(out.outcome).toBe('nudge');
    if (out.outcome === 'nudge') expect(out.candidates.map((c) => c.ownerId)).toEqual(['su-live', 'su-dead']);
    expect(d.excerptCalls).toHaveLength(0); // no retrieval on the nudge branch
  });

  it('a PARKED candidate is wakeable → nudge (parked is not dead)', async () => {
    const out = await planStartConsult(params, deps(routed([candidate('su-parked', 'parked')])));
    expect(out.outcome).toBe('nudge');
  });

  it('ALL candidates dead → proceed_with_excerpts (retrieval, not consult)', async () => {
    const excerpt: PlanStartExcerpt = {
      ownerId: 'su-dead',
      session_id: 's-su-dead',
      turn_idx: 1,
      ts: '2026-08-16T00:00:00.000Z',
      sim: 0.6,
      excerpt: 'I tried this and…',
    };
    const d = deps(routed([candidate('su-dead', 'ended'), candidate('su-rec', 'recorded')]), [excerpt]);
    const out = await planStartConsult(params, d);
    expect(out.outcome).toBe('proceed_with_excerpts');
    if (out.outcome === 'proceed_with_excerpts') {
      expect(out.excerpts).toEqual([excerpt]);
      expect(out.candidates).toHaveLength(2);
    }
    expect(d.excerptCalls[0]).toEqual([{ ownerId: 'su-dead' }, { ownerId: 'su-rec' }]);
  });

  it('excerpt fetch failure still proceeds (nudge never block) — empty excerpts, no throw', async () => {
    const d = deps(routed([candidate('su-dead', 'ended')]), new Error('pg down'));
    const out = await planStartConsult(params, d);
    expect(out.outcome).toBe('proceed_with_excerpts');
    if (out.outcome === 'proceed_with_excerpts') expect(out.excerpts).toEqual([]);
  });

  it('D-006 partition premise: the shared dead-set excludes live and parked', () => {
    // If get-feedback-core ever widens DEAD_RESPONDER_STATES to swallow
    // live/parked, the nudge branch silently dies — fail here first.
    expect(DEAD_RESPONDER_STATES.has('live')).toBe(false);
    expect(DEAD_RESPONDER_STATES.has('parked')).toBe(false);
    expect(DEAD_RESPONDER_STATES.has('ended')).toBe(true);
    expect(DEAD_RESPONDER_STATES.has('recorded')).toBe(true);
  });
});

describe('buildPlanStartQuery', () => {
  it('prefixes the slug and carries the content', () => {
    const q = buildPlanStartQuery('my-plan', 'body text');
    expect(q).toContain('plan my-plan');
    expect(q).toContain('body text');
  });

  it('caps a huge plan body at PLAN_START_QUERY_MAX_CHARS', () => {
    const q = buildPlanStartQuery('my-plan', 'x'.repeat(100_000));
    expect(q.length).toBe(PLAN_START_QUERY_MAX_CHARS);
  });
});
