/**
 * The eval-battery InstanceSubject rail (self-improvement-stack-reconciliation-2026-06-09
 * P-005 + P-006). The reconciliation's two eval rails are the eval-battery's two SUBJECTS:
 * `gym` = the HarnessSubject (component eval), `instance` = the InstanceSubject (whole-
 * instance eval — a genome delta over the interacting wholes). This pins:
 *   - the whole-system vs component classifier (`isWholeSystemProposal`);
 *   - the override that bumps a testable whole-system proposal gym→instance;
 *   - the batched instance dispatch + its `instance:<id>` routedRef + `byRail.instance`;
 *   - the P-006 meta-learning: an instance-routed idea's apiary verdict feeds its lens.
 */
import { describe, expect, it } from 'vitest';
import type { Proposal } from './types';
import type { InstanceVariantView, RouterPorts } from './router';
import {
  classifyProposal,
  isWholeSystemProposal,
  routeProposals,
  wholeSystemInstanceOverride,
} from './router';
import type { ChangeFeedEntry } from '../curation/change-feed';
import {
  classifyIdeaOutcome,
  computeLensOutcomes,
  type RoutedIdeaProvenance,
} from './outcome-feedback';

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    framing: 'Add a retry-budget knob to the worker role',
    mechanism: 'cap worker retries at N before escalating',
    whyNew: 'no prior plan bounds worker retries',
    bet: 'fewer thrash loops',
    cheapExperiment: { hypothesis: 'h', method: 'm', falsifiableSignal: 'f' },
    sourceIdeaIds: ['idea-1'],
    addressesPatternRefs: [],
    ...over,
  };
}

/** A whole-system proposal — varies the genome's interacting wholes. */
const wholeSystem = (over: Partial<Proposal> = {}) =>
  proposal({
    framing: 'Vary the Queen placement prompt + wake policy together',
    mechanism: 'a genome delta over the Queen prompt and the min-sleep floor',
    whyNew: 'the gym can only test a component; this is a whole-instance interaction',
    routeHint: 'gym',
    ...over,
  });

describe('isWholeSystemProposal', () => {
  it('is false for a component idea (varies one role)', () => {
    expect(isWholeSystemProposal(proposal())).toBe(false);
  });

  it('is true when the proposal varies a genome axis (the interacting wholes)', () => {
    expect(isWholeSystemProposal(wholeSystem())).toBe(true);
    expect(isWholeSystemProposal(proposal({ mechanism: 'change the memory architecture' }))).toBe(true);
    expect(isWholeSystemProposal(proposal({ whyNew: 'a system-level coordination economy shift' }))).toBe(true);
  });

  it('is true for an explicit routeHint=instance regardless of text', () => {
    expect(isWholeSystemProposal(proposal({ routeHint: 'instance' }))).toBe(true);
  });
});

describe('wholeSystemInstanceOverride', () => {
  it('bumps a TESTABLE (gym-hinted) whole-system proposal → instance', () => {
    expect(wholeSystemInstanceOverride(wholeSystem())).toBe('instance');
  });

  it('leaves a component gym proposal on gym (HarnessSubject)', () => {
    expect(wholeSystemInstanceOverride(proposal({ routeHint: 'gym' }))).toBeUndefined();
  });

  it('leaves plan / improvement / unhinted ideas alone (only testable splits)', () => {
    expect(wholeSystemInstanceOverride(wholeSystem({ routeHint: 'plan' }))).toBeUndefined();
    expect(wholeSystemInstanceOverride(wholeSystem({ routeHint: 'improvement' }))).toBeUndefined();
    expect(wholeSystemInstanceOverride(wholeSystem({ routeHint: undefined }))).toBeUndefined();
  });
});

describe('classifyProposal with the whole-system override', () => {
  it('routes a testable whole-system idea to instance (the missing rail)', () => {
    const c = classifyProposal(wholeSystem(), { override: wholeSystemInstanceOverride });
    expect(c.rail).toBe('instance');
    expect(c.reason).toMatch(/override/i);
  });

  it('keeps a component idea on gym (HarnessSubject)', () => {
    const c = classifyProposal(proposal({ routeHint: 'gym' }), { override: wholeSystemInstanceOverride });
    expect(c.rail).toBe('gym');
  });

  it('follows an explicit routeHint=instance directly', () => {
    const c = classifyProposal(proposal({ routeHint: 'instance' }));
    expect(c.rail).toBe('instance');
    expect(c.followedHint).toBe(true);
  });
});

function makeFakePorts(over: Partial<RouterPorts> = {}): {
  ports: RouterPorts;
  calls: { instanceDispatch: InstanceVariantView[][] };
} {
  const calls = { instanceDispatch: [] as InstanceVariantView[][] };
  const ports: RouterPorts = {
    plansNew: async (req) => ({ slug: `${req.slugStem}-2026-06-09` }),
    gymDispatch: async () => ({ seeded: [], newNiches: [], skipped: [] }),
    capture: async () => ({ id: 'EI-1', created: true }),
    instanceDispatch:
      over.instanceDispatch ??
      (async (views) => {
        calls.instanceDispatch.push([...views]);
        return { registered: views.map((v) => v.id) };
      }),
    ...over,
  };
  return { ports, calls };
}

describe('routeProposals — instance rail', () => {
  it('dispatches whole-system proposals to the InstanceSubject + sets instance:<id> + counts byRail', async () => {
    const { ports, calls } = makeFakePorts();
    const proposals = [
      proposal({ id: 'i1', routeHint: 'instance' }),
      proposal({ id: 'i2', routeHint: 'instance' }),
      proposal({ id: 'g1', routeHint: 'gym' }),
    ];
    const res = await routeProposals(proposals, ports);

    expect(calls.instanceDispatch).toHaveLength(1); // batched
    expect(calls.instanceDispatch[0].map((v) => v.id)).toEqual(['i1', 'i2']);
    expect(res.byRail).toEqual({ plan: 0, gym: 1, improvement: 0, instance: 2 });
    expect(res.instanceSeed?.registered).toEqual(['i1', 'i2']);
    const i1 = res.decisions.find((d) => d.proposalId === 'i1')!;
    expect(i1.routedRef).toBe('instance:i1');
    expect(res.failed).toEqual([]);
  });

  it('records an error (never aborts) when no InstanceSubject is wired', async () => {
    const { ports } = makeFakePorts();
    delete (ports as { instanceDispatch?: unknown }).instanceDispatch;
    const res = await routeProposals([proposal({ id: 'i1', routeHint: 'instance' })], ports);
    expect(res.failed).toEqual(['i1']);
    expect(res.decisions[0].error).toMatch(/InstanceSubject/i);
    expect(res.decisions[0].routedRef).toBeUndefined();
  });

  it('routes whole-system gym proposals to instance via the override', async () => {
    const { ports, calls } = makeFakePorts();
    const res = await routeProposals([wholeSystem({ id: 'ws1' }), proposal({ id: 'comp', routeHint: 'gym' })], ports, {
      override: wholeSystemInstanceOverride,
    });
    expect(res.byRail.instance).toBe(1);
    expect(res.byRail.gym).toBe(1);
    expect(calls.instanceDispatch[0].map((v) => v.id)).toEqual(['ws1']);
  });
});

/* ── P-006: instance eval verdicts feed lens meta-learning ──────────────── */

function entry(p: Partial<ChangeFeedEntry> & { ref: string; kind: ChangeFeedEntry['kind'] }): ChangeFeedEntry {
  return { id: p.id ?? p.ref, title: p.title ?? p.ref, ts: p.ts ?? '2026-06-09T00:00:00Z', ...p } as ChangeFeedEntry;
}
const prov = (over: Partial<RoutedIdeaProvenance> & { routedRef: string; rail: RoutedIdeaProvenance['rail'] }): RoutedIdeaProvenance => ({
  ideaId: 'idea-1',
  lens: 'analogical',
  ...over,
});

describe('classifyIdeaOutcome — instance rail (P-006)', () => {
  const feed = new Map<string, ChangeFeedEntry>([
    ['instance:promoted', entry({ ref: 'instance:promoted', kind: 'proposal', detail: 'Status: promoted' })],
    ['instance:rejected', entry({ ref: 'instance:rejected', kind: 'proposal', detail: 'Status: rejected' })],
  ]);

  it('a PROMOTED genome variant → won', () => {
    expect(classifyIdeaOutcome(prov({ routedRef: 'instance:promoted', rail: 'instance' }), feed)).toBe('won');
  });

  it('a non-promoted (rejected) variant → lost', () => {
    expect(classifyIdeaOutcome(prov({ routedRef: 'instance:rejected', rail: 'instance' }), feed)).toBe('lost');
  });

  it('not yet evaluated → pending', () => {
    expect(classifyIdeaOutcome(prov({ routedRef: 'instance:missing', rail: 'instance' }), feed)).toBe('pending');
  });
});

describe('computeLensOutcomes — instance outcomes weight the lens', () => {
  it('an instance-promoted idea counts as a win for its lens', () => {
    const completions: ChangeFeedEntry[] = [entry({ ref: 'instance:w1', kind: 'proposal', detail: 'Status: promoted' })];
    const provenance: RoutedIdeaProvenance[] = [{ ideaId: 'i1', lens: 'first-principles', rail: 'instance', routedRef: 'instance:w1' }];
    const r = computeLensOutcomes(provenance, completions);
    expect(r.byLens['first-principles'].won).toBe(1);
    expect(r.byLens['first-principles'].winRate).toBe(1);
  });
});
