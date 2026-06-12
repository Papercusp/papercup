/**
 * outcomes.test.ts — the realized-deferral-cost backfill core (P-042 / FB-14).
 * Pure fixtures: who counts as a deferral, where the window opens/closes, and
 * which downstream accruals land in it.
 */
import { describe, expect, it } from 'vitest';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { BLOCKING_IMPACT_WEIGHTS } from '../harness/improvements/blocking-impact';
import { computeDeferralOutcomes, deferralFeaturesOf, featureBuckets, type TimedEdge } from './outcomes';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-05-01T00:00:00Z');
const NOW = T0 + 28 * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();

let n = 0;
function cand(over: Partial<ImprovementCandidate> = {}): ImprovementCandidate {
  n += 1;
  return {
    id: over.id ?? `EI-${n}`,
    kind: 'change', // human tier under the default policy (autoKinds=['bug'])
    scope: 'operator',
    title: over.title ?? `wholly distinct topic number${n} frobnicate widget${n}`,
    createdAt: iso(T0),
    state: 'open',
    ...over,
  };
}

const outEdge = (issueId: string, atMs: number, rel = 'blocks'): TimedEdge => ({ issueId, direction: 'out', rel, atMs });
const inEdge = (issueId: string, atMs: number, rel = 'relates'): TimedEdge => ({ issueId, direction: 'in', rel, atMs });

describe('the deferral set (who trains the model)', () => {
  it('human-tier kinds are deferrals; auto-tier bugs are not', () => {
    const change = cand({ kind: 'change' });
    const bug = cand({ kind: 'bug' });
    const out = computeDeferralOutcomes([change, bug], [], { nowMs: NOW });
    expect(out.map((o) => o.id)).toEqual([change.id]);
  });

  it('an explicitly human-routed bug (needsHuman) IS a deferral', () => {
    const bug = cand({ kind: 'bug', needsHuman: true });
    const out = computeDeferralOutcomes([bug], [], { nowMs: NOW });
    expect(out.map((o) => o.id)).toEqual([bug.id]);
  });

  it('a sub-hour window is triage, not a deferral (min-window floor)', () => {
    const quick = cand({ state: 'resolved', updatedAt: iso(T0 + 30 * 60 * 1000) });
    expect(computeDeferralOutcomes([quick], [], { nowMs: NOW })).toEqual([]);
  });

  it('a candidate without createdAt cannot be windowed and is skipped', () => {
    const c = cand();
    delete (c as { createdAt?: string }).createdAt;
    expect(computeDeferralOutcomes([c], [], { nowMs: NOW })).toEqual([]);
  });
});

describe('the deferral window', () => {
  it('open item: capture → now', () => {
    const c = cand();
    const [o] = computeDeferralOutcomes([c], [], { nowMs: NOW });
    expect(o.decidedAtMs).toBeNull();
    expect(o.daysDeferred).toBe(28);
  });

  it('decided item: capture → updatedAt (the last-touch decision approximation)', () => {
    const c = cand({ state: 'resolved', updatedAt: iso(T0 + 7 * DAY) });
    const [o] = computeDeferralOutcomes([c], [], { nowMs: NOW });
    expect(o.decidedAtMs).toBe(T0 + 7 * DAY);
    expect(o.daysDeferred).toBe(7);
  });
});

describe('in-window realized accruals', () => {
  it('counts outbound blocks + inbound refs inside the window, B-08-weighted', () => {
    const c = cand({ state: 'resolved', updatedAt: iso(T0 + 14 * DAY) });
    const edges = [
      outEdge(c.id, T0 + 1 * DAY), // in window
      outEdge(c.id, T0 + 20 * DAY), // AFTER decision — not realized while deferred
      inEdge(c.id, T0 + 2 * DAY), // in window
      inEdge(c.id, T0 - 1 * DAY), // before capture
    ];
    const [o] = computeDeferralOutcomes([c], edges, { nowMs: NOW });
    expect(o.blocksOut).toBe(1);
    expect(o.inboundRefs).toBe(1);
    expect(o.realizedCost).toBe(BLOCKING_IMPACT_WEIGHTS.blocksOut + BLOCKING_IMPACT_WEIGHTS.inboundRef);
  });

  it('inbound tagged/blocks edges are not references; outbound non-blocks ignored', () => {
    const c = cand();
    const edges = [
      inEdge(c.id, T0 + DAY, 'tagged'),
      inEdge(c.id, T0 + DAY, 'blocks'), // upstream dependency, not downstream impact
      outEdge(c.id, T0 + DAY, 'relates'),
    ];
    const [o] = computeDeferralOutcomes([c], edges, { nowMs: NOW });
    expect(o.realizedCost).toBe(0);
  });

  it('a same-signature re-capture filed while deferred counts; one filed after decision does not', () => {
    const title = 'flaky lock contention wedges the deploy train';
    const mine = cand({ title, state: 'resolved', updatedAt: iso(T0 + 10 * DAY) });
    const during = cand({ title, createdAt: iso(T0 + 5 * DAY) });
    const after = cand({ title, createdAt: iso(T0 + 20 * DAY) });
    const out = computeDeferralOutcomes([mine, during, after], [], { nowMs: NOW });
    const o = out.find((x) => x.id === mine.id)!;
    expect(o.recaptures).toBe(1);
    expect(o.realizedCost).toBe(BLOCKING_IMPACT_WEIGHTS.openRecurrence);
  });

  it('near-duplicate peers beyond the exact-signature group count separately', () => {
    const mine = cand({ title: 'sync invalidation misses the learning demand panel rows' });
    const nearDup = cand({
      title: 'sync invalidation misses the learning demand panel rows entirely',
      createdAt: iso(T0 + 3 * DAY),
    });
    const out = computeDeferralOutcomes([mine, nearDup], [], { nowMs: NOW });
    const o = out.find((x) => x.id === mine.id)!;
    expect(o.dupPeers).toBe(1);
    expect(o.recaptures).toBe(0);
    expect(o.realizedCost).toBe(BLOCKING_IMPACT_WEIGHTS.dupPeer);
  });
});

describe('creation-time features', () => {
  it('projects the named buckets the model learns over', () => {
    const c = cand({
      severity: 'critical',
      kind: 'change',
      watchdogKey: 'tool-error:locks:acquire',
      sourceRole: 'Scout',
      scope: 'harness:demo',
    });
    expect(featureBuckets(deferralFeaturesOf(c))).toEqual([
      'severity:critical',
      'kind:change',
      'watchdog:yes',
      'source:Scout',
      'scope:harness',
    ]);
  });

  it('defaults: minor severity, human source, operator scope, no watchdog', () => {
    const c = cand();
    delete (c as { severity?: string }).severity;
    expect(featureBuckets(deferralFeaturesOf(c))).toEqual([
      'severity:minor',
      'kind:change',
      'watchdog:no',
      'source:human',
      'scope:operator',
    ]);
  });
});
