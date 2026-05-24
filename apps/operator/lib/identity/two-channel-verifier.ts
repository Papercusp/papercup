/**
 * two-channel-verifier — runtime implementation of P-075 (Phase 1b).
 *
 * Verifies a contributor's binding via two independent channels:
 *   Channel 1 — OAuth: `GET /user` must return a `id` matching the
 *               claimed `github_user_id`. Proves the caller holds a
 *               token issued for that user.
 *   Channel 2 — Signed commit: `.harness/contributors/<login>.json`
 *               on `user/<github_user_id>` branch must (a) exist,
 *               (b) carry a valid device-key signature over the JCS
 *               canonical body, and (c) have a GitHub-verified commit
 *               author whose login matches `github_login`.
 *
 * `verifyBoth()` runs both channels and derives the composite
 * `BindingStatus` via `deriveBindingStatus()` from binding-verifier-types.
 *
 * Types are in `binding-verifier-types.ts`; wire shapes for the
 * contributor file body are in `contributor-file-types.ts`.
 */

import { verify as nodeVerify } from 'node:crypto';
import {
  BindingVerificationResult,
  ChannelResult,
  deriveBindingStatus,
  PENDING_GRACE_WINDOW_MS,
  clampGraceWindowMs,
} from './binding-verifier-types';
import {
  ContributorFileBody,
  CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER,
  contributorFilePath,
  contributorBranchRef,
  isContributorFileBody,
  stripSignatureForSigning,
} from './contributor-file-types';

// ─── Channel 1 ────────────────────────────────────────────────────────────────

export interface VerifyChannel1Options {
  /** GitHub OAuth token scoped at least `read:user`. */
  token: string;
  /** The github user id the caller claims to have. */
  claimedGithubUserId: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Channel 1: verify a GitHub OAuth token identifies the claimed user.
 * Calls `GET /user` on GitHub's API and compares `id` to `claimedGithubUserId`.
 */
export async function verifyChannel1(
  opts: VerifyChannel1Options,
): Promise<ChannelResult> {
  const { token, claimedGithubUserId, fetchFn = fetch } = opts;
  try {
    const resp = await fetchFn('https://api.github.com/user', {
      headers: {
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (resp.status === 401) {
      return { kind: 'fail', reason: 'oauth_token_revoked' };
    }
    if (!resp.ok) {
      return { kind: 'fail', reason: 'github_api_down' };
    }
    const data = (await resp.json()) as { id?: unknown };
    if (typeof data.id !== 'number') {
      return { kind: 'fail', reason: 'github_api_down' };
    }
    if (data.id !== claimedGithubUserId) {
      return { kind: 'fail', reason: 'oauth_user_id_mismatch' };
    }
    return { kind: 'ok' };
  } catch {
    return { kind: 'fail', reason: 'github_api_down' };
  }
}

// ─── Channel 2 ────────────────────────────────────────────────────────────────

export interface VerifyChannel2Options {
  /** Owner of the GitHub repo (e.g. "myorg"). */
  repoOwner: string;
  /** Repo name (e.g. "myproject"). */
  repoName: string;
  /** The contributor's GitHub login (used to build the file path). */
  githubLogin: string;
  /** The contributor's numeric GitHub user id (used to build the branch ref). */
  githubUserId: number;
  /** Device public key (base64, raw 32 bytes) — must match the file body. */
  devicePubkeyBase64: string;
  /** OAuth token for reading the repo. */
  token?: string;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Channel 2: verify the contributor pushed a correctly-signed file to
 * their `user/<github_user_id>` branch on the shared repo. Three checks:
 *   a) File exists at `.harness/contributors/<login>.json`.
 *   b) The file's `signature_by_device` is valid Ed25519 over the
 *      JCS-canonical body (fields ordered per CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER).
 *   c) The latest commit on the file has a GitHub-verified author
 *      whose login matches `githubLogin`.
 */
export async function verifyChannel2(
  opts: VerifyChannel2Options,
): Promise<ChannelResult> {
  const {
    repoOwner,
    repoName,
    githubLogin,
    githubUserId,
    devicePubkeyBase64,
    token,
    fetchFn = fetch,
  } = opts;

  const branch = contributorBranchRef(githubUserId);
  const filePath = contributorFilePath(githubLogin);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers['Authorization'] = 'token ' + token;

  // Step 1: fetch the file content via the Contents API
  const contentsUrl =
    'https://api.github.com/repos/' +
    encodeURIComponent(repoOwner) +
    '/' +
    encodeURIComponent(repoName) +
    '/contents/' +
    encodeURIComponent(filePath) +
    '?ref=' +
    encodeURIComponent(branch);

  let fileBody: ContributorFileBody;
  let commitSha: string;
  try {
    const resp = await fetchFn(contentsUrl, { headers });
    if (resp.status === 404) {
      // Could be branch missing or file missing — both are channel2_file_missing
      return { kind: 'pending', reason: 'just_joined_channel2_propagating' };
    }
    if (!resp.ok) {
      return { kind: 'fail', reason: 'github_api_down' };
    }
    const data = (await resp.json()) as {
      content?: string;
      encoding?: string;
      sha?: string;
    };
    if (!data.content || data.encoding !== 'base64') {
      return { kind: 'fail', reason: 'channel2_file_missing' };
    }
    const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      return { kind: 'fail', reason: 'channel2_file_missing' };
    }
    if (!isContributorFileBody(parsed)) {
      return { kind: 'fail', reason: 'channel2_file_missing' };
    }
    fileBody = parsed;
    commitSha = data.sha ?? '';
  } catch {
    return { kind: 'fail', reason: 'github_api_down' };
  }

  // Step 2: verify the device signature over the JCS canonical body
  const sigValid = verifyContributorFileSignature(fileBody, devicePubkeyBase64);
  if (!sigValid) {
    return { kind: 'fail', reason: 'channel2_signature_invalid' };
  }

  // Step 3: verify the commit that added/updated the file has a
  // GitHub-verified signature and the author login matches
  if (!commitSha) {
    return { kind: 'fail', reason: 'channel2_file_missing' };
  }
  const commitUrl =
    'https://api.github.com/repos/' +
    encodeURIComponent(repoOwner) +
    '/' +
    encodeURIComponent(repoName) +
    '/commits/' +
    encodeURIComponent(commitSha);

  try {
    const resp = await fetchFn(commitUrl, { headers });
    if (!resp.ok) {
      return { kind: 'fail', reason: 'github_api_down' };
    }
    const data = (await resp.json()) as {
      author?: { login?: string } | null;
      commit?: { verification?: { verified?: boolean } };
    };
    if (data.author?.login !== githubLogin) {
      return { kind: 'fail', reason: 'channel2_commit_author_mismatch' };
    }
    if (!data.commit?.verification?.verified) {
      return { kind: 'fail', reason: 'channel2_commit_not_verified' };
    }
  } catch {
    return { kind: 'fail', reason: 'github_api_down' };
  }

  return { kind: 'ok' };
}

// ─── verifyBoth ───────────────────────────────────────────────────────────────

export interface VerifyBothOptions {
  channel1: VerifyChannel1Options;
  channel2: VerifyChannel2Options;
  /** When channel 2 first entered pending. Used for grace-window calc. */
  channel2PendingSince?: number;
  /** Grace window override (ms). Clamped by clampGraceWindowMs. */
  graceWindowMs?: number;
  /** Injectable wall-clock (ms) for tests. */
  nowMs?: number;
}

/**
 * Run both channels and derive the composite BindingVerificationResult.
 * Channel 1 and 2 run in parallel.
 */
export async function verifyBoth(
  opts: VerifyBothOptions,
): Promise<BindingVerificationResult> {
  const checkedAt = opts.nowMs ?? Date.now();
  const [channel1, channel2] = await Promise.all([
    verifyChannel1(opts.channel1),
    verifyChannel2(opts.channel2),
  ]);

  const status = deriveBindingStatus({
    channel1,
    channel2,
    channel2PendingSince: opts.channel2PendingSince,
    graceWindowMs: opts.graceWindowMs,
    nowMs: opts.nowMs,
  });

  const grace = clampGraceWindowMs(opts.graceWindowMs ?? PENDING_GRACE_WINDOW_MS);
  const pendingUntil =
    status === 'pending' ? (opts.channel2PendingSince ?? checkedAt) + grace : undefined;

  return { status, channel1, channel2, checkedAt, pendingUntil };
}

// ─── signature verification ───────────────────────────────────────────────────

/**
 * Verify the `signature_by_device` field in a contributor file body.
 * The signed payload is the JCS-canonicalized body with `signature_by_device`
 * stripped. Field order is CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER minus
 * `signature_by_device`.
 */
function verifyContributorFileSignature(
  body: ContributorFileBody,
  devicePubkeyBase64: string,
): boolean {
  try {
    const signingBody = stripSignatureForSigning(body);
    const canonical = jcsSerialize(signingBody);
    const payload = Buffer.from(canonical, 'utf8');
    const sig = Buffer.from(body.signature_by_device, 'base64');

    // Reconstruct the SPKI DER public key from raw 32-byte base64
    const rawPubkey = Buffer.from(devicePubkeyBase64, 'base64');
    if (rawPubkey.length !== 32) return false;
    const spkiDer = buildSpkiDer(rawPubkey);
    const { createPublicKey } = require('node:crypto') as typeof import('node:crypto');
    const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

    return nodeVerify(null, payload, publicKey, sig);
  } catch {
    return false;
  }
}

/**
 * Minimal JCS (RFC 8785) serializer for the ContributorFileBody signing
 * payload. The field order is CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER
 * (ascending Unicode code-point order per RFC 8785 §3.2). All values
 * in ContributorFileBody are primitives (string, number) — no nested
 * objects — so a simple field-ordered JSON.stringify is equivalent to
 * full JCS for this specific schema.
 */
function jcsSerialize(body: Omit<ContributorFileBody, 'signature_by_device'>): string {
  const signingFields = CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER.filter(
    (f) => f !== 'signature_by_device',
  );
  const ordered: Record<string, unknown> = {};
  for (const field of signingFields) {
    ordered[field] = (body as Record<string, unknown>)[field];
  }
  return JSON.stringify(ordered);
}

function buildSpkiDer(rawPubkey: Buffer): Buffer {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return Buffer.concat([prefix, rawPubkey]);
}
