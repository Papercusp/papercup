/**
 * P-304 pool/broker dual-signature verification — PROPERTY suite (fast-check,
 * real Ed25519 sigs).
 *
 *  1. ROUND-TRIP: any consistently-built dual-signed case (valid host + pool
 *     sigs, both devices attested to the matching owners, assignment binds the
 *     grant, fresh epoch, in-constraint amount, authorized pool ledger) ALWAYS
 *     verifies, and the proven owners are the attested signers.
 *  2. SINGLE BREAK: starting from a valid case, breaking exactly ONE link ALWAYS
 *     refuses with that link's specific code — the chain is fail-closed at every
 *     link and short-circuits at the first failure.
 *
 * Arbitraries are CONSTRUCTIVE so shrinking lands on small readable witnesses.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { generateEd25519KeypairDer, signWithPrivateKeyDer, type GeneratedKeypairDer } from '../identity/ed25519';
import type { BudgetEnvelope } from './offer-budget';
import {
  poolGrantSigningBytes,
  poolAssignmentSigningBytes,
  buildSignedPoolGrant,
  buildSignedPoolAssignment,
  verifyPoolAssignment,
  type PoolGrantBody,
  type PoolAssignmentBody,
  type PoolAssignmentVerifyInput,
  type PoolAssignmentRefusalCode,
} from './pool-broker';

interface CaseParams {
  poolId: string;
  hostRef: string;
  hostOwner: number;
  poolOwner: number;
  grantEpoch: number;
  highWaterDelta: number; // 0..grantEpoch subtracted → fresh
  capAmount: number;
  allowedFleets: string[]; // non-empty
  fleetSlug: string; // in allowedFleets
  amount: number; // 1..capAmount
}

const paramsArb: fc.Arbitrary<CaseParams> = fc
  .record({
    poolId: fc.string({ minLength: 1, maxLength: 8 }).map((s) => `pool:${s}`),
    hostRef: fc.string({ minLength: 1, maxLength: 8 }).map((s) => `host:${s}`),
    hostOwner: fc.integer({ min: 1, max: 100_000 }),
    poolOwner: fc.integer({ min: 100_001, max: 200_000 }),
    grantEpoch: fc.integer({ min: 0, max: 40 }),
    highWaterDelta: fc.integer({ min: 0, max: 40 }),
    capAmount: fc.integer({ min: 1, max: 10_000 }),
    fleetTag: fc.string({ minLength: 1, maxLength: 6 }),
    amountFrac: fc.integer({ min: 1, max: 10_000 }),
  })
  .map((r): CaseParams => {
    const fleetSlug = `f/${r.fleetTag}`;
    return {
      poolId: r.poolId,
      hostRef: r.hostRef,
      hostOwner: r.hostOwner,
      poolOwner: r.poolOwner,
      grantEpoch: r.grantEpoch,
      highWaterDelta: Math.min(r.highWaterDelta, r.grantEpoch),
      capAmount: r.capAmount,
      allowedFleets: [fleetSlug, 'f/other'],
      fleetSlug,
      amount: 1 + (r.amountFrac % r.capAmount), // 1..capAmount
    };
  });

interface BuiltCase {
  input: PoolAssignmentVerifyInput;
  kpHost: GeneratedKeypairDer;
  kpPool: GeneratedKeypairDer;
  p: CaseParams;
}

function grantBodyOf(p: CaseParams): PoolGrantBody {
  const cap: BudgetEnvelope = { remote: { cap: p.capAmount, unit: 'usd-micros', maxPerCall: null }, local: null };
  return { poolId: p.poolId, hostRef: p.hostRef, hostOwnerGithubUserId: p.hostOwner, grantEpoch: p.grantEpoch, cap, allowedFleets: p.allowedFleets, maxPerAssignment: null };
}
function assignmentBodyOf(p: CaseParams, over: Partial<PoolAssignmentBody> = {}): PoolAssignmentBody {
  return { assignmentId: 'asg', poolId: p.poolId, hostRef: p.hostRef, fleetSlug: p.fleetSlug, axis: 'remote', amount: p.amount, unit: 'usd-micros', grantEpoch: p.grantEpoch, assignmentEpoch: 1, ...over };
}
function signedGrant(body: PoolGrantBody, kp: GeneratedKeypairDer) {
  return buildSignedPoolGrant({ body, hostDevicePubkey: kp.pubkeyBase64, signature: signWithPrivateKeyDer(kp.privateKeyDer, poolGrantSigningBytes(body)) });
}
function signedAssignment(body: PoolAssignmentBody, kp: GeneratedKeypairDer) {
  return buildSignedPoolAssignment({ body, poolDevicePubkey: kp.pubkeyBase64, signature: signWithPrivateKeyDer(kp.privateKeyDer, poolAssignmentSigningBytes(body)) });
}

function buildValid(p: CaseParams): BuiltCase {
  const kpHost = generateEd25519KeypairDer();
  const kpPool = generateEd25519KeypairDer();
  const input: PoolAssignmentVerifyInput = {
    grant: signedGrant(grantBodyOf(p), kpHost),
    assignment: signedAssignment(assignmentBodyOf(p), kpPool),
    hostDeviceAttestedGithubUserId: p.hostOwner,
    poolDeviceAttestedGithubUserId: p.poolOwner,
    poolOwnerGithubUserId: p.poolOwner,
    hostHighWaterEpoch: p.grantEpoch - p.highWaterDelta, // <= grantEpoch → fresh
    billing: { pool: { singleOwner: true }, gatewayLeg: 'quota-ledger' },
  };
  return { input, kpHost, kpPool, p };
}

describe('P-304 property — round-trip validity', () => {
  it('any consistently-built dual-signed case verifies; proven owners = attested signers', () => {
    fc.assert(
      fc.property(paramsArb, (p) => {
        const v = verifyPoolAssignment(buildValid(p).input);
        expect(v.ok).toBe(true);
        if (v.ok) {
          expect(v.authorizedHostOwnerGithubUserId).toBe(p.hostOwner);
          expect(v.authorizedPoolOwnerGithubUserId).toBe(p.poolOwner);
          expect(v.fleetSlug).toBe(p.fleetSlug);
          expect(v.amount).toBe(p.amount);
          expect(v.grantEpoch).toBe(p.grantEpoch);
        }
      }),
      { numRuns: 300 },
    );
  });
});

type BreakKind =
  | 'tamperGrant'
  | 'wrongHostKey'
  | 'hostNotAttested'
  | 'hostOwnerMismatch'
  | 'tamperAssignment'
  | 'poolNotAttested'
  | 'poolOwnerMismatch'
  | 'grantMismatch'
  | 'staleEpoch'
  | 'fleetNotAllowed'
  | 'axisNotGranted'
  | 'unitMismatch'
  | 'amountZero'
  | 'amountOverCap'
  | 'billingBad';

const EXPECTED: Record<BreakKind, PoolAssignmentRefusalCode> = {
  tamperGrant: 'host_grant_sig_invalid',
  wrongHostKey: 'host_grant_sig_invalid',
  hostNotAttested: 'host_device_not_attested',
  hostOwnerMismatch: 'host_owner_mismatch',
  tamperAssignment: 'pool_sig_invalid',
  poolNotAttested: 'pool_device_not_attested',
  poolOwnerMismatch: 'pool_owner_mismatch',
  grantMismatch: 'assignment_grant_mismatch',
  staleEpoch: 'grant_epoch_stale',
  fleetNotAllowed: 'fleet_not_allowed',
  axisNotGranted: 'axis_not_granted',
  unitMismatch: 'unit_mismatch',
  amountZero: 'invalid_amount',
  amountOverCap: 'amount_exceeds_cap',
  billingBad: 'pool_billing_unauthorized',
};

function applyBreak(c: BuiltCase, kind: BreakKind): PoolAssignmentVerifyInput {
  const { input, kpPool, p } = c;
  switch (kind) {
    case 'tamperGrant': // widen cap in the body WITHOUT re-signing
      return { ...input, grant: { ...input.grant, body: { ...input.grant.body, cap: { remote: { cap: input.grant.body.cap.remote!.cap + 1, unit: 'usd-micros', maxPerCall: null }, local: null } } } };
    case 'wrongHostKey':
      return { ...input, grant: { ...input.grant, hostDevicePubkey: generateEd25519KeypairDer().pubkeyBase64 } };
    case 'hostNotAttested':
      return { ...input, hostDeviceAttestedGithubUserId: null };
    case 'hostOwnerMismatch':
      return { ...input, hostDeviceAttestedGithubUserId: p.hostOwner + 1 };
    case 'tamperAssignment': // mutate amount in the body WITHOUT re-signing
      return { ...input, assignment: { ...input.assignment, body: { ...input.assignment.body, amount: input.assignment.body.amount + 1 } } };
    case 'poolNotAttested':
      return { ...input, poolDeviceAttestedGithubUserId: null };
    case 'poolOwnerMismatch':
      return { ...input, poolDeviceAttestedGithubUserId: p.poolOwner + 1 };
    case 'grantMismatch': // re-sign an assignment that binds a DIFFERENT grant epoch (pool sig stays valid)
      return { ...input, assignment: signedAssignment(assignmentBodyOf(p, { grantEpoch: p.grantEpoch + 1 }), kpPool), hostHighWaterEpoch: 0 };
    case 'staleEpoch':
      return { ...input, hostHighWaterEpoch: p.grantEpoch + 1 };
    case 'fleetNotAllowed': // re-sign an assignment to a fleet NOT in the allowed set
      return { ...input, assignment: signedAssignment(assignmentBodyOf(p, { fleetSlug: 'f/NOT-ALLOWED-xyz' }), kpPool) };
    case 'axisNotGranted': // re-sign an assignment on the local axis (grant lends none)
      return { ...input, assignment: signedAssignment(assignmentBodyOf(p, { axis: 'local', unit: 'slots' }), kpPool) };
    case 'unitMismatch': // re-sign an assignment with a different unit on the granted axis
      return { ...input, assignment: signedAssignment(assignmentBodyOf(p, { unit: 'tokens' }), kpPool) };
    case 'amountZero':
      return { ...input, assignment: signedAssignment(assignmentBodyOf(p, { amount: 0 }), kpPool) };
    case 'amountOverCap':
      return { ...input, assignment: signedAssignment(assignmentBodyOf(p, { amount: p.capAmount + 1 }), kpPool) };
    case 'billingBad':
      return { ...input, billing: { pool: { singleOwner: false }, gatewayLeg: 'quota-ledger' } };
  }
}

describe('P-304 property — single-break fail-closed', () => {
  it('breaking exactly one link refuses with that link’s code', () => {
    fc.assert(
      fc.property(
        paramsArb,
        fc.constantFrom<BreakKind>(
          'tamperGrant', 'wrongHostKey', 'hostNotAttested', 'hostOwnerMismatch', 'tamperAssignment',
          'poolNotAttested', 'poolOwnerMismatch', 'grantMismatch', 'staleEpoch', 'fleetNotAllowed',
          'axisNotGranted', 'unitMismatch', 'amountZero', 'amountOverCap', 'billingBad',
        ),
        (p, kind) => {
          const c = buildValid(p);
          expect(verifyPoolAssignment(c.input).ok).toBe(true); // sanity: valid before the break
          const v = verifyPoolAssignment(applyBreak(c, kind));
          expect(v.ok).toBe(false);
          if (!v.ok) expect(v.code).toBe(EXPECTED[kind]);
        },
      ),
      { numRuns: 450 },
    );
  });
});
