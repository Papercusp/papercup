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
 * with the right repo id. Gotcha: an already-booted harness won't swarm-join
 * until it re-boots (bootSingleHarness caches handles); finalize writes the file
 * so the join happens on the next substrate boot.
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

export interface FinalizeShareInput {
  slug: string;
  topic: string;
  github_remote: string;
  github_repository_id: number;
  privacy?: HarnessSharedPrivacy;
  discord_channel?: string;
}

export interface FinalizeShareResult {
  ok: true;
  shared_config: HarnessSharedConfig;
  path: string;
}

export interface FinalizeShareDeps {
  /** slug → { projectDir, stateDir } (PG-canonical via resolveHarnessPaths). */
  resolvePaths: (slug: string) => Promise<{ projectDir: string; stateDir: string }>;
  mkdirp: (dir: string) => Promise<void>;
  writeFileUtf8: (absPath: string, contents: string) => Promise<void>;
  now: () => number;
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

  return { ok: true, shared_config: config, path: absPath };
}

const realDeps: FinalizeShareDeps = {
  resolvePaths: (slug) => resolveHarnessPaths(slug, activeWorkspaceId()),
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFileUtf8: (absPath, contents) => writeFile(absPath, contents, 'utf8'),
  now: () => Date.now(),
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
