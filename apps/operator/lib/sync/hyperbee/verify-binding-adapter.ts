/**
 * verify-binding-adapter — the real read-admission `verifyBinding` (Stage 4c).
 *
 * D-004 read-admission admits a peer's log IFF its announce sig verifies AND
 * `device_pubkey` ↔ the announced GitHub identity is a valid TWO-CHANNEL
 * binding for ANY real GitHub identity (no collaborator gate). The pure decider
 * (`read-admission.ts`) injects `verifyBinding(devicePubkey, githubLogin,
 * githubUserId)`; this module builds the real adapter over `verifyBoth`.
 *
 * `verifyBoth` needs context the announce does NOT carry — the SHARED repo's
 * `{repoOwner, repoName}` and an OAuth `token`:
 *   - repoOwner/repoName come from the LOCAL harness's `.harness/shared.json`
 *     `github_remote` (this is the repo whose `user/<id>` branch holds the
 *     remote peer's signed contributor file — channel 2 reads it there).
 *   - token comes from the local `gh` auth (the same `getGhAuthToken` the
 *     publish proxy uses).
 * Both are resolved once and cached (a harness's bound repo + the local token
 * don't change within a boot). The announce supplies the per-peer inputs
 * (devicePubkeyBase64, githubLogin, githubUserId).
 *
 * Admits ONLY on `status === 'verified'` — `'pending'` (channel-2 still
 * propagating) and `'failed'` are NOT admitted at the substrate gate.
 *
 * Fail-closed: if the harness context can't resolve (no shared.json / no gh
 * auth), the adapter admits nothing.
 */

import { resolveHarnessPaths } from '@/lib/resolve-harness-paths';
import { loadSharedConfigFromProjectDir } from '@/lib/harness/load-shared-config';
import { parseGithubUrl } from '@/lib/harness/clone-github';
import { getGhAuthToken } from '@/lib/identity/gh-token';
import { verifyBoth, type VerifyBothOptions } from '@/lib/identity/two-channel-verifier';

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
  /** Override the two-channel verifier (tests). Defaults to `verifyBoth`. */
  verifyBothImpl?: (opts: VerifyBothOptions) => Promise<{ status: 'verified' | 'pending' | 'failed' }>;
}

/**
 * The signature `makeAdmissionDecider` expects: given the announce's
 * device pubkey + GitHub login + numeric id, return true iff the two-channel
 * binding verifies.
 */
export type VerifyBinding = (
  devicePubkeyBase64: string,
  githubLogin: string,
  githubUserId: number,
) => Promise<boolean>;

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
  const verify = opts.verifyBothImpl ?? verifyBoth;

  let ctxPromise: Promise<{ repoOwner: string; repoName: string; token: string } | null> | null = null;

  return async (
    devicePubkeyBase64: string,
    githubLogin: string,
    githubUserId: number,
  ): Promise<boolean> => {
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
      return false;
    }
    const result = await verify({
      channel1: {
        token: ctx.token,
        claimedGithubUserId: githubUserId,
      },
      channel2: {
        repoOwner: ctx.repoOwner,
        repoName: ctx.repoName,
        githubLogin,
        githubUserId,
        devicePubkeyBase64,
        token: ctx.token,
      },
    });
    // 'pending' + 'failed' are NOT admitted at the substrate gate.
    return result.status === 'verified';
  };
}
