/**
 * hive-unlist.test.ts — the signed withdrawal tombstone wire format
 * (hive-from-repo-hardening P-005 / D-005). Mirrors hive-announce.test.ts:
 * generated keypair, injected signer, tamper/freshness/shape matrix.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  HIVE_UNLIST_KIND,
  buildHiveUnlist,
  verifyHiveUnlist,
  isHiveUnlistFrame,
  DEFAULT_HIVE_UNLIST_WINDOW_MS,
  type HiveUnlistBody,
  type SignedHiveUnlist,
} from './hive-unlist';

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

const NOW = 1_700_000_000_000;
const signer =
  (privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) => (bytes: Buffer) =>
    Promise.resolve(nodeSign(null, bytes, privateKey));

function body(pubkey: string, over: Partial<HiveUnlistBody> = {}): HiveUnlistBody {
  return {
    kind: HIVE_UNLIST_KIND,
    hive_id: 'shop-hive',
    owner_device_pubkey: pubkey,
    ts: NOW,
    ...over,
  };
}

describe('hive-unlist wire format (P-005)', () => {
  it('builds + verifies a tombstone signed with a generated keypair', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveUnlist(body(rawPubkeyBase64(publicKey)), signer(privateKey));
    expect(verifyHiveUnlist(frame, { nowMs: NOW })).toBe(true);
    expect(isHiveUnlistFrame(frame)).toBe(true);
  });

  it('tampering with any signed field breaks verification', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveUnlist(body(rawPubkeyBase64(publicKey)), signer(privateKey));
    expect(verifyHiveUnlist({ ...frame, hive_id: 'other-hive' }, { nowMs: NOW })).toBe(false);
    expect(verifyHiveUnlist({ ...frame, ts: NOW + 1 }, { nowMs: NOW })).toBe(false);
  });

  it('a frame signed by a DIFFERENT key than the claimed pubkey fails', async () => {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const frame = await buildHiveUnlist(body(rawPubkeyBase64(a.publicKey)), signer(b.privateKey));
    expect(verifyHiveUnlist(frame, { nowMs: NOW })).toBe(false);
  });

  it('freshness: outside the ±window is rejected', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveUnlist(body(rawPubkeyBase64(publicKey)), signer(privateKey));
    expect(verifyHiveUnlist(frame, { nowMs: NOW + DEFAULT_HIVE_UNLIST_WINDOW_MS + 1 })).toBe(false);
  });

  it('shape rejections: wrong kind, missing fields, bad pubkey length', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveUnlist(body(rawPubkeyBase64(publicKey)), signer(privateKey));
    expect(verifyHiveUnlist({ ...frame, kind: 'hive-announce' } as never, { nowMs: NOW })).toBe(false);
    expect(verifyHiveUnlist({ ...frame, hive_id: '' }, { nowMs: NOW })).toBe(false);
    expect(
      verifyHiveUnlist({ ...frame, owner_device_pubkey: Buffer.alloc(16).toString('base64') }, { nowMs: NOW }),
    ).toBe(false);
    expect(isHiveUnlistFrame({ kind: 'something-else' } as unknown as SignedHiveUnlist)).toBe(false);
  });
});
