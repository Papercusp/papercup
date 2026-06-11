/**
 * hive-announce.test.ts — the signed hive-directory announce (p2p-hive-directory P-001).
 *
 * Mirrors announce.test.ts: generate a Node Ed25519 keypair (no live keychain),
 * inject the signer, round-trip build → verify, and assert every tamper /
 * freshness / shape failure mode the directory's verify gate must reject.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  buildHiveAnnounce,
  verifyHiveAnnounce,
  hiveAnnounceSigningBytes,
  DEFAULT_HIVE_ANNOUNCE_WINDOW_MS,
  isHiveVisibility,
  type HiveAnnounceBody,
  type SignedHiveAnnounce,
} from './hive-announce';

/** Raw 32-byte Ed25519 pubkey, base64 — the binding's device_pubkey convention. */
function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

const FIXED_NOW_MS = 1_700_000_000_000;
const signer = (privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) => (bytes: Buffer) =>
  Promise.resolve(nodeSign(null, bytes, privateKey));

function makeBody(pubkeyBase64: string, over: Partial<HiveAnnounceBody> = {}): HiveAnnounceBody {
  return {
    hive_id: 'hive-ash-01',
    title: 'Ash Hive',
    description: 'A research hive focused on the shop migration.',
    owner_github_login: 'alice',
    owner_github_user_id: 4242,
    owner_device_pubkey: pubkeyBase64,
    attestation_gist_id: 'abc123def456gist',
    member_topics: ['a'.repeat(64), 'b'.repeat(64)],
    visibility: 'public',
    created_at: FIXED_NOW_MS - 86_400_000,
    ts: FIXED_NOW_MS,
    ...over,
  };
}

describe('hive-announce — round-trip + the device-identity binding (P-001)', () => {
  it('builds + verifies an announce signed with a generated keypair', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildHiveAnnounce(body, signer(privateKey));
    expect(typeof frame.sig).toBe('string');
    expect(verifyHiveAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(true);
  });

  it('owner_device_pubkey is the raw-32-byte-base64 form (peer-announce convention)', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pk = rawPubkeyBase64(publicKey);
    expect(Buffer.from(pk, 'base64').length).toBe(32);
  });

  it('preserves member_topics order in the canonical bytes (a reorder is a different message)', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const a = makeBody(rawPubkeyBase64(publicKey), { member_topics: ['x'.repeat(64), 'y'.repeat(64)] });
    const b = makeBody(rawPubkeyBase64(publicKey), { member_topics: ['y'.repeat(64), 'x'.repeat(64)] });
    expect(hiveAnnounceSigningBytes(a).equals(hiveAnnounceSigningBytes(b))).toBe(false);
  });
});

describe('hive-announce — tamper rejection (the directory verify gate)', () => {
  it('rejects a tampered title (signed field)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveAnnounce(makeBody(rawPubkeyBase64(publicKey)), signer(privateKey));
    const tampered: SignedHiveAnnounce = { ...frame, title: 'Evil Hive' };
    expect(verifyHiveAnnounce(tampered, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('rejects a tampered member_topics list', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveAnnounce(makeBody(rawPubkeyBase64(publicKey)), signer(privateKey));
    const tampered: SignedHiveAnnounce = { ...frame, member_topics: [...frame.member_topics, 'c'.repeat(64)] };
    expect(verifyHiveAnnounce(tampered, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('rejects a frame signed by a DIFFERENT key than its owner_device_pubkey (spoofed owner)', async () => {
    const victim = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    // Body claims the victim's pubkey, but we sign with the attacker's key.
    const body = makeBody(rawPubkeyBase64(victim.publicKey));
    const frame = await buildHiveAnnounce(body, signer(attacker.privateKey));
    expect(verifyHiveAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('rejects a sig that does not match the body', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveAnnounce(makeBody(rawPubkeyBase64(publicKey)), signer(privateKey));
    expect(verifyHiveAnnounce({ ...frame, sig: Buffer.from('not-the-sig').toString('base64') }, { nowMs: FIXED_NOW_MS })).toBe(false);
  });
});

describe('hive-announce — freshness (D-007 replay hardening)', () => {
  it('rejects a stale announce (older than the window)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveAnnounce(makeBody(rawPubkeyBase64(publicKey)), signer(privateKey));
    const later = FIXED_NOW_MS + DEFAULT_HIVE_ANNOUNCE_WINDOW_MS + 1;
    expect(verifyHiveAnnounce(frame, { nowMs: later })).toBe(false);
  });

  it('rejects a future-skewed announce', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveAnnounce(makeBody(rawPubkeyBase64(publicKey)), signer(privateKey));
    const earlier = FIXED_NOW_MS - DEFAULT_HIVE_ANNOUNCE_WINDOW_MS - 1;
    expect(verifyHiveAnnounce(frame, { nowMs: earlier })).toBe(false);
  });

  it('tampering ts after signing breaks the sig (covered field)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveAnnounce(makeBody(rawPubkeyBase64(publicKey)), signer(privateKey));
    const tampered: SignedHiveAnnounce = { ...frame, ts: frame.ts + 1 };
    // Even within the window, the moved ts no longer matches the signed bytes.
    expect(verifyHiveAnnounce(tampered, { nowMs: frame.ts + 1 })).toBe(false);
  });
});

describe('hive-announce — shape + visibility guards', () => {
  it('never accepts a private-visibility frame (a private hive must not be on the wire)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveAnnounce(makeBody(rawPubkeyBase64(publicKey), { visibility: 'private' }), signer(privateKey));
    expect(verifyHiveAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('accepts an invite-visibility frame (invite-scoped hives DO announce, just on a private topic)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveAnnounce(makeBody(rawPubkeyBase64(publicKey), { visibility: 'invite' }), signer(privateKey));
    expect(verifyHiveAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(true);
  });

  it('returns false (never throws) on malformed input', () => {
    expect(verifyHiveAnnounce(null as unknown as SignedHiveAnnounce)).toBe(false);
    expect(verifyHiveAnnounce({} as SignedHiveAnnounce)).toBe(false);
    expect(verifyHiveAnnounce({ hive_id: 'x' } as SignedHiveAnnounce)).toBe(false);
  });

  it('isHiveVisibility guards the enum', () => {
    expect(isHiveVisibility('public')).toBe(true);
    expect(isHiveVisibility('invite')).toBe(true);
    expect(isHiveVisibility('private')).toBe(true);
    expect(isHiveVisibility('other')).toBe(false);
  });
});

describe('hive-announce — hive_pubkey addressability field (cross-hive-boundary P-006)', () => {
  it('includes hive_pubkey in the signed bytes only when present (back-compat preserved)', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pk = rawPubkeyBase64(publicKey);
    const without = hiveAnnounceSigningBytes(makeBody(pk));
    const withPk = hiveAnnounceSigningBytes(makeBody(pk, { hive_pubkey: 'aGl2ZS1wdWJrZXk=' }));
    expect(withPk.equals(without)).toBe(false); // present → covered by the sig
    // a body that omits hive_pubkey signs the exact bytes earlier versions did
    expect(hiveAnnounceSigningBytes(makeBody(pk)).equals(without)).toBe(true);
  });

  it('round-trips + verifies an announce carrying hive_pubkey', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveAnnounce(
      makeBody(rawPubkeyBase64(publicKey), { hive_pubkey: 'aGl2ZS1wdWJrZXk=' }),
      signer(privateKey),
    );
    expect(verifyHiveAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(true);
    expect(frame.hive_pubkey).toBe('aGl2ZS1wdWJrZXk=');
  });

  it('a tampered hive_pubkey fails verification (the dial address is sig-bound)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const frame = await buildHiveAnnounce(
      makeBody(rawPubkeyBase64(publicKey), { hive_pubkey: 'b3JpZ2luYWw=' }),
      signer(privateKey),
    );
    expect(verifyHiveAnnounce({ ...frame, hive_pubkey: 'ZXZpbA==' }, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('rejects a non-string hive_pubkey', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const frame = {
      ...makeBody(rawPubkeyBase64(publicKey)),
      hive_pubkey: 42,
      sig: 'x',
    } as unknown as SignedHiveAnnounce;
    expect(verifyHiveAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(false);
  });
});

describe('member_repos — the repo→Hive binding signal (hive-from-github-url P-003)', () => {
  it('round-trips an announce carrying member_repos', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey), {
      member_repos: ['alice/shop#1234567', 'alice/shop-docs'],
    });
    const frame = await buildHiveAnnounce(body, signer(privateKey));
    expect(verifyHiveAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(true);
    expect(frame.member_repos).toEqual(['alice/shop#1234567', 'alice/shop-docs']);
  });

  it('tampering with member_repos breaks the signature', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey), { member_repos: ['alice/shop#1'] });
    const frame = await buildHiveAnnounce(body, signer(privateKey));
    const tampered = { ...frame, member_repos: ['mallory/evil#1'] };
    expect(verifyHiveAnnounce(tampered, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('an announce WITHOUT member_repos signs the exact bytes earlier versions did (additive)', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const withField = { ...body, member_repos: undefined };
    expect(hiveAnnounceSigningBytes(withField).equals(hiveAnnounceSigningBytes(body))).toBe(true);
    expect(hiveAnnounceSigningBytes(body).toString('utf8')).not.toContain('member_repos');
  });

  it('rejects a non-string-array member_repos shape', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildHiveAnnounce(body, signer(privateKey));
    const bad = { ...frame, member_repos: [42] } as unknown as SignedHiveAnnounce;
    expect(verifyHiveAnnounce(bad, { nowMs: FIXED_NOW_MS })).toBe(false);
  });
});
