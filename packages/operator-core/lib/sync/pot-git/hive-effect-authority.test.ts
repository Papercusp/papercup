import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { nextHivePublicationTerm, requireHiveEffectAuthority, type HiveEffectAuthority } from './hive-effect-authority';
import { acceptStagingAdvance, signStagingAdvance } from './staging-advance';
import { electFleetLeader } from '../../p2p/fleet-leader-election';

function key() {
  const k = generateEd25519KeypairDer();
  return { pubkey: k.pubkeyBase64, sign: async (b: Buffer) => signWithPrivateKeyDer(k.privateKeyDer, b) };
}

describe('single owning hive authority (F6)', () => {
  it('divergent same-membership-epoch winners cannot both authorize canonical advances', async () => {
    const owner = key(); const a = key(); const b = key();
    const scope = { hive_id: owner.pubkey, repo_key: 'repo' };
    const context = { ...scope, store_generation: 'sg2-1-' + 'a'.repeat(40) };
    const authority: HiveEffectAuthority = { ...scope, sign: owner.sign };
    for (const device of [a, b]) {
      expect(electFleetLeader({ scope: { ownerGithubUserId: 1, slug: 'fleet' }, rosterMemberUids: new Set([1]),
        rosterEpoch: 7, presence: [], self: { devicePubkey: device.pubkey, githubUserId: 1 },
        incumbent: null, nowMs: 1000, staleMs: 90_000, leaseMs: 30_000 }).isSelf).toBe(true);
    }
    const fields = { epoch: 1, seq: 1, stagingSha: 'a'.repeat(40), nowMs: 1000, context };
    const authorized = await signStagingAdvance({ ...fields, devicePubkeyBase64: a.pubkey, authority }, a.sign);
    const selfElected = await signStagingAdvance({ ...fields, devicePubkeyBase64: b.pubkey, epoch: 999 }, b.sign);
    const opts = { expectedContext: scope, allowedDevices: [a.pubkey, b.pubkey] };
    expect(acceptStagingAdvance(authorized, null, opts)).toEqual({ ok: true });
    expect(acceptStagingAdvance(selfElected, null, opts)).toEqual({ ok: false, reason: 'missing-hive-authority' });
    expect(acceptStagingAdvance({ ...selfElected, v: 3, hive_sig: authorized.hive_sig }, null, opts).ok).toBe(false);
    expect(acceptStagingAdvance(authorized, null, { ...opts, expectedContext: { ...scope, repo_key: 'other' } }).ok).toBe(false);
    expect(acceptStagingAdvance(authorized, { epoch: 1, seq: 1 }, opts).ok).toBe(false);
  });

  it('refuses absent, device-signed, captured and cross-scope sink authorizations', async () => {
    const owner = key(); const peer = key();
    const scope = { hive_id: owner.pubkey, repo_key: 'repo' };
    await expect(requireHiveEffectAuthority(null, scope, ['push'])).rejects.toThrow('owning hive key');
    await expect(requireHiveEffectAuthority({ ...scope, sign: peer.sign }, scope, ['push'])).rejects.toThrow();
    const authority = { ...scope, sign: owner.sign };
    await expect(requireHiveEffectAuthority(authority, { ...scope, repo_key: 'other' }, ['push'])).rejects.toThrow();
    let captured!: Buffer;
    await requireHiveEffectAuthority({ ...scope, sign: async bytes => (captured = await owner.sign(bytes)) }, scope, ['push']);
    await expect(requireHiveEffectAuthority({ ...scope, sign: async () => captured }, scope, ['push'])).rejects.toThrow();
    await expect(requireHiveEffectAuthority(authority, scope, ['push'])).resolves.toBeUndefined();
  });

  it('advances owner publication term on identity/generation change, independently of membership', () => {
    const prior = { epoch: 4, seq: 8, authorityDevice: 'a', storeGeneration: 'g1' };
    expect(nextHivePublicationTerm(prior, 'a', 'g1')).toEqual({ epoch: 4, priorSeq: 8 });
    expect(nextHivePublicationTerm(prior, 'b', 'g1')).toEqual({ epoch: 5, priorSeq: 0 });
    expect(nextHivePublicationTerm(prior, 'a', 'g2')).toEqual({ epoch: 5, priorSeq: 0 });
    expect(() => nextHivePublicationTerm({ ...prior, epoch: Number.MAX_SAFE_INTEGER }, 'b', 'g1')).toThrow();
  });
});
