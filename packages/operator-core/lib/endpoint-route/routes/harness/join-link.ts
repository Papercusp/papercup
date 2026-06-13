/**
 * POST /api/harness/join-link — Entry 4 harness-link join (P-009).
 *
 * Body: {
 *   slug: string,              // desired harness slug
 *   harnessLinkUrl: string,    // papercusp://harness?topic=...&github=...&repo_id=...
 *   existingGistId?: string,   // optional: re-use a pre-existing attestation gist
 * }
 *
 * The joiner's GitHub identity (token, githubUserId, githubLogin) is resolved
 * SERVER-SIDE from the local `gh` CLI auth (D-004). The client no longer needs
 * to supply these. If the local `gh` auth is missing the endpoint returns 401
 * with `{ code: 'gh_auth_required' }`.
 *
 * The device keychain id is DERIVED server-side from the verified
 * `githubUserId` via `resolveDeviceKeychainId` (`<github_user_id>:<machine-
 * fingerprint>`) — the SAME canonical id the swarm announce resolves, so the
 * contributor file signed here verifies against the announced device_pubkey.
 * It is NOT taken from the request body.
 *
 * Response: { ok: true, state: JoinState } on success.
 * Errors: 400 for bad input, 401 for missing gh auth, 409 for slug conflict,
 *         502 for join failure.
 *
 * Steps 3/4/5/8 (Hyperswarm/Hyperbee) produce phase_0_pending status but
 * don't fail the request — the client can inspect `state.steps` for detail.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { loadHarnessRegistry, saveHarnessRegistry } from '../../../harness-registry';
import type { ProjectEntry } from '../../../harness-registry';
import { scaffoldHarnessSchema } from '../../../scaffold-harness-schema';
import { parseHarnessLink } from '../../../harness/url-scheme';
import { joinSharedHarness, JoinStepError } from '../../../harness/join-shared-harness';
import {
  seedGitSyncRoutineForMember,
  type SeedGitSyncRoutineOpts,
  type SeedGitSyncRoutineOutcome,
} from '../../../harness/git-sync/git-sync-routine';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolveDeviceKeychainId } from '../../../identity/device-keychain-id';
import {
  resolveLocalGithubIdentity,
  type LocalGithubIdentity,
  type ResolveLocalGithubIdentityOpts,
} from '../../../identity/resolve-local-github-identity';
import type { HarnessLink } from '../../../harness/url-scheme';
import type { JoinState } from '../../../harness/join-shared-harness';

// ─── injectable deps ──────────────────────────────────────────────────────────

export interface JoinLinkDeps {
  resolveIdentity: (opts?: ResolveLocalGithubIdentityOpts) => Promise<LocalGithubIdentity>;
  loadRegistry: typeof loadHarnessRegistry;
  saveRegistry: typeof saveHarnessRegistry;
  joinHarness: (opts: Parameters<typeof joinSharedHarness>[0]) => Promise<JoinState>;
  scaffold: (slug: string) => Promise<void>;
  /** EI-382: seed the joined clone's git-sync routine (best-effort). */
  seedGitSync: (opts: SeedGitSyncRoutineOpts) => Promise<SeedGitSyncRoutineOutcome>;
  /** Active workspace id for the seed (injectable for hermetic tests). */
  resolveWorkspaceId: () => string;
}

export const realJoinLinkDeps: JoinLinkDeps = {
  resolveIdentity: resolveLocalGithubIdentity,
  loadRegistry: loadHarnessRegistry,
  saveRegistry: saveHarnessRegistry,
  joinHarness: joinSharedHarness,
  scaffold: scaffoldHarnessSchema,
  seedGitSync: (opts) => seedGitSyncRoutineForMember(opts),
  resolveWorkspaceId: activeWorkspaceId,
};

// ─── core handler (injectable, exported for tests) ────────────────────────────

export interface JoinLinkInput {
  slug: string;
  link: HarnessLink;
  existingGistId?: string;
}

export async function handleJoinLink(
  input: JoinLinkInput,
  deps: JoinLinkDeps = realJoinLinkDeps,
): Promise<Response> {
  const { slug, link, existingGistId } = input;

  // Resolve GitHub identity server-side.
  const id = await deps.resolveIdentity();
  if (id.kind === 'gh_auth_required') {
    return Response.json(
      { error: 'GitHub authentication required', code: 'gh_auth_required' },
      { status: 401 },
    );
  }

  const keychainId = resolveDeviceKeychainId(id.githubUserId);

  // Slug uniqueness check.
  const reg = await deps.loadRegistry();
  if (reg.projects.some((p) => p.slug === slug)) {
    return Response.json({ error: 'slug already exists', code: 'slug_conflict' }, { status: 409 });
  }

  // Run the join orchestrator.
  let state: JoinState;
  try {
    state = await deps.joinHarness({
      link,
      slug,
      token: id.token,
      githubUserId: id.githubUserId,
      githubLogin: id.githubLogin,
      keychainId,
      existingGistId,
    });
  } catch (e: unknown) {
    if (e instanceof JoinStepError) {
      return Response.json(
        {
          error: e.message,
          code: e.code,
          stepId: e.stepId,
          state: undefined,
        },
        { status: 502 },
      );
    }
    throw e;
  }

  // Register the harness in the workspace registry. The join orchestrator's
  // boot_federate step already registers the clone (the substrate boot
  // resolves the harness path through the registry, so it must exist BEFORE
  // the boot) — reload and skip when present; pushing onto the stale pre-join
  // `reg` would clobber that entry.
  if (state.cloneDir) {
    const reg2 = await deps.loadRegistry();
    if (!reg2.projects.some((p) => p.slug === slug)) {
      reg2.projects.push({ slug, path: state.cloneDir });
      await deps.saveRegistry(reg2);
    }

    // Scaffold the harness schema (best-effort — don't fail the join if this fails).
    try {
      await deps.scaffold(slug);
    } catch {
      // Non-fatal — harness is still usable without schema.
    }

    // EI-382: seed the joined clone's git-sync routine. A bare-link join
    // registers a minimal { slug, path } entry with no `hive_slug`, so neither
    // joinHiveAsView's per-member loop (the only OTHER join-side seeder) nor the
    // `hive_slug`-filtered boot reconcile would ever seed it — the clone would
    // silently never sync, contradicting the "git-sync owns the tree" contract.
    // Joiner-side ⇒ push:false (D-002: a local commit+fetch+merge mirror; the
    // owner's pushes / a fork-PR is the contribution path), active per D-008,
    // and the cron jitter key is salted per-install (D-004) because the same
    // shared repo may be joined under the same slug on N peer boxes. Best-effort
    // exactly like joinHiveAsView: a seed failure NEVER fails the join (the
    // routine can be backfilled later).
    try {
      const workspaceId = deps.resolveWorkspaceId();
      const entry: ProjectEntry = {
        slug,
        path: state.cloneDir,
        github_remote: `https://github.com/${link.github}`,
        github_repository_id: link.repoId,
      };
      await deps.seedGitSync({
        workspaceId,
        installSlug: slug,
        entry,
        joinerSide: true,
        cronKey: `${slug}:${workspaceId}`,
      });
    } catch {
      // Non-fatal — the boot reconcile / a manual seed can backfill later.
    }
  }

  return Response.json({ ok: true, state });
}

// ─── defineTool handler (wires real deps + parses request) ────────────────────

const joinLink = defineTool({
  method: 'POST',
  path: '/harness/join-link',
  auth: 'loopback',
  // A real join runs gist publish + git clone + substrate boot + DHT announce —
  // routinely >30s (the default route timeout 408'd every real join; the
  // orchestrator kept going server-side and the client saw a spurious failure).
  timeoutSec: 300,
  async handler(req) {
    const body = (await req.json()) as Record<string, unknown>;

    const slug = String(body.slug ?? '').trim();
    if (!slug) return Response.json({ error: 'slug required' }, { status: 400 });

    const harnessLinkUrl = String(body.harnessLinkUrl ?? '').trim();
    const link = parseHarnessLink(harnessLinkUrl);
    if (!link) {
      return Response.json(
        { error: 'invalid harness link URL', code: 'invalid_link' },
        { status: 400 },
      );
    }

    const existingGistId =
      typeof body.existingGistId === 'string' ? body.existingGistId.trim() || undefined : undefined;

    return handleJoinLink({ slug, link, existingGistId }, realJoinLinkDeps);
  },
});

export default joinLink;
