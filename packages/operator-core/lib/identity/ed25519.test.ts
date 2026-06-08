/**
 * ed25519 — the shared Ed25519 helpers extracted from attest.ts so the device
 * key (attest.ts) and the hive key (hive-keypair.ts) share byte-compatible
 * crypto (shared-hive-federation-2026-06-08 P-002). Pure crypto, no I/O.
 */

import { describe, it, expect } from 'vitest';
import { createPublicKey } from 'node:crypto';
import {
  generateEd25519KeypairDer,
  pubkeyBase64FromDer,
  pubkeyBase64FromPrivate,
  privateKeyFromDer,
  publicKeyFromRaw,
  rawPubkeyBase64,
  buildSpkiDerFromRawPubkey,
  signWithPrivateKeyDer,
  verifyEd25519,
} from './ed25519';

describe('ed25519', () => {
  it('generateEd25519KeypairDer yields a 32-byte raw pubkey (b64) + a loadable PKCS8 DER', () => {
    const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
    expect(Buffer.from(pubkeyBase64, 'base64')).toHaveLength(32);
    expect(() => privateKeyFromDer(privateKeyDer)).not.toThrow();
  });

  it('two keypairs differ', () => {
    expect(generateEd25519KeypairDer().pubkeyBase64).not.toBe(generateEd25519KeypairDer().pubkeyBase64);
  });

  it('pubkey extraction is stable + agrees across the DER and KeyObject paths', () => {
    const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
    expect(pubkeyBase64FromDer(privateKeyDer)).toBe(pubkeyBase64);
    expect(pubkeyBase64FromPrivate(privateKeyFromDer(privateKeyDer))).toBe(pubkeyBase64);
  });

  it('sign → verify round-trips; tamper / wrong-key / bad-sig / malformed-key all return false (no throw)', () => {
    const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
    const msg = Buffer.from('the hive identity payload');
    const sig = signWithPrivateKeyDer(privateKeyDer, msg);
    expect(sig).toHaveLength(64);
    expect(verifyEd25519(msg, pubkeyBase64, sig)).toBe(true);

    // tampered message
    expect(verifyEd25519(Buffer.from('the hive identity payloaD'), pubkeyBase64, sig)).toBe(false);
    // wrong key
    expect(verifyEd25519(msg, generateEd25519KeypairDer().pubkeyBase64, sig)).toBe(false);
    // garbage signature
    expect(verifyEd25519(msg, pubkeyBase64, Buffer.alloc(64))).toBe(false);
    // malformed pubkey → false, never throws
    expect(verifyEd25519(msg, 'not-a-valid-32-byte-key', sig)).toBe(false);
  });

  it('buildSpkiDerFromRawPubkey is 44 bytes + round-trips through publicKeyFromRaw / node SPKI', () => {
    const { pubkeyBase64 } = generateEd25519KeypairDer();
    const raw = Buffer.from(pubkeyBase64, 'base64');
    const spki = buildSpkiDerFromRawPubkey(raw);
    expect(spki).toHaveLength(44);

    expect(rawPubkeyBase64(publicKeyFromRaw(raw))).toBe(pubkeyBase64);
    // our hand-built SPKI loads identically to node's own
    const nodePub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(rawPubkeyBase64(nodePub)).toBe(pubkeyBase64);
  });

  it('buildSpkiDerFromRawPubkey rejects a wrong-length key', () => {
    expect(() => buildSpkiDerFromRawPubkey(Buffer.alloc(31))).toThrow(/32-byte/);
    expect(() => buildSpkiDerFromRawPubkey(Buffer.alloc(33))).toThrow(/32-byte/);
  });
});
