/**
 * verify-binding-adapter — the real read-admission `verifyBinding` (Stage 4c).
 *
 * D-002 (admission gate): read-admission verifies the REMOTE-VERIFIABLE
 * channel-2 ONLY (a publicly-readable, device-signed contributor file whose
 * commit GitHub marks verified + authored by that login). Channel-1 is a
 * self-attestation a remote peer can't run; it stays for the publish/self path
 * and has been removed from admission.
 *
 * D-004 read-admission admits a peer's log IFF its announce sig verifies AND
 * `device_pubkey` ↔ the announced GitHub identity is a valid channel-2 binding
 * for ANY real GitHub identity (no collaborator gate). The pure decider
 * (`read-admission.ts`) injects `verifyBinding(devicePubkey, githubLogin,
 * githubUserId)` returning `'verified' | 'pending' | 'fail'`; this module
 * builds the real adapter over `verifyChannel2`.
 *
 * `verifyChannel2` needs context the announce does NOT carry — the SHARED repo's
 * `{repoOwner, repoName}` and an OAuth `token`:
 *   - repoOwner/repoName come from the LOCAL harness's `.harness/shared.json`
 *     `github_remote` (this is the repo whose `user/<id>` branch holds the
 *     remote peer's signed contributor file).
 *   - token comes from the local `gh` auth (the same `getGhAuthToken` the
 *     publish proxy uses).
 * Both are resolved once and cached (a harness's bound repo + the local token
 * don't change within a boot). The announce supplies the per-peer inputs
 * (devicePubkeyBase64, githubLogin, githubUserId).
 *
 * Returns a 3-state result:
 *   - `'verified'` : channel-2 passed → the peer is admitted.
 *   - `'pending'`  : channel-2 file not yet visible on GitHub (propagation lag
 *                   → the boot pending-retry loop re-verifies within a grace window).
 *   - `'fail'`     : channel-2 conclusively failed → not admitted.
 *
 * Fail-closed: if the harness context can't resolve (no shared.json / no gh
 * auth), the adapter returns `'fail'` — admits nothing.
 */

import { resolveHarnessPaths } from '@/lib/resolve-harness-paths';
import { loadSharedConfigFromProjectDir } from '@/lib/harness/load-shared-config';
import { parseGithubUrl } from '@/lib/harness/clone-github';
import { getGhAuthToken } from '@/lib/identity/gh-token';
import { verifyChannel2, type VerifyChannel2Options } from '@/lib/identity/two-channel-verifier';
import type { ChannelResult } from '@/lib/identity/binding-verifier-types';

export interface VerifyBindingAdapterOpts {
  workspaceId: string;
  harnessSlug: string;
  workspaceRoot: string;
  /**
   * Resolve the local harness's shared-repo context (owner/repo + gh token).
   * Defaults to the shared.json + gh-token path. Injectable for tests.
   * Returns null when the harness isn't shared / gh isn't authed (fail-closed).
   */
  resolveContext?: () => Promise<{ repoOwner: string; repoName: string; token: string } | null>;
  /**
   * Override the channel-2 verifier (tests). Defaults to `verifyChannel2`.
   * Replaces the old `verifyBothImpl` seam — admission now runs channel-2 only
   * (D-002); channel-1 remains in the publish/self path but not here.
   */
  verifyChannel2Impl?: (opts: VerifyChannel2Options) => Promise<ChannelResult>;
}

/**
 * The signature `makeAdmissionDecider` expects: given the announce's
 * device pubkey + GitHub login + numeric id, return 'verified' | 'pending' | 'fail'.
 * Channel-2-only (D-002): a remote peer can verify a publicly-readable,
 * device-signed contributor file; channel-1 OAuth is a self-attestation
 * that only the local peer can run and is not applicable for remote admission.
 */
export type VerifyBinding = (
  devicePubkeyBase64: string,
  githubLogin: string,
  githubUserId: number,
) => Promise<'verified' | 'pending' | 'fail'>;

async function defaultResolveContext(
  opts: VerifyBindingAdapterOpts,
): Promise<{ repoOwner: string; repoName: string; token: string } | null> {
  // Resolve the harness's on-disk project dir → shared.json → github_remote.
  let projectDir: string;
  try {
    const resolved = await resolveHarnessPaths(opts.harnessSlug, opts.workspaceId);
    projectDir = resolved.projectDir;
  } catch {
    return null;
  }
  if (!projectDir || projectDir.startsWith('/tmp/papercusp-unresolved/')) return null;
  const cfg = loadSharedConfigFromProjectDir(projectDir);
  if (!cfg) return null;
  const parsed = parseGithubUrl(cfg.github_remote);
  if (!parsed) return null;
  const tok = await getGhAuthToken();
  if (tok.kind !== 'ok') return null;
  return { repoOwner: parsed.owner, repoName: parsed.repo, token: tok.token };
}

/**
 * Build the read-admission `verifyBinding`. The harness context is resolved
 * once on first call and memoized for the boot's lifetime.
 */
export function buildVerifyBindingAdapter(opts: VerifyBindingAdapterOpts): VerifyBinding {
  const resolveContext = opts.resolveContext ?? (() => defaultResolveContext(opts));
  const verify = opts.verifyChannel2Impl ?? verifyChannel2;

  let ctxPromise: Promise<{ repoOwner: string; repoName: string; token: string } | null> | null = null;

  return async (
    devicePubkeyBase64: string,
    githubLogin: string,
    githubUserId: number,
  ): Promise<'verified' | 'pending' | 'fail'> => {
    // Boot-scoped cache: {repoOwner, repoName, token} is resolved once and held
    // for the boot's lifetime. ASSUMPTION (acceptable for alpha): the gh token
    // doesn't expire mid-boot. If it does, this adapter keeps using the stale
    // token and rejects otherwise-valid peers until the harness reboots —
    // there is no in-boot token refresh. A non-null ctx is never re-resolved.
    if (!ctxPromise) ctxPromise = resolveContext();
    const ctx = await ctxPromise;
    if (!ctx) {
      // No harness context (private / no gh auth) → fail closed.
      // Reset so a later boot phase that gains context can retry.
      ctxPromise = null;
      return 'fail';
    }
    // D-002: channel-2 only. Channel-1 (OAuth GET /user) is a self-attestation
    // the LOCAL peer runs for publish/self; a remote peer can't run it for
    // another peer's token and it always fails with oauth_user_id_mismatch
    // when a different engineer's id is passed with the local token. Only
    // channel-2 (publicly-readable device-signed contributor file) is remote-verifiable.
    const result = await verify({
      repoOwner: ctx.repoOwner,
      repoName: ctx.repoName,
      githubLogin,
      githubUserId,
      devicePubkeyBase64,
      token: ctx.token,
    });
    if (result.kind === 'ok') return 'verified';
    if (result.kind === 'pending') return 'pending';
    return 'fail';
  };
}
