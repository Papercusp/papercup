/**
 * hive-policy-author — unit tests (shared-hive-owner-enforcement EN-1, build step 3).
 *
 * Drives the OWNER-side sign+write with injected seams. The key teeth: the signature
 * the author produces VERIFIES over the canonical signed bytes for the bumped version
 * (author ↔ schema ↔ ed25519 agree — the "sign" half of the S0 roundtrip), the version
 * is monotone, and a Swarm without the Hive key is refused.
 */
import { describe, it, expect, vi } from 'vitest';
import { authorHivePolicy, mutateHivePolicy, type AuthorHivePolicySeams } from './hive-policy-author';
import { canonicalizeHivePolicy, hivePolicySignedBytes, type HivePolicy } from './hive-policy-schema';
import type { ResolvedHivePolicy } from './hive-policy-store';
import { generateEd25519KeypairDer, signWithPrivateKeyDer, verifyEd25519 } from './identity/ed25519';

const WS = 'ws';
const HOME = 'home';

function writeCapture() {
  const writes: Array<{ policyJson: string; signature: string; ownerPubkey: string; policyVersion: number }> = [];
  const write: AuthorHivePolicySeams['write'] = async (input) => {
    writes.push(input);
    const resolved: ResolvedHivePolicy = {
      workspaceId: input.workspaceId, hiveHomeSlug: input.hiveHomeSlug,
      policy: JSON.parse(input.policyJson), policyVersion: input.policyVersion,
      ownerPubkey: input.ownerPubkey, signature: input.signature, policyJson: input.policyJson,
      fedHlc: 'h', updatedAt: 1,
    };
    return resolved;
  };
  return { writes, write };
}

describe('authorHivePolicy', () => {
  it('signs the bumped version and the signature VERIFIES over the canonical bytes', async () => {
    const kp = generateEd25519KeypairDer();
    const { writes, write } = writeCapture();
    const policy: HivePolicy = { membership: 'allowlist', allowlist: ['octocat'], rate: { opsPerMin: 5 } };

    const res = await authorHivePolicy({ workspaceId: WS, hiveHomeSlug: HOME, policy }, {
      readCurrent: async () => ({ policyVersion: 5 } as ResolvedHivePolicy), // current v5 → author writes v6
      loadOwnerPubkey: async () => kp.pubkeyBase64,
      sign: async (_ws, _slug, bytes) => signWithPrivateKeyDer(kp.privateKeyDer, bytes),
      write,
    });

    expect(res.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].policyVersion).toBe(6); // monotone bump
    expect(writes[0].ownerPubkey).toBe(kp.pubkeyBase64);

    // The produced signature verifies over the SAME bytes a member's projection recomputes.
    const expectedBytes = hivePolicySignedBytes({
      workspaceId: WS, hiveHomeSlug: HOME, policyVersion: 6,
      canonicalPolicyJson: canonicalizeHivePolicy(policy),
    });
    expect(writes[0].policyJson).toBe(canonicalizeHivePolicy(policy));
    expect(verifyEd25519(expectedBytes, kp.pubkeyBase64, Buffer.from(writes[0].signature, 'base64'))).toBe(true);
  });

  it('first author (no current policy) starts at version 1', async () => {
    const kp = generateEd25519KeypairDer();
    const { writes, write } = writeCapture();
    await authorHivePolicy({ workspaceId: WS, hiveHomeSlug: HOME, policy: {} }, {
      readCurrent: async () => null,
      loadOwnerPubkey: async () => kp.pubkeyBase64,
      sign: async (_ws, _slug, bytes) => signWithPrivateKeyDer(kp.privateKeyDer, bytes),
      write,
    });
    expect(writes[0].policyVersion).toBe(1);
  });

  it('a Swarm without the Hive key is refused (not_owner_swarm) — never writes', async () => {
    const write = vi.fn();
    const res = await authorHivePolicy({ workspaceId: WS, hiveHomeSlug: HOME, policy: {} }, {
      loadOwnerPubkey: async () => null, // not the owner Swarm
      write: write as never,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_owner_swarm');
    expect(write).not.toHaveBeenCalled();
  });

  it('sign throwing (key not held) maps to not_owner_swarm', async () => {
    const res = await authorHivePolicy({ workspaceId: WS, hiveHomeSlug: HOME, policy: {} }, {
      loadOwnerPubkey: async () => 'pk',
      readCurrent: async () => null,
      sign: async () => { throw new Error('hive private key not held'); },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_owner_swarm');
  });
});

describe('mutateHivePolicy (EN-3 ban/takedown write accessor)', () => {
  it('appends to moderation.bannedGithubIds while PRESERVING unknown keys + re-signs', async () => {
    const kp = generateEd25519KeypairDer();
    const { writes, write } = writeCapture();
    const current: ResolvedHivePolicy = {
      workspaceId: WS, hiveHomeSlug: HOME,
      policy: { membership: 'approval', moderation: { bannedGithubIds: ['1'] }, futureKnob: 'keep' },
      policyVersion: 2, ownerPubkey: kp.pubkeyBase64, signature: 's', policyJson: '{}', fedHlc: 'h', updatedAt: 1,
    };

    const res = await mutateHivePolicy({
      workspaceId: WS, hiveHomeSlug: HOME,
      mutate: (p) => ({ ...p, moderation: { ...p.moderation, bannedGithubIds: [...(p.moderation?.bannedGithubIds ?? []), '2'] } }),
    }, {
      readCurrent: async () => current,
      loadOwnerPubkey: async () => kp.pubkeyBase64,
      sign: async (_ws, _slug, bytes) => signWithPrivateKeyDer(kp.privateKeyDer, bytes),
      write,
    });

    expect(res.ok).toBe(true);
    const written = JSON.parse(writes[0].policyJson) as HivePolicy;
    expect(written.moderation?.bannedGithubIds).toEqual(['1', '2']);
    expect(written.futureKnob).toBe('keep'); // forward-compat preserved through the mutate
    expect(writes[0].policyVersion).toBe(3); // bumped from current 2
  });
});
