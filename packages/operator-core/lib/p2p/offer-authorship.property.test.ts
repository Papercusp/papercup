/**
 * P-102 authorship chain — PROPERTY suite (fast-check, real Ed25519 sigs).
 *
 *  1. ROUND-TRIP: any consistently-built case (valid device sig, attested signer
 *     in an owner-signed+anchored publisher set, fresh epoch, capable host) ALWAYS
 *     verifies, and the proven signer id is the attested user.
 *  2. SINGLE BREAK: starting from a valid case, breaking exactly ONE link ALWAYS
 *     refuses with that link's specific code — the chain is fail-closed at every
 *     link and short-circuits at the first (here: only) failure.
 *
 * Arbitraries are CONSTRUCTIVE so shrinking lands on small readable witnesses.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import type { WorkOffer } from './offer-budget';
import {
  offerAuthorshipSigningBytes,
  buildOfferAuthorship,
  verifyOfferAuthorship,
  type AuthorshipVerifyInput,
  type AuthorshipRefusalCode,
} from './offer-authorship';

const CAP_POOL = ['clamp:coord-fleet-only', 'clamp:no-grants', 'clamp:no-secrets', 'clamp:egress-allowlist'];

interface CaseParams {
  offerId: string;
  fleetSlug: string;
  priority: number;
  isolationReqs: string[]; // non-empty
  minMajor: number; // >= 1 so min > 0.0.0
  minMinor: number;
  signerUserId: number;
  otherMembers: number[];
  epoch: number;
  ownerHighWaterDelta: number; // 0..epoch subtracted → fresh
  ownerGithubUserId: number;
}

const paramsArb: fc.Arbitrary<CaseParams> = fc
  .record({
    offerId: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `o-${s}`),
    fleetSlug: fc.string({ minLength: 1, maxLength: 10 }).map((s) => `f/${s}`),
    priority: fc.integer({ min: 0, max: 9 }),
    // Non-empty subset of the cap pool via a constructive mask (>=1 true).
    capMask: fc.tuple(...CAP_POOL.map(() => fc.boolean())),
    minMajor: fc.integer({ min: 1, max: 9 }),
    minMinor: fc.integer({ min: 0, max: 9 }),
    signerUserId: fc.integer({ min: 1, max: 100_000 }),
    otherMembers: fc.array(fc.integer({ min: 100_001, max: 200_000 }), { maxLength: 4 }),
    epoch: fc.integer({ min: 0, max: 50 }),
    ownerHighWaterDelta: fc.integer({ min: 0, max: 50 }),
    ownerGithubUserId: fc.integer({ min: 1, max: 100_000 }),
  })
  .map((r): CaseParams => {
    let isolationReqs = CAP_POOL.filter((_, i) => r.capMask[i]);
    if (isolationReqs.length === 0) isolationReqs = [CAP_POOL[0]!]; // force non-empty
    return {
      offerId: r.offerId,
      fleetSlug: r.fleetSlug,
      priority: r.priority,
      isolationReqs,
      minMajor: r.minMajor,
      minMinor: r.minMinor,
      signerUserId: r.signerUserId,
      otherMembers: r.otherMembers.filter((m) => m !== r.signerUserId),
      epoch: r.epoch,
      ownerHighWaterDelta: Math.min(r.ownerHighWaterDelta, r.epoch),
      ownerGithubUserId: r.ownerGithubUserId,
    };
  });

/** Build a fully-consistent, genuinely-signed case from params. */
function buildValid(p: CaseParams): AuthorshipVerifyInput {
  const kp = generateEd25519KeypairDer();
  const offer: WorkOffer = {
    offerId: p.offerId,
    fleetSlug: p.fleetSlug,
    publisherRef: `user:${p.signerUserId}`,
    billedTo: 'host:h1',
    modelClass: 'any',
    priority: p.priority,
    isolationReqs: p.isolationReqs,
    minRuntimeVersion: `${p.minMajor}.${p.minMinor}.0`,
    budget: { remote: { cap: 1000, unit: 'usd-micros', maxPerCall: 100 }, local: null },
    publishedAt: 1000,
    ttlMs: 60_000,
  };
  const sig = signWithPrivateKeyDer(kp.privateKeyDer, offerAuthorshipSigningBytes(offer, p.epoch));
  return {
    offer,
    authorship: buildOfferAuthorship({ devicePubkey: kp.pubkeyBase64, epoch: p.epoch, signature: sig }),
    attestedGithubUserId: p.signerUserId,
    publisherSet: {
      ownerGithubUserId: p.ownerGithubUserId,
      ownerAnchored: true,
      ownerSignatureValid: true,
      memberGithubUserIds: [p.signerUserId, ...p.otherMembers],
    },
    ownerHighWaterEpoch: p.epoch - p.ownerHighWaterDelta, // <= epoch → fresh
    host: {
      // host runtime way above any generated min → always satisfies.
      runtimeVersion: '99.0.0',
      // host caps ⊇ isolationReqs.
      capabilities: [...CAP_POOL, 'extra'],
    },
  };
}

describe('P-102 property — round-trip validity', () => {
  it('any consistently-built case verifies; proven signer = attested user', () => {
    fc.assert(
      fc.property(paramsArb, (p) => {
        const v = verifyOfferAuthorship(buildValid(p));
        expect(v.ok).toBe(true);
        if (v.ok) {
          expect(v.authorizedGithubUserId).toBe(p.signerUserId);
          expect(v.ownerGithubUserId).toBe(p.ownerGithubUserId);
          expect(v.epoch).toBe(p.epoch);
        }
      }),
      { numRuns: 300 },
    );
  });
});

type BreakKind =
  | 'tamperOffer'
  | 'wrongKey'
  | 'notAttested'
  | 'notInSet'
  | 'ownerUnsigned'
  | 'ownerUnanchored'
  | 'staleEpoch'
  | 'oldRuntime'
  | 'missingCap';

const EXPECTED: Record<BreakKind, AuthorshipRefusalCode> = {
  tamperOffer: 'device_sig_invalid',
  wrongKey: 'device_sig_invalid',
  notAttested: 'device_not_attested',
  notInSet: 'user_not_in_publisher_set',
  ownerUnsigned: 'owner_signature_invalid',
  ownerUnanchored: 'owner_unanchored',
  staleEpoch: 'epoch_stale',
  oldRuntime: 'runtime_too_old',
  missingCap: 'capability_unsatisfied',
};

function applyBreak(base: AuthorshipVerifyInput, kind: BreakKind): AuthorshipVerifyInput {
  switch (kind) {
    case 'tamperOffer':
      // Mutate a signed field WITHOUT re-signing → sig no longer matches.
      return { ...base, offer: { ...base.offer, priority: base.offer.priority + 1000 } };
    case 'wrongKey':
      return { ...base, authorship: { ...base.authorship, devicePubkey: generateEd25519KeypairDer().pubkeyBase64 } };
    case 'notAttested':
      return { ...base, attestedGithubUserId: null };
    case 'notInSet':
      return {
        ...base,
        publisherSet: {
          ...base.publisherSet,
          memberGithubUserIds: base.publisherSet.memberGithubUserIds.filter((m) => m !== base.attestedGithubUserId),
        },
      };
    case 'ownerUnsigned':
      return { ...base, publisherSet: { ...base.publisherSet, ownerSignatureValid: false } };
    case 'ownerUnanchored':
      return { ...base, publisherSet: { ...base.publisherSet, ownerAnchored: false } };
    case 'staleEpoch':
      return { ...base, ownerHighWaterEpoch: base.authorship.epoch + 1 };
    case 'oldRuntime':
      return { ...base, host: { ...base.host, runtimeVersion: '0.0.0' } }; // min major >= 1
    case 'missingCap':
      return {
        ...base,
        host: { ...base.host, capabilities: base.offer.isolationReqs.slice(1) }, // drop the first required cap
      };
  }
}

describe('P-102 property — single-break fail-closed', () => {
  it('breaking exactly one link refuses with that link’s code', () => {
    fc.assert(
      fc.property(
        paramsArb,
        fc.constantFrom<BreakKind>(
          'tamperOffer',
          'wrongKey',
          'notAttested',
          'notInSet',
          'ownerUnsigned',
          'ownerUnanchored',
          'staleEpoch',
          'oldRuntime',
          'missingCap',
        ),
        (p, kind) => {
          const base = buildValid(p);
          // Sanity: the base is valid before the break.
          expect(verifyOfferAuthorship(base).ok).toBe(true);
          const broken = applyBreak(base, kind);
          const v = verifyOfferAuthorship(broken);
          expect(v.ok).toBe(false);
          if (!v.ok) expect(v.code).toBe(EXPECTED[kind]);
        },
      ),
      { numRuns: 400 },
    );
  });
});
