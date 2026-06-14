import { describe, expect, it } from 'vitest';
import {
  buildExperimentDispatchPort,
  forkTestableToExperiments,
  proposalToExperimentRequest,
  type ExperimentDispatchPort,
} from './experiment-rail';
import type { Proposal } from './types';
import type { RoutingDecision } from './router';

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  framing: 'lock contention stalls bees',
  mechanism: 'register events:await on grant + yield the turn',
  whyNew: 'no current path waits on a grant',
  bet: 'fewer stalled turns',
  cheapExperiment: { hypothesis: 'await beats poll', method: 'replay', falsifiableSignal: 'lower stall count' },
  sourceIdeaIds: [],
  addressesPatternRefs: [],
  ...over,
});

const decision = (proposalId: string, rail: RoutingDecision['rail']): RoutingDecision => ({
  proposalId,
  sourceIdeaIds: [],
  rail,
  routedRef: '',
  reason: '',
});

describe('proposalToExperimentRequest', () => {
  it('maps a proposal → a dry-run replay experiment: baseline + candidate overlay + a case', () => {
    const req = proposalToExperimentRequest(proposal());
    expect(req.testId).toBe('replay');
    expect(req.dryRun).toBe(true);
    expect(req.batteryId).toBe('scout:p1');
    expect(req.arms.map((a) => a.id)).toEqual(['baseline', 'candidate']);
    expect(req.arms[0]!.knobs).toEqual({}); // baseline
    expect(String(req.arms[1]!.knobs['overlay.systemOverlay'])).toContain('register events:await');
    expect(req.cases[0]!.intent).toBe('fewer stalled turns');
  });
});

describe('forkTestableToExperiments', () => {
  it('dispatches ONLY gym-rail proposals (additive — leaves routing untouched)', async () => {
    const seen: string[] = [];
    const dispatch: ExperimentDispatchPort = async (req) => {
      seen.push(req.batteryId);
      return { ok: true, plan: { testId: 'replay', tier: 'offline', arms: [], caseCount: 1, repeats: 1, totalCells: 1 } };
    };
    const decisions = [decision('p1', 'gym'), decision('p2', 'plan'), decision('p3', 'gym')];
    const proposals = [proposal({ id: 'p1' }), proposal({ id: 'p2' }), proposal({ id: 'p3' })];

    const res = await forkTestableToExperiments(decisions, proposals, dispatch);
    expect(res).toEqual({ dispatched: 2, failed: 0 });
    expect(seen).toEqual(['scout:p1', 'scout:p3']);
  });

  it('is defensive — a throwing dispatch counts as failed, never throws into the cycle', async () => {
    const dispatch: ExperimentDispatchPort = async () => {
      throw new Error('boom');
    };
    const res = await forkTestableToExperiments([decision('p1', 'gym')], [proposal({ id: 'p1' })], dispatch);
    expect(res).toEqual({ dispatched: 0, failed: 1 });
  });
});

describe('buildExperimentDispatchPort (default = dry-run only, no spend)', () => {
  it('dry-run-validates a request and never invokes the substrate', async () => {
    const out = await buildExperimentDispatchPort()(proposalToExperimentRequest(proposal()));
    expect(out.ok).toBe(true);
    expect(out.plan?.testId).toBe('replay');
    expect(out.result).toBeUndefined(); // dryRun → plan only, no run/result/spend
  });
});
