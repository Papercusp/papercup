/**
 * attest — device-binding attestation via GitHub Gist (P-011).
 *
 * Three public surfaces:
 *   1. `loadOrGenerateDeviceKeypair` — idempotent, persist via keychain.
 *   2. `createAttestationGist` — publish the signed binding gist.
 *   3. `verifyAttestation` — fetch + verify a peer's binding gist, 24h cache.
 *      The fetch authenticates with the local `gh` token when available and
 *      backs off a rate-limited window (see the quota guards below) — an
 *      unauthenticated fetch shares 60 req/hr across every peer behind one
 *      NAT, which live-wedged owner-side admission for ~17 min (WI-1544).
 *
 * Wire shapes are in `attestation-types.ts`; this module owns I/O only.
 *
 * Signature scheme: Ed25519 via Node `crypto.sign(null, payload, privateKey)`.
 * The signed payload is the JCS-ordered fields of AttestationGistBody minus
 * `signature_by_device` (see `canonicalPayloadForSigning`). Field order is
 * the declaration order in the interface — deterministic for this fixed schema.
 */

import { keychainStore, keychainLoad } from './keychain';
import { getGhAuthToken, clearGhAuthTokenCache } from './gh-token';
import {
  generateEd25519KeypairDer,
  pubkeyBase64FromDer,
  signWithPrivateKeyDer,
  verifyEd25519,
} from './ed25519';
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

// ─── GitHub-quota guards (WI-1544 owner-admission stall) ─────────────────────
// The gist fetch used to be unauthenticated — 60 req/hr **per IP**. Peers
// behind one NAT (office, university, the Docker-frames rig) share that
// window, and the boot's pending-retry ticks burn it in minutes; every
// subsequent verify then 403s → 'github_api_unavailable' → 'pending', so
// membership admission silently wedges until the hourly window rolls
// (live-pinned: the owner admitted a joiner exactly at the window reset,
// ~17 min after join). Two guards:
//   1. Attach the local `gh` token when one resolves (5,000 req/hr
//      per-token; a public gist is readable by ANY valid token — auth here
//      is purely for quota, never authority).
//   2. On a rate-limit 403/429, hold a cooldown until the response's
//      `x-ratelimit-reset` — GitHub keeps refusing until then, so earlier
//      re-fetches can only burn sockets.
type QuotaGuards = {
  __attestGhRateLimitedUntilMs?: number;
  __attestGhTokenFailUntilMs?: number;
};
const _q = globalThis as unknown as QuotaGuards;

const RATE_LIMIT_COOLDOWN_MIN_MS = 30_000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 65 * 60_000;
const TOKEN_RESOLVE_FAIL_TTL_MS = 5 * 60_000;

/**
 * Resolve the local gh token for the gist fetch, best-effort. A miss is
 * memoized briefly so an unauthenticated box doesn't re-shell
 * `gh auth token` (3s timeout each) on every admission retry tick.
 */
async function resolveLocalGhToken(): Promise<string | null> {
  if (Date.now() < (_q.__attestGhTokenFailUntilMs ?? 0)) return null;
  const res = await getGhAuthToken().catch(() => null);
  if (res && res.kind === 'ok') return res.token;
  _q.__attestGhTokenFailUntilMs = Date.now() + TOKEN_RESOLVE_FAIL_TTL_MS;
  return null;
}

function fetchGist(gistId: string, token: string | null): Promise<Response> {
  return fetch('https://api.github.com/gists/' + gistId, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: 'token ' + token } : {}),
    },
  });
}

/**
 * Arm the rate-limit cooldown from a refused response. Only a genuine
 * rate-limit refusal (`retry-after`, or 403/429 with remaining=0) arms it —
 * other 403s (SSO walls, abuse blocks without headers) stay un-memoized so
 * the normal retry loop keeps probing.
 */
function armRateLimitCooldown(resp: Response): void {
  if (resp.status !== 403 && resp.status !== 429) return;
  const get = (n: string): string | null => resp.headers?.get?.(n) ?? null;
  let cooldownMs: number | null = null;
  const retryAfterSec = Number(get('retry-after'));
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    cooldownMs = retryAfterSec * 1000;
  } else if (get('x-ratelimit-remaining') === '0') {
    const resetSec = Number(get('x-ratelimit-reset'));
    cooldownMs =
      Number.isFinite(resetSec) && resetSec > 0
        ? resetSec * 1000 - Date.now()
        : RATE_LIMIT_COOLDOWN_MIN_MS;
  }
  if (cooldownMs == null) return;
  const clamped = Math.min(
    Math.max(cooldownMs, RATE_LIMIT_COOLDOWN_MIN_MS),
    RATE_LIMIT_COOLDOWN_MAX_MS,
  );
  _q.__attestGhRateLimitedUntilMs = Date.now() + clamped;
}

/** Clear the rate-limit cooldown + token-miss memo. Test helper. */
export function clearAttestationQuotaGuards(): void {
  _q.__attestGhRateLimitedUntilMs = undefined;
  _q.__attestGhTokenFailUntilMs = undefined;
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
    return { keychainId, pubkeyBase64: pubkeyBase64FromDer(loaded.value) };
  }

  // First run — generate and store
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  await keychainStore(keychainId, privateKeyDer);
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

  // Inside a rate-limit window every fetch is a guaranteed 403 — return the
  // same retryable result the fetch would produce, without the socket.
  if (Date.now() < (_q.__attestGhRateLimitedUntilMs ?? 0)) {
    return { valid: false, reason: 'github_api_unavailable', verifiedAt };
  }

  // Fetch gist — authenticated when the box has a gh token (quota only; the
  // gist is public and any token can read it).
  let gistData: { owner?: { id?: number }; files?: Record<string, { content?: string }> };
  try {
    const token = await resolveLocalGhToken();
    let resp = await fetchGist(gistId, token);
    if (resp.status === 401 && token) {
      // Stale/revoked local token — drop the cached token and finish this
      // check unauthenticated rather than wedging on a dead credential.
      clearGhAuthTokenCache();
      resp = await fetchGist(gistId, null);
    }
    if (resp.status === 404) {
      return { valid: false, reason: 'gist_not_found', verifiedAt };
    }
    if (!resp.ok) {
      armRateLimitCooldown(resp);
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
  const canonical = canonicalPayloadForSigning(payload);
  return signWithPrivateKeyDer(loaded.value, canonical).toString('base64');
}

function verifyEd25519Signature(
  payload: Omit<AttestationGistBody, 'signature_by_device'>,
  pubkeyBase64: string,
  signatureBase64: string,
): boolean {
  return verifyEd25519(
    canonicalPayloadForSigning(payload),
    pubkeyBase64,
    Buffer.from(signatureBase64, 'base64'),
  );
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
