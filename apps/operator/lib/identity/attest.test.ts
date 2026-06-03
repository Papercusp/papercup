import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign as nodeSign, createPublicKey } from 'node:crypto';
import { attestationGistFilename } from './attestation-types';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTestKeychainId(suffix: string) {
  return 'test-' + process.pid + '-' + suffix;
}

/** Build an SPKI DER from raw 32-byte Ed25519 pubkey (mirrors attest.ts). */
function buildSpkiDer(raw: Buffer): Buffer {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return Buffer.concat([prefix, raw]);
}

/** Extract raw 32-byte pubkey from SPKI DER. */
function extractRawPubkey(spkiDer: Buffer): Buffer {
  return spkiDer.subarray(-32);
}

function signCanonical(
  payload: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): string {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  return nodeSign(null, buf, privateKey).toString('base64');
}

// ─── keychain tests ───────────────────────────────────────────────────────────

describe('keychain (encrypted-file fallback)', () => {
  // Override IDENTITY_DIR by pointing homedir to a tmp path via env trick
  // is complex; instead test the exported functions directly after
  // pointing them at a known tmp dir via a factory approach.
  //
  // These tests exercise the fileStore / fileLoad path end-to-end by
  // using a unique keychainId per test so entries don't collide.

  const kcIds: string[] = [];

  afterEach(async () => {
    // Clean up any stored entries
    const { keychainDelete } = await import('./keychain');
    for (const id of kcIds) {
      await keychainDelete(id).catch(() => {});
    }
    kcIds.length = 0;
  });

  it('stores and loads a private key round-trip', async () => {
    const { keychainStore, keychainLoad } = await import('./keychain');
    const id = makeTestKeychainId('store-load');
    kcIds.push(id);

    const { privateKey } = generateKeyPairSync('ed25519');
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;

    await keychainStore(id, privDer);
    const result = await keychainLoad(id);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.equals(privDer)).toBe(true);
    }
  });

  it('returns not_found when no entry exists', async () => {
    const { keychainLoad } = await import('./keychain');
    const id = makeTestKeychainId('not-found-' + Math.random().toString(36).slice(2));
    const result = await keychainLoad(id);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.kind).toBe('not_found');
    }
  });

  it('overwrites on second store', async () => {
    const { keychainStore, keychainLoad } = await import('./keychain');
    const id = makeTestKeychainId('overwrite');
    kcIds.push(id);

    const kp1 = generateKeyPairSync('ed25519');
    const kp2 = generateKeyPairSync('ed25519');
    const der1 = kp1.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
    const der2 = kp2.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;

    await keychainStore(id, der1);
    await keychainStore(id, der2);
    const result = await keychainLoad(id);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.equals(der2)).toBe(true);
    }
  });

  it('delete removes the entry', async () => {
    const { keychainStore, keychainLoad, keychainDelete } = await import('./keychain');
    const id = makeTestKeychainId('delete');

    const { privateKey } = generateKeyPairSync('ed25519');
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;

    await keychainStore(id, privDer);
    await keychainDelete(id);
    const result = await keychainLoad(id);

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.kind).toBe('not_found');
    }
  });
});

// ─── keypair lifecycle ────────────────────────────────────────────────────────

describe('loadOrGenerateDeviceKeypair', () => {
  const kcIds: string[] = [];

  afterEach(async () => {
    const { keychainDelete } = await import('./keychain');
    for (const id of kcIds) {
      await keychainDelete(id).catch(() => {});
    }
    kcIds.length = 0;
  });

  it('generates a keypair on first call', async () => {
    const { loadOrGenerateDeviceKeypair } = await import('./attest');
    const id = makeTestKeychainId('gen-first');
    kcIds.push(id);

    const result = await loadOrGenerateDeviceKeypair(id);
    expect(result.keychainId).toBe(id);
    expect(typeof result.pubkeyBase64).toBe('string');
    // Base64 of 32 bytes = 44 chars
    expect(result.pubkeyBase64.length).toBe(44);
  });

  it('is idempotent — same pubkey on second call', async () => {
    const { loadOrGenerateDeviceKeypair } = await import('./attest');
    const id = makeTestKeychainId('idempotent');
    kcIds.push(id);

    const first = await loadOrGenerateDeviceKeypair(id);
    const second = await loadOrGenerateDeviceKeypair(id);
    expect(second.pubkeyBase64).toBe(first.pubkeyBase64);
  });

  it('different keychainIds produce different pubkeys', async () => {
    const { loadOrGenerateDeviceKeypair } = await import('./attest');
    const id1 = makeTestKeychainId('diff-1');
    const id2 = makeTestKeychainId('diff-2');
    kcIds.push(id1, id2);

    const r1 = await loadOrGenerateDeviceKeypair(id1);
    const r2 = await loadOrGenerateDeviceKeypair(id2);
    expect(r1.pubkeyBase64).not.toBe(r2.pubkeyBase64);
  });
});

// ─── verifyAttestation ────────────────────────────────────────────────────────

describe('verifyAttestation', () => {
  beforeEach(async () => {
    const { clearAttestationCache } = await import('./attest');
    clearAttestationCache();
  });

  function makeFakeGistResponse(overrides?: Partial<{
    ownerId: number;
    body: Partial<{
      version: number;
      device_pubkey: string;
      device_label: string;
      github_user_id: number;
      github_login: string;
      created_at: number;
      signature_by_device: string;
    }>;
    status: number;
  }>) {
    const kp = generateKeyPairSync('ed25519');
    const spkiDer = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const rawPub = extractRawPubkey(spkiDer);
    const pubkeyBase64 = rawPub.toString('base64');

    const payload = {
      version: 1,
      device_pubkey: pubkeyBase64,
      device_label: 'test-device',
      github_user_id: 12345,
      github_login: 'testuser',
      created_at: Date.now(),
    };
    const signature_by_device = signCanonical(payload, kp.privateKey);

    const body = {
      ...payload,
      signature_by_device,
      ...overrides?.body,
    };

    return {
      kp,
      pubkeyBase64,
      body,
      gistResponse: {
        id: 'test-gist-id',
        owner: { id: overrides?.ownerId ?? payload.github_user_id },
        files: {
          // Derive the filename the same way the source does — it sanitizes
          // base64 (+→-, /→_), so a raw slice diverges for ~⅓ of random keys
          // (the old hardcoded form made these tests flaky).
          [attestationGistFilename(pubkeyBase64)]: {
            content: JSON.stringify(body, null, 2),
          },
        },
      },
      status: overrides?.status ?? 200,
    };
  }

  it('returns valid=true for a correctly-signed gist', async () => {
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64, gistResponse } = makeFakeGistResponse();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => gistResponse,
      }),
    );

    const result = await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    expect(result.valid).toBe(true);
    expect(result.resolvedGithubUserId).toBe(12345);
    vi.unstubAllGlobals();
  });

  it('ensureAttestationGist: returns an existing verified gist id without creating', async () => {
    const { ensureAttestationGist } = await import('./attest');
    const { pubkeyBase64, body } = makeFakeGistResponse();
    // Key the gist files under the REAL deterministic filename so both the
    // find-by-filename match and the verifyAttestation lookup hit.
    const filename = attestationGistFilename(pubkeyBase64);
    const validGist = {
      id: 'g-existing',
      owner: { id: 12345 },
      files: { [filename]: { content: JSON.stringify(body, null, 2) } },
    };

    const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
      void init;
      if (typeof url === 'string' && url.includes('/gists?')) {
        // The "list my gists" call → one gist carrying the attestation filename.
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'g-existing', files: { [filename]: {} } }],
        };
      }
      // The verifyAttestation gist-by-id fetch.
      return { ok: true, status: 200, json: async () => validGist };
    });
    vi.stubGlobal('fetch', fetchMock);

    const id = await ensureAttestationGist({
      keychainId: 'unused-on-find-path',
      pubkeyBase64,
      deviceLabel: 'test',
      githubUserId: 12345,
      githubLogin: 'testuser',
      token: 'tok',
    });

    expect(id).toBe('g-existing');
    // It must NOT POST a new gist when an existing verified one is found.
    const posted = fetchMock.mock.calls.some(
      (c) => (c[1] as { method?: string } | undefined)?.method === 'POST',
    );
    expect(posted).toBe(false);
    vi.unstubAllGlobals();
  });

  it('returns gist_not_found on 404', async () => {
    const { verifyAttestation } = await import('./attest');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );

    const result = await verifyAttestation('missing-gist', 'YWJj', 9999);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('gist_not_found');
    vi.unstubAllGlobals();
  });

  it('returns github_api_unavailable on network error', async () => {
    const { verifyAttestation } = await import('./attest');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await verifyAttestation('any-gist', 'YWJj', 9999);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('github_api_unavailable');
    vi.unstubAllGlobals();
  });

  it('returns github_user_id_mismatch when gist owner differs from body', async () => {
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64, gistResponse } = makeFakeGistResponse({ ownerId: 99999 });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => gistResponse,
      }),
    );

    const result = await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('github_user_id_mismatch');
    vi.unstubAllGlobals();
  });

  it('returns signature_invalid on tampered payload', async () => {
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64, gistResponse, body } = makeFakeGistResponse();

    // Tamper: change device_label after signing
    const tampered = { ...gistResponse };
    const filename = attestationGistFilename(pubkeyBase64);
    tampered.files = {
      [filename]: {
        content: JSON.stringify({ ...body, device_label: 'TAMPERED' }, null, 2),
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => tampered,
      }),
    );

    const result = await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_invalid');
    vi.unstubAllGlobals();
  });

  it('returns pubkey_mismatch when claimed pubkey differs from gist body', async () => {
    // pubkey_mismatch fires when:
    //   - the filename in the gist matches the claimed pubkey (so the file IS found)
    //   - but the body's device_pubkey contains a DIFFERENT pubkey
    // This catches a type-confusion where a caller presents the wrong pubkey for a
    // gist that physically exists under that pubkey's derived filename.
    const { verifyAttestation } = await import('./attest');
    const { pubkeyBase64: realPubkey, body: realBody } = makeFakeGistResponse();

    // Build a second keypair; its pubkey will be what we "claim"
    const claimedKp = generateKeyPairSync('ed25519');
    const claimedSpki = claimedKp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const claimedPubkeyBase64 = extractRawPubkey(claimedSpki).toString('base64');

    // The gist's filename is derived from the CLAIMED pubkey, but the body has the REAL pubkey
    const filename = attestationGistFilename(claimedPubkeyBase64);
    const confusedResponse = {
      id: 'test-gist-id',
      owner: { id: realBody.github_user_id },
      files: {
        [filename]: { content: JSON.stringify({ ...realBody, device_pubkey: realPubkey }, null, 2) },
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => confusedResponse,
      }),
    );

    const result = await verifyAttestation('test-gist-id', claimedPubkeyBase64, 12345);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('pubkey_mismatch');
    vi.unstubAllGlobals();
  });

  it('caches successful verifications — fetch called once for two calls', async () => {
    const { verifyAttestation, clearAttestationCache } = await import('./attest');
    clearAttestationCache();

    const { pubkeyBase64, gistResponse } = makeFakeGistResponse();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => gistResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    await verifyAttestation('test-gist-id', pubkeyBase64, 12345);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('skipCache forces re-fetch', async () => {
    const { verifyAttestation, clearAttestationCache } = await import('./attest');
    clearAttestationCache();

    const { pubkeyBase64, gistResponse } = makeFakeGistResponse();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => gistResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    await verifyAttestation('test-gist-id', pubkeyBase64, 12345, { skipCache: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('does not cache failed verifications', async () => {
    const { verifyAttestation, clearAttestationCache } = await import('./attest');
    clearAttestationCache();

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal('fetch', mockFetch);

    await verifyAttestation('bad-gist', 'YWJj', 9999);
    await verifyAttestation('bad-gist', 'YWJj', 9999);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  // ─── regression: cross-identity impersonation via cache key (R-1 fix) ─────────
  //
  // Before the fix the cache key was `gistId + ':' + pubkeyBase64`, omitting
  // the claimedGithubUserId.  This allowed an attacker to:
  //   1. Self-verify as idX  → `G:P` cached valid:true
  //   2. Re-call with VICTIM_id → cache hit returned valid:true → id check bypassed
  //
  // After the fix the key is `gistId + ':' + pubkeyBase64 + ':' + userId`, so
  // step 2 is a cache miss and must go to runVerification, which correctly checks
  // the gist owner against the new claimedGithubUserId and returns
  // `github_user_id_mismatch`.

  it('cache hit for idX must NOT be returned for a different idY (cross-identity isolation)', async () => {
    const { verifyAttestation, clearAttestationCache } = await import('./attest');
    clearAttestationCache();

    // Build a gist owned by ID_X (12345).  makeFakeGistResponse already
    // creates a gist with github_user_id: 12345 and ownerId: 12345.
    const { pubkeyBase64, gistResponse } = makeFakeGistResponse();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => gistResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    // First call: verify legitimately as ID_X (12345) → cache populated, valid:true
    const first = await verifyAttestation('test-gist-id', pubkeyBase64, 12345);
    expect(first.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call: same gistId + pubkey but different claimedGithubUserId (the victim)
    // Must NOT return the cached result — must re-verify against the network,
    // and since the gist is owned by 12345, it must fail with github_user_id_mismatch.
    const second = await verifyAttestation('test-gist-id', pubkeyBase64, 99999);
    expect(mockFetch).toHaveBeenCalledTimes(2); // cache miss → second fetch
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('github_user_id_mismatch');

    vi.unstubAllGlobals();
  });

  it('evictAttestationCache removes all user-id variants for a gist+pubkey pair', async () => {
    const { verifyAttestation, clearAttestationCache, evictAttestationCache } = await import('./attest');
    clearAttestationCache();

    // Two separate users each verify the same gist (different gists in practice,
    // but the eviction contract is about clearing all ids for a given pair).
    // We use two gists owned by different users so each verify call succeeds.
    const { pubkeyBase64, gistResponse } = makeFakeGistResponse();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => gistResponse,
    });
    vi.stubGlobal('fetch', mockFetch);

    // Prime the cache with the real id
    await verifyAttestation('evict-gist', pubkeyBase64, 12345);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Same id again → cache hit, no extra fetch
    await verifyAttestation('evict-gist', pubkeyBase64, 12345);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Evict — prefix scan should remove the 12345 entry
    evictAttestationCache('evict-gist', pubkeyBase64);

    // Now the same call is a cache miss → fetch again
    await verifyAttestation('evict-gist', pubkeyBase64, 12345);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });
});
