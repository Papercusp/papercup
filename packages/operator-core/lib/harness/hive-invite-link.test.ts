/**
 * hive-invite-link.test.ts — the `papercusp://pot?...` invite artifact
 * (hive-from-repo-hardening-2026-06-11 P-006 / D-006). Round-trip + the
 * strict malformed matrix (null on anything off-shape, never a throw).
 */
import { describe, it, expect } from 'vitest';
import {
  formatHiveInviteLink,
  parseHiveInviteLink,
  isValidHivePubkeyBase64,
  HIVE_INVITE_TITLE_MAX,
} from './hive-invite-link';

const PUBKEY = Buffer.alloc(32, 7).toString('base64'); // canonical 32-byte base64
const SECRET = 'a1b2c3d4e5f60718a1b2c3d4e5f60718'; // 32 hex chars

describe('formatHiveInviteLink ↔ parseHiveInviteLink round-trip', () => {
  it('round-trips the full artifact (pubkey + secret + title)', () => {
    const link = formatHiveInviteLink({ pubkeyBase64: PUBKEY, secret: SECRET, title: 'Acme Shop' });
    expect(link.startsWith('papercusp://pot?')).toBe(true);
    expect(parseHiveInviteLink(link)).toEqual({
      secret: SECRET,
      pubkeyBase64: PUBKEY,
      title: 'Acme Shop',
    });
  });

  it('round-trips a secret-only link (pubkey unknown on the minting surface)', () => {
    const link = formatHiveInviteLink({ secret: SECRET });
    expect(parseHiveInviteLink(link)).toEqual({ secret: SECRET });
  });

  it('round-trips a secret + title link without a pubkey', () => {
    const link = formatHiveInviteLink({ secret: SECRET, title: 'shop-hive' });
    expect(parseHiveInviteLink(link)).toEqual({ secret: SECRET, title: 'shop-hive' });
  });

  it('percent-encodes and restores titles with spaces/unicode and base64 +/= chars', () => {
    // A pubkey whose base64 carries '+' and '/' — must survive URL encoding.
    const spicy = Buffer.from(
      Array.from({ length: 32 }, (_, i) => (i * 41 + 250) % 256),
    ).toString('base64');
    expect(isValidHivePubkeyBase64(spicy)).toBe(true);
    const title = 'Über Hive — shop & docs / v2';
    const link = formatHiveInviteLink({ pubkeyBase64: spicy, secret: SECRET, title });
    expect(parseHiveInviteLink(link)).toEqual({ secret: SECRET, pubkeyBase64: spicy, title });
  });

  it('clamps an over-long title at format time so the artifact still parses', () => {
    const link = formatHiveInviteLink({ secret: SECRET, title: 'x'.repeat(500) });
    const parsed = parseHiveInviteLink(link);
    expect(parsed?.title).toBe('x'.repeat(HIVE_INVITE_TITLE_MAX));
  });

  it('preserves the secret verbatim (case + length variants within 32–128 hex)', () => {
    // 32-hex (128-bit) floor cases + the 128-hex ceiling; mixed case preserved.
    for (const s of ['DEADBEEFDEADBEEFDEADBEEFDEADBEEF', 'a'.repeat(128), 'AbCd1234EfAb5678AbCd1234EfAb5678']) {
      expect(parseHiveInviteLink(formatHiveInviteLink({ secret: s }))).toEqual({ secret: s });
    }
  });

  // WAVE-4 X-1 (invite-secret strength): the accept-floor is 32 hex (128 bits),
  // raised from 16 (64 bits) to match the 256-bit minting. Defense-in-depth.
  it('X-1: accepts exactly 32 hex (128-bit floor) but REJECTS 31 hex and the old 16-hex floor', () => {
    expect(parseHiveInviteLink(formatHiveInviteLink({ secret: 'a'.repeat(32) }))).not.toBeNull(); // 128-bit ok
    expect(parseHiveInviteLink(`papercusp://pot?secret=${'a'.repeat(31)}`)).toBeNull(); // one under the floor
    expect(parseHiveInviteLink(`papercusp://pot?secret=${'deadbeef'.repeat(2)}`)).toBeNull(); // 16 hex (old floor) now rejected
    expect(parseHiveInviteLink(formatHiveInviteLink({ secret: 'a'.repeat(64) }))).not.toBeNull(); // the real 256-bit minted length
  });
});

describe('parseHiveInviteLink — malformed matrix (null, never throw)', () => {
  const valid = formatHiveInviteLink({ pubkeyBase64: PUBKEY, secret: SECRET, title: 't' });

  it.each([
    ['not a string', undefined as unknown as string],
    ['empty string', ''],
    ['not a url', 'not a url'],
    ['wrong scheme', `https://hive?secret=${SECRET}`],
    ['wrong host (harness)', `papercusp://harness?secret=${SECRET}`],
    ['wrong host (pots)', `papercusp://pots?secret=${SECRET}`],
    ['old host (hive) now rejected', `papercusp://hive?secret=${SECRET}`],
    ['missing secret', `papercusp://pot?pubkey=${encodeURIComponent(PUBKEY)}`],
    ['empty secret', 'papercusp://pot?secret='],
    ['secret too short (<32)', 'papercusp://pot?secret=abcdef0123'],
    ['secret too long (>128)', `papercusp://pot?secret=${'a'.repeat(129)}`],
    ['secret not hex', `papercusp://pot?secret=${'g'.repeat(32)}`],
    ['extra param', `${valid}&evil=1`],
    ['duplicated secret param', `papercusp://pot?secret=${SECRET}&secret=${SECRET}`],
    ['pubkey not base64', `papercusp://pot?pubkey=${'!'.repeat(44)}&secret=${SECRET}`],
    [
      'pubkey wrong byte length (31B)',
      `papercusp://pot?pubkey=${encodeURIComponent(Buffer.alloc(31, 7).toString('base64'))}&secret=${SECRET}`,
    ],
    [
      'pubkey wrong byte length (33B)',
      `papercusp://pot?pubkey=${encodeURIComponent(Buffer.alloc(33, 7).toString('base64'))}&secret=${SECRET}`,
    ],
    ['empty pubkey', `papercusp://pot?pubkey=&secret=${SECRET}`],
    ['empty title', `papercusp://pot?secret=${SECRET}&title=`],
    [
      'title over 200 chars',
      `papercusp://pot?secret=${SECRET}&title=${encodeURIComponent('x'.repeat(201))}`,
    ],
  ])('%s → null', (_label, input) => {
    expect(parseHiveInviteLink(input)).toBeNull();
  });

  it('the valid control link parses (the matrix is testing the deltas)', () => {
    expect(parseHiveInviteLink(valid)).not.toBeNull();
  });
});

describe('isValidHivePubkeyBase64', () => {
  it('accepts only canonical padded 32-byte base64', () => {
    expect(isValidHivePubkeyBase64(PUBKEY)).toBe(true);
    expect(isValidHivePubkeyBase64(PUBKEY.slice(0, 43))).toBe(false); // unpadded
    expect(isValidHivePubkeyBase64(Buffer.alloc(16, 1).toString('base64'))).toBe(false);
    expect(isValidHivePubkeyBase64('')).toBe(false);
  });
});
