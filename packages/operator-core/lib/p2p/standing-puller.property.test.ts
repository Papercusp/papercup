/**
 * P-103 standing puller — PROPERTY invariants.
 *
 * The load-bearing ones: (H17) parseOfferPayload NEVER throws on ANY string and
 * ALWAYS honours the size-cap; a valid serialized offer round-trips; (X11) an
 * inactive puller ALWAYS skips; (X12) a steal is granted only when every gate
 * holds.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import type { WorkOffer } from './offer-budget';
import { offerAuthorshipSigningBytes, buildOfferAuthorship, type AuthorshipVerifyInput } from './offer-authorship';
import { bakedP2pDefaults } from './settings';
import {
  parseOfferPayload,
  evaluatePull,
  evaluateSteal,
  DEFAULT_OFFER_PAYLOAD_LIMITS,
  type StealContext,
} from './standing-puller';

const axisCapArb = fc.record({
  cap: fc.integer({ min: 0, max: 1_000_000 }),
  unit: fc.constantFrom('usd-micros', 'tokens', 'slot-seconds', 'slots'),
  maxPerCall: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 1_000_000 })),
});

const offerArb: fc.Arbitrary<WorkOffer> = fc.record({
  offerId: fc.string({ minLength: 1 }),
  fleetSlug: fc.string({ minLength: 1 }),
  publisherRef: fc.string(),
  billedTo: fc.string(),
  modelClass: fc.string(),
  priority: fc.integer({ min: -1000, max: 1000 }),
  isolationReqs: fc.array(fc.string()),
  budget: fc.record({ remote: fc.oneof(fc.constant(null), axisCapArb), local: fc.oneof(fc.constant(null), axisCapArb) }),
  publishedAt: fc.nat(),
  ttlMs: fc.nat(),
}) as fc.Arbitrary<WorkOffer>;

const authorshipArb = fc.record({
  devicePubkey: fc.string({ minLength: 1 }),
  signatureByDevice: fc.string({ minLength: 1 }),
  epoch: fc.nat(),
});

const designationArb = fc.oneof(
  fc.constant(undefined),
  fc.record({ designatedHostRef: fc.string({ minLength: 1 }), rosterEpoch: fc.nat(), designatedAtMs: fc.nat(), seq: fc.nat() }),
);

describe('parseOfferPayload — H17 safety properties', () => {
  it('NEVER throws on any string input (hostile payloads cannot crash the loop)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json(), fc.string({ maxLength: 5000 })), (s) => {
        const r = parseOfferPayload(s);
        expect(typeof r.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });

  it('ALWAYS rejects a payload longer than the cap (size-cap, pre-parse)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (s) => {
        const r = parseOfferPayload(s, { maxBytes: s.length - 1 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('payload_too_large');
      }),
    );
  });

  it('round-trips any validly-serialized { offer, authorship, designation? }', () => {
    fc.assert(
      fc.property(offerArb, authorshipArb, designationArb, (offer, authorship, designation) => {
        const raw = JSON.stringify({ offer, authorship, ...(designation !== undefined ? { designation } : {}) });
        fc.pre(raw.length <= DEFAULT_OFFER_PAYLOAD_LIMITS.maxBytes);
        const r = parseOfferPayload(raw);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.payload.offer).toEqual(offer);
          expect(r.payload.authorship).toEqual(authorship);
          expect(r.payload.designation).toEqual(designation ?? null);
        }
      }),
    );
  });
});

/* A single real signed authorship reused across the dormancy fuzz (keygen is
 * expensive; active:false short-circuits before the signature is verified). */
function fixedAuthorship(): AuthorshipVerifyInput {
  const kp = generateEd25519KeypairDer();
  const offer: WorkOffer = {
    offerId: 'o', fleetSlug: 'f', publisherRef: 'p', billedTo: 'b', modelClass: 'm', priority: 0,
    isolationReqs: [], budget: { remote: null, local: null }, publishedAt: 0, ttlMs: 100_000,
  };
  const sig = signWithPrivateKeyDer(kp.privateKeyDer, offerAuthorshipSigningBytes(offer, 1));
  return {
    offer,
    authorship: buildOfferAuthorship({ devicePubkey: kp.pubkeyBase64, epoch: 1, signature: sig }),
    attestedGithubUserId: 5,
    publisherSet: { ownerGithubUserId: 1, ownerAnchored: true, ownerSignatureValid: true, memberGithubUserIds: [5] },
    ownerHighWaterEpoch: 1,
    host: { runtimeVersion: '9.9.9', capabilities: [] },
  };
}

describe('evaluatePull — X11 dormancy property', () => {
  const auth = fixedAuthorship();
  it('an INACTIVE puller ALWAYS skips puller_inactive, whatever the other inputs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('off', 'selected-fleets', 'any-fleet'),
        fc.nat(),
        designationArb,
        (mode, nowMs, designation) => {
          const settings = bakedP2pDefaults();
          settings.optIn.mode = mode;
          const d = evaluatePull({
            active: false,
            selfHostRef: 'host:self',
            settings,
            nowMs,
            maxRolloutTier: 1,
            authorship: auth,
            hostAvailability: { remote: null, local: null },
            designation: designation ?? null,
            hostHighWaterEpoch: 0,
            hostHighWaterSeq: 0,
            steal: { t2StaleMs: 0, selfReliability: 1, minReliabilityToSteal: 0, publisherExcludedHosts: [], betterCandidateExists: false },
          });
          expect(d.outcome).toBe('skip');
          if (d.outcome === 'skip') expect(d.reason).toBe('puller_inactive');
        },
      ),
    );
  });
});

describe('evaluateSteal — X12 monotonicity', () => {
  it('eligible ⇒ every gate held (past T2, not excluded, reliable, no better candidate)', () => {
    const ctxArb: fc.Arbitrary<StealContext> = fc.record({
      t2StaleMs: fc.nat({ max: 100_000 }),
      selfReliability: fc.float({ min: 0, max: 1, noNaN: true }),
      minReliabilityToSteal: fc.float({ min: 0, max: 1, noNaN: true }),
      publisherExcludedHosts: fc.array(fc.string()),
      betterCandidateExists: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.nat(), fc.nat(), ctxArb, fc.string({ minLength: 1 }), (designatedAtMs, nowMs, ctx, self) => {
        const s = evaluateSteal(designatedAtMs, nowMs, ctx, self);
        if (s.eligible) {
          expect(nowMs - designatedAtMs).toBeGreaterThan(ctx.t2StaleMs);
          expect(ctx.publisherExcludedHosts).not.toContain(self);
          expect(ctx.selfReliability).toBeGreaterThanOrEqual(ctx.minReliabilityToSteal);
          expect(ctx.betterCandidateExists).toBe(false);
        }
      }),
    );
  });
});
