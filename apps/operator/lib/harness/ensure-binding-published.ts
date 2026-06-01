/**
 * ensure-binding-published — ensures the caller's device-signed contributor
 * file is published to the shared GitHub repo via a GitHub-verified commit.
 *
 * ## Why the GitHub Contents API (Plan Open-Risk R-1)
 * `two-channel-verifier.ts` `verifyChannel2` requires the commit that
 * published the contributor file to be GitHub-**verified**
 * (`commit.verification.verified === true`) and authored by the token's
 * user. A plain local `git commit` + push produces an UNVERIFIED commit.
 * Publishing via `octokit.rest.repos.createOrUpdateFileContents` (PUT
 * /repos/{owner}/{repo}/contents/{path}) goes through GitHub's web-flow,
 * which creates a GitHub-signed, web-flow-authored commit → verified. Do
 * NOT shell out to git here.
 *
 * ## R-1 tripwire
 * The `verification.verified === true` property is a GitHub *runtime*
 * behavior and CANNOT be asserted in an offline unit test (the Octokit is
 * faked). It is verified by DESIGN (we use `createOrUpdateFileContents`,
 * never local git). Live verification is left to manual / integration
 * acceptance.
 *
 * ## Idempotency
 * If the file already exists AND carries the current `device_pubkey` AND
 * its `signature_by_device` verifies → returns without a PUT. Otherwise
 * (file missing, wrong pubkey, or invalid sig) → PUT (create or update).
 *
 * Both the share path (publisher) and the join path (joiner) call this
 * function so neither can forget to publish — the mutual-binding fix.
 */

import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import {
  contributorFilePath,
  contributorBranchRef,
  buildSignedContributorFile,
  isContributorFileBody,
  CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER,
} from '../identity/contributor-file-types';
import { getOctokit } from '../identity/octokit-client';
import type { Octokit } from '@octokit/rest';

// ─── public types ─────────────────────────────────────────────────────────────

export interface EnsureBindingOpts {
  /** Owner of the shared GitHub repo (e.g. "myorg"). */
  repoOwner: string;
  /** Name of the shared GitHub repo (e.g. "shared-harness"). */
  repoName: string;
  /** GitHub identity of the publisher. */
  identity: {
    /** GitHub OAuth token — used to authenticate Octokit when `octokit`
     * is not provided (the default `getOctokit()` path). Not used when
     * `octokit` is injected. */
    token: string;
    /** Stable numeric GitHub user id — forms the branch name. */
    githubUserId: number;
    /** GitHub login — forms the file path. */
    githubLogin: string;
  };
  /** Keychain id passed verbatim to `sign`. */
  keychainId: string;
  /** Raw 32-byte Ed25519 public key, base64-encoded. */
  devicePubkeyBase64: string;
  /**
   * Signing callback. Receives the JCS-canonical payload bytes; returns
   * the raw signature bytes. In production this wraps a keychain signer;
   * in tests it wraps a generated Ed25519 key — no OS keychain dependency.
   */
  sign: (keychainId: string, payload: Buffer) => Promise<Buffer>;
  /** Default branch of the shared repo. Used to seed the new branch when
   * `user/<githubUserId>` doesn't exist yet. */
  defaultBranch: string;
  /** Channel-1 attestation gist id. Embedded in the contributor file body. */
  attestationGistId?: string;
  /**
   * Injectable Octokit instance for tests (avoids gh-token resolution).
   * Typed as `unknown` so callers don't have to import `@octokit/rest` —
   * we cast internally.
   */
  octokit?: unknown;
}

export interface EnsureBindingResult {
  /** The device pubkey that was published (always present). */
  devicePubkeyBase64: string;
  /** SHA of the GitHub commit that published the file. Only present when
   * a PUT was performed (absent on no-op idempotent return). */
  commitSha?: string;
}

// ─── main function ────────────────────────────────────────────────────────────

/**
 * Ensure the caller's contributor file is published to the shared GitHub
 * repo as a GitHub-verified commit.
 *
 * 1. Resolves the Octokit instance (injected or from `getOctokit()`).
 * 2. Ensures the `user/<githubUserId>` branch exists (creates from
 *    `defaultBranch` HEAD if absent).
 * 3. Builds + signs the contributor file body via `buildSignedContributorFile`.
 * 4. Checks idempotency: if the file already exists with the same
 *    `device_pubkey` and a valid signature, returns without a PUT.
 * 5. Otherwise creates or updates the file via the Contents API (GitHub
 *    web-flow commit → verified).
 */
export async function ensureMyBindingPublished(
  opts: EnsureBindingOpts,
): Promise<EnsureBindingResult> {
  // ── 1. Resolve Octokit ──────────────────────────────────────────────────────
  const octokit = (opts.octokit as Octokit | undefined) ?? (await getOctokit());
  if (!octokit) {
    throw new Error(
      'ensureMyBindingPublished: no Octokit instance available — ' +
        'either inject opts.octokit or ensure gh CLI is authenticated (`gh auth login`).',
    );
  }
  const oc = octokit as Octokit;

  const { repoOwner: owner, repoName: repo, identity, defaultBranch } = opts;
  const branch = contributorBranchRef(identity.githubUserId);
  const path = contributorFilePath(identity.githubLogin);

  // ── 2. Ensure branch exists ─────────────────────────────────────────────────
  await ensureBranchExists(oc, owner, repo, branch, defaultBranch);

  // ── 3. Build + sign the contributor file body ───────────────────────────────
  const fileBody = await buildSignedContributorFile({
    githubUserId: identity.githubUserId,
    githubLogin: identity.githubLogin,
    devicePubkeyBase64: opts.devicePubkeyBase64,
    attestationGistId: opts.attestationGistId ?? '',
    sign: opts.sign,
    keychainId: opts.keychainId,
  });

  // ── 4. Idempotency: check existing file ─────────────────────────────────────
  let existingSha: string | undefined;
  try {
    const contentRes = await oc.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });
    const data = contentRes.data as {
      content?: string;
      encoding?: string;
      sha?: string;
    } | undefined;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      existingSha = data.sha;
      if (data.content && data.encoding === 'base64') {
        const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
        let existing: unknown;
        try {
          existing = JSON.parse(decoded);
        } catch {
          // malformed — fall through to PUT
        }
        if (
          isContributorFileBody(existing) &&
          existing.device_pubkey === `ed25519:${opts.devicePubkeyBase64}` &&
          verifySignatureOffline(existing, opts.devicePubkeyBase64)
        ) {
          // Already published with the correct key + valid sig → no-op.
          return { devicePubkeyBase64: opts.devicePubkeyBase64 };
        }
      }
    }
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 404) {
      throw err;
    }
    // 404 = file (or branch) doesn't exist → fall through to PUT
  }

  // ── 5. PUT via Contents API (GitHub-verified commit) ────────────────────────
  const content = Buffer.from(JSON.stringify(fileBody, null, 2) + '\n', 'utf8').toString('base64');
  const message = `chore: publish contributor binding for ${identity.githubLogin}`;

  const putRes = await oc.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message,
    content,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  const commitSha = (putRes.data as { commit?: { sha?: string } }).commit?.sha;
  return { devicePubkeyBase64: opts.devicePubkeyBase64, commitSha };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Ensure the given branch ref exists. If it doesn't, create it from the
 * HEAD of `defaultBranch`.
 *
 * 404-detection: Octokit throws a `RequestError` with `.status === 404`
 * when the ref doesn't exist. We catch it on that exact status code.
 */
async function ensureBranchExists(
  oc: Octokit,
  owner: string,
  repo: string,
  branch: string,
  defaultBranch: string,
): Promise<void> {
  // Strip the leading `refs/heads/` prefix if present — getRef takes the
  // short form: `heads/<branch>`.
  const shortRef = branch.startsWith('refs/heads/')
    ? branch.slice('refs/heads/'.length)
    : branch;
  const fullRef = 'refs/heads/' + shortRef;

  try {
    await oc.rest.git.getRef({ owner, repo, ref: `heads/${shortRef}` });
    // Branch exists — nothing to do.
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 404) throw err;

    // Branch doesn't exist → get default branch HEAD and create.
    const defaultRef = await oc.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });
    const headSha = (defaultRef.data as { object?: { sha?: string } }).object?.sha;
    if (!headSha) {
      throw new Error(
        `ensureMyBindingPublished: could not resolve HEAD sha of '${defaultBranch}'`,
      );
    }
    await oc.rest.git.createRef({
      owner,
      repo,
      ref: fullRef,
      sha: headSha,
    });
  }
}

/**
 * Verify the `signature_by_device` in a contributor file body offline
 * (without GitHub API calls). Mirrors the logic in `two-channel-verifier.ts`
 * `verifyContributorFileSignature`.
 *
 * Returns `true` when the signature is valid; `false` on any error or
 * invalid signature.
 */
function verifySignatureOffline(
  body: import('../identity/contributor-file-types').ContributorFileBody,
  devicePubkeyBase64: string,
): boolean {
  try {
    // Reconstruct the signing payload (JCS-canonical, sig field omitted).
    const signingFields = (CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER as readonly string[]).filter(
      (f) => f !== 'signature_by_device',
    );
    const ordered: Record<string, unknown> = {};
    for (const f of signingFields) {
      ordered[f] = (body as Record<string, unknown>)[f];
    }
    const payload = Buffer.from(JSON.stringify(ordered), 'utf8');
    const sig = Buffer.from(body.signature_by_device, 'base64');

    // Reconstruct SPKI DER public key from raw 32-byte base64.
    // SPKI prefix for Ed25519: 302a300506032b6570032100 (12 bytes).
    const rawPubkey = Buffer.from(devicePubkeyBase64, 'base64');
    if (rawPubkey.length !== 32) return false;
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer = Buffer.concat([spkiPrefix, rawPubkey]);
    const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

    return nodeVerify(null, payload, publicKey, sig);
  } catch {
    return false;
  }
}
