/**
 * attest — device-binding attestation via GitHub Gist (P-011).
 *
 * Three public surfaces:
 *   1. `loadOrGenerateDeviceKeypair` — idempotent, persist via keychain.
 *   2. `createAttestationGist` — publish the signed binding gist.
 *   3. `verifyAttestation` — fetch + verify a peer's binding gist, 24h cache.
 *
 * Wire shapes are in `attestation-types.ts`; this module owns I/O only.
 *
 * Signature scheme: Ed25519 via Node `crypto.sign(null, payload, privateKey)`.
 * The signed payload is the JCS-ordered fields of AttestationGistBody minus
 * `signature_by_device` (see `canonicalPayloadForSigning`). Field order is
 * the declaration order in the interface — deterministic for this fixed schema.
 */

import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, createPrivateKey } from 'node:crypto';
import { keychainStore, keychainLoad } from './keychain';
import {
  AttestationGistBody,
  AttestationVerificationResult,
  DeviceKeypairId,
  ATTESTATION_VERIFY_CACHE_TTL_MS,
  attestationGistFilename,
} from './attestation-types';

// ─── module-level verify cache ────────────────────────────────────────────────
type CacheEntry = { result: AttestationVerificationResult; cachedAt: number };
type VerifyCache = { __attestVerifyCache?: Map<string, CacheEntry> };
const _g = globalThis as unknown as VerifyCache;
function getCache(): Map<string, CacheEntry> {
  if (!_g.__attestVerifyCache) _g.__attestVerifyCache = new Map();
  return _g.__attestVerifyCache;
}

// ─── keypair lifecycle ────────────────────────────────────────────────────────

/**
 * Load the existing device keypair from the keychain, or generate +
 * persist a new one on first call. Idempotent: repeated calls with the
 * same keychainId always return the same public key.
 *
 * The private key NEVER leaves the keychain after this function returns —
 * callers receive only `DeviceKeypairId` (pubkey + id for lookup).
 */
export async function loadOrGenerateDeviceKeypair(
  keychainId: string,
): Promise<DeviceKeypairId> {
  const loaded = await keychainLoad(keychainId);
  if (loaded.kind === 'ok') {
    // Reconstruct the public key from the stored private key DER
    const privKey = createPrivateKeyFromDer(loaded.value);
    const pubkeyBase64 = extractPubkeyBase64(privKey);
    return { keychainId, pubkeyBase64 };
  }

  // First run — generate and store
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  await keychainStore(keychainId, privateKeyDer);

  const pubkeyBase64 = extractPubkeyBase64FromPublicKey(publicKey);
  return { keychainId, pubkeyBase64 };
}

// ─── gist creation ────────────────────────────────────────────────────────────

export interface CreateAttestationGistInput {
  keychainId: string;
  pubkeyBase64: string;
  deviceLabel: string;
  githubUserId: number;
  githubLogin: string;
  /** OAuth token with `gist` scope */
  token: string;
}

export interface CreateAttestationGistResult {
  gistId: string;
  gistUrl: string;
  body: AttestationGistBody;
}

/**
 * Create the GitHub Gist that constitutes this device's attestation.
 * The gist is public (GitHub requires auth for gist creation, but the
 * verifier needs to read it without the creator's token).
 *
 * Signs the canonical payload with the Ed25519 private key from the
 * keychain before publishing, so the gist is self-authenticating.
 */
export async function createAttestationGist(
  input: CreateAttestationGistInput,
): Promise<CreateAttestationGistResult> {
  const { keychainId, pubkeyBase64, deviceLabel, githubUserId, githubLogin, token } = input;

  // Build the body (minus signature first, then sign)
  const unsignedBody: Omit<AttestationGistBody, 'signature_by_device'> = {
    version: 1,
    device_pubkey: pubkeyBase64,
    device_label: deviceLabel,
    github_user_id: githubUserId,
    github_login: githubLogin,
    created_at: Date.now(),
  };

  const signature_by_device = await signPayload(keychainId, unsignedBody);
  const body: AttestationGistBody = { ...unsignedBody, signature_by_device };

  const filename = attestationGistFilename(pubkeyBase64);
  const gistPayload = {
    description: 'Papercusp device binding attestation',
    public: true,
    files: {
      [filename]: { content: JSON.stringify(body, null, 2) },
    },
  };

  const resp = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Authorization: 'token ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(gistPayload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new AttestationError(
      'gist_creation_failed',
      'GitHub API returned ' + resp.status + ': ' + text,
    );
  }

  const data = (await resp.json()) as { id: string; html_url: string };
  return { gistId: data.id, gistUrl: data.html_url, body };
}

/**
 * Idempotently resolve THIS device's attestation gist id under the
 * authenticated user, creating it on first use. Used by the write-free join
 * path (`non-collaborator-join-fork-pr-2026-06-02`): the gist id rides the
 * signed announce, so each boot needs its own gist id without a shared-repo
 * contributor file (and without local persistence — GitHub is the store).
 *
 * The attestation gist filename is DETERMINISTIC from the device pubkey
 * (`attestationGistFilename`), so we can find an existing gist by listing the
 * user's gists and matching that filename, then confirming it verifies for
 * `(pubkey, githubUserId)`. If none verifies, we create a fresh one.
 */
export async function ensureAttestationGist(
  input: CreateAttestationGistInput,
): Promise<string> {
  const expectedFilename = attestationGistFilename(input.pubkeyBase64);
  try {
    const resp = await fetch('https://api.github.com/gists?per_page=100', {
      headers: {
        Authorization: 'token ' + input.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (resp.ok) {
      const gists = (await resp.json()) as Array<{
        id?: string;
        files?: Record<string, unknown> | null;
      }>;
      for (const g of gists) {
        if (!g.id || !g.files || !(expectedFilename in g.files)) continue;
        const v = await verifyAttestation(g.id, input.pubkeyBase64, input.githubUserId, {
          skipCache: true,
        });
        if (v.valid) return g.id;
      }
    }
  } catch {
    // Network/list failure → fall through to create (idempotent enough: a
    // duplicate gist is harmless; both verify identically).
  }
  const created = await createAttestationGist(input);
  return created.gistId;
}

// ─── verification ─────────────────────────────────────────────────────────────

/**
 * Verify a peer's attestation gist. Checks:
 *   1. Gist exists and is readable (P-011f: 404 → pubkey_revoked signal)
 *   2. Gist body matches AttestationGistBody schema (version, required fields)
 *   3. Gist owner's github_user_id matches body's github_user_id
 *   4. Claimed pubkey matches body's device_pubkey
 *   5. Ed25519 signature over canonical payload is valid
 *
 * Results are cached for ATTESTATION_VERIFY_CACHE_TTL_MS (24h).
 * Pass `skipCache: true` in opts to force re-verification (e.g. after
 * a revocation signal).
 */
export async function verifyAttestation(
  gistId: string,
  claimedPubkeyBase64: string,
  claimedGithubUserId: number,
  opts?: { skipCache?: boolean },
): Promise<AttestationVerificationResult> {
  const cacheKey = gistId + ':' + claimedPubkeyBase64 + ':' + claimedGithubUserId;
  if (!opts?.skipCache) {
    const cached = getCache().get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < ATTESTATION_VERIFY_CACHE_TTL_MS) {
      return cached.result;
    }
  }

  const result = await runVerification(gistId, claimedPubkeyBase64, claimedGithubUserId);

  // Only cache successful verifications — failures re-verify on next call
  // so revocation is detected promptly.
  if (result.valid) {
    getCache().set(cacheKey, { result, cachedAt: Date.now() });
  }

  return result;
}

/**
 * Evict all cache entries for a given gist + pubkey pair (across all
 * claimedGithubUserId values). The cache key now includes the claimed id
 * (fix for cross-identity impersonation), so eviction must scan by prefix
 * `gistId + ':' + pubkeyBase64 + ':'` rather than an exact match.
 * Callers do not need to supply a user id — this evicts every identity that
 * was cached under this gist/pubkey combination.
 */
export function evictAttestationCache(gistId: string, pubkeyBase64: string): void {
  const prefix = gistId + ':' + pubkeyBase64 + ':';
  const cache = getCache();
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

/** Clear the entire verification cache. Test helper. */
export function clearAttestationCache(): void {
  getCache().clear();
}

// ─── internal ─────────────────────────────────────────────────────────────────

async function runVerification(
  gistId: string,
  claimedPubkeyBase64: string,
  claimedGithubUserId: number,
): Promise<AttestationVerificationResult> {
  const verifiedAt = Date.now();

  // Fetch gist
  let gistData: { owner?: { id?: number }; files?: Record<string, { content?: string }> };
  try {
    const resp = await fetch('https://api.github.com/gists/' + gistId, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (resp.status === 404) {
      return { valid: false, reason: 'gist_not_found', verifiedAt };
    }
    if (!resp.ok) {
      return { valid: false, reason: 'github_api_unavailable', verifiedAt };
    }
    gistData = (await resp.json()) as typeof gistData;
  } catch {
    return { valid: false, reason: 'github_api_unavailable', verifiedAt };
  }

  // Find the attestation file
  const files = gistData.files ?? {};
  const expectedFilename = attestationGistFilename(claimedPubkeyBase64);
  const fileEntry = files[expectedFilename];
  if (!fileEntry?.content) {
    return { valid: false, reason: 'gist_body_invalid', verifiedAt };
  }

  // Parse body
  let body: unknown;
  try {
    body = JSON.parse(fileEntry.content);
  } catch {
    return { valid: false, reason: 'gist_body_invalid', verifiedAt };
  }
  if (!isAttestationGistBody(body)) {
    return { valid: false, reason: 'gist_body_invalid', verifiedAt };
  }

  // Owner id check
  const ownerId = gistData.owner?.id;
  if (ownerId !== body.github_user_id) {
    return { valid: false, reason: 'github_user_id_mismatch', verifiedAt };
  }
  if (body.github_user_id !== claimedGithubUserId) {
    return { valid: false, reason: 'github_user_id_mismatch', verifiedAt };
  }

  // Claimed pubkey must match body
  if (body.device_pubkey !== claimedPubkeyBase64) {
    return { valid: false, reason: 'pubkey_mismatch', verifiedAt };
  }

  // Signature check
  const { signature_by_device, ...rest } = body;
  const sigOk = verifyEd25519Signature(rest, claimedPubkeyBase64, signature_by_device);
  if (!sigOk) {
    return { valid: false, reason: 'signature_invalid', verifiedAt };
  }

  return {
    valid: true,
    verifiedAt,
    resolvedGithubUserId: body.github_user_id,
  };
}

function isAttestationGistBody(v: unknown): v is AttestationGistBody {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return (
    b.version === 1 &&
    typeof b.device_pubkey === 'string' &&
    typeof b.device_label === 'string' &&
    typeof b.github_user_id === 'number' &&
    typeof b.github_login === 'string' &&
    typeof b.created_at === 'number' &&
    typeof b.signature_by_device === 'string'
  );
}

// ─── crypto helpers ───────────────────────────────────────────────────────────

async function signPayload(
  keychainId: string,
  payload: Omit<AttestationGistBody, 'signature_by_device'>,
): Promise<string> {
  const loaded = await keychainLoad(keychainId);
  if (loaded.kind !== 'ok') {
    throw new AttestationError(
      'keychain_error',
      'private key not found in keychain for id: ' + keychainId,
    );
  }
  const privateKey = createPrivateKeyFromDer(loaded.value);
  const canonical = canonicalPayloadForSigning(payload);
  const sig = nodeSign(null, canonical, privateKey);
  return sig.toString('base64');
}

function verifyEd25519Signature(
  payload: Omit<AttestationGistBody, 'signature_by_device'>,
  pubkeyBase64: string,
  signatureBase64: string,
): boolean {
  try {
    const pubkeyDer = buildSpkiDerFromRawPubkey(Buffer.from(pubkeyBase64, 'base64'));
    const publicKey = createPublicKey({ key: pubkeyDer, format: 'der', type: 'spki' });
    const canonical = canonicalPayloadForSigning(payload);
    const sig = Buffer.from(signatureBase64, 'base64');
    return nodeVerify(null, canonical, publicKey, sig);
  } catch {
    return false;
  }
}

/**
 * Canonical serialization for signing: field-ordered JSON over the
 * payload fields (excluding signature_by_device). Field order matches
 * the AttestationGistBody interface declaration — equivalent to JCS
 * (RFC 8785) for this fixed primitive-value schema.
 */
function canonicalPayloadForSigning(
  payload: Omit<AttestationGistBody, 'signature_by_device'>,
): Buffer {
  const ordered = {
    version: payload.version,
    device_pubkey: payload.device_pubkey,
    device_label: payload.device_label,
    github_user_id: payload.github_user_id,
    github_login: payload.github_login,
    created_at: payload.created_at,
  };
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

function createPrivateKeyFromDer(der: Buffer) {
  // node:crypto is imported at the top — a bare require() here threw "require is
  // not defined" under operator-core's ESM (type:module), breaking the device
  // keypair load → plan_items:claim (EI-8) + any authority path that resolves the
  // self device identity. Use the top-level import.
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function extractPubkeyBase64(privateKey: ReturnType<typeof createPrivateKeyFromDer>): string {
  const pub = createPublicKey(privateKey);
  return extractPubkeyBase64FromPublicKey(pub);
}

function extractPubkeyBase64FromPublicKey(
  publicKey: ReturnType<typeof createPublicKey>,
): string {
  // SPKI DER for Ed25519 is 44 bytes; the raw 32-byte pubkey is the last 32 bytes.
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

/**
 * Reconstruct a 44-byte SPKI DER from a raw 32-byte Ed25519 public key.
 * The SPKI prefix for Ed25519 is the fixed 12-byte OID sequence:
 *   30 2a 30 05 06 03 2b 65 70 03 21 00
 */
function buildSpkiDerFromRawPubkey(rawPubkey: Buffer): Buffer {
  if (rawPubkey.length !== 32) {
    throw new Error('expected 32-byte Ed25519 public key, got ' + rawPubkey.length);
  }
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return Buffer.concat([prefix, rawPubkey]);
}

// ─── error class ──────────────────────────────────────────────────────────────

export class AttestationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AttestationError';
  }
}
