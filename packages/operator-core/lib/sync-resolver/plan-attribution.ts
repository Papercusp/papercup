/**
 * plan-attribution — enrich the plans.* sync payloads (UI data layer) with
 * resolved author identities for the ownership/attribution badges
 * (shared-hive-collaboration-2026-06-14 P-001, B1, D-001).
 *
 * This is UI enrichment, deliberately kept OUT of the agent-facing plans:* tool
 * output: the badges are a desktop surfacing concern, so the resolution + extra
 * reads live at the sync-resolver layer (callPlansRead → enrich here) rather than
 * in the canonical read tool. Additive + best-effort: any failure leaves the base
 * payload untouched (the UI simply renders no badge).
 *
 * Reads are scoped to the plan's REAL workspace — derived per-harness for a single
 * plan (resolveWorkspaceForHarness, P-005), or the active workspace for the cross-plan
 * list/items enrichers (the UI lists one workspace at a time). NEVER a silent 'default'
 * (which mis-attributed badges across the WI-148 workspace split — D-003):
 *   - latest plan_revisions row per plan → the LAST EDITOR (author_id+author_kind).
 *   - harness_plan_parts.author per item → the PER-ITEM author. NOTE: on a single
 *     box the part author is the 'local'/'remote' origin sentinel (no device
 *     keypair), so per-item identity only carries real data under multi-machine
 *     federation; sentinel/empty authors are dropped (no badge) here.
 *
 * Identity resolution + always-renders fallback live in
 * lib/identity/resolve-plan-author-identity.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { resolveWorkspaceForHarness } from '../harness/workspace-for-harness';
import {
  resolvePlanAuthorIdentities,
  planAuthorKey,
  type PlanAuthorInput,
  type ResolvedAuthor,
} from '../identity/resolve-plan-author-identity';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/** Part authors that carry no real identity (single-box origin sentinels). */
const SENTINEL_AUTHORS = new Set(['', 'local', 'remote']);

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

interface LatestRevisionRow {
  harness_slug: string;
  plan_slug: string;
  author_id: string;
  author_kind: string;
}

/** Latest (max-seq) revision author per plan, batched (one query, no N+1). */
async function latestRevisionAuthors(
  workspaceId: string,
  planSlugs: string[],
  sql: Sql,
): Promise<Map<string, { authorId: string; authorKind: 'human' | 'agent' }>> {
  const out = new Map<string, { authorId: string; authorKind: 'human' | 'agent' }>();
  if (planSlugs.length === 0) return out;
  const rows = (await sql.unsafe(
    `SELECT DISTINCT ON (harness_slug, plan_slug) harness_slug, plan_slug, author_id, author_kind
       FROM harness_shared.plan_revisions
      WHERE workspace_id = $1 AND plan_slug = ANY($2)
      ORDER BY harness_slug, plan_slug, seq DESC`,
    [workspaceId, planSlugs],
  )) as unknown as LatestRevisionRow[];
  for (const r of rows) {
    out.set(`${r.harness_slug}:${r.plan_slug}`, {
      authorId: r.author_id,
      authorKind: r.author_kind === 'human' ? 'human' : 'agent',
    });
  }
  return out;
}

/** Per-item part authors for one plan (item:P-NNN → author), sentinels dropped. */
async function planItemAuthors(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  sql: Sql,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rows = (await sql.unsafe(
    `SELECT part_key, author FROM harness_shared.harness_plan_parts
      WHERE workspace_id = $1 AND harness_slug = $2 AND plan_slug = $3
        AND part_key LIKE 'item:%' AND tombstone = false`,
    [workspaceId, harnessSlug, planSlug],
  )) as unknown as Array<{ part_key: string; author: string | null }>;
  for (const r of rows) {
    const author = (r.author ?? '').trim();
    if (!author || SENTINEL_AUTHORS.has(author)) continue;
    out.set(r.part_key.slice('item:'.length), author);
  }
  return out;
}

interface PlanListRowLike {
  slug?: unknown;
  owner?: unknown;
  harness?: unknown;
  [k: string]: unknown;
}

/**
 * Enrich plans.list rows in place-by-copy with `ownerIdentity` + `lastEditor`.
 * One hive_members index query + one batched latest-revision query, total.
 */
export async function enrichPlanListRows(
  rows: unknown[],
  opts?: { sql?: Sql; workspaceId?: string },
): Promise<unknown[]> {
  const list = rows as PlanListRowLike[];
  if (!Array.isArray(list) || list.length === 0) return rows;
  const sql = pg(opts?.sql);
  // The list is scoped to ONE workspace (the UI shows the active workspace's plans); use
  // it for the attribution reads rather than a silent 'default' (P-005 / D-003).
  const workspaceId = opts?.workspaceId ?? activeWorkspaceId();

  const slugs = list.map((r) => (typeof r.slug === 'string' ? r.slug : null)).filter((s): s is string => !!s);
  let latest: Map<string, { authorId: string; authorKind: 'human' | 'agent' }>;
  try {
    latest = await latestRevisionAuthors(workspaceId, slugs, sql);
  } catch {
    latest = new Map();
  }

  const inputs: PlanAuthorInput[] = [];
  for (const r of list) {
    if (typeof r.owner === 'string' && r.owner.trim()) inputs.push({ kind: 'email', value: r.owner.trim() });
    const harness = typeof r.harness === 'string' ? r.harness : operatorHomeHarnessSlug();
    const slug = typeof r.slug === 'string' ? r.slug : '';
    const le = latest.get(`${harness}:${slug}`);
    if (le) inputs.push({ kind: 'authorId', value: le.authorId, authorKind: le.authorKind });
  }
  const resolved = await resolvePlanAuthorIdentities(workspaceId, inputs, { sql });

  return list.map((r) => {
    const harness = typeof r.harness === 'string' ? r.harness : operatorHomeHarnessSlug();
    const slug = typeof r.slug === 'string' ? r.slug : '';
    const ownerIdentity =
      typeof r.owner === 'string' && r.owner.trim()
        ? resolved.get(planAuthorKey('email', r.owner.trim())) ?? null
        : null;
    const le = latest.get(`${harness}:${slug}`);
    const lastEditor = le ? resolved.get(planAuthorKey('authorId', le.authorId)) ?? null : null;
    return { ...r, ownerIdentity, lastEditor };
  });
}

interface PlanItemRowLike {
  plan?: unknown;
  item?: { id?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * Enrich plans.items (cross-plan) rows with per-item `item.lastEditedBy`. One
 * batched plan_parts query across the listed plans + one resolver pass. Sentinel
 * (local/remote/null) authors are dropped, so on a single box this is a no-op
 * (graceful); it lights up when real per-op author pubkeys federate.
 */
export async function enrichPlanItemsRows(
  rows: unknown[],
  opts?: { sql?: Sql; workspaceId?: string },
): Promise<unknown[]> {
  const list = rows as PlanItemRowLike[];
  if (!Array.isArray(list) || list.length === 0) return rows;
  const sql = pg(opts?.sql);
  // Cross-plan, but within ONE workspace (the active one) — use it, not a silent 'default'.
  const workspaceId = opts?.workspaceId ?? activeWorkspaceId();

  const planSlugs = [
    ...new Set(list.map((r) => (typeof r.plan === 'string' ? r.plan : '')).filter(Boolean)),
  ];
  const authorByItem = new Map<string, string>();
  try {
    if (planSlugs.length > 0) {
      const partRows = (await sql.unsafe(
        `SELECT plan_slug, part_key, author FROM harness_shared.harness_plan_parts
          WHERE workspace_id = $1 AND plan_slug = ANY($2)
            AND part_key LIKE 'item:%' AND tombstone = false`,
        [workspaceId, planSlugs],
      )) as unknown as Array<{ plan_slug: string; part_key: string; author: string | null }>;
      for (const r of partRows) {
        const author = (r.author ?? '').trim();
        if (!author || SENTINEL_AUTHORS.has(author)) continue;
        authorByItem.set(`${r.plan_slug}:${r.part_key.slice('item:'.length)}`, author);
      }
    }
  } catch {
    /* leave empty → graceful no-badge */
  }
  if (authorByItem.size === 0) return rows;

  const inputs: PlanAuthorInput[] = [...new Set(authorByItem.values())].map((value) => ({
    kind: 'pubkey' as const,
    value,
  }));
  const resolved = await resolvePlanAuthorIdentities(workspaceId, inputs, { sql });

  return list.map((r) => {
    const plan = typeof r.plan === 'string' ? r.plan : '';
    const id = r.item && typeof r.item.id === 'string' ? r.item.id : '';
    const author = plan && id ? authorByItem.get(`${plan}:${id}`) : undefined;
    const lastEditedBy: ResolvedAuthor | null = author
      ? resolved.get(planAuthorKey('pubkey', author)) ?? null
      : null;
    return r.item ? { ...r, item: { ...r.item, lastEditedBy } } : r;
  });
}

interface PlanDetailLike {
  frontmatter?: { slug?: unknown; owner?: unknown; [k: string]: unknown };
  items?: Array<{ id?: unknown; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * Enrich a single plans.get payload with plan-level `ownerIdentity` +
 * `lastEditor` and per-item `lastEditedBy` (when a real, non-sentinel part
 * author resolves). Best-effort.
 */
export async function enrichPlanDetail(
  plan: unknown,
  opts?: { sql?: Sql; workspaceId?: string; harnessSlug?: string },
): Promise<unknown> {
  const p = plan as PlanDetailLike;
  if (!p || typeof p !== 'object' || !p.frontmatter) return plan;
  const sql = pg(opts?.sql);
  const slug = typeof p.frontmatter.slug === 'string' ? p.frontmatter.slug : '';
  const harnessSlug = opts?.harnessSlug ?? operatorHomeHarnessSlug();
  if (!slug) return plan;
  // Derive the workspace from THIS plan's harness (P-005) — best-effort: if the harness
  // can't be resolved to a workspace, leave the payload un-enriched (graceful no-badge),
  // never a silent cross-workspace 'default' read (D-003).
  let workspaceId: string;
  try {
    workspaceId = await resolveWorkspaceForHarness(harnessSlug, opts?.workspaceId);
  } catch {
    return plan;
  }

  let latest = new Map<string, { authorId: string; authorKind: 'human' | 'agent' }>();
  let itemAuthors = new Map<string, string>();
  try {
    [latest, itemAuthors] = await Promise.all([
      latestRevisionAuthors(workspaceId, [slug], sql),
      planItemAuthors(workspaceId, harnessSlug, slug, sql),
    ]);
  } catch {
    /* leave empty → graceful no-badge */
  }

  const owner = typeof p.frontmatter.owner === 'string' ? p.frontmatter.owner.trim() : '';
  const le = latest.get(`${harnessSlug}:${slug}`);
  const inputs: PlanAuthorInput[] = [];
  if (owner) inputs.push({ kind: 'email', value: owner });
  if (le) inputs.push({ kind: 'authorId', value: le.authorId, authorKind: le.authorKind });
  for (const author of itemAuthors.values()) inputs.push({ kind: 'pubkey', value: author });
  const resolved = await resolvePlanAuthorIdentities(workspaceId, inputs, { sql });

  const ownerIdentity = owner ? resolved.get(planAuthorKey('email', owner)) ?? null : null;
  const lastEditor = le ? resolved.get(planAuthorKey('authorId', le.authorId)) ?? null : null;

  const items = Array.isArray(p.items)
    ? p.items.map((it) => {
        const id = typeof it.id === 'string' ? it.id : '';
        const author = id ? itemAuthors.get(id) : undefined;
        const lastEditedBy: ResolvedAuthor | null = author
          ? resolved.get(planAuthorKey('pubkey', author)) ?? null
          : null;
        return { ...it, lastEditedBy };
      })
    : p.items;

  return { ...p, ownerIdentity, lastEditor, items };
}
