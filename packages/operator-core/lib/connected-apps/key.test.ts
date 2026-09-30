/**
 * key.test.ts — app-key minting, parsing and hash comparison
 * (external-app-access-to-workspaces-2026-09-29 P-002; R-8 unit half).
 *
 * The integration half (store.integration.test.ts) proves what reaches the
 * database; this file proves the pure functions it relies on: a key has one
 * parseable shape, the stored digest is sha256 of the whole key, and the digest
 * comparison refuses every near-miss.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_KEY_ID_LENGTH,
  APP_KEY_PREFIX,
  appKeyHashMatches,
  hashAppKey,
  isAppKeyShaped,
  mintAppKey,
  newAppKeyId,
  parseAppKey,
} from './key';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('mintAppKey', () => {
  it('produces pcapp_<16-char id>_<43-char base64url secret>', () => {
    const { id, key } = mintAppKey();
    expect(key.startsWith(APP_KEY_PREFIX)).toBe(true);
    expect(id).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(key).toMatch(/^pcapp_[A-Za-z0-9]{16}_[A-Za-z0-9_-]{43}$/);
    expect(key.slice(APP_KEY_PREFIX.length, APP_KEY_PREFIX.length + APP_KEY_ID_LENGTH)).toBe(id);
  });

  it('stores sha256(full key) as lowercase hex, and that digest does not contain the secret', () => {
    const { key, tokenHash } = mintAppKey();
    expect(tokenHash).toBe(sha256(key));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const secret = parseAppKey(key)!.secret;
    expect(tokenHash.includes(secret)).toBe(false);
  });

  it('mints distinct ids and keys', () => {
    const minted = Array.from({ length: 200 }, () => mintAppKey());
    expect(new Set(minted.map((m) => m.id)).size).toBe(200);
    expect(new Set(minted.map((m) => m.key)).size).toBe(200);
    expect(new Set(Array.from({ length: 200 }, () => newAppKeyId())).size).toBe(200);
  });
});

describe('parseAppKey', () => {
  it('round-trips a minted key', () => {
    const { id, key } = mintAppKey();
    const parsed = parseAppKey(key);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(id);
    expect(`${APP_KEY_PREFIX}${parsed!.id}_${parsed!.secret}`).toBe(key);
  });

  it('parses a secret that itself contains _ (the id is fixed-length)', () => {
    const secret = `${'a'.repeat(20)}_${'b'.repeat(22)}`;
    expect(secret).toHaveLength(43);
    const parsed = parseAppKey(`pcapp_ABCDEFGH12345678_${secret}`);
    expect(parsed).toEqual({ id: 'ABCDEFGH12345678', secret });
  });

  it.each([
    ['wrong prefix', `pcap_ABCDEFGH12345678_${'a'.repeat(43)}`],
    ['no prefix (a device JWT)', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'],
    ['id too short', `pcapp_ABCDEFGH1234567_${'a'.repeat(43)}`],
    ['id too long', `pcapp_ABCDEFGH123456789_${'a'.repeat(43)}`],
    ['id with a non-alphanumeric', `pcapp_ABCDEFGH1234567-_${'a'.repeat(43)}`],
    ['secret too short', `pcapp_ABCDEFGH12345678_${'a'.repeat(42)}`],
    ['secret too long', `pcapp_ABCDEFGH12345678_${'a'.repeat(44)}`],
    ['secret with padding', `pcapp_ABCDEFGH12345678_${'a'.repeat(42)}=`],
    ['empty', ''],
  ])('refuses %s', (_label, token) => {
    expect(parseAppKey(token)).toBeNull();
  });
});

describe('isAppKeyShaped', () => {
  it('claims every pcapp_ bearer, well-formed or not, and nothing else', () => {
    expect(isAppKeyShaped(mintAppKey().key)).toBe(true);
    expect(isAppKeyShaped('pcapp_garbage')).toBe(true);
    expect(isAppKeyShaped('eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(false);
    expect(isAppKeyShaped('')).toBe(false);
    expect(isAppKeyShaped(null)).toBe(false);
    expect(isAppKeyShaped(undefined)).toBe(false);
  });
});

describe('appKeyHashMatches', () => {
  it('accepts the key its digest was taken from', () => {
    const { key, tokenHash } = mintAppKey();
    expect(appKeyHashMatches(key, tokenHash)).toBe(true);
    expect(hashAppKey(key)).toBe(tokenHash);
  });

  it('refuses the right id with a different secret', () => {
    const a = mintAppKey();
    const forged = `${APP_KEY_PREFIX}${a.id}_${'x'.repeat(43)}`;
    expect(appKeyHashMatches(forged, a.tokenHash)).toBe(false);
  });

  it('refuses another key, and a missing or malformed stored digest', () => {
    const a = mintAppKey();
    const b = mintAppKey();
    expect(appKeyHashMatches(b.key, a.tokenHash)).toBe(false);
    expect(appKeyHashMatches(a.key, null)).toBe(false);
    expect(appKeyHashMatches(a.key, undefined)).toBe(false);
    expect(appKeyHashMatches(a.key, '')).toBe(false);
    expect(appKeyHashMatches(a.key, a.tokenHash.toUpperCase())).toBe(false);
    expect(appKeyHashMatches(a.key, a.tokenHash.slice(0, 63))).toBe(false);
  });

  it('refuses when the stored value is the key itself rather than its digest', () => {
    const { key } = mintAppKey();
    expect(appKeyHashMatches(key, key)).toBe(false);
  });
});
