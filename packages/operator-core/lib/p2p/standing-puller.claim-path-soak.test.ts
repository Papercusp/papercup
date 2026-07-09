/**
 * p2p/standing-puller.claim-path-soak.test.ts — the SOFTWARE half of the
 * "P-003 claim-path soak" that X11 (PULLER_ACTIVATION_LANDED) references
 * (p2p-rest-lanes-2026-07-09 P-007 / WI-1936 / WI-3544).
 *
 * IMPORTANT SCOPE NOTE (do not misread a green run here as "flip the flag"):
 * this soak proves the PULL-DECISION PIPELINE's gate order/precedence is
 * correct under heavy randomization, running fully in-process with no PG/IO.
 * It does NOT satisfy the OTHER, separate half of the X11 gate — the LIVE
 * second-device attestation witness (p2p-work-distribution-2026-07-02 P-003,
 * WI-1585; mirrored here as p2p-rest-lanes P-009 / WI-3546) — which requires
 * a real 2-machine rig and has NOT landed as of 2026-07-09 (WI-1585 is still
 * `todo`). PULLER_ACTIVATION_LANDED must stay `false` until BOTH halves land.
 *
 * METHOD: for each of MANY randomized scenarios, independently walk the
 * documented gate order (evaluatePull's own doc-comment, gates 0/1/2/3/5/6/7 —
 * gate 4, the P-102 authorship chain, is held at a fixed-valid fixture here
 * since it already has its own dedicated property coverage in
 * offer-authorship.property.test.ts) using the SAME exported pure helpers
 * evaluatePull calls internally, and assert evaluatePull's actual outcome
 * matches the walk's predicted outcome+reason. This catches gate-reordering /
 * short-circuit regressions that a single-scenario unit test would miss.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import type { WorkOffer } from './offer-budget';
import { isOfferExpired } from './offer-budget';
import { offerAuthorshipSigningBytes, buildOfferAuthorship, type AuthorshipVerifyInput } from './offer-authorship';
import { evaluateClaimAuthority, type HostAvailability, type AxisAvailability } from './claim-authority';
import { resolveForeignWorkAdmission, bakedP2pDefaults, type P2pSettings } from './settings';
import {
  evaluatePull,
  evaluateSteal,
  revalidateExecutionEpoch,
  type StealContext,
  type OfferDesignation,
  type PullDecision,
} from './standing-puller';

const SELF = 'host:self';
const OTHER = 'host:other';

/** One fixed, validly-signed authorship (gate 4 stays green — see file header). */
function fixedAuthorship(offer: WorkOffer): AuthorshipVerifyInput {
  const kp = generateEd25519KeypairDer();
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

const axisAvailArb: fc.Arbitrary<AxisAvailability | null> = fc.oneof(
  fc.constant(null),
  fc.record({
    allotmentRemaining: fc.integer({ min: -5, max: 1000 }),
    liveHeadroom: fc.integer({ min: -5, max: 1000 }),
  }),
);

const hostAvailabilityArb: fc.Arbitrary<HostAvailability> = fc.record({
  remote: axisAvailArb,
  local: axisAvailArb,
});

const settingsArb: fc.Arbitrary<P2pSettings> = fc.record({
  killSwitchEngaged: fc.boolean(),
  optInMode: fc.constantFrom('off', 'selected-fleets', 'any-fleet'),
  optedInFleet: fc.boolean(), // when mode===selected-fleets, is the offer's fleet in the set?
}).map(({ killSwitchEngaged, optInMode, optedInFleet }) => {
  const s = bakedP2pDefaults();
  s.killSwitch.engaged = killSwitchEngaged;
  s.optIn.mode = optInMode as P2pSettings['optIn']['mode'];
  s.optIn.fleets = optInMode === 'selected-fleets' && optedInFleet ? ['fleet-x'] : [];
  return s;
});

const designationArb: fc.Arbitrary<OfferDesignation | null> = fc.oneof(
  fc.constant(null),
  fc.constant({ designatedHostRef: SELF, rosterEpoch: 1, designatedAtMs: 0, seq: 0 }),
  fc.record({ designatedAtMs: fc.nat({ max: 100_000 }), seq: fc.nat({ max: 10 }) }).map((d) => ({
    designatedHostRef: OTHER,
    rosterEpoch: 1,
    ...d,
  })),
);

const stealCtxArb: fc.Arbitrary<StealContext> = fc.record({
  t2StaleMs: fc.nat({ max: 50_000 }),
  selfReliability: fc.float({ min: 0, max: 1, noNaN: true }),
  minReliabilityToSteal: fc.float({ min: 0, max: 1, noNaN: true }),
  publisherExcludedHosts: fc.oneof(fc.constant([]), fc.constant([SELF]), fc.constant([OTHER])),
  betterCandidateExists: fc.boolean(),
});

describe('evaluatePull — claim-path SOAK (P-007/WI-1936 software half of the X11 soak)', () => {
  it('the actual outcome/reason always matches an independent gate-order walk (many randomized scenarios)', () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.integer({ min: 0, max: 50_000 }), // publishedAt
        fc.integer({ min: 0, max: 200_000 }), // ttlMs
        fc.integer({ min: 0, max: 300_000 }), // nowMs
        hostAvailabilityArb,
        designationArb,
        stealCtxArb,
        fc.integer({ min: 0, max: 5 }), // hostHighWaterEpoch
        fc.integer({ min: 0, max: 20 }), // hostHighWaterSeq
        (settings, publishedAt, ttlMs, nowMs, hostAvailability, designation, steal, hwEpoch, hwSeq) => {
          const offer: WorkOffer = {
            offerId: 'o1',
            fleetSlug: 'fleet-x',
            publisherRef: 'pub',
            billedTo: 'billed',
            modelClass: 'frontier-remote',
            priority: 0,
            isolationReqs: [],
            budget: { remote: { cap: 100, unit: 'usd-micros', maxPerCall: null }, local: null },
            publishedAt,
            ttlMs,
          };
          const authorship = fixedAuthorship(offer);

          const actual: PullDecision = evaluatePull({
            active: true,
            selfHostRef: SELF,
            settings,
            nowMs,
            maxRolloutTier: 1,
            authorship,
            hostAvailability,
            designation,
            hostHighWaterEpoch: hwEpoch,
            hostHighWaterSeq: hwSeq,
            steal,
          });

          // ── independent reference walk, gate-by-gate, in the documented order ──
          const admission = resolveForeignWorkAdmission(settings, nowMs, { maxRolloutTier: 1 });
          if (!admission.admitNewClaims) {
            expect(actual.outcome).toBe('skip');
            if (actual.outcome === 'skip') expect(actual.reason).toBe(admission.refusalReason);
            return;
          }
          if (admission.optedInFleets !== null && !admission.optedInFleets.includes(offer.fleetSlug)) {
            expect(actual).toMatchObject({ outcome: 'skip', reason: 'fleet_not_opted_in' });
            return;
          }
          if (isOfferExpired(offer, nowMs)) {
            expect(actual).toMatchObject({ outcome: 'skip', reason: 'offer_expired' });
            return;
          }
          // gate 4 (authorship) is held fixed-valid by construction — never refuses here.
          const claim = evaluateClaimAuthority(offer, hostAvailability);
          if (!claim.claimable) {
            expect(actual).toMatchObject({ outcome: 'skip', reason: 'no_claim_authority' });
            return;
          }
          if (designation) {
            const reval = revalidateExecutionEpoch({
              executorEpoch: 1,
              executorSeq: designation.seq,
              hostHighWaterEpoch: hwEpoch,
              hostHighWaterSeq: hwSeq,
            });
            if (!reval.ok) {
              expect(actual).toMatchObject({ outcome: 'skip', reason: 'execution_epoch_stale' });
              return;
            }
          }
          if (designation === null || designation.designatedHostRef === SELF) {
            expect(actual.outcome).toBe('claim');
            if (actual.outcome === 'claim' || actual.outcome === 'steal') expect(actual.stole).toBe(false);
            return;
          }
          // designated to OTHER — steal path.
          const stealDecision = evaluateSteal(designation.designatedAtMs, nowMs, steal, SELF);
          if (stealDecision.eligible) {
            expect(actual.outcome).toBe('steal');
            if (actual.outcome === 'claim' || actual.outcome === 'steal') expect(actual.stole).toBe(true);
          } else {
            expect(actual.outcome).toBe('skip');
            if (actual.outcome === 'skip') expect(actual.reason).toBe(`steal:${stealDecision.code}`);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('NEVER throws across the same randomized scenario space (host-authority code must fail closed, not crash)', () => {
    fc.assert(
      fc.property(
        settingsArb,
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 300_000 }),
        hostAvailabilityArb,
        designationArb,
        stealCtxArb,
        (settings, publishedAt, ttlMs, nowMs, hostAvailability, designation, steal) => {
          const offer: WorkOffer = {
            offerId: 'o2',
            fleetSlug: 'fleet-x',
            publisherRef: 'pub',
            billedTo: 'billed',
            modelClass: 'frontier-remote',
            priority: 0,
            isolationReqs: [],
            budget: { remote: { cap: 100, unit: 'usd-micros', maxPerCall: null }, local: null },
            publishedAt,
            ttlMs,
          };
          expect(() =>
            evaluatePull({
              active: true,
              selfHostRef: SELF,
              settings,
              nowMs,
              maxRolloutTier: 1,
              authorship: fixedAuthorship(offer),
              hostAvailability,
              designation,
              hostHighWaterEpoch: 0,
              hostHighWaterSeq: 0,
              steal,
            }),
          ).not.toThrow();
        },
      ),
      { numRuns: 2000 },
    );
  });
});
