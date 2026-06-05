import { describe, expect, it } from 'vitest';
import {
  CHANNEL2_PROPAGATION_GRACE_WINDOW_MS,
  CONTRIBUTORS_DIR,
  CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER,
  CONTRIBUTOR_FILE_VERSION,
  GITHUB_LOGIN_MAX_LENGTH,
  SUPPORTED_DEVICE_PUBKEY_ALGORITHMS,
  contributorBranchRef,
  contributorFilePath,
  formatDevicePubkeySpec,
  isContributorFileBody,
  isSafeGithubLoginSegment,
  parseDevicePubkeySpec,
  type ContributorFileBody,
} from './contributor-file-types';

const baseBody: ContributorFileBody = {
  version: 1,
  github_user_id: 12345,
  github_login: 'alice',
  device_pubkey: 'ed25519:AABBCCDDEEFF',
  device_attestation_gist_id: 'abc123def456',
  joined_at: '2026-05-24T18:00:00Z',
  signature_by_device: 'sig-base64url',
};

describe('CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER', () => {
  it('is JCS-compliant ascending unicode-codepoint sort', () => {
    const sorted = [...CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER].sort();
    expect(CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER).toEqual(sorted);
  });

  it('covers every ContributorFileBody field exactly once', () => {
    const fields = Object.keys(baseBody).sort();
    const order = [...CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER].sort();
    expect(order).toEqual(fields);
  });

  it('matches CONTRIBUTOR_FILE_VERSION as a stable v1 constant', () => {
    expect(CONTRIBUTOR_FILE_VERSION).toBe(1);
  });
});

describe('parseDevicePubkeySpec', () => {
  it('accepts a well-formed ed25519 spec', () => {
    const r = parseDevicePubkeySpec('ed25519:AABBCC_-');
    expect(r).toEqual({ alg: 'ed25519', keyBase64Url: 'AABBCC_-' });
  });

  it('rejects an unknown algorithm tag', () => {
    expect(parseDevicePubkeySpec('rsa:something')).toBeNull();
    expect(parseDevicePubkeySpec('ed448:AABBCC')).toBeNull();
  });

  it('rejects missing colon', () => {
    expect(parseDevicePubkeySpec('ed25519AABBCC')).toBeNull();
  });

  it('rejects empty algorithm or key', () => {
    expect(parseDevicePubkeySpec(':AABBCC')).toBeNull();
    expect(parseDevicePubkeySpec('ed25519:')).toBeNull();
  });

  it('rejects non-base64url chars in key portion', () => {
    expect(parseDevicePubkeySpec('ed25519:AABB==')).toBeNull(); // padding not allowed in base64url
    expect(parseDevicePubkeySpec('ed25519:AA+BB')).toBeNull(); // standard-base64 + not allowed
    expect(parseDevicePubkeySpec('ed25519:AA BB')).toBeNull();
  });

  it('rejects non-string input', () => {
    // @ts-expect-error — testing defensive behavior on bad runtime input
    expect(parseDevicePubkeySpec(null)).toBeNull();
    // @ts-expect-error
    expect(parseDevicePubkeySpec(123)).toBeNull();
  });

  it('round-trips with formatDevicePubkeySpec', () => {
    const spec = formatDevicePubkeySpec('ed25519', 'XYZabc-_');
    expect(parseDevicePubkeySpec(spec)).toEqual({ alg: 'ed25519', keyBase64Url: 'XYZabc-_' });
  });
});

describe('SUPPORTED_DEVICE_PUBKEY_ALGORITHMS', () => {
  it('includes ed25519 as the v1 algorithm', () => {
    expect(SUPPORTED_DEVICE_PUBKEY_ALGORITHMS).toContain('ed25519');
  });
});

describe('contributorFilePath', () => {
  it('builds the canonical path', () => {
    expect(contributorFilePath('alice')).toBe('.papercusp/contributors/alice.json');
  });

  it('uses CONTRIBUTORS_DIR as the prefix', () => {
    expect(contributorFilePath('bob').startsWith(CONTRIBUTORS_DIR + '/')).toBe(true);
  });
});

describe('contributorBranchRef', () => {
  it('builds the canonical user/<id> form', () => {
    expect(contributorBranchRef(12345)).toBe('user/12345');
    expect(contributorBranchRef(1)).toBe('user/1');
  });

  it('rejects non-positive or non-integer ids', () => {
    expect(() => contributorBranchRef(0)).toThrow(TypeError);
    expect(() => contributorBranchRef(-1)).toThrow(TypeError);
    expect(() => contributorBranchRef(1.5)).toThrow(TypeError);
    // @ts-expect-error — defensive against bad runtime input
    expect(() => contributorBranchRef('12345')).toThrow(TypeError);
  });
});

describe('isSafeGithubLoginSegment', () => {
  it('accepts well-formed GitHub logins', () => {
    expect(isSafeGithubLoginSegment('alice')).toBe(true);
    expect(isSafeGithubLoginSegment('alice-bob')).toBe(true);
    expect(isSafeGithubLoginSegment('user1')).toBe(true);
    expect(isSafeGithubLoginSegment('a')).toBe(true);
    expect(isSafeGithubLoginSegment('a'.repeat(GITHUB_LOGIN_MAX_LENGTH))).toBe(true);
  });

  it('rejects path-escape attempts', () => {
    expect(isSafeGithubLoginSegment('../etc')).toBe(false);
    expect(isSafeGithubLoginSegment('a/b')).toBe(false);
    expect(isSafeGithubLoginSegment('a\\b')).toBe(false);
    expect(isSafeGithubLoginSegment('.')).toBe(false);
    expect(isSafeGithubLoginSegment('..')).toBe(false);
  });

  it('rejects GitHub-disallowed shapes', () => {
    expect(isSafeGithubLoginSegment('-alice')).toBe(false);
    expect(isSafeGithubLoginSegment('alice-')).toBe(false);
    expect(isSafeGithubLoginSegment('al--ice')).toBe(false);
    expect(isSafeGithubLoginSegment('')).toBe(false);
  });

  it('rejects over-length logins', () => {
    expect(isSafeGithubLoginSegment('a'.repeat(GITHUB_LOGIN_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error
    expect(isSafeGithubLoginSegment(null)).toBe(false);
    // @ts-expect-error
    expect(isSafeGithubLoginSegment(undefined)).toBe(false);
    // @ts-expect-error
    expect(isSafeGithubLoginSegment(123)).toBe(false);
  });

  it('rejects underscores (not in GitHub login alphabet)', () => {
    expect(isSafeGithubLoginSegment('alice_bob')).toBe(false);
  });
});

describe('isContributorFileBody', () => {
  it('accepts a well-formed body', () => {
    expect(isContributorFileBody(baseBody)).toBe(true);
  });

  it('rejects wrong version', () => {
    expect(isContributorFileBody({ ...baseBody, version: 2 as unknown as 1 })).toBe(false);
    expect(isContributorFileBody({ ...baseBody, version: '1' })).toBe(false);
  });

  it('rejects non-positive or non-integer github_user_id', () => {
    expect(isContributorFileBody({ ...baseBody, github_user_id: 0 })).toBe(false);
    expect(isContributorFileBody({ ...baseBody, github_user_id: -1 })).toBe(false);
    expect(isContributorFileBody({ ...baseBody, github_user_id: 1.5 })).toBe(false);
    expect(isContributorFileBody({ ...baseBody, github_user_id: '12345' as unknown as number })).toBe(false);
  });

  it('rejects empty required strings', () => {
    expect(isContributorFileBody({ ...baseBody, github_login: '' })).toBe(false);
    expect(isContributorFileBody({ ...baseBody, device_pubkey: '' })).toBe(false);
    expect(isContributorFileBody({ ...baseBody, device_attestation_gist_id: '' })).toBe(false);
    expect(isContributorFileBody({ ...baseBody, joined_at: '' })).toBe(false);
    expect(isContributorFileBody({ ...baseBody, signature_by_device: '' })).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isContributorFileBody(null)).toBe(false);
    expect(isContributorFileBody(undefined)).toBe(false);
    expect(isContributorFileBody('not an object')).toBe(false);
    expect(isContributorFileBody(42)).toBe(false);
  });

  it('rejects extra unexpected fields silently (forward-compat note: shape check is "has-all", extras allowed)', () => {
    // JCS over an unexpected-key set would diverge from the signing party,
    // so the shape check intentionally only validates KNOWN required fields.
    // The verifier rejects extras separately based on
    // CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER, not here.
    expect(isContributorFileBody({ ...baseBody, extra_field: 'whatever' })).toBe(true);
  });
});

describe('CHANNEL2_PROPAGATION_GRACE_WINDOW_MS', () => {
  it('is 24h', () => {
    expect(CHANNEL2_PROPAGATION_GRACE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
