/**
 * POST /api/harness/:slug/share/finalize — write `.harness/shared.json`
 * (Phase 11 P-077, the missing finalize link).
 *
 * The ShareWizard's final step POSTs here with `{ state }` (the collected
 * ShareWizardState). Until now the route didn't exist, so `.harness/shared.json`
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
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { resolveHarnessPaths } from '@/lib/resolve-harness-paths';
import {
  buildFreshConfig,
  isHarnessSharedConfig,
  HARNESS_SHARED_CONFIG_REL_PATH,
  HARNESS_SHARED_PRIVACY_LEVELS,
  type HarnessSharedConfig,
  type HarnessSharedPrivacy,
} from '@/lib/harness/harness-shared-config-types';
import type { BindingClaimStatus } from '@/lib/harness/binding-types';

export interface FinalizeShareInput {
  slug: string;
  topic: string;
  github_remote: string;
  github_repository_id: number;
  privacy?: HarnessSharedPrivacy;
  discord_channel?: string;
}

/** Outcome of the post-write substrate reboot (when the flag is on). */
export interface FinalizeShareSwarm {
  /** True if a reboot was actually attempted (substrate enabled). */
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
   * `{ rebooted: false, error }`. Omit to skip (realDeps's impl no-ops when
   * the substrate flag is off, returning `{ rebooted: false }`).
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
 * Write `.harness/shared.json` for `slug`. Returns the written config + path.
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
  };
}

const realDeps: FinalizeShareDeps = {
  resolvePaths: (slug) => resolveHarnessPaths(slug, activeWorkspaceId()),
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFileUtf8: (absPath, contents) => writeFile(absPath, contents, 'utf8'),
  now: () => Date.now(),
  // Reboot the harness in-process so it joins the swarm immediately. The Model
  // B substrate always boots (the PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE gate was
  // removed in Stage 4d), so the reboot always runs — picking up the freshly
  // written shared.json so the harness derives its swarm topic + announces.
  reboot: async (slug) => {
    const { rebootHarness } = await import('@/lib/sync/hyperbee/boot-all');
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
      const { createUnclaimedBinding } = await import('@/lib/harness/binding-service');
      const rec = await createUnclaimedBinding({
        githubUrl: github_remote,
        privacy,
        harness_topic,
        harness_slug: slug,
      });
      return { created: true, claim_status: rec.claim_status };
    } catch (e) {
      const { BindingServiceErrorThrowable } = await import('@/lib/harness/binding-types');
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
