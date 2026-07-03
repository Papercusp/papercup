/**
 * P-103 standing puller — EXAMPLE-based unit tests.
 *
 * Drives the H17 untrusted-payload intake (parseOfferPayload), the pull-decision
 * pipeline (evaluatePull), the X12 steal gate (evaluateSteal), the H9 execution-
 * epoch revalidation, and the X11 dormancy contract. The happy paths use REAL
 * Ed25519 signatures (the pipeline composes verifyOfferAuthorship, which verifies
 * a genuine device signature). Generated invariants live in the property test.
 */
import { describe, it, expect } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import type { WorkOffer } from './offer-budget';
import { offerAuthorshipSigningBytes, buildOfferAuthorship, type AuthorshipVerifyInput } from './offer-authorship';
import type { HostAvailability } from './claim-authority';
import { bakedP2pDefaults, type P2pSettings } from './settings';
import {
  parseOfferPayload,
  evaluatePull,
  evaluateSteal,
  revalidateExecutionEpoch,
  pullerActivationInvariant,
  PULLER_ACTIVATION_LANDED,
  DEFAULT_OFFER_PAYLOAD_LIMITS,
  type OfferDesignation,
  type PullEvaluationInput,
  type StealContext,
} from './standing-puller';

/* ── fixtures ──────────────────────────────────────────────────────────── */

function makeOffer(over: Partial<WorkOffer> = {}): WorkOffer {
  return {
    offerId: 'offer-1',
    fleetSlug: '279242982/hiveloop',
    publisherRef: 'user:5',
    billedTo: 'host:h1',
    modelClass: 'frontier-remote',
    priority: 3,
    isolationReqs: ['clamp:coord-fleet-only', 'clamp:no-grants'],
    minRuntimeVersion: '1.2.0',
    budget: { remote: { cap: 1000, unit: 'usd-micros', maxPerCall: 100 }, local: null },
    publishedAt: 1000,
    ttlMs: 60_000,
    ...over,
  };
}

/** A genuinely-signed authorship input (device sig verifies over the offer+epoch). */
function signedAuthorship(over: { offer?: Partial<WorkOffer>; epoch?: number; attestedGithubUserId?: number | null } = {}): AuthorshipVerifyInput {
  const kp = generateEd25519KeypairDer();
  const offer = makeOffer(over.offer);
  const epoch = over.epoch ?? 4;
  const sig = signWithPrivateKeyDer(kp.privateKeyDer, offerAuthorshipSigningBytes(offer, epoch));
  return {
    offer,
    authorship: buildOfferAuthorship({ devicePubkey: kp.pubkeyBase64, epoch, signature: sig }),
    attestedGithubUserId: over.attestedGithubUserId === undefined ? 5 : over.attestedGithubUserId,
    publisherSet: { ownerGithubUserId: 279242982, ownerAnchored: true, ownerSignatureValid: true, memberGithubUserIds: [5, 7] },
    ownerHighWaterEpoch: 4,
    host: { runtimeVersion: '1.3.0', capabilities: ['clamp:coord-fleet-only', 'clamp:no-grants', 'extra'] },
  };
}

function optedInSettings(mut: (s: P2pSettings) => void = () => {}): P2pSettings {
  const s = bakedP2pDefaults();
  s.optIn.mode = 'any-fleet';
  mut(s);
  return s;
}

const HOST_OK: HostAvailability = { remote: { allotmentRemaining: 500, liveHeadroom: 500 }, local: null };
const STEAL_OK: StealContext = { t2StaleMs: 10_000, selfReliability: 0.9, minReliabilityToSteal: 0.5, publisherExcludedHosts: [], betterCandidateExists: false };

function pullInput(over: Partial<PullEvaluationInput> = {}): PullEvaluationInput {
  return {
    active: true,
    selfHostRef: 'host:self',
    settings: optedInSettings(),
    nowMs: 5_000,
    maxRolloutTier: 1,
    authorship: signedAuthorship(),
    hostAvailability: HOST_OK,
    designation: null,
    hostHighWaterEpoch: 0,
    hostHighWaterSeq: 0,
    steal: STEAL_OK,
    ...over,
  };
}

function goodDesignation(over: Partial<OfferDesignation> = {}): OfferDesignation {
  return { designatedHostRef: 'host:self', rosterEpoch: 4, designatedAtMs: 1_000, seq: 0, ...over };
}

function serialize(offer: WorkOffer, over: { authorship?: unknown; designation?: unknown } = {}): string {
  return JSON.stringify({
    offer,
    authorship: over.authorship ?? { devicePubkey: 'pk', signatureByDevice: 'sig', epoch: 4 },
    ...(over.designation !== undefined ? { designation: over.designation } : {}),
  });
}

/* ── H17 intake — parseOfferPayload ───────────────────────────────────── */

describe('parseOfferPayload (H17 intake)', () => {
  it('parses a valid { offer, authorship, designation } payload', () => {
    const offer = makeOffer();
    const r = parseOfferPayload(serialize(offer, { designation: goodDesignation() }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.offer.offerId).toBe('offer-1');
      expect(r.payload.authorship.epoch).toBe(4);
      expect(r.payload.designation?.designatedHostRef).toBe('host:self');
    }
  });

  it('treats an absent designation as an OPEN offer (designation null)', () => {
    const r = parseOfferPayload(serialize(makeOffer()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.designation).toBeNull();
  });

  it('ignores extra junk keys when required fields are valid', () => {
    const raw = JSON.stringify({ offer: { ...makeOffer(), junk: 'x' }, authorship: { devicePubkey: 'pk', signatureByDevice: 'sig', epoch: 4, extra: 1 }, unrelated: [1, 2, 3] });
    expect(parseOfferPayload(raw).ok).toBe(true);
  });

  it('rejects an OVERSIZED payload BEFORE parsing (size-cap), without throwing', () => {
    const huge = 'x'.repeat(DEFAULT_OFFER_PAYLOAD_LIMITS.maxBytes + 1);
    let r: ReturnType<typeof parseOfferPayload>;
    expect(() => { r = parseOfferPayload(huge); }).not.toThrow();
    expect(r!.ok).toBe(false);
    if (!r!.ok) expect(r!.code).toBe('payload_too_large');
  });

  it('rejects a payload at a tiny custom cap', () => {
    const r = parseOfferPayload(serialize(makeOffer()), { maxBytes: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('payload_too_large');
  });

  it('rejects non-JSON without throwing', () => {
    const r = parseOfferPayload('{not valid json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_json');
  });

  it('rejects a non-object JSON root (array)', () => {
    const r = parseOfferPayload('[1,2,3]');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_object');
  });

  it('rejects a missing offer', () => {
    const r = parseOfferPayload(JSON.stringify({ authorship: { devicePubkey: 'pk', signatureByDevice: 's', epoch: 1 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('malformed_offer');
  });

  it('rejects an offer with a non-array isolationReqs', () => {
    const bad = { ...makeOffer(), isolationReqs: 'not-array' };
    const r = parseOfferPayload(JSON.stringify({ offer: bad, authorship: { devicePubkey: 'pk', signatureByDevice: 's', epoch: 1 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('malformed_offer');
  });

  it('rejects an offer with a malformed budget axis (bad unit)', () => {
    const bad = { ...makeOffer(), budget: { remote: { cap: 10, unit: 'bogus', maxPerCall: null }, local: null } };
    const r = parseOfferPayload(JSON.stringify({ offer: bad, authorship: { devicePubkey: 'pk', signatureByDevice: 's', epoch: 1 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('malformed_offer');
  });

  it('rejects an offer with a negative cap', () => {
    const bad = { ...makeOffer(), budget: { remote: { cap: -1, unit: 'usd-micros', maxPerCall: null }, local: null } };
    const r = parseOfferPayload(JSON.stringify({ offer: bad, authorship: { devicePubkey: 'pk', signatureByDevice: 's', epoch: 1 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('malformed_offer');
  });

  it('rejects a missing authorship', () => {
    const r = parseOfferPayload(JSON.stringify({ offer: makeOffer() }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('malformed_authorship');
  });

  it('rejects authorship missing the epoch', () => {
    const r = parseOfferPayload(JSON.stringify({ offer: makeOffer(), authorship: { devicePubkey: 'pk', signatureByDevice: 's' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('malformed_authorship');
  });

  it('rejects a designation present but malformed (missing seq)', () => {
    const r = parseOfferPayload(serialize(makeOffer(), { designation: { designatedHostRef: 'h', rosterEpoch: 1, designatedAtMs: 1 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('malformed_designation');
  });
});

/* ── evaluatePull — X11 dormancy ──────────────────────────────────────── */

describe('evaluatePull — X11 activation gate', () => {
  it('is DORMANT when active is unset (defaults to PULLER_ACTIVATION_LANDED=false)', () => {
    const d = evaluatePull({ ...pullInput(), active: undefined });
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('puller_inactive');
  });

  it('is DORMANT when active:false even with an otherwise-claimable offer', () => {
    const d = evaluatePull(pullInput({ active: false }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('puller_inactive');
  });
});

/* ── evaluatePull — the pipeline ──────────────────────────────────────── */

describe('evaluatePull — claim / skip pipeline', () => {
  it('CLAIMS an open (undesignated), admitted, authored, capacity-ok offer', () => {
    const d = evaluatePull(pullInput());
    expect(d.outcome).toBe('claim');
    if (d.outcome !== 'skip') {
      expect(d.stole).toBe(false);
      expect(d.authorizedGithubUserId).toBe(5);
      expect(d.ownerGithubUserId).toBe(279242982);
      expect(d.epoch).toBe(4);
      expect(d.grants).toHaveLength(1);
      expect(d.grants[0].axis).toBe('remote');
      expect(d.grants[0].effectiveCap.cap).toBe(500); // min(offer 1000, avail 500)
    }
  });

  it('CLAIMS when designated to THIS host', () => {
    const d = evaluatePull(pullInput({ designation: goodDesignation({ designatedHostRef: 'host:self' }) }));
    expect(d.outcome).toBe('claim');
    if (d.outcome !== 'skip') expect(d.stole).toBe(false);
  });

  it('skips on kill-switch', () => {
    const d = evaluatePull(pullInput({ settings: optedInSettings((s) => { s.killSwitch.engaged = true; }) }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('kill-switch');
  });

  it('skips on opt-in off', () => {
    const d = evaluatePull(pullInput({ settings: optedInSettings((s) => { s.optIn.mode = 'off'; }) }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('opt-in-off');
  });

  it('skips outside a schedule window', () => {
    const d = evaluatePull(pullInput({ settings: optedInSettings((s) => { s.optIn.windows = [{ days: [], startMin: 0, endMin: 1440 }]; }) }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('outside-window');
  });

  it('skips a fleet outside the selected-fleets opt-in set', () => {
    const d = evaluatePull(pullInput({ settings: optedInSettings((s) => { s.optIn.mode = 'selected-fleets'; s.optIn.fleets = ['other/fleet']; }) }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('fleet_not_opted_in');
  });

  it('CLAIMS a fleet that IS in the selected-fleets set', () => {
    const d = evaluatePull(pullInput({ settings: optedInSettings((s) => { s.optIn.mode = 'selected-fleets'; s.optIn.fleets = ['279242982/hiveloop']; }) }));
    expect(d.outcome).toBe('claim');
  });

  it('skips an expired offer (H16)', () => {
    const d = evaluatePull(pullInput({ nowMs: 1_000 + 60_000 + 1 }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('offer_expired');
  });

  it('skips on a broken authorship chain (unattested device)', () => {
    const d = evaluatePull(pullInput({ authorship: signedAuthorship({ attestedGithubUserId: null }) }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('authorship:device_not_attested');
  });

  it('skips when the host has no claim authority (axis not served)', () => {
    const d = evaluatePull(pullInput({ hostAvailability: { remote: null, local: null } }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') {
      expect(d.reason).toBe('no_claim_authority');
      expect(d.claimRefusals?.[0].code).toBe('axis_not_served');
    }
  });

  it('skips a stale execution epoch (H9)', () => {
    const d = evaluatePull(pullInput({
      designation: goodDesignation({ designatedHostRef: 'host:other', seq: 1 }),
      hostHighWaterEpoch: 4, // == authorship epoch
      hostHighWaterSeq: 5, // designation seq 1 trails
    }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('execution_epoch_stale');
  });

  it('skips when not the designee and not yet stealable (within T2)', () => {
    const d = evaluatePull(pullInput({ designation: goodDesignation({ designatedHostRef: 'host:other', designatedAtMs: 4_500 }), nowMs: 5_000 }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('steal:not_yet_stealable');
  });

  it('STEALS from a stale designee when steal-eligible', () => {
    const d = evaluatePull(pullInput({
      designation: goodDesignation({ designatedHostRef: 'host:other', designatedAtMs: 0 }),
      nowMs: 20_000, // age 20s > T2 10s
    }));
    expect(d.outcome).toBe('steal');
    if (d.outcome !== 'skip') expect(d.stole).toBe(true);
  });

  it('does NOT steal when publisher-excluded', () => {
    const d = evaluatePull(pullInput({
      designation: goodDesignation({ designatedHostRef: 'host:other', designatedAtMs: 0 }),
      nowMs: 20_000,
      steal: { ...STEAL_OK, publisherExcludedHosts: ['host:self'] },
    }));
    expect(d.outcome).toBe('skip');
    if (d.outcome === 'skip') expect(d.reason).toBe('steal:publisher_excluded');
  });
});

/* ── evaluateSteal (X12) ──────────────────────────────────────────────── */

describe('evaluateSteal (X12)', () => {
  it('not yet stealable within T2', () => {
    const s = evaluateSteal(1_000, 5_000, STEAL_OK, 'host:self'); // age 4s <= T2 10s
    expect(s.eligible).toBe(false);
    if (!s.eligible) expect(s.code).toBe('not_yet_stealable');
  });

  it('publisher-excluded host cannot steal', () => {
    const s = evaluateSteal(0, 20_000, { ...STEAL_OK, publisherExcludedHosts: ['host:self'] }, 'host:self');
    expect(s.eligible).toBe(false);
    if (!s.eligible) expect(s.code).toBe('publisher_excluded');
  });

  it('reliability below floor cannot steal', () => {
    const s = evaluateSteal(0, 20_000, { ...STEAL_OK, selfReliability: 0.2, minReliabilityToSteal: 0.5 }, 'host:self');
    expect(s.eligible).toBe(false);
    if (!s.eligible) expect(s.code).toBe('reliability_too_low');
  });

  it('yields to a strictly-better candidate', () => {
    const s = evaluateSteal(0, 20_000, { ...STEAL_OK, betterCandidateExists: true }, 'host:self');
    expect(s.eligible).toBe(false);
    if (!s.eligible) expect(s.code).toBe('better_candidate');
  });

  it('eligible when past T2, reliable, not excluded, no better candidate', () => {
    expect(evaluateSteal(0, 20_000, STEAL_OK, 'host:self').eligible).toBe(true);
  });
});

/* ── revalidateExecutionEpoch (H9) ────────────────────────────────────── */

describe('revalidateExecutionEpoch (H9)', () => {
  it('rejects an executor epoch below the host high-water', () => {
    expect(revalidateExecutionEpoch({ executorEpoch: 2, executorSeq: 99, hostHighWaterEpoch: 3, hostHighWaterSeq: 0 }).ok).toBe(false);
  });
  it('rejects the same epoch with a trailing seq', () => {
    expect(revalidateExecutionEpoch({ executorEpoch: 3, executorSeq: 4, hostHighWaterEpoch: 3, hostHighWaterSeq: 5 }).ok).toBe(false);
  });
  it('admits the same epoch + seq (equal watermark)', () => {
    expect(revalidateExecutionEpoch({ executorEpoch: 3, executorSeq: 5, hostHighWaterEpoch: 3, hostHighWaterSeq: 5 }).ok).toBe(true);
  });
  it('admits an ahead epoch even with a lower seq', () => {
    expect(revalidateExecutionEpoch({ executorEpoch: 4, executorSeq: 0, hostHighWaterEpoch: 3, hostHighWaterSeq: 99 }).ok).toBe(true);
  });
});

/* ── X11 dormancy invariant ───────────────────────────────────────────── */

describe('pullerActivationInvariant', () => {
  it('the module ships DORMANT (PULLER_ACTIVATION_LANDED === false) with no violations', () => {
    expect(PULLER_ACTIVATION_LANDED).toBe(false);
    expect(pullerActivationInvariant()).toEqual([]);
  });
});
