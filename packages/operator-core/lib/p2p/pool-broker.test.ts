/**
 * P-304 pool/broker gateway dual-signature verification — EXAMPLE-based unit
 * tests, with REAL Ed25519 sigs. Each test drives one link of the host-side
 * verify chain (host-grant-sig, pool-assignment-sig, both attestations, owner
 * match, grant-binding, X6 epoch, constraints, X7 pool-ledger authority) with a
 * hand-built case. The generated round-trip / single-break corpus lives in
 * pool-broker.property.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
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
} from './pool-broker';

const HOST_OWNER = 279242982;
const POOL_OWNER = 555001;

const CAP: BudgetEnvelope = { remote: { cap: 1000, unit: 'usd-micros', maxPerCall: 100 }, local: null };

function grantBody(over: Partial<PoolGrantBody> = {}): PoolGrantBody {
  return {
    poolId: 'pool:alpha',
    hostRef: 'host:h1',
    hostOwnerGithubUserId: HOST_OWNER,
    grantEpoch: 4,
    cap: CAP,
    allowedFleets: ['f/a', 'f/b'],
    maxPerAssignment: null,
    ...over,
  };
}
function assignmentBody(over: Partial<PoolAssignmentBody> = {}): PoolAssignmentBody {
  return {
    assignmentId: 'asg-1',
    poolId: 'pool:alpha',
    hostRef: 'host:h1',
    fleetSlug: 'f/a',
    axis: 'remote',
    amount: 500,
    unit: 'usd-micros',
    grantEpoch: 4,
    assignmentEpoch: 9,
    ...over,
  };
}

function signGrant(body: PoolGrantBody, kp = generateEd25519KeypairDer()) {
  const sig = signWithPrivateKeyDer(kp.privateKeyDer, poolGrantSigningBytes(body));
  return { grant: buildSignedPoolGrant({ body, hostDevicePubkey: kp.pubkeyBase64, signature: sig }), kp };
}
function signAssignment(body: PoolAssignmentBody, kp = generateEd25519KeypairDer()) {
  const sig = signWithPrivateKeyDer(kp.privateKeyDer, poolAssignmentSigningBytes(body));
  return { assignment: buildSignedPoolAssignment({ body, poolDevicePubkey: kp.pubkeyBase64, signature: sig }), kp };
}

/** A fully-valid, genuinely-signed dual-signature case. */
function validInput(overrides: Partial<PoolAssignmentVerifyInput> = {}): PoolAssignmentVerifyInput {
  const { grant } = signGrant(grantBody());
  const { assignment } = signAssignment(assignmentBody());
  return {
    grant,
    assignment,
    hostDeviceAttestedGithubUserId: HOST_OWNER,
    poolDeviceAttestedGithubUserId: POOL_OWNER,
    poolOwnerGithubUserId: POOL_OWNER,
    hostHighWaterEpoch: 4,
    billing: { pool: { singleOwner: true }, gatewayLeg: 'quota-ledger' },
    ...overrides,
  };
}

describe('verifyPoolAssignment — happy path', () => {
  it('a dual-signed, attested, owner-matched, in-constraint, fresh assignment verifies', () => {
    const v = verifyPoolAssignment(validInput());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.authorizedHostOwnerGithubUserId).toBe(HOST_OWNER);
      expect(v.authorizedPoolOwnerGithubUserId).toBe(POOL_OWNER);
      expect(v.fleetSlug).toBe('f/a');
      expect(v.amount).toBe(500);
      expect(v.grantEpoch).toBe(4);
    }
  });

  it('the proven owners are the ATTESTED signers, not any self-claimed body field', () => {
    // grant body claims host owner HOST_OWNER, but the device is attested to a different id.
    const v = verifyPoolAssignment(validInput({ hostDeviceAttestedGithubUserId: 999 }));
    expect(v).toMatchObject({ ok: false, code: 'host_owner_mismatch' });
  });
});

describe('verifyPoolAssignment — host grant signature link', () => {
  it('refuses a tampered grant body (host sig no longer matches)', () => {
    const base = validInput();
    // widen the cap in the body WITHOUT re-signing.
    const tampered: PoolAssignmentVerifyInput = {
      ...base,
      grant: { ...base.grant, body: { ...base.grant.body, cap: { remote: { cap: 9_999_999, unit: 'usd-micros', maxPerCall: null }, local: null } } },
    };
    expect(verifyPoolAssignment(tampered)).toMatchObject({ ok: false, code: 'host_grant_sig_invalid' });
  });

  it('refuses a wrong-key host signature', () => {
    const base = validInput();
    const other = generateEd25519KeypairDer();
    expect(verifyPoolAssignment({ ...base, grant: { ...base.grant, hostDevicePubkey: other.pubkeyBase64 } })).toMatchObject({ ok: false, code: 'host_grant_sig_invalid' });
  });

  it('refuses a malformed host signature without throwing', () => {
    const base = validInput();
    expect(verifyPoolAssignment({ ...base, grant: { ...base.grant, signatureByHost: '!!!not-base64!!!' } })).toMatchObject({ ok: false, code: 'host_grant_sig_invalid' });
  });
});

describe('verifyPoolAssignment — attestation + owner links', () => {
  it('refuses an unattested host device', () => {
    expect(verifyPoolAssignment(validInput({ hostDeviceAttestedGithubUserId: null }))).toMatchObject({ ok: false, code: 'host_device_not_attested' });
  });
  it('refuses an unattested pool device', () => {
    expect(verifyPoolAssignment(validInput({ poolDeviceAttestedGithubUserId: null }))).toMatchObject({ ok: false, code: 'pool_device_not_attested' });
  });
  it('refuses a pool device attested to someone other than the pool owner', () => {
    expect(verifyPoolAssignment(validInput({ poolDeviceAttestedGithubUserId: 42 }))).toMatchObject({ ok: false, code: 'pool_owner_mismatch' });
  });
});

describe('verifyPoolAssignment — pool assignment signature link', () => {
  it('refuses a wrong-key pool signature', () => {
    const base = validInput();
    const other = generateEd25519KeypairDer();
    expect(verifyPoolAssignment({ ...base, assignment: { ...base.assignment, poolDevicePubkey: other.pubkeyBase64 } })).toMatchObject({ ok: false, code: 'pool_sig_invalid' });
  });
  it('refuses a tampered assignment amount (pool sig no longer matches)', () => {
    const base = validInput();
    expect(verifyPoolAssignment({ ...base, assignment: { ...base.assignment, body: { ...base.assignment.body, amount: 999 } } })).toMatchObject({ ok: false, code: 'pool_sig_invalid' });
  });
});

describe('verifyPoolAssignment — grant binding + X6 epoch', () => {
  it('refuses an assignment that binds a different grant epoch (re-signed, so the pool sig is valid)', () => {
    const { grant } = signGrant(grantBody({ grantEpoch: 4 }));
    const { assignment } = signAssignment(assignmentBody({ grantEpoch: 7 })); // pool signed a mismatched epoch
    const v = verifyPoolAssignment({
      grant,
      assignment,
      hostDeviceAttestedGithubUserId: HOST_OWNER,
      poolDeviceAttestedGithubUserId: POOL_OWNER,
      poolOwnerGithubUserId: POOL_OWNER,
      hostHighWaterEpoch: 4,
      billing: { pool: { singleOwner: true }, gatewayLeg: 'quota-ledger' },
    });
    expect(v).toMatchObject({ ok: false, code: 'assignment_grant_mismatch' });
  });

  it('refuses a stale grant epoch below the host high-water (X6)', () => {
    const v = verifyPoolAssignment(validInput({ hostHighWaterEpoch: 5 })); // grant epoch 4 < 5
    expect(v).toMatchObject({ ok: false, code: 'grant_epoch_stale' });
  });

  it('accepts grant epoch equal to the high-water (monotone, not strict)', () => {
    expect(verifyPoolAssignment(validInput({ hostHighWaterEpoch: 4 })).ok).toBe(true);
  });
});

describe('verifyPoolAssignment — constraints (fleet, axis, unit, amount)', () => {
  function withAssignment(over: Partial<PoolAssignmentBody>): PoolAssignmentVerifyInput {
    const { grant } = signGrant(grantBody());
    const { assignment } = signAssignment(assignmentBody(over));
    return {
      grant,
      assignment,
      hostDeviceAttestedGithubUserId: HOST_OWNER,
      poolDeviceAttestedGithubUserId: POOL_OWNER,
      poolOwnerGithubUserId: POOL_OWNER,
      hostHighWaterEpoch: 4,
      billing: { pool: { singleOwner: true }, gatewayLeg: 'quota-ledger' },
    };
  }

  it('refuses a fleet not in the grant allowed set', () => {
    expect(verifyPoolAssignment(withAssignment({ fleetSlug: 'f/z' }))).toMatchObject({ ok: false, code: 'fleet_not_allowed' });
  });
  it('refuses an axis the grant did not lend', () => {
    expect(verifyPoolAssignment(withAssignment({ axis: 'local', unit: 'slots' }))).toMatchObject({ ok: false, code: 'axis_not_granted' });
  });
  it('refuses a unit mismatch on a granted axis (H14)', () => {
    expect(verifyPoolAssignment(withAssignment({ unit: 'tokens' }))).toMatchObject({ ok: false, code: 'unit_mismatch' });
  });
  it('refuses a non-positive amount', () => {
    expect(verifyPoolAssignment(withAssignment({ amount: 0 }))).toMatchObject({ ok: false, code: 'invalid_amount' });
  });
  it('refuses an amount over the granted cap', () => {
    expect(verifyPoolAssignment(withAssignment({ amount: 2000 }))).toMatchObject({ ok: false, code: 'amount_exceeds_cap' });
  });
  it('refuses an amount over the per-assignment clamp', () => {
    const { grant } = signGrant(grantBody({ maxPerAssignment: 100 }));
    const { assignment } = signAssignment(assignmentBody({ amount: 500 })); // < cap 1000 but > clamp 100
    const v = verifyPoolAssignment({
      grant,
      assignment,
      hostDeviceAttestedGithubUserId: HOST_OWNER,
      poolDeviceAttestedGithubUserId: POOL_OWNER,
      poolOwnerGithubUserId: POOL_OWNER,
      hostHighWaterEpoch: 4,
      billing: { pool: { singleOwner: true }, gatewayLeg: 'quota-ledger' },
    });
    expect(v).toMatchObject({ ok: false, code: 'amount_exceeds_max_per_assignment' });
  });
});

describe('verifyPoolAssignment — X7 / D-009 pool-ledger authority', () => {
  it('refuses a multi-owner pool (M17 — pool-with-attribution requires single-owner)', () => {
    expect(verifyPoolAssignment(validInput({ billing: { pool: { singleOwner: false }, gatewayLeg: 'quota-ledger' } }))).toMatchObject({ ok: false, code: 'pool_billing_unauthorized' });
  });
  it('refuses when no pool billing context is supplied (fail-closed)', () => {
    expect(verifyPoolAssignment(validInput({ billing: undefined }))).toMatchObject({ ok: false, code: 'pool_billing_unauthorized' });
  });
  it('refuses a forbidden relay leg (D-009 — inference bytes never route through the pool)', () => {
    expect(verifyPoolAssignment(validInput({ billing: { pool: { singleOwner: true }, gatewayLeg: 'streaming-relay' } }))).toMatchObject({ ok: false, code: 'pool_billing_unauthorized' });
  });
});
