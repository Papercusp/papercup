/**
 * hive-policy-schema — pure unit tests (shared-hive-owner-enforcement EN-1).
 *
 * Covers the SIGNING CONTRACT the whole layer rests on: a canonical form that is
 * order-independent + stable, signed bytes that bind workspace/slug/version, the
 * sign→verify Ed25519 roundtrip (the S0 crypto core), forward-compat preservation of
 * unknown keys, and the input validator.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalizeHivePolicy,
  hivePolicySignedBytes,
  parseHivePolicyJson,
  coerceHivePolicyInput,
  HIVE_POLICY_SIG_DOMAIN,
  type HivePolicy,
} from './hive-policy-schema';
import { generateEd25519KeypairDer, signWithPrivateKeyDer, verifyEd25519 } from './identity/ed25519';

describe('canonicalizeHivePolicy', () => {
  it('is INDEPENDENT of key insertion order (deterministic)', () => {
    const a: HivePolicy = { membership: 'approval', rate: { opsPerMin: 10, prsPerDay: 3 }, allowlist: ['b', 'a'] };
    const b: HivePolicy = { allowlist: ['b', 'a'], rate: { prsPerDay: 3, opsPerMin: 10 }, membership: 'approval' };
    expect(canonicalizeHivePolicy(a)).toBe(canonicalizeHivePolicy(b));
  });

  it('PRESERVES array order (it is signed content)', () => {
    expect(canonicalizeHivePolicy({ allowlist: ['a', 'b'] })).not.toBe(
      canonicalizeHivePolicy({ allowlist: ['b', 'a'] }),
    );
  });

  it('is single-line (no literal newline) so the signed envelope stays unambiguous', () => {
    const c = canonicalizeHivePolicy({ moderation: { takedownList: ['x\ny'] } });
    expect(c.includes('\n')).toBe(false); // the embedded newline is escaped as \n
  });

  it('forward-compat: PRESERVES unknown keys through a parse→canonicalize round trip', () => {
    const withUnknown = { membership: 'open', futureKnob: { deep: [1, 2] }, x: 'y' } as HivePolicy;
    const canon = canonicalizeHivePolicy(withUnknown);
    const round = canonicalizeHivePolicy(parseHivePolicyJson(canon));
    expect(round).toBe(canon);
    expect(canon).toContain('futureKnob');
  });

  it('empty / null policy canonicalizes to {}', () => {
    expect(canonicalizeHivePolicy({})).toBe('{}');
    expect(canonicalizeHivePolicy(null)).toBe('{}');
    expect(canonicalizeHivePolicy(undefined)).toBe('{}');
  });
});

describe('hivePolicySignedBytes', () => {
  const base = { workspaceId: 'ws', hiveHomeSlug: 'home', policyVersion: 1, canonicalPolicyJson: '{}' };

  it('carries the domain tag (anti-cross-protocol replay)', () => {
    expect(hivePolicySignedBytes(base).toString('utf8').startsWith(HIVE_POLICY_SIG_DOMAIN)).toBe(true);
  });

  it('changes when ANY binding field changes (anti cross-hive/version replay)', () => {
    const b0 = hivePolicySignedBytes(base).toString('hex');
    expect(hivePolicySignedBytes({ ...base, workspaceId: 'ws2' }).toString('hex')).not.toBe(b0);
    expect(hivePolicySignedBytes({ ...base, hiveHomeSlug: 'home2' }).toString('hex')).not.toBe(b0);
    expect(hivePolicySignedBytes({ ...base, policyVersion: 2 }).toString('hex')).not.toBe(b0);
    expect(hivePolicySignedBytes({ ...base, canonicalPolicyJson: '{"a":1}' }).toString('hex')).not.toBe(b0);
  });
});

describe('sign → verify roundtrip (the S0 crypto core)', () => {
  it('a signature over the canonical bytes verifies; a tampered policy / wrong key does NOT', () => {
    const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
    const policy: HivePolicy = { rate: { opsPerMin: 5 }, membership: 'allowlist', allowlist: ['octocat'] };
    const canonical = canonicalizeHivePolicy(policy);
    const bytes = hivePolicySignedBytes({ workspaceId: 'ws', hiveHomeSlug: 'home', policyVersion: 7, canonicalPolicyJson: canonical });
    const sig = signWithPrivateKeyDer(privateKeyDer, bytes);

    // Valid.
    expect(verifyEd25519(bytes, pubkeyBase64, sig)).toBe(true);

    // Tampered policy → the recomputed bytes differ → verify fails.
    const tampered = hivePolicySignedBytes({
      workspaceId: 'ws', hiveHomeSlug: 'home', policyVersion: 7,
      canonicalPolicyJson: canonicalizeHivePolicy({ ...policy, allowlist: ['attacker'] }),
    });
    expect(verifyEd25519(tampered, pubkeyBase64, sig)).toBe(false);

    // Wrong (attacker) key → verify fails even over the SAME bytes.
    const attacker = generateEd25519KeypairDer();
    expect(verifyEd25519(bytes, attacker.pubkeyBase64, sig)).toBe(false);

    // Version replay → bytes differ → verify fails.
    const replayed = hivePolicySignedBytes({ workspaceId: 'ws', hiveHomeSlug: 'home', policyVersion: 8, canonicalPolicyJson: canonical });
    expect(verifyEd25519(replayed, pubkeyBase64, sig)).toBe(false);
  });
});

describe('coerceHivePolicyInput', () => {
  it('accepts a valid policy + an empty policy', () => {
    expect(coerceHivePolicyInput({}).ok).toBe(true);
    expect(coerceHivePolicyInput({ rate: { opsPerMin: 10 }, membership: 'open', allowlist: ['a'], moderation: { reportable: true } }).ok).toBe(true);
  });

  it('accepts unknown keys (forward-compat)', () => {
    const r = coerceHivePolicyInput({ futureKnob: 42, membership: 'approval' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy.futureKnob).toBe(42);
  });

  it('rejects non-objects + structurally-wrong known fields', () => {
    expect(coerceHivePolicyInput(null).ok).toBe(false);
    expect(coerceHivePolicyInput([]).ok).toBe(false);
    expect(coerceHivePolicyInput('x').ok).toBe(false);
    expect(coerceHivePolicyInput({ membership: 'tyrant' }).ok).toBe(false);
    expect(coerceHivePolicyInput({ allowlist: [1, 2] }).ok).toBe(false);
    expect(coerceHivePolicyInput({ rate: { opsPerMin: -1 } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ rate: { opsPerMin: 'lots' } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ moderation: { bannedGithubIds: [1] } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ moderation: { reportable: 'yes' } }).ok).toBe(false);
  });
});

describe('parseHivePolicyJson', () => {
  it('round-trips a policy; tolerates junk (→ {})', () => {
    expect(parseHivePolicyJson('{"membership":"open"}')).toEqual({ membership: 'open' });
    expect(parseHivePolicyJson('not json')).toEqual({});
    expect(parseHivePolicyJson('[1,2]')).toEqual({}); // arrays aren't policies
    expect(parseHivePolicyJson(null)).toEqual({});
    expect(parseHivePolicyJson('')).toEqual({});
  });
});

describe('policy.comms (P-012 — cross-machine-coord-parity-and-trust-2026-07-01)', () => {
  it('accepts a valid comms.defaultTier and preserves unknown comms subkeys (signed round-trip)', () => {
    const res = coerceHivePolicyInput({ comms: { defaultTier: 'wake', futureKnob: 42 } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.policy.comms).toEqual({ defaultTier: 'wake', futureKnob: 42 });
      // canonicalization covers the whole object — comms is signed like everything else
      const canon = canonicalizeHivePolicy(res.policy);
      expect(canon).toContain('"defaultTier":"wake"');
      expect(canon).toContain('"futureKnob":42');
    }
  });

  it('accepts every lattice tier and an empty comms object', () => {
    for (const tier of ['observe', 'message', 'wake', 'steer']) {
      expect(coerceHivePolicyInput({ comms: { defaultTier: tier } }).ok).toBe(true);
    }
    expect(coerceHivePolicyInput({ comms: {} }).ok).toBe(true);
  });

  it('rejects a garbage defaultTier and a non-object comms', () => {
    expect(coerceHivePolicyInput({ comms: { defaultTier: 'root' } }).ok).toBe(false);
    expect(coerceHivePolicyInput({ comms: 'wake' }).ok).toBe(false);
    expect(coerceHivePolicyInput({ comms: ['wake'] }).ok).toBe(false);
  });
});
