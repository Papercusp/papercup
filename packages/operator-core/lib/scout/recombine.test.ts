/**
 * Tests for P-006 debate + recombine (D-006). Self-contained (local fake + local
 * fixtures). The load-bearing invariant pinned here: every RETURNED Proposal
 * carries a complete cheap falsifiable experiment — a group whose LLM output
 * fails the D-006 gate is DROPPED, never smuggled through.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Idea, ScoredIdea, ScoutLlmCall } from './types';
import {
  planRecombinations,
  validateProposal,
  recombineProposals,
} from './recombine';

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
 * WI-39721 — the routeHint coercion must be LOUD, and ROUTING-NEUTRAL while it is.
 * `parseProposal` accepts 3 of the 5 members declared by `Proposal['routeHint']`;
 * 'goal'/'instance' coerce to undefined and take DEFAULT_ROUTING_RAIL. Admitting
 * them is owner-reserved (D-006), so what is pinned here is the SIGNAL — and, just
 * as load-bearing, that emitting it changed no routing.
 */
describe('recombineProposals — dropped routeHint signal', () => {
  it('records an unaccepted hint WITHOUT routing it (still coerces to undefined)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await recombineProposals([scored({ idea: idea({ id: 'g' }) })], {
        llmCall: fakeProposer({ ...COMPLETE_PROPOSAL, route: 'goal' }),
      });
      // Routing is UNCHANGED: the hint is still dropped, exactly as before.
      expect(r.proposals).toHaveLength(1);
      expect(r.proposals[0].routeHint).toBeUndefined();
      // ...but the ask is no longer invisible.
      expect(r.droppedRouteHints).toEqual([{ value: 'goal', count: 1 }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('goal×1');
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
});
