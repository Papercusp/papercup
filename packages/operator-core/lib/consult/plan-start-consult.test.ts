/**
 * plan-start-consult.test.ts — P-002 partition semantics
 * (consult-min-max-and-rubric-vetting-2026-08-17, D-001 §2 / D-002 / D-003).
 *
 * The partition is the contract: any selectable live candidate —
 * floor-qualified or best-available minimum fill — → nudge (labeled
 * selection); floor-qualified all-dead → proceed with transcript excerpts;
 * minimum physically unfillable → honest proceed (no_live_responder when a
 * pool existed, no_qualified_responder when none / degraded). Route + excerpt
 * deps are stubbed — the router itself is covered by
 * relevance-router.integration.test.ts, and the shared selectResponders by
 * get-feedback-core's suites.
 */
import { describe, expect, it } from 'vitest';
import type { RouteResult, RoutingCandidate } from './relevance-router';
import { DEAD_RESPONDER_STATES, DEFAULT_MAX_RESPONDERS, DEFAULT_MIN_RESPONDERS } from './get-feedback-core';
import {
  buildGoalKickoffQuery,
  buildPlanStartQuery,
  goalKickoffConsult,
  PLAN_START_QUERY_MAX_CHARS,
  planStartConsult,
  type PlanStartConsultDeps,
  type PlanStartExcerpt,
} from './plan-start-consult';

function candidate(ownerId: string, liveness: string, score = 0.7): RoutingCandidate {
  return {
    ownerId,
    score,
    signals: { similarity: score >= 0.5 ? 0.6 : 0.3, recency: 0.5, verification: 0.2, authorship: 0 },
    evidence: [{ session_id: `s-${ownerId}`, turn_idx: 1, ts: '2026-08-16T00:00:00.000Z', sim: 0.6 }],
    liveness,
  };
}

/** qualified = floor-clearing candidates; pool = the full ranked snapshot
 * (defaults to qualified — pass a superset to model below-floor candidates). */
function routed(qualified: RoutingCandidate[], pool?: RoutingCandidate[]): RouteResult {
  const candidates = pool ?? qualified;
  return {
    verdict: qualified.length > 0 ? 'routed' : 'no_qualified_responder',
    qualified,
    snapshot: {
      query: 'q',
      floor: 0.5,
      simFloor: 0.4,
      weights: { similarity: 0.55, recency: 0.15, verification: 0.15, authorship: 0.15 },
      candidates,
      computedAt: '2026-08-16T00:00:00.000Z',
    },
    queryVec: [0.1],
    queryProfile: null,
    queryMode: null,
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

describe('planStartConsult (P-002 partition, min:1)', () => {
  it('empty candidate pool → honest proceed (no_qualified_responder)', async () => {
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

  it('below the floor with a LIVE best-available → nudge labeled via:"minimum" (D-001 §2 — no silent promote)', async () => {
    const fill = candidate('su-below', 'live', 0.3);
    const d = deps(routed([], [fill]));
    const out = await planStartConsult(params, d);
    expect(out.outcome).toBe('nudge');
    if (out.outcome === 'nudge') {
      expect(out.candidates.map((c) => c.ownerId)).toEqual(['su-below']);
      expect(out.selection.min).toBe(DEFAULT_MIN_RESPONDERS);
      expect(out.selection.max).toBe(DEFAULT_MAX_RESPONDERS);
      expect(out.selection.selected).toEqual([
        expect.objectContaining({ ownerId: 'su-below', via: 'minimum' }),
      ]);
    }
    expect(d.excerptCalls).toHaveLength(0);
  });

  it('minimum fill takes the BEST-scoring live below-floor candidate, exactly one (min:1)', async () => {
    const better = candidate('su-better', 'live', 0.4);
    const worse = candidate('su-worse', 'live', 0.2);
    const out = await planStartConsult(params, deps(routed([], [better, worse])));
    expect(out.outcome).toBe('nudge');
    if (out.outcome === 'nudge') {
      expect(out.selection.selected.map((s) => s.ownerId)).toEqual(['su-better']);
      expect(out.candidates.map((c) => c.ownerId)).toEqual(['su-better']);
    }
  });

  it('below the floor with an ALL-DEAD pool → proceed no_live_responder (unfillable minimum, not silent)', async () => {
    const out = await planStartConsult(
      params,
      deps(routed([], [candidate('su-dead', 'ended', 0.3), candidate('su-rec', 'recorded', 0.2)])),
    );
    expect(out).toEqual({ outcome: 'proceed', verdict: 'no_live_responder' });
  });

  it('floor-qualified LIVE candidate → nudge via:"floor"; dead qualified ride along as evidence', async () => {
    const live = candidate('su-live', 'live');
    const dead = candidate('su-dead', 'ended');
    const d = deps(routed([live, dead]));
    const out = await planStartConsult(params, d);
    expect(out.outcome).toBe('nudge');
    if (out.outcome === 'nudge') {
      expect(out.candidates.map((c) => c.ownerId)).toEqual(['su-live', 'su-dead']);
      expect(out.selection.selected).toEqual([expect.objectContaining({ ownerId: 'su-live', via: 'floor' })]);
    }
    expect(d.excerptCalls).toHaveLength(0); // no retrieval on the nudge branch
  });

  it('a PARKED candidate is wakeable → nudge (parked is not dead)', async () => {
    const out = await planStartConsult(params, deps(routed([candidate('su-parked', 'parked')])));
    expect(out.outcome).toBe('nudge');
  });

  it('qualified all dead + a live below-floor fill → nudge (minimum fill), dead qualified appended', async () => {
    const deadQ = candidate('su-deadq', 'ended');
    const fill = candidate('su-fill', 'parked', 0.3);
    const d = deps(routed([deadQ], [deadQ, fill]));
    const out = await planStartConsult(params, d);
    expect(out.outcome).toBe('nudge');
    if (out.outcome === 'nudge') {
      expect(out.selection.selected).toEqual([expect.objectContaining({ ownerId: 'su-fill', via: 'minimum' })]);
      // Selected set first, then the dead floor-qualified evidence.
      expect(out.candidates.map((c) => c.ownerId)).toEqual(['su-fill', 'su-deadq']);
    }
    expect(d.excerptCalls).toHaveLength(0);
  });

  it('the selected set caps at the global max even with more live qualified', async () => {
    const many = [1, 2, 3, 4, 5].map((i) => candidate(`su-${i}`, 'live'));
    const out = await planStartConsult(params, deps(routed(many)));
    expect(out.outcome).toBe('nudge');
    if (out.outcome === 'nudge') {
      expect(out.selection.selected).toHaveLength(DEFAULT_MAX_RESPONDERS);
      expect(out.selection.selected.every((s) => s.via === 'floor')).toBe(true);
    }
  });

  it('ALL candidates dead, no live fill anywhere → proceed_with_excerpts (retrieval, not consult)', async () => {
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

  it('excerpts stay scoped to FLOOR-QUALIFIED dead candidates — a dead below-floor pool row is never fetched', async () => {
    const deadQ = candidate('su-deadq', 'ended');
    const deadBelow = candidate('su-deadbelow', 'ended', 0.3);
    const d = deps(routed([deadQ], [deadQ, deadBelow]));
    const out = await planStartConsult(params, d);
    expect(out.outcome).toBe('proceed_with_excerpts');
    expect(d.excerptCalls[0]).toEqual([{ ownerId: 'su-deadq' }]);
  });

  it('excerpt fetch failure still proceeds (nudge never block) — empty excerpts, no throw', async () => {
    const d = deps(routed([candidate('su-dead', 'ended')]), new Error('pg down'));
    const out = await planStartConsult(params, d);
    expect(out.outcome).toBe('proceed_with_excerpts');
    if (out.outcome === 'proceed_with_excerpts') expect(out.excerpts).toEqual([]);
  });

  it('partition premises: the shared dead-set excludes live/parked; the global min is 1', () => {
    // If get-feedback-core ever widens DEAD_RESPONDER_STATES to swallow
    // live/parked, the nudge branch silently dies — fail here first. If the
    // global minimum ever drops to 0, D-001 §2 (plan-step min:1) is broken.
    expect(DEAD_RESPONDER_STATES.has('live')).toBe(false);
    expect(DEAD_RESPONDER_STATES.has('parked')).toBe(false);
    expect(DEAD_RESPONDER_STATES.has('ended')).toBe(true);
    expect(DEAD_RESPONDER_STATES.has('recorded')).toBe(true);
    expect(DEFAULT_MIN_RESPONDERS).toBeGreaterThanOrEqual(1);
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

describe('buildGoalKickoffQuery (P-010 — the goal OUTLINE as query document)', () => {
  it('prefixes the title and carries body + labeled kill criterion', () => {
    const q = buildGoalKickoffQuery({
      title: 'Ship a paid app',
      body: 'what winning looks like',
      killCriterion: 'no paying user by day 30',
    });
    expect(q).toContain('goal Ship a paid app');
    expect(q).toContain('what winning looks like');
    expect(q).toContain('Kill criterion: no paying user by day 30');
  });

  it('omits absent/blank sections instead of emitting empty labels', () => {
    const q = buildGoalKickoffQuery({ title: 'Ship it', body: '   ', killCriterion: null });
    expect(q).toBe('goal Ship it');
    expect(q).not.toContain('Kill criterion:');
  });

  it('caps at the same window as the plan query (shared embedder budget)', () => {
    const q = buildGoalKickoffQuery({ title: 'T', body: 'x'.repeat(100_000) });
    expect(q.length).toBe(PLAN_START_QUERY_MAX_CHARS);
  });
});

describe('goalKickoffConsult (P-010 — same partition as the plan-step consult)', () => {
  const goalParams = {
    workspaceId: 'ws',
    requesterId: 'su-me',
    title: 'Ship a paid app',
    body: 'scope + constraints',
    killCriterion: 'no paying user by day 30',
  };

  it('routes the OUTLINE query — not a plan-slug query', async () => {
    let seenQuestion = '';
    const d = deps(routed([]));
    const routeSpy: PlanStartConsultDeps['route'] = async (p) => {
      seenQuestion = p.question;
      return routed([]);
    };
    const out = await goalKickoffConsult(goalParams, { ...d, route: routeSpy });
    expect(out).toEqual({ outcome: 'proceed', verdict: 'no_qualified_responder' });
    expect(seenQuestion).toContain('goal Ship a paid app');
    expect(seenQuestion).toContain('Kill criterion: no paying user by day 30');
  });

  it('delegates to the shared partition: live qualified → nudge via:"floor" (min:1 semantics intact)', async () => {
    const out = await goalKickoffConsult(goalParams, deps(routed([candidate('su-live', 'live')])));
    expect(out.outcome).toBe('nudge');
    if (out.outcome === 'nudge') {
      expect(out.selection.min).toBe(DEFAULT_MIN_RESPONDERS);
      expect(out.selection.selected).toEqual([
        expect.objectContaining({ ownerId: 'su-live', via: 'floor' }),
      ]);
    }
  });

  it('delegates the minimum-fill branch too: live below-floor → nudge via:"minimum"', async () => {
    const out = await goalKickoffConsult(
      goalParams,
      deps(routed([], [candidate('su-below', 'live', 0.3)])),
    );
    expect(out.outcome).toBe('nudge');
    if (out.outcome === 'nudge') {
      expect(out.selection.selected).toEqual([
        expect.objectContaining({ ownerId: 'su-below', via: 'minimum' }),
      ]);
    }
  });

  it('all-dead qualified → proceed_with_excerpts (retrieval, not consult)', async () => {
    const d = deps(routed([candidate('su-dead', 'ended')]));
    const out = await goalKickoffConsult(goalParams, d);
    expect(out.outcome).toBe('proceed_with_excerpts');
    expect(d.excerptCalls[0]).toEqual([{ ownerId: 'su-dead' }]);
  });
});
