/**
 * Tests for P-006 debate + recombine (D-006). Self-contained (local fake + local
 * fixtures). The load-bearing invariant pinned here: every RETURNED Proposal
 * carries a complete cheap falsifiable experiment — a group whose LLM output
 * fails the D-006 gate is DROPPED, never smuggled through.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Idea, Proposal, ScoredIdea, ScoutLlmCall } from './types';
import {
  buildRecombinePrompt,
  planRecombinations,
  validateProposal,
  recombineProposals,
  ACCEPTED_ROUTE_HINTS,
  ALL_ROUTE_HINTS,
  DELIBERATELY_UNACCEPTED_ROUTE_HINTS,
  type RouteHintHold,
  type RouteHintsAreExhaustive,
} from './recombine';
import { classifyProposal, DEFAULT_ROUTING_RAIL, makeGoalScaleOverride } from './router';

function idea(over: Partial<Idea> = {}): Idea {
  return {
    id: 'i1',
    lens: 'first-principles',
    title: 't',
    body: 'b',
    mechanism: 'm',
    addressesPatternRefs: [],
    ...over,
  };
}
function scored(over: Partial<ScoredIdea> = {}): ScoredIdea {
  return {
    idea: idea(),
    novelty: 0.8,
    feasibility: 0.7,
    noveltyMatches: [],
    verdict: 'keep',
    notes: '',
    ...over,
  };
}

/** A fake proposer LLM returning a fixed proposal JSON. */
function fakeProposer(json: unknown): ScoutLlmCall {
  return async () => ({ text: JSON.stringify(json), json, costUsd: 0, inputTokens: 0, outputTokens: 0 });
}

const COMPLETE_PROPOSAL = {
  framing: 'lock contention treated as attack not yield',
  mechanism: 'register events:await on grant; yield the turn',
  whyNew: 'prior lock work dropped; borrows immune tolerance',
  bet: 'kills the retry-storm class of friction',
  experiment: {
    hypothesis: 'most blocks are transient',
    method: 'instrument 50 blocks through the yield path',
    falsifiableSignal: 'retry-spins do not drop vs baseline',
  },
  route: 'plan',
};

describe('validateProposal (D-006 gate)', () => {
  it('accepts a complete proposal', () => {
    const v = validateProposal({
      framing: 'f',
      mechanism: 'm',
      whyNew: 'w',
      bet: 'b',
      cheapExperiment: { hypothesis: 'h', method: 'm', falsifiableSignal: 's' },
      sourceIdeaIds: ['a'],
      addressesPatternRefs: [],
    });
    expect(v.ok).toBe(true);
  });

  it('rejects a proposal whose experiment is incomplete', () => {
    const v = validateProposal({
      framing: 'f',
      mechanism: 'm',
      whyNew: 'w',
      bet: 'b',
      cheapExperiment: { hypothesis: 'h', method: '', falsifiableSignal: '' },
      sourceIdeaIds: ['a'],
      addressesPatternRefs: [],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/cheapExperiment/);
  });

  it('rejects a proposal missing a source idea', () => {
    const v = validateProposal({
      framing: 'f',
      mechanism: 'm',
      whyNew: 'w',
      bet: 'b',
      cheapExperiment: { hypothesis: 'h', method: 'm', falsifiableSignal: 's' },
      sourceIdeaIds: [],
      addressesPatternRefs: [],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/sourceIdeaIds/);
  });
});

describe('planRecombinations', () => {
  it('pairs topically-related survivors and leaves unrelated ones alone', () => {
    const s1 = scored({ idea: idea({ id: 'a', title: 'lock contention retry storm', body: 'blocked edits retry instead of yield' }), novelty: 0.9 });
    const s2 = scored({ idea: idea({ id: 'b', title: 'lock contention backoff', body: 'blocked edits should yield and wait' }), novelty: 0.8 });
    const s3 = scored({ idea: idea({ id: 'c', title: 'docs outline caching', body: 'cache the docs outline per session' }), novelty: 0.7 });
    const groups = planRecombinations([s1, s2, s3]);
    expect(groups).toHaveLength(2);
    expect(groups[0].members.map((m) => m.idea.id).sort()).toEqual(['a', 'b']);
    expect(groups[1].members.map((m) => m.idea.id)).toEqual(['c']);
  });

  it('respects maxGroups', () => {
    const survivors = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
      scored({ idea: idea({ id, title: `unrelated topic ${id}`, body: `distinct body ${id}` }), novelty: 0.9 - i * 0.1 }),
    );
    const groups = planRecombinations(survivors, { maxGroups: 2 });
    expect(groups.length).toBeLessThanOrEqual(2);
  });
});

describe('buildRecombinePrompt — target-aware goal intake', () => {
  it('offers goal only as a known-target amendment and forbids invented targets', () => {
    const group = planRecombinations([scored({ idea: idea({ id: 'goal-candidate' }) })])[0]!;
    const { system } = buildRecombinePrompt(group, {});
    expect(system).toContain('"route": "plan|gym|improvement|goal"');
    expect(system).toContain('targetGoalId');
    expect(system).toContain('ONLY to amend a KNOWN existing goal');
    expect(system).toContain('Never invent a targetGoalId');
  });
});

describe('recombineProposals', () => {
  it('only recombines survivors (verdict ≠ reject)', async () => {
    const kept = scored({ idea: idea({ id: 'k', title: 'kept idea', body: 'a' }), verdict: 'keep' });
    const rejected = scored({ idea: idea({ id: 'r', title: 'rejected idea', body: 'z' }), verdict: 'reject' });
    const r = await recombineProposals([kept, rejected], { llmCall: fakeProposer(COMPLETE_PROPOSAL) });
    const allSources = r.proposals.flatMap((p) => p.sourceIdeaIds);
    expect(allSources).toContain('k');
    expect(allSources).not.toContain('r');
  });

  it('every returned proposal carries a complete cheap experiment (D-006 invariant)', async () => {
    const r = await recombineProposals([scored({ idea: idea({ id: 'k' }) })], { llmCall: fakeProposer(COMPLETE_PROPOSAL) });
    expect(r.proposals.length).toBeGreaterThan(0);
    for (const p of r.proposals) {
      expect(validateProposal(p).ok).toBe(true);
      expect(p.cheapExperiment.hypothesis).not.toBe('');
      expect(p.cheapExperiment.method).not.toBe('');
      expect(p.cheapExperiment.falsifiableSignal).not.toBe('');
    }
  });

  it('DROPS a group whose LLM output fails the D-006 gate (no experiment) instead of smuggling it', async () => {
    const noExperiment = { framing: 'f', mechanism: 'm', whyNew: 'w', bet: 'b' }; // missing experiment
    const r = await recombineProposals([scored({ idea: idea({ id: 'k' }) })], { llmCall: fakeProposer(noExperiment) });
    expect(r.proposals).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].errors.join(' ')).toMatch(/cheapExperiment/);
  });

  it('merges two related survivors into one proposal citing both source ideas', async () => {
    const s1 = scored({
      idea: idea({
        id: 'a',
        title: 'lock contention retry',
        body: 'blocked edits retry',
        seededByRefs: ['elite:peer-a:module|sync|low:c1'],
      }),
      novelty: 0.9,
    });
    const s2 = scored({
      idea: idea({
        id: 'b',
        title: 'lock contention yield',
        body: 'blocked edits yield',
        seededByRefs: ['elite:peer-b:module|sync|low:c2'],
      }),
      novelty: 0.8,
    });
    const r = await recombineProposals([s1, s2], { llmCall: fakeProposer(COMPLETE_PROPOSAL) });
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0].sourceIdeaIds.sort()).toEqual(['a', 'b']);
    expect(r.proposals[0].routeHint).toBe('plan');
    expect(r.proposals[0].addressesPatternRefs).toBeDefined();
    expect(r.proposals[0].seededByRefs?.sort()).toEqual([
      'elite:peer-a:module|sync|low:c1',
      'elite:peer-b:module|sync|low:c2',
    ]);
  });

  it('aborts a wedged downstream recombine call at its phase-local cap', async () => {
    let seenSignal: AbortSignal | undefined;
    const r = await recombineProposals(
      [scored({ idea: idea({ id: 'wedged' }) })],
      {
        llmCall: async (opts) => {
          seenSignal = opts.signal;
          return await new Promise<never>(() => {});
        },
      },
      { timeoutMs: 10 },
    );
    expect(seenSignal?.aborted).toBe(true);
    expect(r.proposals).toHaveLength(0);
    expect(r.dropped[0]?.errors.join(' ')).toContain('recombine timed out after 10ms');
  });
});

/**
 * WI-39721 — rejected routeHint coercion must be LOUD and routing-neutral.
 * `goal` is accepted only when targetGoalId makes it an amendment. Untargeted
 * goal creation and every instance hint still coerce to undefined and take
 * DEFAULT_ROUTING_RAIL.
 */
describe('recombineProposals — dropped routeHint signal', () => {
  it('keeps goal creation held and records the rejected hint loudly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await recombineProposals([scored({ idea: idea({ id: 'g' }) })], {
        llmCall: fakeProposer({ ...COMPLETE_PROPOSAL, route: 'goal' }),
      });
      expect(r.proposals).toHaveLength(1);
      expect(r.proposals[0].routeHint).toBeUndefined();
      expect(r.droppedRouteHints).toEqual([{ value: 'goal', count: 1 }]);
      expect(r.proposals[0].droppedRouteHint).toBe('goal');
      expect(r.proposals[0].targetGoalId).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('goal×1');
      expect(String(warn.mock.calls[0]?.[0])).toContain('goal requires a non-empty targetGoalId');
    } finally {
      warn.mockRestore();
    }
  });

  it('admits goal WITH target as an amendment and preserves the recombine-to-router seam', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await recombineProposals([scored({ idea: idea({ id: 'amend' }) })], {
        llmCall: fakeProposer({
          ...COMPLETE_PROPOSAL,
          route: 'goal',
          targetGoalId: '  goal-existing  ',
        }),
      });
      expect(r.proposals).toHaveLength(1);
      expect(r.proposals[0]).toMatchObject({
        routeHint: 'goal',
        targetGoalId: 'goal-existing',
      });
      expect(r.proposals[0].droppedRouteHint).toBeUndefined();
      expect(r.droppedRouteHints).toEqual([]);
      expect(classifyProposal(r.proposals[0])).toMatchObject({
        rail: 'goal',
        followedHint: true,
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('counts the ask even when the group fails the D-006 gate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await recombineProposals([scored({ idea: idea({ id: 'x' }) })], {
        llmCall: fakeProposer({
          ...COMPLETE_PROPOSAL,
          route: 'instance',
          experiment: { hypothesis: 'h', method: '', falsifiableSignal: '' },
        }),
      });
      expect(r.proposals).toHaveLength(0);
      expect(r.dropped).toHaveLength(1);
      expect(r.droppedRouteHints).toEqual([{ value: 'instance', count: 1 }]);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent for an accepted hint, and for no hint at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const accepted = await recombineProposals([scored({ idea: idea({ id: 'a' }) })], {
        llmCall: fakeProposer(COMPLETE_PROPOSAL),
      });
      expect(accepted.proposals[0].routeHint).toBe('plan');
      expect(accepted.droppedRouteHints).toEqual([]);
      // WI-39879: an ACCEPTED hint is not a drop, so nothing rides on the proposal.
      expect(accepted.proposals[0].droppedRouteHint).toBeUndefined();

      const { route: _omitted, ...noHint } = COMPLETE_PROPOSAL;
      const absent = await recombineProposals([scored({ idea: idea({ id: 'b' }) })], {
        llmCall: fakeProposer(noHint),
      });
      expect(absent.proposals[0].routeHint).toBeUndefined();
      expect(absent.droppedRouteHints).toEqual([]);

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('proves the seam: untargeted direct goal creation stays held while plan escalation is live', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // This is the real producer path: the model asks recombine for `goal`,
      // parseProposal drops that unaccepted hint, and the router sees the
      // post-coercion Proposal that production would route today.
      const held = await recombineProposals([scored({ idea: idea({ id: 'direct-goal' }) })], {
        llmCall: fakeProposer({ ...COMPLETE_PROPOSAL, route: 'goal' }),
      });
      expect(held.proposals).toHaveLength(1);
      expect(held.proposals[0].routeHint).toBeUndefined();
      expect(held.proposals[0].droppedRouteHint).toBe('goal');
      expect(classifyProposal(held.proposals[0])).toMatchObject({
        rail: DEFAULT_ROUTING_RAIL,
        followedHint: false,
      });

      // The live door is a plan hint escalated by the router's real override
      // path; keep this alongside the held direct-hint assertion so the test
      // never overstates the direct path as the whole goal rail.
      const live = await recombineProposals([scored({ idea: idea({ id: 'plan-goal' }) })], {
        llmCall: fakeProposer({
          ...COMPLETE_PROPOSAL,
          framing: 'a weeks-long, multi-plan campaign with a measurable end-state',
          route: 'plan',
        }),
      });
      expect(live.proposals).toHaveLength(1);
      expect(live.proposals[0].routeHint).toBe('plan');
      expect(classifyProposal(live.proposals[0], { override: makeGoalScaleOverride() })).toMatchObject({
        rail: 'goal',
        followedHint: false,
      });
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * WI-39724 — the routeHint DRIFT GUARD.
 *
 * `Proposal['routeHint']` (types.ts) and the set `parseProposal` accepts once drifted
 * apart with NOTHING failing. What is pinned here is the target-aware invariant:
 *
 *   every union member is accepted, held, or conditionally held with a reason;
 *   every conditional hold must also be named in ACCEPTED_ROUTE_HINTS
 *
 * so a new hint without a decision fails, and either half of the goal amendment
 * admission cannot be changed without the other.
 *
 * FALSIFIABILITY (acceptance): proven by permanent in-file CONTROLS below — the audit
 * is a pure function over its three inputs, so a deliberately-broken input set is fed
 * to the REAL implementation with no mutation of the shared tree. That matters here
 * beyond hygiene: git-sync sweeps this checkout on a schedule, so an in-place
 * mutate/restore probe can be COMMITTED mid-probe even when nothing goes wrong.
 */
type CoverageViolation = { hint: string; problem: string };

function auditRouteHintCoverage(
  all: readonly string[],
  accepted: readonly string[],
  unaccepted: Record<string, RouteHintHold | undefined>,
): CoverageViolation[] {
  const violations: CoverageViolation[] = [];
  for (const hint of all) {
    const isAccepted = accepted.includes(hint);
    const isListed = Object.prototype.hasOwnProperty.call(unaccepted, hint);
    const hold = unaccepted[hint];
    if (hold && typeof hold !== 'string') {
      if (!hold.reason.trim()) {
        violations.push({ hint, problem: 'conditionally held with no written reason' });
      } else if (!isAccepted) {
        violations.push({ hint, problem: 'conditional admission is missing from accepted hints' });
      }
      continue;
    }
    if (isAccepted && isListed) {
      violations.push({ hint, problem: 'contradictory: both accepted and listed as deliberately unaccepted' });
      continue;
    }
    if (isAccepted) continue;
    if (!isListed) {
      violations.push({ hint, problem: 'undecided: neither accepted nor listed as deliberately unaccepted' });
      continue;
    }
    const reason = hold;
    if (typeof reason !== 'string' || reason.trim() === '') {
      violations.push({ hint, problem: 'listed as deliberately unaccepted with no written reason' });
    }
  }
  for (const hint of Object.keys(unaccepted)) {
    if (!all.includes(hint)) {
      violations.push({ hint, problem: 'stale: listed as deliberately unaccepted but no longer in the union' });
    }
  }
  return violations;
}

describe('routeHint drift guard (WI-39724)', () => {
  it('every union member is accepted, or deliberately unaccepted WITH a reason', () => {
    expect(
      auditRouteHintCoverage(
        ALL_ROUTE_HINTS,
        ACCEPTED_ROUTE_HINTS,
        DELIBERATELY_UNACCEPTED_ROUTE_HINTS,
      ),
    ).toEqual([]);
  });

  it('accepts targeted goal amendments while holding creation and all instance hints', () => {
    expect(ALL_ROUTE_HINTS).toContain('goal');
    expect(ACCEPTED_ROUTE_HINTS as readonly string[]).toContain('goal');
    const goalHold = DELIBERATELY_UNACCEPTED_ROUTE_HINTS.goal;
    expect(goalHold).toMatchObject({ exceptWhen: 'targetGoalId' });
    expect(typeof goalHold === 'object' ? goalHold.reason : '').toMatch(/D-006/);

    expect(ALL_ROUTE_HINTS).toContain('instance');
    expect(ACCEPTED_ROUTE_HINTS as readonly string[]).not.toContain('instance');
    expect(DELIBERATELY_UNACCEPTED_ROUTE_HINTS.instance).toEqual(expect.any(String));
  });

  // ---- CONTROLS: the guard must FAIL on each way the invariant can break. ----
  it('CONTROL — catches a union member nobody decided about', () => {
    const v = auditRouteHintCoverage(
      [...ALL_ROUTE_HINTS, 'archive'],
      ACCEPTED_ROUTE_HINTS,
      DELIBERATELY_UNACCEPTED_ROUTE_HINTS,
    );
    expect(v).toHaveLength(1);
    expect(v[0].hint).toBe('archive');
    expect(v[0].problem).toContain('undecided');
  });

  it('CONTROL — catches a deliberately-unaccepted hint with an empty reason', () => {
    const v = auditRouteHintCoverage(ALL_ROUTE_HINTS, ACCEPTED_ROUTE_HINTS, {
      ...DELIBERATELY_UNACCEPTED_ROUTE_HINTS,
      instance: '   ',
    });
    expect(v).toEqual([{ hint: 'instance', problem: expect.stringContaining('no written reason') }]);
  });

  it('CONTROL — catches a hint that is both accepted and held back', () => {
    const v = auditRouteHintCoverage(ALL_ROUTE_HINTS, [...ACCEPTED_ROUTE_HINTS, 'instance'], {
      ...DELIBERATELY_UNACCEPTED_ROUTE_HINTS,
    });
    expect(v).toEqual([{ hint: 'instance', problem: expect.stringContaining('contradictory') }]);
  });

  it('CONTROL — catches a conditional admission missing from accepted hints', () => {
    const v = auditRouteHintCoverage(
      ALL_ROUTE_HINTS,
      ACCEPTED_ROUTE_HINTS.filter((hint) => hint !== 'goal'),
      DELIBERATELY_UNACCEPTED_ROUTE_HINTS,
    );
    expect(v).toEqual([
      { hint: 'goal', problem: expect.stringContaining('conditional admission is missing') },
    ]);
  });

  it('CONTROL — catches a stale entry left behind after a hint leaves the union', () => {
    const v = auditRouteHintCoverage(ALL_ROUTE_HINTS, ACCEPTED_ROUTE_HINTS, {
      ...DELIBERATELY_UNACCEPTED_ROUTE_HINTS,
      retired: 'removed from the union a release ago',
    });
    expect(v).toEqual([{ hint: 'retired', problem: expect.stringContaining('stale') }]);
  });

  /**
   * The COMPILE-TIME half. `ALL_ROUTE_HINTS` must never become a hand-maintained copy
   * of the union — an incomplete copy is the exact failure mode this whole item exists
   * to prevent, and it reads as a PASSING guard (the runtime audit above would happily
   * report [] while never having heard of the new member).
   */
  it('the exhaustiveness alias in recombine.ts resolves to never (list covers the union)', () => {
    const exhaustive: RouteHintsAreExhaustive extends never ? true : false = true;
    expect(exhaustive).toBe(true);
    // ...and the runtime list agrees with the union it is generated against.
    expect([...ALL_ROUTE_HINTS].sort()).toEqual(
      ['plan', 'gym', 'improvement', 'instance', 'goal'].sort(),
    );
  });
});

/**
 * CONTROL for the compile-time half — an INCOMPLETE list must be rejected by the same
 * `AssertNever<Exclude<…>>` shape recombine.ts uses. `@ts-expect-error` inverts the
 * check: if this ever stopped being an error (someone neutering the pattern into
 * `type AssertNever<T> = T`), the directive becomes unused and `tsc` fails on it. It
 * is exported so it is never an unused local, and has no runtime representation.
 */
type AssertNever<T extends never> = T;
const INCOMPLETE_HINTS = ['plan'] as const;
/** 'gym' | 'improvement' | 'instance' | 'goal' — i.e. NOT never, which is the point. */
type MissingFromIncompleteList = Exclude<
  NonNullable<Proposal['routeHint']>,
  (typeof INCOMPLETE_HINTS)[number]
>;
// @ts-expect-error — the four missing members make Exclude non-never, so AssertNever must refuse to compile. (Keep this directive and the line it guards adjacent and single-line: a directive whose next line is a comment or an unfinished expression suppresses nothing and reports as unused.)
export type IncompleteRouteHintListIsRejected = AssertNever<MissingFromIncompleteList>;
