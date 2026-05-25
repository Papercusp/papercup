/**
 * load — user profile data fetcher.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
 *       (P-072 real data follow-up).
 *
 * Resolves a github_user_id into a UserProfileData via PG reads against:
 *   - harness_shared.contributors          → header + per-harness rows
 *   - harness_shared.harness_features_consolidated → features-shipped
 *   - harness_shared.shared_repo_binding_cache     → claimed_harnesses
 *
 * Pure logic — takes an injectable `runQuery` so tests can fake PG
 * without a postgres instance. Production callers pass a thin wrapper
 * around getOrgPg().sql.unsafe.
 *
 * Defensive about missing tables / empty rows: returns an empty profile
 * if no contributor rows match.
 */

import type {
  ActivityEntry,
  ClaimedHarness,
  HarnessBlock,
  UserProfileData,
} from '../../app/users/github/[id]/UserProfile';
import type { BindingStatus } from '../../app/_components/BindingStatusBadge';
import type { ClaimStatus } from '../../app/_components/ClaimStatusBadge';
import { loadUserRecentActivity } from './load-activity';

export interface UserProfileLoadOpts {
  github_user_id: number;
  /**
   * The viewer's `github_user_id` — used for the §18 privacy filter
   * (Q-2): rows from shared-private harnesses where the viewer isn't
   * a member are hidden. When null, only shared-public harnesses
   * appear (anonymous viewer).
   */
  viewer_github_user_id?: number | null;
  /**
   * Inject-able PG query runner. Production: a thin wrapper around
   * `getOrgPg().sql.unsafe(query, params)` returning rows.
   */
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
}

interface ContributorRow {
  workspace_id: string;
  harness_slug: string;
  github_user_id: string | number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  device_attestations: unknown;
  joined_at: string | Date;
}

interface FeaturesShippedRow {
  harness_slug: string;
  features_shipped: string | number;
}

interface BindingRow {
  harness_slug: string;
  claim_status: string;
  privacy: string;
}

function pickBindingStatus(rows: ContributorRow[]): BindingStatus {
  if (rows.length === 0) return 'unverified';
  let anyVerified = false;
  let anyPending = false;
  for (const r of rows) {
    const attestations = Array.isArray(r.device_attestations)
      ? r.device_attestations
      : [];
    for (const a of attestations) {
      if (a && typeof a === 'object') {
        const verified = (a as { verified?: boolean }).verified;
        if (verified === true) anyVerified = true;
        if (verified === false) anyPending = true;
      }
    }
  }
  if (anyVerified) return 'verified';
  if (anyPending) return 'pending';
  return 'unverified';
}

function normalizeClaimStatus(s: string): ClaimStatus {
  if (s === 'claimed' || s === 'unclaimed' || s === 'stale' || s === 'superseded') {
    return s;
  }
  return 'unclaimed';
}

/**
 * Load a user profile from PG. Empty/missing tables yield an empty
 * profile rather than throwing.
 */
export async function loadUserProfile(
  opts: UserProfileLoadOpts,
): Promise<UserProfileData> {
  const { github_user_id, runQuery } = opts;
  const viewerId = opts.viewer_github_user_id ?? null;

  // 1) Contributor rows for this user — one per (workspace, harness).
  //    Defensive: catch missing-table errors (fresh install before
  //    dogfood ensure ran) and treat as empty.
  let contribRows: ContributorRow[] = [];
  try {
    contribRows = await runQuery<ContributorRow>(
      `SELECT workspace_id, harness_slug, github_user_id, github_username,
              display_name, avatar_url, device_attestations, joined_at
         FROM harness_shared.contributors
        WHERE github_user_id = $1
        ORDER BY joined_at ASC`,
      [github_user_id],
    );
  } catch {
    contribRows = [];
  }

  if (contribRows.length === 0) {
    return {
      github_user_id,
      github_login: `user-${github_user_id}`,
      display_name: null,
      avatar_url: null,
      binding_status: 'unverified',
      harnesses: [],
      recent_activity: [],
      claimed_harnesses: [],
    };
  }

  // Pick the "primary" identity row — most recent display name + avatar.
  const primary = contribRows[contribRows.length - 1]!;

  // 2) Privacy filter — for shared-private harnesses the viewer isn't
  //    in, drop the row. Anonymous viewer (null) only sees shared-public.
  //    Needs binding rows to know privacy; fetch alongside claimed harnesses.
  let bindingRows: BindingRow[] = [];
  try {
    bindingRows = await runQuery<BindingRow>(
      `SELECT harness_slug, claim_status, privacy
         FROM harness_shared.shared_repo_binding_cache
        WHERE workspace_id = ANY($1)`,
      [Array.from(new Set(contribRows.map((r) => r.workspace_id)))],
    );
  } catch {
    bindingRows = [];
  }
  const bindingBySlug = new Map<string, BindingRow>(
    bindingRows.map((b) => [b.harness_slug, b]),
  );

  // viewerHarnessMembership: harnesses the viewer is contributing to (used to
  // unlock shared-private rows).
  let viewerHarnessMembership: Set<string> = new Set();
  if (viewerId != null) {
    try {
      const vrows = await runQuery<{ harness_slug: string }>(
        `SELECT DISTINCT harness_slug
           FROM harness_shared.contributors
          WHERE github_user_id = $1`,
        [viewerId],
      );
      viewerHarnessMembership = new Set(vrows.map((r) => r.harness_slug));
    } catch {
      viewerHarnessMembership = new Set();
    }
  }

  function visible(harness_slug: string): boolean {
    const b = bindingBySlug.get(harness_slug);
    // Default to visible when binding row is missing (e.g. ensure hasn't
    // run or shared_repo_binding_cache is sparse) — surfacing the row
    // beats silently dropping a real contributor's harness.
    if (!b) return true;
    if (b.privacy === 'shared-public') return true;
    if (viewerId != null && viewerId === github_user_id) return true;
    return viewerHarnessMembership.has(harness_slug);
  }

  const visibleContribRows = contribRows.filter((r) => visible(r.harness_slug));

  // 3) Per-harness features-shipped count.
  let featuresShippedRows: FeaturesShippedRow[] = [];
  try {
    featuresShippedRows = await runQuery<FeaturesShippedRow>(
      `SELECT harness_slug, COUNT(*) AS features_shipped
         FROM harness_shared.harness_features_consolidated
        WHERE status = 'shipped'
          AND taken_by = $1
        GROUP BY harness_slug`,
      [String(github_user_id)],
    );
  } catch {
    featuresShippedRows = [];
  }
  const shippedBySlug = new Map<string, number>(
    featuresShippedRows.map((r) => [
      r.harness_slug,
      typeof r.features_shipped === 'string'
        ? Number.parseInt(r.features_shipped, 10) || 0
        : Number(r.features_shipped),
    ]),
  );

  const harnesses: HarnessBlock[] = visibleContribRows.map((r) => ({
    harness_slug: r.harness_slug,
    display_title: r.harness_slug,
    href: `/harness/${r.harness_slug}`,
    prs_merged: 0,
    features_shipped: shippedBySlug.get(r.harness_slug) ?? 0,
    activity_events: 0,
  }));

  // 4) Claimed harnesses — rows where this user is in claimed_by_github_user_ids.
  //    For now, derive from shared_repo_binding_cache rows whose claim_status
  //    is `claimed` and whose claimed_by_github_user_ids contains this id.
  //    Falls back to empty when the table isn't present.
  let claimedRows: Array<{
    harness_slug: string;
    claim_status: string;
  }> = [];
  try {
    claimedRows = await runQuery(
      `SELECT harness_slug, claim_status
         FROM harness_shared.shared_repo_binding_cache
        WHERE claim_status IN ('claimed', 'stale')
          AND $1 = ANY(claimed_by_github_user_ids)`,
      [String(github_user_id)],
    );
  } catch {
    claimedRows = [];
  }
  const claimed_harnesses: ClaimedHarness[] = claimedRows
    .filter((c) => visible(c.harness_slug))
    .map((c) => ({
      harness_slug: c.harness_slug,
      display_title: c.harness_slug,
      href: `/harness/${c.harness_slug}`,
      claim_status: normalizeClaimStatus(c.claim_status),
    }));

  // 5) Recent activity feed — cross-harness, scoped to visible harnesses.
  let recent_activity: ActivityEntry[] = [];
  try {
    recent_activity = await loadUserRecentActivity({
      github_user_id,
      visible_harness_slugs: harnesses.map((h) => h.harness_slug),
      runQuery,
    });
  } catch {
    recent_activity = [];
  }

  return {
    github_user_id,
    github_login: primary.github_username,
    display_name: primary.display_name,
    avatar_url: primary.avatar_url,
    binding_status: pickBindingStatus(visibleContribRows),
    harnesses,
    recent_activity,
    claimed_harnesses,
  };
}
