import { describe, it, expect } from 'vitest';
import {
  type HostAvailability,
  buildClaimLedgers,
  claimRefusalToReceiptFields,
  evaluateClaimAuthority,
} from './claim-authority';
import { type BudgetEnvelope, type WorkOffer, reserve, remaining } from './offer-budget';

const offer = (budget: BudgetEnvelope): WorkOffer => ({
  offerId: 'ofr-1',
  fleetSlug: 'ml-fleet',
  publisherRef: 'device:abc',
  billedTo: 'host:me',
  modelClass: 'any',
  priority: 5,
  isolationReqs: [],
  budget,
  publishedAt: 0,
  ttlMs: 60_000,
});

const remoteCap = (cap: number, maxPerCall: number | null = null) => ({ cap, unit: 'usd-micros' as const, maxPerCall });
const localCap = (cap: number) => ({ cap, unit: 'slots' as const, maxPerCall: null });

describe('evaluateClaimAuthority (D-007 two-layer gate)', () => {
  it('claimable when both layers admit both axes; effective cap = min(offer, allotment, headroom)', () => {
    const o = offer({ remote: remoteCap(5_000_000), local: localCap(8) });
    const host: HostAvailability = {
      remote: { allotmentRemaining: 1_000_000, liveHeadroom: 2_000_000 }, // policy binds → 1M
      local: { allotmentRemaining: 4, liveHeadroom: 2 }, // physics binds → 2
    };
    const res = evaluateClaimAuthority(o, host);
    expect(res.claimable).toBe(true);
    if (!res.claimable) return;
    const remoteG = res.grants.find((g) => g.axis === 'remote')!;
    const localG = res.grants.find((g) => g.axis === 'local')!;
    expect(remoteG.effectiveCap.cap).toBe(1_000_000); // min(5M offer, 1M allot, 2M headroom)
    expect(localG.effectiveCap.cap).toBe(2); // min(8 offer, 4 allot, 2 headroom)
  });

  it('refuses on POLICY exhaustion (allotment remaining 0)', () => {
    const o = offer({ remote: remoteCap(1000), local: null });
    const res = evaluateClaimAuthority(o, { remote: { allotmentRemaining: 0, liveHeadroom: 999 }, local: null });
    expect(res.claimable).toBe(false);
    if (res.claimable) return;
    expect(res.refusals[0]!.code).toBe('no_allotment_remaining');
    expect(res.refusals[0]!.axis).toBe('remote');
  });

  it('refuses on PHYSICS exhaustion (live headroom 0, allotment healthy)', () => {
    const o = offer({ remote: remoteCap(1000), local: null });
    const res = evaluateClaimAuthority(o, { remote: { allotmentRemaining: 999, liveHeadroom: 0 }, local: null });
    expect(res.claimable).toBe(false);
    if (res.claimable) return;
    expect(res.refusals[0]!.code).toBe('no_live_headroom');
  });

  it('refuses an axis the host does not serve (M11 default-zero)', () => {
    const o = offer({ remote: null, local: localCap(2) });
    const res = evaluateClaimAuthority(o, { remote: { allotmentRemaining: 9, liveHeadroom: 9 }, local: null });
    expect(res.claimable).toBe(false);
    if (res.claimable) return;
    expect(res.refusals[0]!.code).toBe('axis_not_served');
    expect(res.refusals[0]!.axis).toBe('local');
  });

  it('an offer drawing only the remote axis ignores an absent local axis', () => {
    const o = offer({ remote: remoteCap(1000), local: null });
    const res = evaluateClaimAuthority(o, { remote: { allotmentRemaining: 500, liveHeadroom: 900 }, local: null });
    expect(res.claimable).toBe(true);
    if (!res.claimable) return;
    expect(res.grants).toHaveLength(1);
    expect(res.grants[0]!.axis).toBe('remote');
    expect(res.grants[0]!.available).toBe(500);
  });

  it('a zero-axis (unmetered) offer is claimable with no grants', () => {
    const res = evaluateClaimAuthority(offer({ remote: null, local: null }), { remote: null, local: null });
    expect(res.claimable).toBe(true);
    if (res.claimable) expect(res.grants).toHaveLength(0);
  });

  it('respects a per-axis minViable floor', () => {
    const o = offer({ remote: remoteCap(1000), local: null });
    const res = evaluateClaimAuthority(o, { remote: { allotmentRemaining: 50, liveHeadroom: 50 }, local: null }, { minViable: { remote: 100 } });
    expect(res.claimable).toBe(false); // 50 < 100 floor
  });
});

describe('buildClaimLedgers → P-107 (H11 composition)', () => {
  it('seeds a ledger bounded by the tightest of {offer, allotment, headroom}', () => {
    const o = offer({ remote: remoteCap(5_000_000, 100_000), local: null });
    const res = evaluateClaimAuthority(o, { remote: { allotmentRemaining: 300_000, liveHeadroom: 900_000 }, local: null });
    expect(res.claimable).toBe(true);
    if (!res.claimable) return;
    const ledgers = buildClaimLedgers(res.grants);
    const remote = ledgers.remote!;
    expect(remaining(remote)).toBe(300_000); // min(5M, 300k, 900k)
    expect(remote.maxPerCall).toBe(100_000); // the offer's H11 clamp survives
    // a call over max-per-call is refused; a call over remaining is refused
    expect(reserve(remote, 200_000, 'a').ok).toBe(false); // > maxPerCall
    const okReserve = reserve(remote, 100_000, 'a');
    expect(okReserve.ok).toBe(true);
  });
});

describe('claimRefusalToReceiptFields (P-004 bridge)', () => {
  it('produces work-offer:claim receipt fields carrying the axis + structured code', () => {
    const o = offer({ remote: remoteCap(1000), local: null });
    const res = evaluateClaimAuthority(o, { remote: { allotmentRemaining: 0, liveHeadroom: 5 }, local: null });
    expect(res.claimable).toBe(false);
    if (res.claimable) return;
    const fields = claimRefusalToReceiptFields(res.refusals[0]!);
    expect(fields.action).toBe('work-offer:claim');
    expect(fields.budgetAxis).toBe('remote');
    expect(fields.refusal.code).toBe('no_allotment_remaining');
  });
});
