/**
 * announce.test.ts — signed peer announce wire-format (Model B substrate, Stage 3).
 *
 * The announce binds a peer's Hypercore log to a device identity:
 *   { device_pubkey, github_user_id, github_login, log_core_key, sig }
 *
 * Crypto contract (Stage-0 spike, run-verified): Node-crypto Ed25519,
 * `sign(null, …)` / `verify(null, …)`, with the device pubkey represented as
 * the RAW 32-byte key, base64-encoded — the SAME string convention as the
 * binding's `device_pubkey` (attest.ts / two-channel-verifier.ts). These tests
 * generate a Node Ed25519 keypair (no live keychain) and inject the signer.
 *
 * Covered:
 *  - round-trip: build with a generated keypair → verifyAnnounce → true;
 *  - device_pubkey in the body is the raw-32-byte-base64 form (binding convention);
 *  - tamper a signed field (log_core_key / github_login) → verifyAnnounce → false;
 *  - a sig that doesn't match the body → false;
 *  - bad-shape / malformed frames → false (never throws).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  announceSigningBytes,
  buildAnnounce,
  verifyAnnounce,
  type AnnounceBody,
  type SignedAnnounce,
} from './announce';

/** Raw 32-byte Ed25519 pubkey, base64 — the binding's device_pubkey convention. */
function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

function makeBody(pubkeyBase64: string): AnnounceBody {
  return {
    device_pubkey: pubkeyBase64,
    github_user_id: 4242,
    github_login: 'alice',
    log_core_key: 'a'.repeat(64), // 64-hex hypercore key shape
  };
}

describe('announce', () => {
  it('builds + verifies a round-trip announce signed with a generated keypair', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubkeyBase64 = rawPubkeyBase64(publicKey);
    const body = makeBody(pubkeyBase64);

    const frame = await buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));

    // device_pubkey is the raw-32-byte-base64 form (matches the binding convention).
    expect(Buffer.from(frame.device_pubkey, 'base64').length).toBe(32);
    expect(frame.device_pubkey).toBe(pubkeyBase64);
    // sig is base64 of a 64-byte Ed25519 signature.
    expect(Buffer.from(frame.sig, 'base64').length).toBe(64);

    expect(verifyAnnounce(frame)).toBe(true);
  });

  it('signing bytes exclude sig and are deterministic + field-ordered', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));

    // signing bytes of the body == signing bytes derived from the signed frame
    expect(announceSigningBytes(body).equals(announceSigningBytes(frame))).toBe(true);
    // they do not contain the signature
    expect(announceSigningBytes(frame).toString('utf8')).not.toContain('sig');
    // fixed field order: device_pubkey, github_user_id, github_login, log_core_key
    expect(announceSigningBytes(body).toString('utf8')).toBe(
      JSON.stringify({
        device_pubkey: body.device_pubkey,
        github_user_id: body.github_user_id,
        github_login: body.github_login,
        log_core_key: body.log_core_key,
      }),
    );
  });

  it('rejects a tampered signed field (log_core_key)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));

    const tampered: SignedAnnounce = { ...frame, log_core_key: 'b'.repeat(64) };
    expect(verifyAnnounce(tampered)).toBe(false);
  });

  it('rejects a tampered signed field (github_login)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));

    const tampered: SignedAnnounce = { ...frame, github_login: 'mallory' };
    expect(verifyAnnounce(tampered)).toBe(false);
  });

  it('rejects a sig that does not match the body (different key)', async () => {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(a.publicKey));
    // Sign the body with B's private key but claim A's pubkey in the frame.
    const frame = await buildAnnounce(body, async (bytes) => nodeSign(null, bytes, b.privateKey));

    expect(verifyAnnounce(frame)).toBe(false);
  });

  it('rejects a garbage / mismatched signature', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));

    expect(verifyAnnounce({ ...frame, sig: Buffer.alloc(64).toString('base64') })).toBe(false);
    expect(verifyAnnounce({ ...frame, sig: 'not-base64-but-still-a-string!!' })).toBe(false);
  });

  it('returns false on bad-shape frames instead of throwing', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pubkeyBase64 = rawPubkeyBase64(publicKey);

    // device_pubkey that is not 32 raw bytes
    expect(
      verifyAnnounce({
        device_pubkey: Buffer.from('short').toString('base64'),
        github_user_id: 1,
        github_login: 'x',
        log_core_key: 'a'.repeat(64),
        sig: Buffer.alloc(64).toString('base64'),
      }),
    ).toBe(false);

    // missing fields entirely
    expect(verifyAnnounce({} as unknown as SignedAnnounce)).toBe(false);
    expect(verifyAnnounce(null as unknown as SignedAnnounce)).toBe(false);
    expect(
      verifyAnnounce({ device_pubkey: pubkeyBase64 } as unknown as SignedAnnounce),
    ).toBe(false);
  });
});
