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
import { loadHarnessRegistry, mutateHarnessRegistry } from '../../../harness-registry';
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
  /** EI-82 hardening (2026-07-03): registration is an ATOMIC upsert-or-enrich —
   *  never a load→push→save whole-payload overwrite (which silently clobbered /
   *  was clobbered by any concurrent registry writer). */
  mutateRegistry: typeof mutateHarnessRegistry;
  joinHarness: (opts: Parameters<typeof joinSharedHarness>[0]) => Promise<JoinState>;
  scaffold: (slug: string) => Promise<void>;
  /** EI-382: seed the joined clone's git-sync routine (best-effort). */
  seedGitSync: (opts: SeedGitSyncRoutineOpts) => Promise<SeedGitSyncRoutineOutcome>;
  /** Active workspace id for the seed (injectable for hermetic tests). */
  resolveWorkspaceId: () => string;
  /** D-007 (from-repo-seed receive-side fix): seed hive_directory_cache with the
   *  VERIFIED owner binding a hive MEMBER link carries, so the joiner's owner-log
   *  bootstrap-admit fires at boot WITHOUT catching the live announce beacon (the
   *  run-20 "0 announce → empty roster → drop all owner content" receive failure).
   *  Channel-2 re-verifies the device against the attestation gist BEFORE seeding —
   *  the link is transport, not the trust anchor. Best-effort: a failure NEVER fails
   *  the join (the beacon path still backfills). Injectable for hermetic tests. */
  seedOwnerBinding: (input: SeedOwnerBindingInput) => Promise<SeedOwnerBindingOutcome>;
}

/** D-007 input for the verified owner-binding seed (all fields from the member link). */
export interface SeedOwnerBindingInput {
  workspaceId: string;
  /** base64 raw-32 Ed25519 hive pubkey — the hive_directory_cache key. */
  hivePubkey: string;
  /** base64 owner device pubkey to channel-2 verify + bind. */
  ownerDevicePubkey: string;
  /** owner numeric GitHub user id (channel-2 verify target). */
  ownerGithubUserId: number;
  /** owner GitHub login (for the DiscoveredHive entry). */
  ownerGithubLogin: string;
  /** owner device-attestation gist id (channel-2 anchor). */
  attestationGistId: string;
  /** the hive federation topic (hex) for the synthetic DiscoveredHive's memberTopics. */
  topic: string;
  /** best-effort hive id for the cache entry (consumer keys on hivePubkey, not this). */
  hiveId: string;
}

export interface SeedOwnerBindingOutcome {
  /** true when a NEW verified binding was written (false = unverified, or already present). */
  seeded: boolean;
  reason?: string;
}

/**
 * D-007 default seed: channel-2 re-verify the owner device against its
 * attestation gist, then ADD-IF-ABSENT a synthetic DiscoveredHive carrying the
 * verified (hivePubkey → ownerDevicePubkey) binding into hive_directory_cache.
 * Add-if-absent (keyed on hivePubkey) so a later, richer beacon-sourced entry is
 * never clobbered. Dynamic imports keep the route module light + avoid PG/identity
 * pulled into its static graph. Never throws — returns {seeded:false} on any issue.
 */
async function defaultSeedOwnerBinding(
  input: SeedOwnerBindingInput,
): Promise<SeedOwnerBindingOutcome> {
  try {
    const { verifyAttestation } = await import('../../../identity/attest');
    const res = await verifyAttestation(
      input.attestationGistId,
      input.ownerDevicePubkey,
      input.ownerGithubUserId,
    ).catch(() => null);
    if (!res || !res.valid) return { seeded: false, reason: 'attestation_unverified' };

    const { updateOperatorState } = await import('../../../operator-state-pg');
    type DiscoveredHive = import('../../../hive-directory').DiscoveredHive;
    const now = Date.now();
    let didSeed = false;
    await updateOperatorState<{ hives: DiscoveredHive[] }>(
      'hive_directory_cache',
      { hives: [] },
      (cur) => {
        const hives = Array.isArray(cur?.hives) ? cur.hives : [];
        // Add-if-absent by hivePubkey — never clobber a richer beacon entry.
        if (hives.some((h) => h && h.hivePubkey === input.hivePubkey)) return { hives };
        didSeed = true;
        const entry: DiscoveredHive = {
          hiveId: input.hiveId,
          title: '',
          description: '',
          ownerGithubLogin: input.ownerGithubLogin,
          ownerGithubUserId: input.ownerGithubUserId,
          ownerDevicePubkey: input.ownerDevicePubkey,
          hivePubkey: input.hivePubkey,
          memberTopics: [input.topic],
          visibility: 'public',
          createdAt: now,
          announcedTs: now,
          lastSeenMs: now,
          attested: true,
        };
        return { hives: [...hives, entry] };
      },
      input.workspaceId,
    );
    return { seeded: didSeed };
  } catch (e) {
    return { seeded: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export const realJoinLinkDeps: JoinLinkDeps = {
  resolveIdentity: resolveLocalGithubIdentity,
  loadRegistry: loadHarnessRegistry,
  mutateRegistry: mutateHarnessRegistry,
  joinHarness: joinSharedHarness,
  scaffold: scaffoldHarnessSchema,
  seedGitSync: (opts) => seedGitSyncRoutineForMember(opts),
  resolveWorkspaceId: activeWorkspaceId,
  seedOwnerBinding: defaultSeedOwnerBinding,
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

  // Register the harness in the workspace registry — an ATOMIC upsert-or-enrich
  // (EI-82 hardening, 2026-07-03, WI-971 adjacent). The join orchestrator's
  // boot_federate step already registers the clone pre-boot (the substrate boot
  // resolves the harness path through the registry), historically as a MINIMAL
  // { slug, path } row — which made this block's EI-1623 self-describing
  // enrichment DEAD CODE (the slug-present check skipped it) and left the clone
  // invisible to the hive_slug/joined_via_link-keyed git-sync reconcile. The
  // old shape here was also a racy load→push→save whole-payload overwrite that
  // could silently clobber (or be clobbered by) any concurrent registry writer
  // — the suspected mechanism behind a joined-hive row that federated for hours
  // then vanished at restart (mac-VM P-003 repro, 2026-07-03). Now: absent →
  // insert the full self-describing row; present-but-minimal → fill ONLY the
  // missing coord fields in place; already-enriched → no-op.
  if (state.cloneDir) {
    const cloneDir = state.cloneDir;
    await deps.mutateRegistry((reg) => {
      const existing = reg.projects.find((p) => p.slug === slug);
      if (!existing) {
        return {
          ...reg,
          projects: [
            ...reg.projects,
            {
              slug,
              path: cloneDir,
              github_remote: `https://github.com/${link.github}`,
              github_repository_id: link.repoId,
              joined_via_link: true,
            },
          ],
        };
      }
      if (
        existing.github_remote &&
        typeof existing.github_repository_id === 'number' &&
        existing.joined_via_link !== undefined
      ) {
        return reg; // already self-describing — nothing to do
      }
      return {
        ...reg,
        projects: reg.projects.map((p) =>
          p.slug !== slug
            ? p
            : {
                ...p,
                ...(p.github_remote ? {} : { github_remote: `https://github.com/${link.github}` }),
                ...(typeof p.github_repository_id === 'number'
                  ? {}
                  : { github_repository_id: link.repoId }),
                ...(p.joined_via_link === undefined ? { joined_via_link: true } : {}),
              },
        ),
      };
    });

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

    // D-007 (from-repo-seed receive-side fix): if this is a hive MEMBER link
    // carrying the owner binding, seed hive_directory_cache with the VERIFIED
    // (hivePubkey → ownerDevicePubkey) so the owner-log bootstrap-admit fires at
    // boot without waiting to catch the live announce beacon — closing the run-20
    // "0 announce → empty roster → drop all owner content" receive failure. The
    // seed channel-2 re-verifies the device; best-effort, NEVER fails the join.
    if (
      link.hivePubkey &&
      link.ownerDevicePubkey &&
      typeof link.ownerGithubUserId === 'number' &&
      link.attestationGistId
    ) {
      try {
        await deps.seedOwnerBinding({
          workspaceId: deps.resolveWorkspaceId(),
          hivePubkey: link.hivePubkey,
          ownerDevicePubkey: link.ownerDevicePubkey,
          ownerGithubUserId: link.ownerGithubUserId,
          ownerGithubLogin: link.repoOwner,
          attestationGistId: link.attestationGistId,
          topic: link.topic,
          hiveId: `${link.repoName}-hive`,
        });
      } catch {
        // Non-fatal — the announce-beacon ingest can still seed it later.
      }
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
