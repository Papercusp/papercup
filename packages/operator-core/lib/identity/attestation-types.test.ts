import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_OAUTH_SCOPES,
  ATTESTATION_VERIFY_CACHE_TTL_MS,
  DEVICE_LABEL_MAX_LENGTH,
  attestationGistFilename,
  clampDeviceLabel,
  deriveDefaultDeviceLabel,
  hasAllAttestationScopes,
  missingAttestationScopes,
  type AttestationGistBody,
  type AttestationVerificationResult,
} from './attestation-types';

describe('ATTESTATION_OAUTH_SCOPES', () => {
  it('includes both gist and read:user per memo §1', () => {
    expect(ATTESTATION_OAUTH_SCOPES).toEqual(['gist', 'read:user']);
  });
});

describe('ATTESTATION_VERIFY_CACHE_TTL_MS', () => {
  it('is 24 hours per memo §"Cache hit/miss"', () => {
    expect(ATTESTATION_VERIFY_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('attestationGistFilename', () => {
  it('uses the 8-char pubkey prefix', () => {
    const pubkey = 'abcd1234efghIJKL5678';
    expect(attestationGistFilename(pubkey)).toBe('papercusp-device-binding-abcd1234.json');
  });
  it('handles short pubkeys without padding', () => {
    expect(attestationGistFilename('xyz')).toBe('papercusp-device-binding-xyz.json');
  });
  it('handles empty pubkey defensively', () => {
    expect(attestationGistFilename('')).toBe('papercusp-device-binding-.json');
  });
  it("maps base64 '/' and '+' in the prefix to the filename-safe alphabet (gist 422 bug)", () => {
    // A gist filename cannot contain '/'; raw base64 prefixes do ~11% of the time.
    expect(attestationGistFilename('ab/d+2zz9999')).toBe('papercusp-device-binding-ab_d-2zz.json');
    expect(attestationGistFilename('////++++rest')).toBe('papercusp-device-binding-____----.json');
  });
  it('NEVER produces a gist-invalid filename for a real Ed25519 pubkey (regression)', () => {
    const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto');
    for (let i = 0; i < 500; i++) {
      const { publicKey } = generateKeyPairSync('ed25519');
      const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
      const pubkeyBase64 = der.subarray(-32).toString('base64');
      const fn = attestationGistFilename(pubkeyBase64);
      // '/' is the hard 422 trigger; assert neither it nor raw '+' survive.
      expect(fn.includes('/'), `prefix of ${pubkeyBase64} produced '/' in ${fn}`).toBe(false);
      expect(fn.slice('papercusp-device-binding-'.length).includes('+')).toBe(false);
    }
  });
});

describe('hasAllAttestationScopes', () => {
  it('true when both scopes granted', () => {
    expect(hasAllAttestationScopes(new Set(['gist', 'read:user']))).toBe(true);
  });
  it('true when extra scopes granted', () => {
    expect(hasAllAttestationScopes(new Set(['gist', 'read:user', 'repo']))).toBe(true);
  });
  it('false when only read:user granted', () => {
    expect(hasAllAttestationScopes(new Set(['read:user']))).toBe(false);
  });
  it('false when only gist granted', () => {
    expect(hasAllAttestationScopes(new Set(['gist']))).toBe(false);
  });
  it('false when nothing granted', () => {
    expect(hasAllAttestationScopes(new Set())).toBe(false);
  });
});

describe('missingAttestationScopes', () => {
  it('empty array when both granted', () => {
    expect(missingAttestationScopes(new Set(['gist', 'read:user']))).toEqual([]);
  });
  it('lists gist when only read:user granted', () => {
    expect(missingAttestationScopes(new Set(['read:user']))).toEqual(['gist']);
  });
  it('lists read:user when only gist granted', () => {
    expect(missingAttestationScopes(new Set(['gist']))).toEqual(['read:user']);
  });
  it('lists both when nothing granted (preserves declaration order)', () => {
    expect(missingAttestationScopes(new Set())).toEqual(['gist', 'read:user']);
  });
});

describe('deriveDefaultDeviceLabel', () => {
  it('uses hostname-username when both present', () => {
    expect(
      deriveDefaultDeviceLabel({ hostname: 'macbook', username: 'alice', randomFallback: 'abc123' }),
    ).toBe('macbook-alice');
  });
  it('falls back to hostname when username missing', () => {
    expect(
      deriveDefaultDeviceLabel({ hostname: 'macbook', randomFallback: 'abc123' }),
    ).toBe('macbook');
  });
  it('falls back to random when hostname missing', () => {
    expect(
      deriveDefaultDeviceLabel({ username: 'alice', randomFallback: 'abc123' }),
    ).toBe('papercusp-abc123');
  });
  it('falls back to random when both missing', () => {
    expect(
      deriveDefaultDeviceLabel({ randomFallback: 'xyz789' }),
    ).toBe('papercusp-xyz789');
  });
  it('trims whitespace before deciding fallback', () => {
    expect(
      deriveDefaultDeviceLabel({ hostname: '  ', username: '\t\n', randomFallback: 'def456' }),
    ).toBe('papercusp-def456');
  });
});

describe('clampDeviceLabel', () => {
  it('passes through short labels', () => {
    expect(clampDeviceLabel('macbook-alice')).toBe('macbook-alice');
  });
  it('trims whitespace before clamping', () => {
    expect(clampDeviceLabel('   foo   ')).toBe('foo');
  });
  it('clamps labels exactly at the boundary', () => {
    const exact = 'a'.repeat(DEVICE_LABEL_MAX_LENGTH);
    expect(clampDeviceLabel(exact)).toBe(exact);
    expect(clampDeviceLabel(exact).length).toBe(DEVICE_LABEL_MAX_LENGTH);
  });
  it('truncates above the boundary', () => {
    const tooLong = 'a'.repeat(DEVICE_LABEL_MAX_LENGTH + 50);
    expect(clampDeviceLabel(tooLong).length).toBe(DEVICE_LABEL_MAX_LENGTH);
  });
  it('returns empty string for non-string input (defensive)', () => {
    // @ts-expect-error — testing runtime guard
    expect(clampDeviceLabel(null)).toBe('');
    // @ts-expect-error — testing runtime guard
    expect(clampDeviceLabel(undefined)).toBe('');
    // @ts-expect-error — testing runtime guard
    expect(clampDeviceLabel(123)).toBe('');
  });
});

describe('type-sanity construction', () => {
  it('AttestationGistBody can be constructed with the documented shape', () => {
    const body: AttestationGistBody = {
      version: 1,
      device_pubkey: 'AAAAC3NzaC1lZDI1NTE5AAAAIH+xyz==',
      device_label: 'macbook-alice',
      github_user_id: 12345,
      github_login: 'alice',
      created_at: 1779600000000,
      signature_by_device: 'ZmFrZXNpZ25hdHVyZQ==',
    };
    expect(body.version).toBe(1);
  });

  it('AttestationVerificationResult variants compose correctly', () => {
    const ok: AttestationVerificationResult = {
      valid: true,
      verifiedAt: Date.now(),
      resolvedGithubUserId: 12345,
    };
    const fail: AttestationVerificationResult = {
      valid: false,
      reason: 'signature_invalid',
      verifiedAt: Date.now(),
    };
    expect(ok.valid).toBe(true);
    expect(fail.reason).toBe('signature_invalid');
  });
});
