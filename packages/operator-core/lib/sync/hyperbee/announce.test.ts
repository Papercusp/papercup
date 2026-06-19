/**
 * announce.test.ts — signed peer announce wire-format (Model B substrate, Stage 3).
 *
 * The announce binds a peer's Hypercore log to a device identity:
 *   { device_pubkey, github_user_id, github_login, log_core_key, ts, nonce?, sig }
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
 *  - bad-shape / malformed frames → false (never throws);
 *  - D-007 freshness: stale ts, future-skew ts → false; fresh ts → true;
 *  - D-007 tamper: tampering ts or nonce after signing → false (sig check).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  announceSigningBytes,
  buildAnnounce,
  verifyAnnounce,
  DEFAULT_ANNOUNCE_WINDOW_MS,
  type AnnounceBody,
  type SignedAnnounce,
} from './announce';

/** Raw 32-byte Ed25519 pubkey, base64 — the binding's device_pubkey convention. */
function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

const FIXED_NOW_MS = 1_700_000_000_000; // deterministic epoch for tests
const TEST_GIST_ID = 'abc123def456gist'; // deterministic attestation gist id

function makeBody(pubkeyBase64: string): AnnounceBody {
  return {
    device_pubkey: pubkeyBase64,
    github_user_id: 4242,
    github_login: 'alice',
    attestation_gist_id: TEST_GIST_ID,
    log_core_key: 'a'.repeat(64), // 64-hex hypercore key shape
    ts: FIXED_NOW_MS,
  };
}

/** Build an announce with the fixed test clock. */
async function buildTestAnnounce(
  body: Omit<AnnounceBody, 'ts'> & { ts?: number },
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  opts?: { nowMs?: number },
): Promise<SignedAnnounce> {
  return buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey), {
    nowMs: opts?.nowMs ?? FIXED_NOW_MS,
  });
}

describe('announce', () => {
  it('builds + verifies a round-trip announce signed with a generated keypair', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubkeyBase64 = rawPubkeyBase64(publicKey);
    const body = makeBody(pubkeyBase64);

    const frame = await buildTestAnnounce(body, privateKey);

    // device_pubkey is the raw-32-byte-base64 form (matches the binding convention).
    expect(Buffer.from(frame.device_pubkey, 'base64').length).toBe(32);
    expect(frame.device_pubkey).toBe(pubkeyBase64);
    // sig is base64 of a 64-byte Ed25519 signature.
    expect(Buffer.from(frame.sig, 'base64').length).toBe(64);
    // ts is stamped with the injected clock.
    expect(frame.ts).toBe(FIXED_NOW_MS);

    expect(verifyAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(true);
  });

  it('signing bytes exclude sig and are deterministic + field-ordered', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildTestAnnounce(body, privateKey);

    // signing bytes of the body == signing bytes derived from the signed frame
    expect(announceSigningBytes(body).equals(announceSigningBytes(frame))).toBe(true);
    // they do not contain the signature
    expect(announceSigningBytes(frame).toString('utf8')).not.toContain('sig');
    // fixed field order: device_pubkey, github_user_id, github_login,
    // attestation_gist_id, log_core_key, ts
    expect(announceSigningBytes(body).toString('utf8')).toBe(
      JSON.stringify({
        device_pubkey: body.device_pubkey,
        github_user_id: body.github_user_id,
        github_login: body.github_login,
        attestation_gist_id: body.attestation_gist_id,
        log_core_key: body.log_core_key,
        ts: body.ts,
      }),
    );
  });

  it('rejects a tampered signed field (log_core_key)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildTestAnnounce(body, privateKey);

    const tampered: SignedAnnounce = { ...frame, log_core_key: 'b'.repeat(64) };
    expect(verifyAnnounce(tampered, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('rejects a tampered signed field (github_login)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildTestAnnounce(body, privateKey);

    const tampered: SignedAnnounce = { ...frame, github_login: 'mallory' };
    expect(verifyAnnounce(tampered, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('A-003 (a′): a present harness_slug round-trips + is covered by the signing bytes', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body: AnnounceBody = {
      ...makeBody(rawPubkeyBase64(publicKey)),
      harness_slug: 'hello-world-hive',
    };
    const frame = await buildTestAnnounce(body, privateKey);
    expect(verifyAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(true);
    // the slug IS in the signing bytes → it cannot be spoofed in transit.
    expect(announceSigningBytes(frame).toString('utf8')).toContain(
      '"harness_slug":"hello-world-hive"',
    );
  });

  it('A-003 (a′): tampering harness_slug breaks verification (it is signed)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body: AnnounceBody = {
      ...makeBody(rawPubkeyBase64(publicKey)),
      harness_slug: 'member-slug',
    };
    const frame = await buildTestAnnounce(body, privateKey);
    // Re-routing a log to another harness by swapping the slug must fail the sig.
    const tampered: SignedAnnounce = { ...frame, harness_slug: 'hive-home-slug' };
    expect(verifyAnnounce(tampered, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('A-003 (a′) backward-compat: an absent harness_slug yields byte-identical signing bytes', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey)); // no harness_slug
    const withUndefined: AnnounceBody = { ...body, harness_slug: undefined };
    expect(announceSigningBytes(withUndefined).equals(announceSigningBytes(body))).toBe(true);
    expect(announceSigningBytes(body).toString('utf8')).not.toContain('harness_slug');
  });

  it('rejects a sig that does not match the body (different key)', async () => {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(a.publicKey));
    // Sign the body with B's private key but claim A's pubkey in the frame.
    const frame = await buildTestAnnounce(body, b.privateKey);

    expect(verifyAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('rejects a garbage / mismatched signature', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildTestAnnounce(body, privateKey);

    expect(
      verifyAnnounce({ ...frame, sig: Buffer.alloc(64).toString('base64') }, { nowMs: FIXED_NOW_MS }),
    ).toBe(false);
    expect(
      verifyAnnounce({ ...frame, sig: 'not-base64-but-still-a-string!!' }, { nowMs: FIXED_NOW_MS }),
    ).toBe(false);
  });

  it('returns false on bad-shape frames instead of throwing', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pubkeyBase64 = rawPubkeyBase64(publicKey);

    // device_pubkey that is not 32 raw bytes
    expect(
      verifyAnnounce(
        {
          device_pubkey: Buffer.from('short').toString('base64'),
          github_user_id: 1,
          github_login: 'x',
          log_core_key: 'a'.repeat(64),
          ts: FIXED_NOW_MS,
          sig: Buffer.alloc(64).toString('base64'),
        },
        { nowMs: FIXED_NOW_MS },
      ),
    ).toBe(false);

    // missing fields entirely
    expect(verifyAnnounce({} as unknown as SignedAnnounce)).toBe(false);
    expect(verifyAnnounce(null as unknown as SignedAnnounce)).toBe(false);
    expect(
      verifyAnnounce({ device_pubkey: pubkeyBase64 } as unknown as SignedAnnounce),
    ).toBe(false);
  });

  // ── D-007: freshness / replay protection ──

  it('D-007: a fresh announce (ts ≈ now) verifies true', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const nowMs = FIXED_NOW_MS;
    const frame = await buildTestAnnounce(body, privateKey, { nowMs });
    expect(verifyAnnounce(frame, { nowMs })).toBe(true);
  });

  it('D-007: a stale announce (ts far in the past) → false', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const buildMs = FIXED_NOW_MS;
    const windowMs = DEFAULT_ANNOUNCE_WINDOW_MS;
    // Build at buildMs; verify at buildMs + windowMs + 1ms → stale.
    const frame = await buildTestAnnounce(body, privateKey, { nowMs: buildMs });
    expect(verifyAnnounce(frame, { nowMs: buildMs + windowMs + 1, windowMs })).toBe(false);
  });

  it('D-007: a future-skew announce beyond the window → false', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const buildMs = FIXED_NOW_MS + DEFAULT_ANNOUNCE_WINDOW_MS + 1;
    // Build with ts windowMs+1 ms in the future relative to verifier's nowMs.
    const frame = await buildTestAnnounce(body, privateKey, { nowMs: buildMs });
    expect(verifyAnnounce(frame, { nowMs: FIXED_NOW_MS, windowMs: DEFAULT_ANNOUNCE_WINDOW_MS })).toBe(false);
  });

  it('D-007: tampering ts after signing → sig check fails (ts is covered by sig)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const nowMs = FIXED_NOW_MS;
    const frame = await buildTestAnnounce(body, privateKey, { nowMs });
    // Tamper ts to "now" from the verifier's perspective — would pass freshness
    // if ts weren't signed, but sig check must fail because canonical bytes differ.
    const tampered: SignedAnnounce = { ...frame, ts: nowMs + 1 };
    expect(verifyAnnounce(tampered, { nowMs })).toBe(false);
  });

  it('D-007: nonce (when present) is covered by the sig — tamper nonce → false', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubkeyBase64 = rawPubkeyBase64(publicKey);
    const bodyWithNonce: AnnounceBody = {
      device_pubkey: pubkeyBase64,
      github_user_id: 4242,
      github_login: 'alice',
      attestation_gist_id: TEST_GIST_ID,
      log_core_key: 'a'.repeat(64),
      ts: FIXED_NOW_MS,
      nonce: 'original-nonce',
    };
    const frame = await buildTestAnnounce(bodyWithNonce, privateKey, { nowMs: FIXED_NOW_MS });
    // Valid with correct nonce.
    expect(verifyAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(true);
    // Tamper nonce → sig breaks.
    const tampered: SignedAnnounce = { ...frame, nonce: 'attacker-nonce' };
    expect(verifyAnnounce(tampered, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('D-007: signing bytes include ts and nonce (when present)', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pubkeyBase64 = rawPubkeyBase64(publicKey);

    // Without nonce: ts must appear in bytes; nonce key must NOT appear.
    const bodyNoNonce: AnnounceBody = {
      device_pubkey: pubkeyBase64,
      github_user_id: 1,
      github_login: 'x',
      attestation_gist_id: TEST_GIST_ID,
      log_core_key: 'a'.repeat(64),
      ts: FIXED_NOW_MS,
    };
    const bytesNoNonce = announceSigningBytes(bodyNoNonce).toString('utf8');
    expect(bytesNoNonce).toContain(`"ts":${FIXED_NOW_MS}`);
    expect(bytesNoNonce).not.toContain('"nonce"');

    // With nonce: both ts and nonce must appear in bytes.
    const bodyWithNonce: AnnounceBody = { ...bodyNoNonce, nonce: 'abc123' };
    const bytesWithNonce = announceSigningBytes(bodyWithNonce).toString('utf8');
    expect(bytesWithNonce).toContain(`"ts":${FIXED_NOW_MS}`);
    expect(bytesWithNonce).toContain('"nonce":"abc123"');
  });

  // ── write-free join: the attestation gist id rides the SIGNED announce ──
  // (replaces the shared-repo contributor file as the carrier of the gist id;
  // admission proves the binding from the announce + verifyAttestation(gist)).

  it('attestation_gist_id round-trips and is covered by the signature', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildTestAnnounce(body, privateKey);

    expect(frame.attestation_gist_id).toBe(TEST_GIST_ID);
    expect(verifyAnnounce(frame, { nowMs: FIXED_NOW_MS })).toBe(true);

    // Tampering the gist id after signing must break the sig (it's signed-over).
    const tampered: SignedAnnounce = { ...frame, attestation_gist_id: 'attacker-controlled-gist' };
    expect(verifyAnnounce(tampered, { nowMs: FIXED_NOW_MS })).toBe(false);
  });

  it('signing bytes include attestation_gist_id', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    expect(announceSigningBytes(body).toString('utf8')).toContain(
      `"attestation_gist_id":"${TEST_GIST_ID}"`,
    );
  });

  it('rejects a frame missing attestation_gist_id (shape check, never throws)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = makeBody(rawPubkeyBase64(publicKey));
    const frame = await buildTestAnnounce(body, privateKey);

    const { attestation_gist_id: _omit, ...without } = frame;
    void _omit;
    expect(verifyAnnounce(without as unknown as SignedAnnounce, { nowMs: FIXED_NOW_MS })).toBe(false);
  });
});
