/**
 * POST /api/harness/:slug/share/finalize — write `.papercusp/shared.json`
 * (Phase 11 P-077, the missing finalize link).
 *
 * The ShareWizard's final step POSTs here with `{ state }` (the collected
 * ShareWizardState). Until now the route didn't exist, so `.papercusp/shared.json`
 * was never written and every harness booted `swarm: null` — boot-all's
 * `defaultResolveSwarmBinding` reads exactly this file and keys the swarm on
 * `github_repository_id`. Writing a valid config IS the "go shared" flip:
 * there is no separate registry `state` column (every consumer — boot, discord,
 * projects `is_shared` — derives shared-ness from the file's presence).
 *
 * Core logic is `finalizeShare(input, deps)` (deps injected) so it's unit-
 * testable without fs/registry; the defineTool handler wires the real impls and
 * maps the ShareWizard `{ state }` body onto it.
 *
 * NOTE the topic in shared.json is for the human `papercusp://harness?...` link
 * + diagnostics only — boot DERIVES its swarm topic from github_repository_id
 * (derive-swarm-topic.ts), so what matters for going online is a valid config
 * with the right repo id.
 *
 * Going online without a host restart: an already-booted harness caches its
 * handle (`bootSingleHarness` returns `already-booted` and never re-resolves
 * the swarm binding), so just writing the file wouldn't make a running harness
 * join the swarm. This route therefore reboots the harness after the write
 * (`rebootHarness` = closeBootedHarness + bootSingleHarness) so the next boot
 * re-resolves the now-present config and joins the derived topic. (The Model B
 * substrate always boots — Stage 4d removed the opt-in gate.) This is safe
 * in-process: the finalize route and the booted-handle map both live in the
 * hono-host (`bin/host-bootstrap.ts` boots the substrate there). The reboot is
 * best-effort — a failure never fails the write; the file is the source of
 * truth and a host restart would still bring it online.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolveHarnessPaths } from '../../../resolve-harness-paths';
import {
  buildFreshConfig,
  isHarnessSharedConfig,
  HARNESS_SHARED_CONFIG_REL_PATH,
  HARNESS_SHARED_PRIVACY_LEVELS,
  type HarnessSharedConfig,
  type HarnessSharedPrivacy,
} from '../../../harness/harness-shared-config-types';
import type { BindingClaimStatus } from '../../../harness/binding-types';

/**
 * Result of the publisher-binding publish seam (`ensureBinding` dep below).
 * Write-free (non-collaborator-join-fork-pr-2026-06-02): publishing the
 * publisher's binding ensures its attestation GIST exists — there is no
 * shared-repo write — and `devicePubkeyBase64` is the device key it attests.
 * The value is informational: `finalizeShare` only flips `bindingPublished`
 * on success and never reads the returned fields.
 */
export interface EnsureBindingResult {
  /** The device pubkey whose attestation gist was ensured (base64, raw 32 bytes). */
  devicePubkeyBase64: string;
}

export interface FinalizeShareInput {
  slug: string;
  topic: string;
  github_remote: string;
  github_repository_id: number;
  privacy?: HarnessSharedPrivacy;
  discord_channel?: string;
}

/** Outcome of the post-write substrate reboot. */
export interface FinalizeShareSwarm {
  /** True if a reboot was attempted. With `realDeps` the substrate always
   *  boots (Stage 4d removed the opt-in gate), so this is always true; a
   *  custom `deps` that omits `reboot` leaves `swarm` undefined instead. */
  rebooted: boolean;
  /** The (re)boot state — 'booted' | 'already-booted' | 'failed'. */
  state?: 'booted' | 'already-booted' | 'failed';
  /** Boot/reboot error message, if any. */
  error?: string;
}

/** Outcome of the post-write unclaimed-binding creation (claim/dedup system). */
export interface FinalizeShareBinding {
  /** True if a new unclaimed binding row was created this finalize. */
  created: boolean;
  /** Claim status of the created OR pre-existing binding, when known. */
  claim_status?: BindingClaimStatus;
  /** True if a binding already existed for this repo (BINDING_EXISTS). */
  already_existed?: boolean;
  /** Error message if creation failed (e.g. no gh-token / GitHub down). */
  error?: string;
}

export interface FinalizeShareResult {
  ok: true;
  shared_config: HarnessSharedConfig;
  path: string;
  /**
   * Present when a substrate reboot was attempted after the write. Tells the
   * ShareWizard whether the harness is now joining the swarm in-process
   * (rebooted, state 'booted') or whether a host restart is still needed.
   */
  swarm?: FinalizeShareSwarm;
  /**
   * Present when binding-row creation was attempted after the write. Records
   * whether this engineer became the provisional owner, or a binding already
   * existed (someone shared this repo first), or creation failed.
   */
  binding?: FinalizeShareBinding;
  /**
   * True when the publisher's device-signed contributor file was successfully
   * published to the shared GitHub repo (mutual binding, D-003). Absent when
   * the `ensureBinding` dep was not provided.
   */
  bindingPublished?: boolean;
  /**
   * Set when the publisher binding publish was attempted but failed (including
   * when gh auth is unavailable). The share itself still succeeds — this is a
   * non-fatal warning. Absent when the publish succeeded or was not attempted.
   */
  bindingWarning?: string;
  /**
   * Outcome of the best-effort git-commit of shared.json (#2 follow-up).
   * Absent when the `commitSharedJson` dep was not provided.
   */
  commit?: FinalizeShareCommit;
}

/** Outcome of committing shared.json into the harness repo (best-effort). */
export interface FinalizeShareCommit {
  /** True when a commit was actually created. */
  committed: boolean;
  /** The new commit SHA, when committed. */
  commit_sha?: string;
  /** Why no commit was made (nothing to commit, not a git repo, error, …). */
  reason?: string;
}

export interface FinalizeShareDeps {
  /** slug → { projectDir, stateDir } (PG-canonical via resolveHarnessPaths). */
  resolvePaths: (slug: string) => Promise<{ projectDir: string; stateDir: string }>;
  mkdirp: (dir: string) => Promise<void>;
  writeFileUtf8: (absPath: string, contents: string) => Promise<void>;
  now: () => number;
  /**
   * Optional: re-boot the harness substrate after the file is written so an
   * already-booted (swarm: null) harness joins the swarm without a host
   * restart. Best-effort — a throw is caught and reported as
   * `{ rebooted: false, error }`. Omit to skip the reboot entirely (then no
   * `swarm` is returned). `realDeps` always provides it — the substrate
   * always boots (Stage 4d), so the reboot is unconditional there.
   */
  reboot?: (slug: string) => Promise<FinalizeShareSwarm>;
  /**
   * Optional: create the unclaimed binding row (claim/dedup system) for this
   * repo. Best-effort — a throw is caught and reported as
   * `{ created: false, error }`; a pre-existing binding (BINDING_EXISTS) is
   * reported as `{ created: false, already_existed: true }`. Needs gh auth
   * (hits GitHub). Independent of the substrate flag. Omit to skip.
   */
  createBinding?: (args: {
    slug: string;
    github_remote: string;
    harness_topic: string;
    privacy: HarnessSharedPrivacy;
  }) => Promise<FinalizeShareBinding>;
  /**
   * Optional: publish the publisher's own device-signed contributor file to
   * the shared GitHub repo (mutual binding, D-003). Best-effort — a throw is
   * caught and recorded as `bindingWarning`; the share itself + reboot still
   * succeed. Omit to skip (no `bindingPublished` / `bindingWarning` in result).
   *
   * Called AFTER shared.json is written and the repo owner/name are known,
   * BEFORE the reboot (so the publisher binding is on GitHub before joiners
   * arrive after the substrate announces).
   *
   * Returns `{ devicePubkeyBase64, commitSha? }` on success.
   */
  ensureBinding?: (args: {
    repoOwner: string;
    repoName: string;
    defaultBranch: string;
    github_remote: string;
  }) => Promise<EnsureBindingResult>;
  /**
   * Optional: git-commit the shared.json we just wrote, so a completed share
   * leaves a clean COMMITTED state rather than a dangling untracked file (which
   * otherwise only lands in git when an unrelated commit sweeps the tree).
   * Commits ONLY shared.json (scoped pathspec) so it never sweeps unrelated
   * work-in-progress into the share commit. Best-effort — a throw (not a git
   * repo, mid-rebase, nothing to commit, …) is caught and recorded as
   * `commit.committed=false`. Called right AFTER the write. Omit to skip.
   */
  commitSharedJson?: (args: {
    projectDir: string;
    absPath: string;
  }) => Promise<FinalizeShareCommit>;
}

/** Raised on bad input / unknown harness; the handler maps it to a 4xx. */
export class FinalizeShareError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FinalizeShareError';
  }
}

/**
 * Write `.papercusp/shared.json` for `slug`. Returns the written config + path.
 * Throws FinalizeShareError (mapped to 4xx) on bad input or an unregistered
 * slug — never writes a half-shared / out-of-tree file.
 */
export async function finalizeShare(
  input: FinalizeShareInput,
  deps: FinalizeShareDeps,
): Promise<FinalizeShareResult> {
  if (!input.slug) throw new FinalizeShareError('slug required', 400);

  const privacy: HarnessSharedPrivacy = input.privacy ?? 'shared-private';
  if (!(HARNESS_SHARED_PRIVACY_LEVELS as readonly string[]).includes(privacy)) {
    throw new FinalizeShareError(`invalid privacy: ${privacy}`, 400);
  }

  // buildFreshConfig is the single builder + validator (throws TypeError on a
  // bad topic / empty remote / non-positive repo id) — map those to 400.
  let config: HarnessSharedConfig;
  try {
    config = buildFreshConfig({
      topic: input.topic,
      github_remote: input.github_remote,
      github_repository_id: input.github_repository_id,
      privacy,
      now: deps.now(),
      ...(input.discord_channel ? { discord_channel: input.discord_channel } : {}),
    });
  } catch (e) {
    throw new FinalizeShareError(
      `invalid shared-harness config: ${e instanceof Error ? e.message : String(e)}`,
      400,
    );
  }
  // Defensive: the on-disk file must pass the same predicate every reader uses.
  if (!isHarnessSharedConfig(config)) {
    throw new FinalizeShareError('built config failed validation', 400);
  }

  const { projectDir, stateDir } = await deps.resolvePaths(input.slug);
  if (projectDir.startsWith('/tmp/papercusp-unresolved/')) {
    throw new FinalizeShareError(`unknown harness slug: ${input.slug}`, 404);
  }

  await deps.mkdirp(stateDir);
  const absPath = join(projectDir, HARNESS_SHARED_CONFIG_REL_PATH);
  await deps.writeFileUtf8(absPath, JSON.stringify(config, null, 2));

  // Persist the share into git (best-effort, #2): commit ONLY shared.json so a
  // completed share leaves a clean committed state instead of a dangling
  // untracked file that only lands in git when an unrelated commit sweeps the
  // tree. Never fails the finalize — the on-disk file is already authoritative.
  let commit: FinalizeShareCommit | undefined;
  if (deps.commitSharedJson) {
    try {
      commit = await deps.commitSharedJson({ projectDir, absPath });
    } catch (e) {
      commit = { committed: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  // Publisher binding side effect (best-effort, D-003): publish the publisher's
  // own device-signed contributor file to the shared GitHub repo. This makes
  // verification symmetric — joiners can now read the publisher's contributor
  // file from the `user/<id>` branch and complete channel-2 verification.
  // Non-fatal: a missing gh token or GitHub outage must not block the share.
  let bindingPublished: boolean | undefined;
  let bindingWarning: string | undefined;
  if (deps.ensureBinding) {
    const parsed = parseGithubRemoteForBinding(input.github_remote);
    if (parsed) {
      try {
        await deps.ensureBinding({
          repoOwner: parsed.owner,
          repoName: parsed.repo,
          defaultBranch: parsed.defaultBranch,
          github_remote: input.github_remote,
        });
        bindingPublished = true;
      } catch (e) {
        bindingWarning = e instanceof Error ? e.message : String(e);
      }
    } else {
      bindingWarning = `could not parse github_remote for binding: ${input.github_remote}`;
    }
  }

  // Claim-system side effect (best-effort): create the unclaimed binding row so
  // dedup + provisional ownership work. Never fails the finalize — the file is
  // the swarm-critical artifact; the binding row is the claim layer on top.
  let binding: FinalizeShareBinding | undefined;
  if (deps.createBinding) {
    try {
      binding = await deps.createBinding({
        slug: input.slug,
        github_remote: input.github_remote,
        harness_topic: config.topic,
        privacy,
      });
    } catch (e) {
      binding = { created: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Going-online side effect (best-effort): reboot the harness so an already-
  // booted handle re-resolves its swarm binding from the file we just wrote.
  // Never fails the finalize — the file is written and authoritative.
  let swarm: FinalizeShareSwarm | undefined;
  if (deps.reboot) {
    try {
      swarm = await deps.reboot(input.slug);
    } catch (e) {
      swarm = { rebooted: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    ok: true,
    shared_config: config,
    path: absPath,
    ...(swarm ? { swarm } : {}),
    ...(binding ? { binding } : {}),
    ...(bindingPublished !== undefined ? { bindingPublished } : {}),
    ...(bindingWarning !== undefined ? { bindingWarning } : {}),
    ...(commit !== undefined ? { commit } : {}),
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a GitHub remote URL into { owner, repo, defaultBranch } for the
 * publisher binding publish. Uses `parseGithubUrl` (the same parser used by
 * clone-github). `defaultBranch` is always 'main' for the publisher path —
 * the repo was just shared and is under the publisher's control; the shared.json
 * already confirms it exists. A Octokit `repos.get` round-trip is not worth the
 * extra latency here; 'main' is the universal default for Papercusp-shared repos.
 */
function parseGithubRemoteForBinding(
  github_remote: string,
): { owner: string; repo: string; defaultBranch: string } | null {
  const HTTPS_RE =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?\/?$/;
  const SSH_RE =
    /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?$/;
  const trimmed = github_remote.trim();
  let m = HTTPS_RE.exec(trimmed) ?? SSH_RE.exec(trimmed);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!owner || !repo) return null;
  return { owner, repo, defaultBranch: 'main' };
}

const realDeps: FinalizeShareDeps = {
  resolvePaths: (slug) => resolveHarnessPaths(slug, activeWorkspaceId()),
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFileUtf8: (absPath, contents) => writeFile(absPath, contents, 'utf8'),
  now: () => Date.now(),
  // Commit ONLY shared.json (scoped pathspec) so the share lands deterministically
  // in git instead of waiting for an unrelated commit to sweep the tree — and so it
  // never packages unrelated work-in-progress. Best-effort: not-a-git-repo /
  // nothing-to-commit / errors are returned, never thrown. `--no-verify` per the
  // repo's commit convention (CLAUDE.md).
  commitSharedJson: async ({ projectDir, absPath }) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { relative } = await import('node:path');
    const run = promisify(execFile);
    const rel = relative(projectDir, absPath);
    try {
      await run('git', ['-C', projectDir, 'rev-parse', '--is-inside-work-tree']);
    } catch {
      return { committed: false, reason: 'not a git repository' };
    }
    try {
      // Check status vs HEAD BEFORE staging: if nothing changed, return without
      // a `git add`, so the nothing-to-commit path never leaves shared.json
      // staged in the index (an unrelated later commit would otherwise sweep it
      // up — violating this function's scoped-commit guarantee). Untracked (`??`)
      // and modified (` M`) both show non-empty here.
      const { stdout: status } = await run('git', [
        '-C', projectDir, 'status', '--porcelain', '--', rel,
      ]);
      if (status.trim() === '') {
        return { committed: false, reason: 'nothing to commit (shared.json unchanged)' };
      }
      await run('git', ['-C', projectDir, 'add', '--', rel]);
      await run('git', [
        '-C', projectDir,
        'commit', '--no-verify', '-m', `chore(share): record ${rel}`, '--', rel,
      ]);
      const { stdout: sha } = await run('git', ['-C', projectDir, 'rev-parse', 'HEAD']);
      return { committed: true, commit_sha: sha.trim() };
    } catch (e) {
      return { committed: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },
  // Reboot the harness in-process so it joins the swarm immediately. The Model
  // B substrate always boots (the PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE gate was
  // removed in Stage 4d), so the reboot always runs — picking up the freshly
  // written shared.json so the harness derives its swarm topic + announces.
  reboot: async (slug) => {
    const { rebootHarness } = await import('../../../sync/hyperbee/boot-all');
    const r = await rebootHarness(activeWorkspaceId(), slug);
    return {
      rebooted: true,
      state: r.boot.state,
      ...(r.boot.error ? { error: r.boot.error } : {}),
    };
  },
  // Create the unclaimed binding row (claim/dedup). BINDING_EXISTS (someone
  // shared this repo first) is reported, not thrown. Hits GitHub via the
  // binding service; a missing gh-token surfaces as { created: false, error }.
  createBinding: async ({ slug, github_remote, harness_topic, privacy }) => {
    try {
      const { createUnclaimedBinding } = await import('../../../harness/binding-service');
      const rec = await createUnclaimedBinding({
        githubUrl: github_remote,
        privacy,
        harness_topic,
        harness_slug: slug,
      });
      return { created: true, claim_status: rec.claim_status };
    } catch (e) {
      const { BindingServiceErrorThrowable } = await import('../../../harness/binding-types');
      if (e instanceof BindingServiceErrorThrowable && e.error.code === 'BINDING_EXISTS') {
        return {
          created: false,
          already_existed: true,
          claim_status: e.error.binding.claim_status,
        };
      }
      return { created: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
  // Publish the publisher's own device-signed contributor file (D-003, mutual
  // binding). Mirrors the join path (join-shared-harness.ts stepPublishBinding
  // + step1_oauthAttest). Uses the same signWithDeviceKey signer as the join
  // path and announce path (local-announce-identity.ts). Non-fatal — callers
  // catch errors and surface them as bindingWarning.
  ensureBinding: async () => {
    const { resolveLocalGithubIdentity } = await import('../../../identity/resolve-local-github-identity');
    const identity = await resolveLocalGithubIdentity();
    if (identity.kind === 'gh_auth_required') {
      throw new Error('gh auth required — publisher binding skipped; re-share after `gh auth login`');
    }

    const { resolveDeviceKeychainId } = await import('../../../identity/device-keychain-id');
    const { loadOrGenerateDeviceKeypair, ensureAttestationGist } = await import('../../../identity/attest');

    const keychainId = resolveDeviceKeychainId(identity.githubUserId);
    const keypair = await loadOrGenerateDeviceKeypair(keychainId);

    // Write-free (non-collaborator-join-fork-pr-2026-06-02): publishing the
    // publisher's binding = ensuring its attestation GIST exists (idempotent
    // find-or-create — no duplicate gist on re-share). The signed announce sent
    // at boot carries the gist id; remote peers admit via verifyAttestation.
    // There is NO shared-repo contributor-file write — sharing needs no extra
    // repo permission beyond what the publisher already has.
    await ensureAttestationGist({
      keychainId,
      pubkeyBase64: keypair.pubkeyBase64,
      deviceLabel: 'unnamed-device',
      githubUserId: identity.githubUserId,
      githubLogin: identity.githubLogin,
      token: identity.token,
    });
    return { devicePubkeyBase64: keypair.pubkeyBase64 };
  },
};

/** Map the ShareWizard `{ state }` body onto FinalizeShareInput. */
function inputFromBody(slug: string, body: unknown): FinalizeShareInput {
  const state = (body as { state?: Record<string, unknown> } | null)?.state ?? {};
  const repoId =
    typeof state.github_repository_id === 'number'
      ? state.github_repository_id
      : Number.parseInt(String(state.github_repository_id ?? ''), 10);
  return {
    slug,
    topic: String(state.topic ?? ''),
    github_remote: String(state.github_remote ?? ''),
    github_repository_id: Number.isFinite(repoId) ? repoId : NaN,
    privacy: state.privacy as HarnessSharedPrivacy | undefined,
    discord_channel:
      typeof state.discord_channel === 'string' ? state.discord_channel : undefined,
  };
}

const shareFinalize = defineTool({
  method: 'POST',
  path: '/harness/:slug/share/finalize',
  auth: 'public',
  // Sharing publishes the binding gist + boots the substrate + announces on the
  // DHT — can exceed the default 30s route timeout (the work then finished
  // server-side while the caller saw a spurious 408).
  timeoutSec: 300,
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const body = await req.json().catch(() => null);
    try {
      const result = await finalizeShare(inputFromBody(slug, body), realDeps);
      return Response.json(result);
    } catch (e) {
      if (e instanceof FinalizeShareError) {
        return Response.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
  },
});

export default shareFinalize;
