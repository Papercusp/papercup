/**
 * hive-publish-from-repo — the visibility-gated publish step of
 * create-a-Hive-from-a-GitHub-URL (hive-from-github-url-2026-06-11 P-007;
 * D-002 auto-publish · D-003 private/invite rules · D-004/D-008 HYBRID).
 *
 * For a freshly-created from-repo Hive:
 *   public  → directory announce (member_repos + one-click member links over
 *             the HIVE federation topic) + a Cupboard listing row PER MEMBER
 *             REPO (all carrying hive_pubkey — the uniqueness/off-network
 *             index) + local binding-cache rows.
 *   invite  → directory announce on the invite-secret topic ONLY. NO Cupboard
 *             rows (repo-discoverability would leak the hive to non-holders).
 *   private → never reaches this module (the caller skips it; D-003 zero
 *             external writes).
 *
 * Every leg is best-effort and individually reported — a publish failure NEVER
 * fails the create (re-publish rides discovery:set_hive / the boot tick).
 */

import { randomBytes } from 'node:crypto';

import { loadHarnessRegistry, type ProjectEntry } from './harness-registry';
import { getHiveDirectory } from './hive-directory-deps';
import { deriveHiveMemberRepoRefs } from './hive-member-repos';
import {
  publishHiveToDirectory,
  type HiveDirectoryMeta,
  type HiveOwnerIdentity,
} from './hive-publish';
import { saveOwnedHiveMeta } from './hive-directory-meta';
import { parseGithubUrl } from './harness/clone-github';
import { formatHarnessLink } from './harness/url-scheme';
import {
  deriveHiveFederationTopic,
  topicAsHex,
} from './sync/hyperbee/derive-swarm-topic';
import type { HiveVisibility } from './sync/hyperbee/hive-announce';

// ── Result shape ───────────────────────────────────────────────────────────────

export interface PublishCreatedHiveOutcome {
  announced: boolean;
  /** Returned for invite hives so the creator can hand the secret to invitees. */
  inviteSecret?: string;
  cupboard: {
    attempted: boolean;
    /** Why the Cupboard leg was skipped, when it was. */
    skipped?: 'invite' | 'private_repo' | 'no_hive_pubkey' | 'no_member_repo_ids';
    rowsCreated?: number;
    /** Rows already present (the worker's per-repo uniqueness, HTTP 409) —
     *  expected on re-publish/visibility flips, not a failure. */
    rowsExisted?: number;
    rowsFailed?: number;
    /** Hardening D-002 auto-claim: rows claimed by the creator at create time
     *  (the worker verified maintain/admin via its OWN claim path). A row left
     *  unclaimed because the creator lacks permission is the normal
     *  provisional posture, not a failure. */
    rowsClaimed?: number;
    errors?: string[];
  };
  localBindings?: { created: number; existed: number; failed: number };
  error?: string;
}

export interface PublishCreatedHiveOpts {
  workspaceId: string;
  /** The Hive home slug (== directory hiveId). */
  hiveSlug: string;
  title: string;
  description: string;
  visibility: Exclude<HiveVisibility, 'private'>;
  /** GitHub repo visibility — a private repo never gets a Cupboard row (the
   *  public registry refuses private repos, same gate as the ShareWizard). */
  repoIsPrivate?: boolean;
}

// ── Injectable seams ───────────────────────────────────────────────────────────

export interface PublishCreatedHiveDeps {
  saveMeta?: typeof saveOwnedHiveMeta;
  ensureWired?: (workspaceId: string) => Promise<unknown>;
  resolveOwner?: () => Promise<HiveOwnerIdentity>;
  loadPubkey?: (workspaceId: string, hiveSlug: string) => Promise<string | null>;
  loadRegistry?: typeof loadHarnessRegistry;
  deriveMemberRepos?: typeof deriveHiveMemberRepoRefs;
  publishDirectory?: typeof publishHiveToDirectory;
  getDirectory?: typeof getHiveDirectory;
  publishListing?: (
    input: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    error?: string;
    status?: number;
    upstream_status?: number;
    /** The worker's create response (carries the new listing's `id`). */
    data?: unknown;
  }>;
  /**
   * Hardening D-002: drive the worker's OWN claim path (POST
   * /listings/:id/claim — the same endpoint the claim CTA uses; the worker
   * verifies maintain/admin itself). Best-effort; insufficient permission is
   * the normal provisional outcome.
   */
  claimListing?: (
    listingId: string | number,
  ) => Promise<{ ok: boolean; status?: number; error?: string }>;
  createLocalBinding?: (input: {
    githubUrl: string;
    privacy: 'shared-private' | 'shared-public';
    harness_topic: string;
    harness_slug: string;
  }) => Promise<unknown>;
  /** Owned-meta read for republishHiveAfterMemberAdd. */
  getMeta?: (hiveId: string, workspaceId: string) => Promise<HiveDirectoryMeta | null>;
  now?: () => number;
  randomSecret?: () => string;
}

async function defaultClaimListing(
  listingId: string | number,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const { getGhAuthToken } = await import('./identity/gh-token');
    const tokenRes = await getGhAuthToken();
    if (tokenRes.kind !== 'ok') return { ok: false, error: 'gh_auth_required' };
    const { resolveCupboardBaseUrl } = await import(
      './endpoint-route/routes/harness/cupboard-publish'
    );
    const res = await fetch(`${resolveCupboardBaseUrl()}/listings/${listingId}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenRes.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true, status: res.status };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: body.error ?? `cupboard_http_${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function defaultResolveOwner(): Promise<HiveOwnerIdentity> {
  const { resolveLocalAnnounceIdentity } = await import('./sync/hyperbee/local-announce-identity');
  const id = await resolveLocalAnnounceIdentity({ logCoreKeyHex: '0'.repeat(64) });
  return {
    githubLogin: id.githubLogin,
    githubUserId: id.githubUserId,
    devicePubkey: id.devicePubkeyBase64,
    attestationGistId: id.attestationGistId,
  };
}

// ── The publish step ───────────────────────────────────────────────────────────

export async function publishCreatedHive(
  opts: PublishCreatedHiveOpts,
  deps: PublishCreatedHiveDeps = {},
): Promise<PublishCreatedHiveOutcome> {
  const saveMeta = deps.saveMeta ?? saveOwnedHiveMeta;
  const now = deps.now ?? Date.now;
  const randomSecret = deps.randomSecret ?? (() => randomBytes(32).toString('hex'));

  const inviteSecret = opts.visibility === 'invite' ? randomSecret() : undefined;

  // 1 — persist the listing meta (the durable half; the boot tick re-publishes it).
  const meta: HiveDirectoryMeta = {
    hiveId: opts.hiveSlug,
    title: opts.title,
    description: opts.description,
    workspaceId: opts.workspaceId, // P-004: announce-build enrichment key
    visibility: opts.visibility,
    memberTopics: [],
    createdAt: now(),
    ...(inviteSecret ? { inviteSecret } : {}),
  };
  try {
    await saveMeta(meta, opts.workspaceId);
  } catch (e) {
    return {
      announced: false,
      cupboard: { attempted: false },
      error: `save_meta_failed: ${e instanceof Error ? e.message : e}`,
      ...(inviteSecret ? { inviteSecret } : {}),
    };
  }

  const out = await publishListingForMeta(
    meta,
    { workspaceId: opts.workspaceId, ...(opts.repoIsPrivate !== undefined ? { repoIsPrivate: opts.repoIsPrivate } : {}) },
    deps,
  );
  return { ...out, ...(inviteSecret ? { inviteSecret } : {}) };
}

/**
 * P-009 — re-publish an EXISTING hive's listing after a member was added
 * (into-hive mode): re-derives member repos/links, re-announces, and registers
 * the NEW member repo's Cupboard + local rows only (`onlyRepoIds` — re-posting
 * existing rows would just trip the worker's per-repo uniqueness). A hive that
 * was never published (private / no meta) is left untouched.
 */
export async function republishHiveAfterMemberAdd(
  opts: {
    workspaceId: string;
    hiveSlug: string;
    /** Restrict the Cupboard/local-binding legs to these repo ids (the new member). */
    onlyRepoIds?: number[];
    repoIsPrivate?: boolean;
  },
  deps: PublishCreatedHiveDeps = {},
): Promise<PublishCreatedHiveOutcome | { skipped: 'unpublished_hive' }> {
  const getMeta =
    deps.getMeta ??
    (async (hiveId: string, ws: string) =>
      (await import('./hive-directory-meta')).getOwnedHiveMeta(hiveId, ws));
  const meta = await getMeta(opts.hiveSlug, opts.workspaceId).catch(() => null);
  if (!meta || meta.visibility === 'private') return { skipped: 'unpublished_hive' };
  return publishListingForMeta(
    meta as HiveDirectoryMeta & { visibility: Exclude<HiveVisibility, 'private'> },
    {
      workspaceId: opts.workspaceId,
      ...(opts.repoIsPrivate !== undefined ? { repoIsPrivate: opts.repoIsPrivate } : {}),
      ...(opts.onlyRepoIds ? { onlyRepoIds: opts.onlyRepoIds } : {}),
    },
    deps,
  );
}

/** The shared announce + Cupboard + local-binding legs (steps 2–6). */
async function publishListingForMeta(
  meta: HiveDirectoryMeta & { visibility: Exclude<HiveVisibility, 'private'> },
  opts: { workspaceId: string; repoIsPrivate?: boolean; onlyRepoIds?: number[] },
  deps: PublishCreatedHiveDeps = {},
): Promise<PublishCreatedHiveOutcome> {
  const resolveOwner = deps.resolveOwner ?? defaultResolveOwner;
  const loadRegistry = deps.loadRegistry ?? loadHarnessRegistry;
  const deriveMemberRepos = deps.deriveMemberRepos ?? deriveHiveMemberRepoRefs;
  const publishDirectory = deps.publishDirectory ?? publishHiveToDirectory;
  const getDirectory = deps.getDirectory ?? getHiveDirectory;

  // 2 — best-effort transport wire (a box that gh-authed after boot).
  try {
    const ensureWired =
      deps.ensureWired ??
      (async (ws: string) => (await import('./hive-directory-boot')).ensureHiveDirectoryWired(ws));
    await ensureWired(opts.workspaceId);
  } catch {
    /* announce below degrades to registered-not-broadcast */
  }

  // 3 — enrichment: identity pubkey + member repos + one-click member links over
  //     the HIVE federation topic (the joiner clones the repo + joins that topic).
  const loadPubkey =
    deps.loadPubkey ??
    (async (ws: string, slug: string) =>
      (await import('./identity/hive-keypair')).loadHivePubkey(ws, slug).catch(() => null));
  const hivePubkey = await loadPubkey(opts.workspaceId, meta.hiveId).catch(() => null);
  const memberRepos = await deriveMemberRepos(opts.workspaceId, meta.hiveId).catch(
    () => [] as string[],
  );

  const reg = await loadRegistry(opts.workspaceId).catch(() => ({ projects: [] as ProjectEntry[] }));
  const members = reg.projects.filter(
    (p) =>
      (p.slug === meta.hiveId || p.hive_slug === meta.hiveId) &&
      typeof p.github_remote === 'string' &&
      p.github_remote.length > 0,
  );

  const hiveTopicHex = hivePubkey ? topicAsHex(deriveHiveFederationTopic(hivePubkey)) : null;
  const memberLinks: string[] = [];
  if (hiveTopicHex) {
    for (const m of members) {
      const parsed = m.github_remote ? parseGithubUrl(m.github_remote) : null;
      if (!parsed || typeof m.github_repository_id !== 'number') continue;
      memberLinks.push(
        formatHarnessLink({
          topic: hiveTopicHex,
          github: `${parsed.owner}/${parsed.repo}`,
          repoOwner: parsed.owner,
          repoName: parsed.repo,
          repoId: m.github_repository_id,
        }),
      );
    }
  }

  // 4 — directory announce (the content authority, D-004).
  let announced = false;
  let announceError: string | undefined;
  try {
    const owner = await resolveOwner();
    const res = await publishDirectory(
      getDirectory(),
      {
        ...meta,
        ...(hivePubkey ? { hivePubkey } : {}),
        ...(memberRepos.length ? { memberRepos } : {}),
        ...(memberLinks.length ? { memberLinks } : {}),
      },
      owner,
    );
    announced = res.announced;
  } catch (e) {
    announceError = e instanceof Error ? e.message : String(e);
  }

  // 5 — the Cupboard index (PUBLIC hives only; D-003 invite leak rule; the
  //     public registry refuses private repos).
  const cupboard: PublishCreatedHiveOutcome['cupboard'] = { attempted: false };
  if (meta.visibility !== 'public') {
    cupboard.skipped = 'invite';
  } else if (opts.repoIsPrivate) {
    cupboard.skipped = 'private_repo';
  } else if (!hivePubkey || !hiveTopicHex) {
    cupboard.skipped = 'no_hive_pubkey';
  } else {
    const withIds = members.filter(
      (m) =>
        typeof m.github_repository_id === 'number' &&
        (!opts.onlyRepoIds || opts.onlyRepoIds.includes(m.github_repository_id)),
    );
    if (withIds.length === 0) {
      cupboard.skipped = 'no_member_repo_ids';
    } else {
      cupboard.attempted = true;
      cupboard.rowsCreated = 0;
      cupboard.rowsExisted = 0;
      cupboard.rowsFailed = 0;
      cupboard.rowsClaimed = 0;
      cupboard.errors = [];
      const claimListing = deps.claimListing ?? defaultClaimListing;
      const publishListing =
        deps.publishListing ??
        (async (input: Record<string, unknown>) =>
          (await import('./cupboard/publish-listing')).publishListingToCupboard(
            input as never,
          ));
      for (const m of withIds) {
        const parsed = parseGithubUrl(m.github_remote!);
        if (!parsed) continue;
        const res = await publishListing({
          listing_kind: 'harness',
          github_repository_id: m.github_repository_id!,
          github_owner: parsed.owner,
          github_name: parsed.repo,
          github_url: parsed.cloneUrl,
          title: meta.title,
          description: meta.description,
          topic_hex: hiveTopicHex,
          hive_pubkey: hivePubkey,
          hive_title: meta.title,
        }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        if (res.ok) {
          cupboard.rowsCreated! += 1;
          // D-002 auto-claim: the worker's own claim path verifies maintain/
          // admin. 403 insufficient_permission = the normal provisional
          // posture; 409 already_claimed = someone beat us — both silent.
          const listingId = (('data' in res ? res.data : undefined) as { id?: string | number } | undefined)?.id;
          if (listingId !== undefined && listingId !== null) {
            const claim = await claimListing(listingId).catch(() => ({ ok: false as const }));
            if (claim.ok) cupboard.rowsClaimed! += 1;
          }
        } else if (
          ('status' in res && (res.status === 409 || res.upstream_status === 409)) ||
          /exists|conflict/i.test(res.error ?? '')
        ) {
          cupboard.rowsExisted! += 1; // re-publish/flip over an existing row — fine
        } else {
          cupboard.rowsFailed! += 1;
          if (res.error) cupboard.errors!.push(`${parsed.owner}/${parsed.repo}: ${res.error}`);
        }
      }
      if (cupboard.errors!.length === 0) delete cupboard.errors;
    }
  }

  // 6 — local binding-cache rows (the first-hop lookup leg). Public + invite —
  //     a LOCAL row leaks nothing off-box.
  const localBindings = { created: 0, existed: 0, failed: 0 };
  if (hiveTopicHex) {
    const createLocalBinding =
      deps.createLocalBinding ??
      (async (input: {
        githubUrl: string;
        privacy: 'shared-private' | 'shared-public';
        harness_topic: string;
        harness_slug: string;
      }) => (await import('./harness/binding-service')).createUnclaimedBinding(input));
    for (const m of members) {
      if (typeof m.github_repository_id !== 'number' || !m.github_remote) continue;
      if (opts.onlyRepoIds && !opts.onlyRepoIds.includes(m.github_repository_id)) continue;
      try {
        await createLocalBinding({
          githubUrl: m.github_remote,
          privacy: meta.visibility === 'public' ? 'shared-public' : 'shared-private',
          harness_topic: hiveTopicHex,
          harness_slug: m.slug,
        });
        localBindings.created += 1;
      } catch (e) {
        if ((e as { code?: string }).code === 'BINDING_EXISTS') localBindings.existed += 1;
        else localBindings.failed += 1;
      }
    }
  }

  return {
    announced,
    cupboard,
    localBindings,
    ...(announceError ? { error: announceError } : {}),
  };
}
