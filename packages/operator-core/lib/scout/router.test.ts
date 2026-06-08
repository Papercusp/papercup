/**
 * router.test.ts — Scout loop routing (P-007 / D-007).
 *
 * Pins the contract the verification lane (su-b6c3f invariant #5) + the cycle
 * (cb4b9) + the ledger (su-80be9, P-013) build against:
 *   - PURE classification on routeHint (+ override) — checkable with zero ports;
 *   - injected-port dispatch — routing asserted WITHOUT real writes;
 *   - batched gym dispatch + defensive (one failed sink ≠ aborted batch);
 *   - routedRef forms (plan:<slug> / gym:<proposalId> / wi:<id>) that join in P-013;
 *   - per-source-idea provenance expansion (every recombined lens attributed, D-009).
 */
import { describe, expect, it } from 'vitest';
import type { Proposal } from './types';
import type { ScoutIdeaView, SeedDistantResult } from './gym-bridge';
import {
  classifyProposal,
  decideRoutes,
  decisionsToProvenance,
  deriveSlugStem,
  proposalTitle,
  proposalToGymView,
  routeProposals,
  type RouterPorts,
  type RoutingDecision,
} from './router';

/* ── fixtures ─────────────────────────────────────────────────────────── */

function fixtureProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    framing: 'Reduce lock contention by re-queuing blocked edits',
    mechanism: 'on lock-block, register a wake on grant + yield the turn (events:await)',
    whyNew: 'no prior plan treats a block as a wake-trigger',
    bet: 'fewer wasted retries, lower contention across the fleet',
    cheapExperiment: {
      hypothesis: 'wake-on-grant cuts retry spins',
      method: 'instrument one session; count spins before/after',
      falsifiableSignal: 'spin count unchanged after the switch',
    },
    sourceIdeaIds: ['idea-analogical-1'],
    addressesPatternRefs: ['plan:lock-contention-2026-06-01'],
    ...over,
  };
}

function fakeSeed(ideas: readonly ScoutIdeaView[]): SeedDistantResult {
  return {
    seeded: ideas.map((i, n) => ({ ideaId: i.id, nicheKey: `niche-${n}`, admitted: true, distance: 1 })),
    newNiches: ideas.map((_, n) => `niche-${n}`),
    skipped: [],
  };
}

function makeFakePorts(over: Partial<RouterPorts> = {}): {
  ports: RouterPorts;
  calls: { plansNew: unknown[]; gymDispatch: ScoutIdeaView[][]; capture: unknown[] };
} {
  const calls = { plansNew: [] as unknown[], gymDispatch: [] as ScoutIdeaView[][], capture: [] as unknown[] };
  const ports: RouterPorts = {
    plansNew:
      over.plansNew ??
      (async (req) => {
        calls.plansNew.push(req);
        return { slug: `${req.slugStem}-2026-06-08` };
      }),
    gymDispatch:
      over.gymDispatch ??
      (async (ideas) => {
        calls.gymDispatch.push([...ideas]);
        return fakeSeed(ideas);
      }),
    capture:
      over.capture ??
      (async (req) => {
        calls.capture.push(req);
        return { id: `EI-${calls.capture.length}`, created: true };
      }),
  };
  return { ports, calls };
}

/* ── classifyProposal (pure) ──────────────────────────────────────────── */

describe('classifyProposal', () => {
  it('follows an explicit routeHint for each rail', () => {
    for (const rail of ['plan', 'gym', 'improvement'] as const) {
      const c = classifyProposal(fixtureProposal({ routeHint: rail }));
      expect(c.rail).toBe(rail);
      expect(c.followedHint).toBe(true);
      expect(c.reason).toContain(rail);
    }
  });

  it('defaults to improvement (smallest-footprint) when there is no routeHint', () => {
    const c = classifyProposal(fixtureProposal({ routeHint: undefined }));
    expect(c.rail).toBe('improvement');
    expect(c.followedHint).toBe(false);
    expect(c.reason).toMatch(/no routeHint/i);
  });

  it('honours an explicit defaultRail when there is no routeHint', () => {
    const c = classifyProposal(fixtureProposal({ routeHint: undefined }), { defaultRail: 'plan' });
    expect(c.rail).toBe('plan');
    expect(c.followedHint).toBe(false);
  });

  it('lets the override hook overrule the recombine routeHint', () => {
    const p = fixtureProposal({ routeHint: 'improvement' });
    const c = classifyProposal(p, { override: () => 'plan' });
    expect(c.rail).toBe('plan');
    expect(c.followedHint).toBe(false); // overrode the hint
    expect(c.reason).toMatch(/override/i);
  });

  it('marks followedHint true when an override agrees with the hint', () => {
    const p = fixtureProposal({ routeHint: 'gym' });
    const c = classifyProposal(p, { override: () => 'gym' });
    expect(c.rail).toBe('gym');
    expect(c.followedHint).toBe(true);
  });

  it('defers to the hint when the override returns undefined', () => {
    const p = fixtureProposal({ routeHint: 'gym' });
    const c = classifyProposal(p, { override: () => undefined });
    expect(c.rail).toBe('gym');
    expect(c.followedHint).toBe(true);
  });
});

/* ── decideRoutes (pure batch) ────────────────────────────────────────── */

describe('decideRoutes', () => {
  it('preserves order and carries sourceIdeaIds / title / grounding refs', () => {
    const proposals = [
      fixtureProposal({ id: 'a', routeHint: 'plan', sourceIdeaIds: ['i1', 'i2'] }),
      fixtureProposal({ id: 'b', routeHint: 'gym', addressesPatternRefs: ['wi:F-102'] }),
    ];
    const decisions = decideRoutes(proposals);
    expect(decisions.map((d) => d.proposalId)).toEqual(['a', 'b']);
    expect(decisions[0].sourceIdeaIds).toEqual(['i1', 'i2']);
    expect(decisions[0].title).toBe(proposalTitle(proposals[0]));
    expect(decisions[1].addressesPatternRefs).toEqual(['wi:F-102']);
    // No routedRef before dispatch.
    expect(decisions.every((d) => d.routedRef === undefined)).toBe(true);
  });
});

/* ── adapters ─────────────────────────────────────────────────────────── */

describe('deriveSlugStem', () => {
  it('produces a scout- prefixed, plans:new-valid kebab slug', () => {
    const slug = deriveSlugStem('Reduce Lock Contention!! (re-queue)');
    expect(slug).toBe('scout-reduce-lock-contention-re-queue');
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(slug.length).toBeGreaterThanOrEqual(3);
  });

  it('falls back for an all-punctuation / empty framing', () => {
    expect(deriveSlugStem('!!! ???')).toBe('scout-idea');
    expect(deriveSlugStem('')).toBe('scout-idea');
  });

  it('caps the stem and never leaves a trailing hyphen', () => {
    const slug = deriveSlugStem('x'.repeat(200));
    expect(slug.startsWith('scout-')).toBe(true);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });
});

describe('proposalTitle / proposalToGymView', () => {
  it('takes the first non-empty framing line, capped at 200', () => {
    expect(proposalTitle(fixtureProposal({ framing: '\n\n  Hello world  \nsecond' }))).toBe('Hello world');
    expect(proposalTitle(fixtureProposal({ framing: 'y'.repeat(300) })).length).toBe(200);
  });

  it('maps a proposal to a gym view keyed by the PROPOSAL id', () => {
    const p = fixtureProposal({ id: 'prop-7' });
    const view = proposalToGymView(p);
    expect(view.id).toBe('prop-7'); // candidateId == proposalId → gym:<proposalId> joins
    expect(view.text).toContain(p.framing);
    expect(view.text).toContain(p.mechanism);
  });
});

/* ── routeProposals (injected ports) ──────────────────────────────────── */

describe('routeProposals', () => {
  it('dispatches each rail to its port and fills the routedRef form', async () => {
    const proposals = [
      fixtureProposal({ id: 'p-plan', routeHint: 'plan', framing: 'A big architectural rework' }),
      fixtureProposal({ id: 'p-gym', routeHint: 'gym' }),
      fixtureProposal({ id: 'p-imp', routeHint: 'improvement' }),
    ];
    const { ports, calls } = makeFakePorts();
    const res = await routeProposals(proposals, ports);

    const byId = Object.fromEntries(res.decisions.map((d) => [d.proposalId, d]));
    expect(byId['p-plan'].routedRef).toBe('plan:scout-a-big-architectural-rework-2026-06-08');
    expect(byId['p-gym'].routedRef).toBe('gym:p-gym');
    expect(byId['p-imp'].routedRef).toBe('wi:EI-1');

    expect(res.byRail).toEqual({ plan: 1, gym: 1, improvement: 1 });
    expect(res.failed).toEqual([]);
    // Exactly the injected ports were touched (no real writes).
    expect(calls.plansNew).toHaveLength(1);
    expect(calls.capture).toHaveLength(1);
  });

  it('batches all gym-routed proposals into a SINGLE gymDispatch call', async () => {
    const proposals = [
      fixtureProposal({ id: 'g1', routeHint: 'gym' }),
      fixtureProposal({ id: 'g2', routeHint: 'gym' }),
      fixtureProposal({ id: 'g3', routeHint: 'gym' }),
    ];
    const { ports, calls } = makeFakePorts();
    const res = await routeProposals(proposals, ports);

    expect(calls.gymDispatch).toHaveLength(1);
    expect(calls.gymDispatch[0].map((v) => v.id)).toEqual(['g1', 'g2', 'g3']);
    expect(res.gymSeed?.newNiches).toHaveLength(3);
    expect(res.decisions.every((d) => d.routedRef === `gym:${d.proposalId}`)).toBe(true);
  });

  it('is defensive: one throwing sink fails only its decision, not the batch', async () => {
    const proposals = [
      fixtureProposal({ id: 'ok-imp', routeHint: 'improvement' }),
      fixtureProposal({ id: 'bad-plan', routeHint: 'plan' }),
    ];
    const { ports } = makeFakePorts({
      plansNew: async () => {
        throw new Error('plans:new busy');
      },
    });
    const res = await routeProposals(proposals, ports);

    const bad = res.decisions.find((d) => d.proposalId === 'bad-plan')!;
    const ok = res.decisions.find((d) => d.proposalId === 'ok-imp')!;
    expect(bad.error).toMatch(/busy/);
    expect(bad.routedRef).toBeUndefined();
    expect(ok.routedRef).toBe('wi:EI-1'); // the good one still dispatched
    expect(res.failed).toEqual(['bad-plan']);
  });

  it('fails the whole gym batch (not other rails) when gymDispatch throws', async () => {
    const proposals = [
      fixtureProposal({ id: 'g1', routeHint: 'gym' }),
      fixtureProposal({ id: 'g2', routeHint: 'gym' }),
      fixtureProposal({ id: 'imp', routeHint: 'improvement' }),
    ];
    const { ports } = makeFakePorts({
      gymDispatch: async () => {
        throw new Error('archive down');
      },
    });
    const res = await routeProposals(proposals, ports);
    expect(res.failed.sort()).toEqual(['g1', 'g2']);
    expect(res.decisions.find((d) => d.proposalId === 'imp')!.routedRef).toBe('wi:EI-1');
    expect(res.gymSeed).toBeUndefined();
  });
});

/* ── decisionsToProvenance (→ P-013) ──────────────────────────────────── */
// The per-idea expansion primitive the CYCLE calls with its own lens resolver
// (cb4b9's cycle.ts imports this → ScoutCycleResult.provenance → su-80be9's
// recordRoutedIdea). Router stays lens-free; the cycle supplies lensOf.

describe('decisionsToProvenance', () => {
  const lensOf = (id: string) =>
    (({ ia: 'analogical', ib: 'reframing' }) as Record<string, 'analogical' | 'reframing'>)[id];

  it('expands one routed proposal into one provenance row per source idea (every lens attributed)', () => {
    const decisions: RoutingDecision[] = [
      {
        proposalId: 'p1',
        sourceIdeaIds: ['ia', 'ib'],
        rail: 'plan',
        reason: 'x',
        followedHint: true,
        title: 'T',
        routedRef: 'plan:foo-2026-06-08',
      },
    ];
    const prov = decisionsToProvenance(decisions, lensOf, { cycleId: 'cyc-1', routedAt: '2026-06-08T00:00:00.000Z' });
    expect(prov).toHaveLength(2);
    expect(prov.map((p) => p.lens).sort()).toEqual(['analogical', 'reframing']);
    expect(prov.every((p) => p.rail === 'plan' && p.routedRef === 'plan:foo-2026-06-08')).toBe(true);
    expect(prov.every((p) => p.cycleId === 'cyc-1' && p.title === 'T')).toBe(true);
    expect(prov.map((p) => p.ideaId).sort()).toEqual(['ia', 'ib']);
  });

  it('skips undispatched decisions and unresolvable lenses', () => {
    const decisions: RoutingDecision[] = [
      { proposalId: 'p1', sourceIdeaIds: ['ia'], rail: 'gym', reason: 'x', followedHint: true }, // no routedRef
      { proposalId: 'p2', sourceIdeaIds: ['ia', 'unknown'], rail: 'gym', reason: 'x', followedHint: true, routedRef: 'gym:p2' },
    ];
    const prov = decisionsToProvenance(decisions, lensOf);
    // p1 skipped (no routedRef); p2 keeps only 'ia' (lens resolved), 'unknown' dropped.
    expect(prov).toHaveLength(1);
    expect(prov[0]).toMatchObject({ ideaId: 'ia', lens: 'analogical', rail: 'gym', routedRef: 'gym:p2' });
  });

  it('round-trips routeProposals output into provenance', async () => {
    const proposals = [fixtureProposal({ id: 'rp', routeHint: 'improvement', sourceIdeaIds: ['ia'] })];
    const { ports } = makeFakePorts();
    const { decisions } = await routeProposals(proposals, ports);
    const prov = decisionsToProvenance(decisions, lensOf, { cycleId: 'c' });
    expect(prov).toEqual([
      { ideaId: 'ia', lens: 'analogical', rail: 'improvement', routedRef: 'wi:EI-1', cycleId: 'c', title: proposalTitle(proposals[0]) },
    ]);
  });
});
