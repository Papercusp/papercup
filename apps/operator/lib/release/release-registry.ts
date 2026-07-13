/**
 * The release registry — one row per cut, and the window of work it shipped.
 * (WI-4446; table: migration 589 `harness_shared.releases`.)
 *
 * [owner:Avi 2026-07-12] "we should also have the agent auto generate a high
 * level changelog. Can we also publish the full list of work items fixed between
 * releases and plans implemented?"
 *
 * TWO CONSUMERS, ONE TABLE — so they can never disagree about what shipped:
 *   1. the beta release-history page (static, on the R2 secret path)   → release-history-page.ts
 *   2. GET /api/updates/history (the in-app Update Center)             → updates-history.ts
 *
 * WHY THE LISTS ARE SNAPSHOTTED AT CUT TIME, NEVER RE-DERIVED ON READ:
 * "what shipped in 0.0.8" is a fact about the past. Re-deriving it from a live
 * work_items query would let a later edit — an item reopened, a plan renamed —
 * silently rewrite an already-published changelog. `snapshotWindow` runs ONCE,
 * at the cut, and the ids are frozen in the row.
 *
 * ⚠ SCOPE EVERY QUERY BY (workspace_id, harness_slug). These tables are
 * MULTI-TENANT: this dev box alone carries `papercusp-workspace` AND `default`,
 * and harness slugs `papercusp` AND `operator:papercusp-workspace`. A filter on
 * the slug alone silently reads another tenant's rows and looks like a diverged
 * store when it isn't.
 */

import type { Sql } from 'postgres';

/** Terminal statuses — an item in one of these SHIPPED. (Issue-family settles to
 *  `resolved`, feature-family to `passed`; `closed` covers both.) */
export const TERMINAL_STATUSES = ['resolved', 'passed', 'closed'] as const;

export interface ReleaseArtifact {
  product: 'gui' | 'server';
  /** e.g. `linux-x86_64`, `darwin-universal`, `windows-x86_64`. */
  platform: string;
  name: string;
  url: string;
  size: number;
  sha256: string;
}

/** One shipped work item, as frozen into the release row. */
export interface ShippedItem {
  id: string;
  title: string;
  planSlug: string | null;
}

/** One plan whose work landed in this window. */
export interface ShippedPlan {
  slug: string;
  title: string;
  status: string;
  /** The plan's markdown body — rendered onto its own page. */
  content: string;
  /** How many of this release's work items came from this plan. */
  itemCount: number;
}

export interface ReleaseRow {
  version: string;
  channel: string;
  cutAt: Date;
  publishedAt: Date | null;
  changelogMd: string | null;
  workItemIds: string[];
  planSlugs: string[];
  artifacts: ReleaseArtifact[];
  gitSha: string | null;
  cutBy: string | null;
  notes: string | null;
}

export interface Snapshot {
  items: ShippedItem[];
  plans: ShippedPlan[];
  /** Internal engineer-issue ids (EI-*) in the window. These ARE recorded in the
   *  release row — the row states the fact ("everything that went terminal"), and
   *  the VIEW decides what to show. The page counts them rather than listing them
   *  (see `isUserFacing`), but nothing is silently dropped from the record. */
  internalIds: string[];
}

/**
 * Is this work item user-facing release-notes material?
 *
 * `EI-*` are engineer-issues: the fleet's OWN self-improvement observations
 * ("this gate has no callers", "this tool's guidance is over budget"). They are
 * real work, but they are the agents fixing their own tooling — a beta tester
 * reading release notes has no use for them, and in a 4-day window there are
 * hundreds. Counted, not listed.
 */
export function isUserFacing(id: string): boolean {
  return !id.startsWith('EI-');
}

/**
 * Group a release's items by the plan that produced them, largest plan first,
 * with the unplanned items last.
 *
 * WHY GROUPING IS NOT COSMETIC: a real release window here is ~1,000 work items
 * (measured: 1,038 terminal in 4 days). A flat list of 1,000 titles is not "the
 * full list the owner asked for" — it is a wall no one reads. Grouped under the
 * plan each item came from, the same 1,000 items become ~44 readable stories.
 */
export function groupItemsByPlan(
  items: ShippedItem[],
  plans: ShippedPlan[],
): Array<{ plan: ShippedPlan | null; items: ShippedItem[] }> {
  const byPlan = new Map<string, ShippedItem[]>();
  const unplanned: ShippedItem[] = [];
  for (const item of items) {
    if (!item.planSlug) {
      unplanned.push(item);
      continue;
    }
    const bucket = byPlan.get(item.planSlug);
    if (bucket) bucket.push(item);
    else byPlan.set(item.planSlug, [item]);
  }

  const planBySlug = new Map(plans.map((p) => [p.slug, p]));
  const groups = [...byPlan.entries()]
    .map(([slug, groupItems]) => ({
      plan: planBySlug.get(slug) ?? null,
      items: groupItems,
      slug,
    }))
    // A plan we have no row for still gets its items shown (under its slug) —
    // dropping them would silently shrink "the full list".
    .filter((g) => g.items.length > 0)
    .sort((a, b) => b.items.length - a.items.length || a.slug.localeCompare(b.slug))
    .map(({ plan, items: groupItems }) => ({ plan, items: groupItems }));

  if (unplanned.length > 0) groups.push({ plan: null, items: unplanned });
  return groups;
}

// ────────────────────────────────────────────────────────────────────────────
// Postgres store. Thin by design: every non-trivial decision above is pure and
// unit-tested; these functions only fetch and shape.
// ────────────────────────────────────────────────────────────────────────────

export interface Scope {
  workspaceId: string;
  harnessSlug: string;
}

/**
 * Everything that went terminal in [fromMs, toMs) — the work this release shipped.
 * Bounds are EPOCH MILLIS because `work_items.updated_ts` is a BIGINT, not a
 * timestamptz: comparing it to `now() - interval '3 days'` fails outright with
 * `operator does not exist: bigint > timestamp with time zone`.
 */
export async function snapshotWindow(
  sql: Sql,
  scope: Scope,
  fromMs: number,
  toMs: number,
): Promise<Snapshot> {
  const rows = await sql<
    Array<{ feature_id: string; title: string; source_plan_slug: string | null }>
  >`
    SELECT feature_id, title, source_plan_slug
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND status = ANY(${sql.array([...TERMINAL_STATUSES])})
       AND updated_ts >= ${fromMs}
       AND updated_ts <  ${toMs}
     ORDER BY updated_ts ASC
  `;

  const items: ShippedItem[] = rows
    .filter((r) => isUserFacing(r.feature_id))
    .map((r) => ({ id: r.feature_id, title: r.title ?? '', planSlug: r.source_plan_slug }));
  const internalIds = rows.map((r) => r.feature_id).filter((id) => !isUserFacing(id));

  const slugs = [...new Set(items.map((i) => i.planSlug).filter((s): s is string => !!s))];
  const plans = slugs.length > 0 ? await fetchPlans(sql, scope, slugs, items) : [];

  return { items, plans, internalIds };
}

/**
 * Look up the display data for a release's FROZEN id lists.
 *
 * The row stores ids, not titles — deliberately. The SET of items is the fact we
 * freeze at cut time; a title someone later clarifies should show its improved
 * wording, but must never change WHICH items shipped. So: frozen ids in, current
 * titles out.
 */
export async function hydrateRelease(
  sql: Sql,
  scope: Scope,
  row: ReleaseRow,
): Promise<{ items: ShippedItem[]; plans: ShippedPlan[]; internalCount: number }> {
  const userFacingIds = row.workItemIds.filter(isUserFacing);
  const internalCount = row.workItemIds.length - userFacingIds.length;
  if (userFacingIds.length === 0) return { items: [], plans: [], internalCount };

  const rows = await sql<
    Array<{ feature_id: string; title: string; source_plan_slug: string | null }>
  >`
    SELECT feature_id, title, source_plan_slug
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND feature_id = ANY(${sql.array(userFacingIds)})
     ORDER BY updated_ts ASC
  `;
  const items: ShippedItem[] = rows.map((r) => ({
    id: r.feature_id,
    title: r.title ?? '',
    planSlug: r.source_plan_slug,
  }));
  const plans =
    row.planSlugs.length > 0 ? await fetchPlans(sql, scope, row.planSlugs, items) : [];
  return { items, plans, internalCount };
}

async function fetchPlans(
  sql: Sql,
  scope: Scope,
  slugs: string[],
  items: ShippedItem[],
): Promise<ShippedPlan[]> {
  const rows = await sql<
    Array<{ plan_slug: string; title: string; status: string; content: string | null }>
  >`
    SELECT plan_slug, title, status, content
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ANY(${sql.array(slugs)})
  `;
  const counts = new Map<string, number>();
  for (const i of items) {
    if (i.planSlug) counts.set(i.planSlug, (counts.get(i.planSlug) ?? 0) + 1);
  }
  return rows
    .map((r) => ({
      slug: r.plan_slug,
      title: r.title ?? r.plan_slug,
      status: r.status ?? 'unknown',
      content: r.content ?? '',
      itemCount: counts.get(r.plan_slug) ?? 0,
    }))
    .sort((a, b) => b.itemCount - a.itemCount || a.slug.localeCompare(b.slug));
}

/** Every recorded release for a channel, newest cut first. */
export async function listReleases(
  sql: Sql,
  workspaceId: string,
  channel?: string,
): Promise<ReleaseRow[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT version, channel, cut_at, published_at, changelog_md,
           work_item_ids, plan_slugs, artifacts, git_sha, cut_by, notes
      FROM harness_shared.releases
     WHERE workspace_id = ${workspaceId}
       ${channel ? sql`AND channel = ${channel}` : sql``}
     ORDER BY cut_at DESC
  `;
  return rows.map(toReleaseRow);
}

function toReleaseRow(r: Record<string, unknown>): ReleaseRow {
  return {
    version: String(r.version),
    channel: String(r.channel),
    cutAt: r.cut_at as Date,
    publishedAt: (r.published_at as Date | null) ?? null,
    changelogMd: (r.changelog_md as string | null) ?? null,
    workItemIds: (r.work_item_ids as string[] | null) ?? [],
    planSlugs: (r.plan_slugs as string[] | null) ?? [],
    artifacts: (r.artifacts as ReleaseArtifact[] | null) ?? [],
    gitSha: (r.git_sha as string | null) ?? null,
    cutBy: (r.cut_by as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  };
}

/** The cut_at of the release immediately BEFORE `cutAt` in the same channel —
 *  i.e. the lower bound of this release's window. Null when this is the first. */
export async function previousCutAt(
  sql: Sql,
  workspaceId: string,
  channel: string,
  cutAt: Date,
): Promise<Date | null> {
  const rows = await sql<Array<{ cut_at: Date }>>`
    SELECT cut_at
      FROM harness_shared.releases
     WHERE workspace_id = ${workspaceId}
       AND channel = ${channel}
       AND cut_at < ${cutAt}
     ORDER BY cut_at DESC
     LIMIT 1
  `;
  return rows[0]?.cut_at ?? null;
}

/** Insert (or update) the release row. Idempotent on (workspace, channel, version)
 *  so a re-run of the recorder after a fixed changelog is safe. */
export async function recordRelease(
  sql: Sql,
  workspaceId: string,
  row: ReleaseRow,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.releases
      (workspace_id, version, channel, cut_at, published_at, changelog_md,
       work_item_ids, plan_slugs, artifacts, git_sha, cut_by, notes)
    VALUES
      (${workspaceId}, ${row.version}, ${row.channel}, ${row.cutAt},
       ${row.publishedAt}, ${row.changelogMd},
       ${sql.array(row.workItemIds)}, ${sql.array(row.planSlugs)},
       ${sql.json(row.artifacts as unknown as object)},
       ${row.gitSha}, ${row.cutBy}, ${row.notes})
    ON CONFLICT (workspace_id, channel, version) DO UPDATE SET
      cut_at        = EXCLUDED.cut_at,
      published_at  = EXCLUDED.published_at,
      changelog_md  = EXCLUDED.changelog_md,
      work_item_ids = EXCLUDED.work_item_ids,
      plan_slugs    = EXCLUDED.plan_slugs,
      artifacts     = EXCLUDED.artifacts,
      git_sha       = EXCLUDED.git_sha,
      cut_by        = EXCLUDED.cut_by,
      notes         = EXCLUDED.notes
  `;
}
