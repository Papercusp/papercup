/**
 * hive-policy-secrets-guard — pure unit tests for the owner-signed secrets-scan waivers
 * that ride the pot policy (WI-10002785).
 *
 * Root cause under test: `harness_shared.secrets_guard_path_exemptions` is host-local, so
 * a waiver the owner adjudicated on one machine re-refused on every joined peer. The fix
 * carries waivers in the signed policy document; these tests pin the document half:
 * validation (a waiver switches scanning OFF, so malformed entries are refused), the
 * order-independent canonical form (so two owner devices sign identical bytes), the
 * add/remove helpers, and that the signature still covers the waiver after a
 * parse→canonicalize round trip (a member must verify exactly what the owner signed).
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalizeHivePolicy,
  coerceHivePolicyInput,
  hivePolicySignedBytes,
  parseHivePolicyJson,
  policySecretsGuardExemptions,
  secretsGuardExemptionProblem,
  withSecretsGuardExemptions,
  withoutSecretsGuardExemptions,
  type HivePolicy,
} from './hive-policy-schema';
import { generateEd25519KeypairDer, signWithPrivateKeyDer, verifyEd25519 } from './identity/ed25519';

const A = { path: 'libs/x/fixture.test.ts', reason: 'test PEM fixture' };
const B = { path: 'packages/y/config.ts', reason: 'type name, not a secret' };

describe('coerceHivePolicyInput — secretsGuard', () => {
  it('accepts a well-formed waiver list (and preserves unknown knobs)', () => {
    const res = coerceHivePolicyInput({ secretsGuard: { pathExemptions: [A, { ...B, extra: 1 }], futureKnob: true } });
    expect(res.ok).toBe(true);
  });

  it.each([
    [{ secretsGuard: [] }, 'policy.secretsGuard must be an object'],
    [{ secretsGuard: { pathExemptions: {} } }, 'policy.secretsGuard.pathExemptions must be an array'],
    [{ secretsGuard: { pathExemptions: [{ path: '', reason: 'r' }] } }, 'path must be a non-empty string'],
    [{ secretsGuard: { pathExemptions: [{ path: '/etc/passwd', reason: 'r' }] } }, 'repo-relative'],
    [{ secretsGuard: { pathExemptions: [{ path: 'a/../b', reason: 'r' }] } }, 'repo-relative'],
    [{ secretsGuard: { pathExemptions: [{ path: 'a\nb', reason: 'r' }] } }, 'repo-relative'],
    [{ secretsGuard: { pathExemptions: [{ path: 'a/b' }] } }, 'reason must be a non-empty string'],
  ])('refuses %j', (input, fragment) => {
    const res = coerceHivePolicyInput(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(fragment);
  });

  it('secretsGuardExemptionProblem accepts both prefix forms', () => {
    expect(secretsGuardExemptionProblem({ path: 'dist/', reason: 'r' })).toBeNull();
    expect(secretsGuardExemptionProblem({ path: 'dist/**', reason: 'r' })).toBeNull();
  });
});

describe('withSecretsGuardExemptions / withoutSecretsGuardExemptions', () => {
  it('sorts by path so the canonical bytes do not depend on authoring order', () => {
    const ab = withSecretsGuardExemptions({}, [A, B]);
    const ba = withSecretsGuardExemptions(withSecretsGuardExemptions({}, [B]), [A]);
    expect(canonicalizeHivePolicy(ab)).toBe(canonicalizeHivePolicy(ba));
    expect(policySecretsGuardExemptions(ab).map((e) => e.path)).toEqual([A.path, B.path]);
  });

  it('an entry for an existing path REPLACES it (one waiver per path)', () => {
    const p = withSecretsGuardExemptions(withSecretsGuardExemptions({}, [A]), [{ ...A, reason: 'updated' }]);
    expect(policySecretsGuardExemptions(p)).toEqual([{ ...A, reason: 'updated' }]);
  });

  it('never drops the rest of the owner-signed policy', () => {
    const base: HivePolicy = { membership: 'allowlist', allowlist: ['o'], secretsGuard: { futureKnob: 1 } };
    const p = withSecretsGuardExemptions(base, [A]);
    expect(p.membership).toBe('allowlist');
    expect(p.allowlist).toEqual(['o']);
    expect(p.secretsGuard?.futureKnob).toBe(1);
  });

  it('remove of an absent path returns the SAME object (no re-sign churn)', () => {
    const p = withSecretsGuardExemptions({ membership: 'open' }, [A]);
    expect(withoutSecretsGuardExemptions(p, ['not/there'])).toBe(p);
    const bare: HivePolicy = { membership: 'open' };
    expect(withoutSecretsGuardExemptions(bare, [A.path])).toBe(bare);
  });

  it('removing the last waiver removes the empty container too', () => {
    const p = withoutSecretsGuardExemptions(withSecretsGuardExemptions({ membership: 'open' }, [A]), [A.path]);
    expect(p).toEqual({ membership: 'open' });
  });

  it('policySecretsGuardExemptions skips malformed entries on READ (fail-safe: scanning stays on)', () => {
    const junk = { secretsGuard: { pathExemptions: [A, { path: '/abs', reason: 'x' }, 'str', { path: 'p' }] } } as unknown as HivePolicy;
    expect(policySecretsGuardExemptions(junk)).toEqual([A]);
    expect(policySecretsGuardExemptions(null)).toEqual([]);
  });
});

describe('signature coverage', () => {
  it('the owner signature over a policy carrying waivers verifies after a parse→canonicalize round trip, and a widened waiver does not', () => {
    const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
    const policyJson = canonicalizeHivePolicy(withSecretsGuardExemptions({ membership: 'allowlist' }, [A, B]));
    const bytes = (json: string) =>
      hivePolicySignedBytes({ workspaceId: 'ws', potHomeSlug: 'home', policyVersion: 7, canonicalPolicyJson: json });
    const sig = signWithPrivateKeyDer(privateKeyDer, bytes(policyJson));

    const roundTripped = canonicalizeHivePolicy(parseHivePolicyJson(policyJson));
    expect(roundTripped).toBe(policyJson);
    expect(verifyEd25519(bytes(roundTripped), pubkeyBase64, sig)).toBe(true);

    // A member cannot widen the owner's waiver list under the owner's signature.
    const widened = canonicalizeHivePolicy(
      withSecretsGuardExemptions(parseHivePolicyJson(policyJson), [{ path: 'packages/', reason: 'member widened' }]),
    );
    expect(verifyEd25519(bytes(widened), pubkeyBase64, sig)).toBe(false);
  });
});
