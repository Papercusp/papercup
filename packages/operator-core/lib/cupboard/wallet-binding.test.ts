import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  createWalletBindingChallenge,
  ethereumPersonalMessageDigest,
  normalizeEvmAddress,
  recoverEthereumAddress,
  verifyWalletBindingSignature,
} from './wallet-binding';

const privateKey = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
]);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function addressFor(key: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(key, false);
  return `0x${hex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
}

function sign(message: string, key = privateKey): string {
  const recovered = secp256k1.sign(ethereumPersonalMessageDigest(message), key, {
    prehash: false,
    format: 'recovered',
  });
  const ethereum = new Uint8Array(65);
  ethereum.set(recovered.subarray(1), 0);
  ethereum[64] = recovered[0] + 27;
  return `0x${hex(ethereum)}`;
}

const wallet = addressFor(privateKey);

describe('wallet-binding challenge', () => {
  it('binds the authenticated principal, wallet, expiry and server nonce into a SIWE-style message', () => {
    let fill = 0;
    const challenge = createWalletBindingChallenge({
      principalId: 'gh:123',
      walletAddress: wallet.toUpperCase().replace('0X', '0x'),
      domain: 'cupboard.test',
      chainId: 42161,
      nowMs: Date.parse('2026-09-05T20:00:00.000Z'),
      randomBytes(length) {
        return new Uint8Array(length).fill(++fill);
      },
    });

    expect(challenge.walletAddress).toBe(wallet);
    expect(challenge.challengeId).toBe(`wbc_${'01'.repeat(16)}`);
    expect(challenge.nonce).toBe('02'.repeat(16));
    expect(challenge.expiresAtMs - challenge.issuedAtMs).toBe(300_000);
    expect(challenge.message).toContain('cupboard.test wants you to sign in with your Ethereum account:');
    expect(challenge.message).toContain(`\n${wallet}\n`);
    expect(challenge.message).toContain('Chain ID: 42161');
    expect(challenge.message).toContain(`Nonce: ${'02'.repeat(16)}`);
    expect(challenge.message).toContain('Expiration Time: 2026-09-05T20:05:00.000Z');
    expect(challenge.message).toContain('urn:papercusp:principal:gh:123');
  });

  it('rejects non-address strings instead of treating an address as a principal lookup', () => {
    expect(normalizeEvmAddress('gh:123')).toBeNull();
    expect(() =>
      createWalletBindingChallenge({
        principalId: 'gh:123',
        walletAddress: 'alice@example.com',
        domain: 'cupboard.test',
      }),
    ).toThrow(/20-byte/);
  });
});

describe('EIP-191 wallet proof', () => {
  it('recovers and verifies the signing EVM address', () => {
    const challenge = createWalletBindingChallenge({
      principalId: 'gh:123',
      walletAddress: wallet,
      domain: 'cupboard.test',
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const signature = sign(challenge.message);
    expect(recoverEthereumAddress(challenge.message, signature)).toBe(wallet);
    expect(
      verifyWalletBindingSignature({
        message: challenge.message,
        signature,
        expectedAddress: wallet,
      }),
    ).toEqual({ ok: true, recoveredAddress: wallet });
  });

  it('refuses a signature for a different challenged wallet', () => {
    const otherKey = privateKey.slice();
    otherKey[31] = 2;
    const otherWallet = addressFor(otherKey);
    const message = 'bind exactly this challenge';
    expect(
      verifyWalletBindingSignature({
        message,
        signature: sign(message),
        expectedAddress: otherWallet,
      }),
    ).toMatchObject({ ok: false, code: 'address_mismatch', recoveredAddress: wallet });
  });

  it('refuses malformed recovery bytes and message tampering', () => {
    const message = 'bind exactly this challenge';
    const signature = sign(message);
    const invalidV = `${signature.slice(0, -2)}25`;
    expect(recoverEthereumAddress(message, invalidV)).toBeNull();
    expect(recoverEthereumAddress(`${message}!`, signature)).not.toBe(wallet);
  });
});
