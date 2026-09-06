import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { compareGenerationVersion, isSignedProtocolContext, makeSignedProtocolContext, signedProtocolContextMatches, storeGenerationOrdinal, type SignedSnapshotFloor } from './signed-context';
import { acceptRefAnnouncement, refAnnounceSigningBytes, verifyRefAnnouncement, type SignedRefAnnouncement } from './ref-announce';
import { acceptFetchedSigrefs, sigrefsSigningBytes, verifySigrefs, type SignedSigrefs } from './sigrefs';
import { acceptStagingAdvance, signStagingAdvance, verifyStagingAdvance } from './staging-advance';
import { hiveEffectFixture } from './hive-effect-authority.fixture';

const { scope, authority } = hiveEffectFixture('gh-1303510992');
const generation = (ordinal: number, nonce = 'a') => `sg2-${ordinal}-${nonce.repeat(40)}`;
const context = (ordinal = 1, nonce = 'a') => makeSignedProtocolContext(scope.hive_id, scope.repo_key, generation(ordinal, nonce));
const key = generateEd25519KeypairDer();
const sign = async (bytes: Buffer) => signWithPrivateKeyDer(key.privateKeyDer, bytes);
const floor = (ordinal = 1, version = 90): SignedSnapshotFloor => ({ ...context(ordinal), version, sigrefs_oid: 'b'.repeat(40) });
async function announcement(ordinal = 1, version = 1): Promise<SignedRefAnnouncement> {
  const payload = { v: 2, device_pubkey: key.pubkeyBase64, sigrefs_oid: 'b'.repeat(40), version, ts: 100, ...context(ordinal) };
  return { ...payload, sig: (await sign(refAnnounceSigningBytes(payload))).toString('base64') };
}
async function snapshot(ordinal = 1, version = 1): Promise<SignedSigrefs> {
  const payload = { v: 3, device_pubkey: key.pubkeyBase64, version, ts: 100, refs: [], ...context(ordinal) };
  return { ...payload, sig: (await sign(sigrefsSigningBytes(payload))).toString('base64') };
}

describe('signed pot-git generation contract (P-513/F2)', () => {
  it('requires an actual persisted generation and validates its ordinal and scope', () => {
    expect(isSignedProtocolContext(context())).toBe(true);
    for (const value of ['', 'sg1-' + 'a'.repeat(64), generation(0), generation(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(storeGenerationOrdinal(value)).toBeNull();
      expect(() => makeSignedProtocolContext(scope.hive_id, scope.repo_key, value)).toThrow();
    }
    expect(isSignedProtocolContext({ ...context(), hive_id: 'bad\u0000id' })).toBe(false);
    expect(signedProtocolContextMatches(context(), { ...scope, repo_key: 'another' })).toBe(false);
    expect(signedProtocolContextMatches(context(2), scope)).toBe(true);
    expect(signedProtocolContextMatches(context(2), context(1))).toBe(false);
  });

  it('orders generation before sequence and rejects conflicting nonces at one ordinal', () => {
    expect(compareGenerationVersion({ ...context(2), version: 1 }, floor())).toBe(1);
    expect(compareGenerationVersion({ ...context(1), version: 999 }, floor(2))).toBe(-1);
    expect(compareGenerationVersion({ ...context(1, 'c'), version: 999 }, floor())).toBeNull();
    expect(compareGenerationVersion({ version: 999 }, floor())).toBe(-1);
  });

  it('allows a recreated store at sequence one, and rejects old-generation replays after restart', async () => {
    const prior = JSON.parse(JSON.stringify(floor())) as SignedSnapshotFloor;
    const fresh = await announcement(2);
    expect(acceptRefAnnouncement(fresh, { priorVersion: 90, replayFloor: prior, expectedContext: scope }).ok).toBe(true);
    expect(acceptFetchedSigrefs(await snapshot(2), key.pubkeyBase64, 90, { replayFloor: prior, expectedContext: scope }).ok).toBe(true);
    const next = { ...floor(2), version: 1 };
    expect(acceptRefAnnouncement(await announcement(1, 999), { priorVersion: 1, replayFloor: next, expectedContext: scope })).toMatchObject({ ok: false, reason: 'stale-generation' });
    expect(acceptFetchedSigrefs(await snapshot(1, 999), key.pubkeyBase64, 1, { replayFloor: next, expectedContext: scope })).toEqual({ ok: false, reason: 'stale-generation' });
    expect(acceptRefAnnouncement(fresh, { priorVersion: 1, replayFloor: next, expectedContext: scope })).toMatchObject({ ok: false, reason: 'stale-version' });
  });

  it('binds scope, device, generation and sequence in all three signatures', async () => {
    const ann = await announcement();
    const refs = await snapshot();
    const advance = await signStagingAdvance({ devicePubkeyBase64: key.pubkeyBase64, epoch: 3, seq: 1, stagingSha: 'c'.repeat(40), nowMs: 1, context: context(), authority }, sign);
    for (const change of [{ hive_id: 'different' }, { repo_key: 'other' }, { store_generation: generation(2) }, { device_pubkey: generateEd25519KeypairDer().pubkeyBase64 }]) {
      expect(verifyRefAnnouncement({ ...ann, ...change })).toBe(false);
      expect(verifySigrefs({ ...refs, ...change }, key.pubkeyBase64)).toBe(false);
      expect(verifyStagingAdvance({ ...advance, ...change })).toBe(false);
    }
    expect(verifyRefAnnouncement({ ...ann, version: 2 })).toBe(false);
    expect(verifySigrefs({ ...refs, version: 2 }, key.pubkeyBase64)).toBe(false);
    expect(verifyStagingAdvance({ ...advance, seq: 2 })).toBe(false);
    expect(acceptRefAnnouncement(ann, { priorVersion: null })).toMatchObject({ ok: false, reason: 'context-mismatch' });
  });

  it('requires explicit legacy negotiation and prevents downgrade after a scoped floor', async () => {
    const a = { ...(await announcement()), v: 1 };
    a.sig = (await sign(refAnnounceSigningBytes(a))).toString('base64');
    const s = { ...(await snapshot()), v: 1 };
    s.sig = (await sign(sigrefsSigningBytes(s))).toString('base64');
    const adv = await signStagingAdvance({ devicePubkeyBase64: key.pubkeyBase64, epoch: 1, seq: 1, stagingSha: 'c'.repeat(40), nowMs: 1 }, sign);
    expect(acceptRefAnnouncement(a, { priorVersion: null })).toMatchObject({ ok: false, reason: 'legacy-version' });
    expect(acceptFetchedSigrefs(s, key.pubkeyBase64, null)).toEqual({ ok: false, reason: 'legacy-version' });
    expect(acceptStagingAdvance(adv, null)).toEqual({ ok: false, reason: 'legacy-version' });
    expect(acceptRefAnnouncement(a, { priorVersion: null, allowLegacy: true }).ok).toBe(true);
    expect(acceptFetchedSigrefs(s, key.pubkeyBase64, null, { allowLegacy: true }).ok).toBe(true);
    expect(acceptStagingAdvance(adv, null, { allowLegacy: true }).ok).toBe(true);
    expect(acceptStagingAdvance(adv, null, { allowLegacy: true, knownStoreGenerations: { [key.pubkeyBase64]: generation(1) } }))
      .toEqual({ ok: false, reason: 'legacy-version' });
    expect(acceptRefAnnouncement(a, { priorVersion: null, allowLegacy: true, replayFloor: floor() })).toMatchObject({ ok: false, reason: 'legacy-version' });
    expect(acceptFetchedSigrefs(s, key.pubkeyBase64, null, { allowLegacy: true, replayFloor: floor() })).toEqual({ ok: false, reason: 'legacy-version' });
  });

  it('requires staging generation acceptance as well as the independent authority fence', async () => {
    const adv = await signStagingAdvance({ devicePubkeyBase64: key.pubkeyBase64, epoch: 3, seq: 100, stagingSha: 'c'.repeat(40), nowMs: 1, context: context(), authority }, sign);
    const opts = { expectedContext: scope, expectedDevice: key.pubkeyBase64, maxGrantedEpoch: 3 };
    expect(acceptStagingAdvance(adv, null, { ...opts, knownStoreGenerations: {} })).toEqual({ ok: false, reason: 'unknown-generation' });
    expect(acceptStagingAdvance(adv, null, { ...opts, knownStoreGenerations: { [key.pubkeyBase64]: generation(2) } })).toEqual({ ok: false, reason: 'stale-generation' });
    expect(acceptStagingAdvance(adv, { epoch: 4, seq: 0 }, { ...opts, knownStoreGenerations: { [key.pubkeyBase64]: generation(1) } })).toEqual({ ok: false, reason: 'stale-epoch-seq' });
    expect(acceptStagingAdvance(adv, null, { ...opts, knownStoreGenerations: { [key.pubkeyBase64]: generation(1) } })).toEqual({ ok: true });
  });
});
