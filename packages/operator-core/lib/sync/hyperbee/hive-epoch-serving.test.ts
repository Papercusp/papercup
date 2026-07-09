/**
 * Tests for the re-key SERVING layer (Brief RE-KEY / Move 2, K's P4). Two tiers:
 *  - pure: deriveOpId determinism + sensitivity, buildOpAAD assembly (the part ed300's
 *    contract delegates to the serving layer — opId must be deterministic + stable).
 *  - integration: the serving wrappers against ed300's REAL createHiveEpochCrypto — a
 *    round-trip, plus the C-001 cut-off at the serving level (wrong-epoch key and a
 *    tampered (hive, epoch, op) both fail-closed on decrypt).
 *
 * Keychain is mocked in-memory (mirrors hive-epoch-crypto-impl.test.ts) so the test is
 * hermetic; sodium-native is real.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  deriveOpId,
  buildOpAAD,
  encryptOpPayload,
  decryptOpPayload,
  type OpIdentity,
} from './hive-epoch-serving';
import type { HiveEpochCrypto, EpochKey, OpAAD } from './hive-epoch-crypto';

const { mem } = vi.hoisted(() => ({ mem: new Map<string, Buffer>() }));
vi.mock('../../identity/keychain', () => ({
  keychainStore: async (id: string, der: Buffer) => {
    mem.set(id, der);
    return { kind: 'ok', value: undefined };
  },
  keychainLoad: async (id: string) =>
    mem.has(id) ? { kind: 'ok', value: mem.get(id)! } : { kind: 'error', error: { kind: 'not_found' } },
  keychainDelete: async (id: string) => {
    mem.delete(id);
    return { kind: 'ok', value: undefined };
  },
}));

const ID_A: OpIdentity = { tableTag: 'harness-features', rowKey: 'F-1', authorPubkey: 'pkA' };
const enc = (s: string) => new TextEncoder().encode(s);

describe('deriveOpId — deterministic + stable + sensitive', () => {
  it('identical inputs → identical id (cross-peer stability)', () => {
    expect(deriveOpId(ID_A)).toBe(deriveOpId({ ...ID_A }));
  });
  it('is a 64-char sha256 hex digest', () => {
    expect(deriveOpId(ID_A)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('differs on tableTag, rowKey, OR author (every field is bound)', () => {
    const base = deriveOpId(ID_A);
    expect(deriveOpId({ ...ID_A, tableTag: 'hive-settings' })).not.toBe(base);
    expect(deriveOpId({ ...ID_A, rowKey: 'F-2' })).not.toBe(base);
    expect(deriveOpId({ ...ID_A, authorPubkey: 'pkB' })).not.toBe(base);
  });
  it('normalizes null/undefined author to the same id', () => {
    const n: OpIdentity = { tableTag: 't', rowKey: 'k', authorPubkey: null };
    expect(deriveOpId(n)).toBe(deriveOpId({ ...n, authorPubkey: undefined }));
  });
});

describe('buildOpAAD — assembles {potId, epoch, opId}', () => {
  it('carries the derived opId + the passed hive/epoch', () => {
    const aad = buildOpAAD('hive-1', 3, ID_A);
    expect(aad).toEqual({ potId: 'hive-1', epoch: 3, opId: deriveOpId(ID_A) });
  });
});

describe('encrypt/decryptOpPayload pass the correct AAD (fake crypto)', () => {
  it('forwards buildOpAAD to the crypto on both encrypt + decrypt', async () => {
    const seen: OpAAD[] = [];
    const fake: HiveEpochCrypto = {
      deriveEpochKey: async () => new Uint8Array(32) as EpochKey,
      wrapKeyToMember: async () => new Uint8Array(),
      unwrapEpochKey: async () => new Uint8Array(32) as EpochKey,
      encryptOp: async (p, _k, ad) => { seen.push(ad); return p; },
      decryptOp: async (c, _k, ad) => { seen.push(ad); return c; },
    };
    const key = new Uint8Array(32) as EpochKey;
    const ctx = { potId: 'hive-9', epoch: 7, id: ID_A };
    await encryptOpPayload(fake, enc('x'), ctx, key);
    await decryptOpPayload(fake, enc('x'), ctx, key);
    const want = { potId: 'hive-9', epoch: 7, opId: deriveOpId(ID_A) };
    expect(seen[0]).toEqual(want);
    expect(seen[1]).toEqual(want); // encrypt + decrypt assemble the IDENTICAL AAD
  });
});

describe('serving round-trip + C-001 cut-off (real createHiveEpochCrypto)', () => {
  it('round-trips under the same epoch key, and fails-closed on wrong-epoch key or tampered AAD', async () => {
    const { createHiveEpochCrypto } = await import('./hive-epoch-crypto-impl');
    const c = createHiveEpochCrypto();
    const k1 = await c.deriveEpochKey('hive-1', 1);
    const ctx = { potId: 'hive-1', epoch: 1, id: ID_A };
    const payload = enc('secret feature body');

    const ct = await encryptOpPayload(c, payload, ctx, k1);
    expect(Buffer.from(ct).equals(Buffer.from(payload))).toBe(false); // actually encrypted
    const pt = await decryptOpPayload(c, ct, ctx, k1);
    expect(new TextDecoder().decode(pt)).toBe('secret feature body'); // round-trips

    // CUT-OFF 1: a different epoch's key (what a removed peer would be stuck with /
    // what an old-epoch holder has) cannot decrypt new-epoch content.
    const k2 = await c.deriveEpochKey('hive-1', 2);
    await expect(decryptOpPayload(c, ct, ctx, k2)).rejects.toBeTruthy();

    // CUT-OFF 2: tampered op-identity (different rowKey → different opId → different AAD)
    // fails closed, even with the right key.
    const tampered = { ...ctx, id: { ...ID_A, rowKey: 'F-EVIL' } };
    await expect(decryptOpPayload(c, ct, tampered, k1)).rejects.toBeTruthy();

    // CUT-OFF 3: tampered epoch in the AAD fails closed.
    await expect(decryptOpPayload(c, ct, { ...ctx, epoch: 2 }, k1)).rejects.toBeTruthy();
  });
});
