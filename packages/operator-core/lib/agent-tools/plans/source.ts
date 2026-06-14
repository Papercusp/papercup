/**
 * PG-canonical source for plans.
 *
 * Plans live in `harness_shared.harness_plans` — one row per plan, keyed by
 * (workspace_id, harness_slug, plan_slug). The `content` column holds the
 * canonical markdown blob; reads parse it into a `ParsedPlan` exactly as the
 * old filesystem reader did, so every downstream consumer (items/list/search/
 * effective-status) is unchanged. The frontmatter + op_* columns are a derived
 * index maintained on write.
 *
 * Plan: plans-pg-canonical-migration-2026-06-03 (Stage 1 — reads/writes flip
 * FS→PG). The filesystem at apps/operator/docs/plans/ is retired in Stage 2.
 *
 * The dir-resolution helpers (getRepoRoot / resolveHarnessPlansDir) survive as
 * SLUG/HARNESS VALIDATORS + repo-root resolvers (a launched plan agent still
 * `cd`s into the repo root); they no longer read plan bytes.
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { parsePlan, type ParsedPlan, type PlanItem, type PlanStatus } from './parser';
import { hashPlanContent } from './content-hash';
import { withWorkspace } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { loadHarnessRegistry } from '../../harness-registry';
import { resolveProject } from '../../harness-core';
import { detectPapercupRoot, PAPERCUP_HARNESS_SLUG } from '../../harness/register-papercup';

export const PLANS_DIR_REL = 'apps/operator/docs/plans';
export const ARCHIVE_DIR_REL = 'apps/operator/docs/plans/archive';

const PAPERCUP_PLANS_REL = 'apps/operator/docs/plans';
const DEFAULT_HARNESS_PLANS_REL = 'docs/plans';

function plansRelFor(harnessPath: string): string {
  const detected = detectPapercupRoot();
  if (detected && path.resolve(harnessPath) === path.resolve(detected)) {
    return PAPERCUP_PLANS_REL;
  }
  return DEFAULT_HARNESS_PLANS_REL;
}

/**
 * Options threading the (workspace, harness) PG key through the read API.
 * `harnessSlug` is the only field consumers need; `workspaceId` is resolved
 * from the registry when omitted. The legacy filesystem override fields
 * (`plansDir` / `archiveDir` / `repoRoot`) are accepted-but-ignored so the
 * ~handful of historical call sites that still pass them keep compiling
 * through the Stage-2 cleanup.
 */
export interface PlanSourceOpts {
  /** Harness whose plans to read. Omitted / '*' / 'all' → papercup primary. */
  harnessSlug?: string;
  /** Workspace the plans live in. Omitted → resolved from the registry / DEFAULT. */
  workspaceId?: string;
  /** @deprecated filesystem override — ignored under PG-canonical storage. */
  plansDir?: string;
  /** @deprecated filesystem override — ignored under PG-canonical storage. */
  archiveDir?: string;
  /** @deprecated filesystem override — ignored under PG-canonical storage. */
  repoRoot?: string;
}

/** A raw harness_plans row (camelCased), for callers needing version / op_* state. */
export interface PlanRow {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  content: string;
  contentHash: string;
  version: number;
  title: string | null;
  status: string | null;
  created: string | null;
  updated: string | null;
  owner: string | null;
  /** P-015 free-text initiative grouping label (frontmatter-derived). */
  initiative: string | null;
  supersedes: string[];
  supersededBy: string | null;
  opStatus: 'started' | 'paused' | 'done' | null;
  opStartedAt: string | null;
  opUpdatedAt: string | null;
  currentWave: string | null;
  opPriority: number | null;
  archived: boolean;
  isLegacy: boolean;
  updatedAt: string;
  // Stage-3 structured derived index (may be empty for un-normalized rows).
  items: PlanIndexItem[];
  decisions: PlanIndexDecision[];
  nowState: string | null;
  nowNext: string | null;
}

interface PlanDbRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  content: string;
  content_hash: string;
  version: string | number;
  title: string | null;
  status: string | null;
  created: string | null;
  updated: string | null;
  owner: string | null;
  initiative: string | null;
  supersedes: string[] | null;
  superseded_by: string | null;
  op_status: string | null;
  op_started_at: string | null;
  op_updated_at: string | null;
  current_wave: string | null;
  op_priority: number | null;
  archived: boolean;
  is_legacy: boolean;
  updated_at: string;
  items: unknown;
  decisions: unknown;
  now_state: string | null;
  now_next: string | null;
}

function rowFromDb(r: PlanDbRow): PlanRow {
  return {
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    planSlug: r.plan_slug,
    content: r.content,
    contentHash: r.content_hash,
    version: Number(r.version),
    title: r.title,
    status: r.status,
    created: r.created,
    updated: r.updated,
    owner: r.owner,
    initiative: r.initiative,
    supersedes: r.supersedes ?? [],
    supersededBy: r.superseded_by,
    opStatus: (r.op_status as PlanRow['opStatus']) ?? null,
    opStartedAt: r.op_started_at,
    opUpdatedAt: r.op_updated_at,
    currentWave: r.current_wave,
    opPriority: r.op_priority,
    archived: r.archived,
    isLegacy: r.is_legacy,
    updatedAt: r.updated_at,
    items: Array.isArray(r.items) ? (r.items as PlanIndexItem[]) : [],
    decisions: Array.isArray(r.decisions) ? (r.decisions as PlanIndexDecision[]) : [],
    nowState: r.now_state,
    nowNext: r.now_next,
  };
}

/**
 * Resolve a `PlanSourceOpts` to the concrete (workspaceId, harnessSlug) PG key.
 * No harness / the SU wildcard `'*'` / `'all'` / the papercup slug → the
 * papercup primary harness in its workspace. A concrete other slug → that
 * harness, whose workspace is looked up via the registry (cross-workspace
 * fallback, mirroring the old FS resolver) and defaulted to DEFAULT_WORKSPACE_ID.
 */
export async function resolvePlanScope(
  opts: PlanSourceOpts = {},
): Promise<{ workspaceId: string; harnessSlug: string }> {
  const raw = opts.harnessSlug?.trim();
  if (!raw || raw === '*' || raw === 'all' || raw === PAPERCUP_HARNESS_SLUG) {
    return {
      workspaceId: opts.workspaceId ?? DEFAULT_WORKSPACE_ID,
      harnessSlug: PAPERCUP_HARNESS_SLUG,
    };
  }
  if (opts.workspaceId) return { workspaceId: opts.workspaceId, harnessSlug: raw };
  let workspaceId = DEFAULT_WORKSPACE_ID;
  try {
    const project = await resolveProject(raw);
    const ws = (project as { workspaceId?: string } | null | undefined)?.workspaceId;
    if (ws) workspaceId = ws;
  } catch {
    // Unknown harness — default workspace; the SELECT simply returns no rows.
  }
  return { workspaceId, harnessSlug: raw };
}

/** Synthetic stable locator for a plan (the old `.md` path) — display + lock key. */
export function syntheticPlanPath(harnessSlug: string, slug: string): string {
  return harnessSlug === PAPERCUP_HARNESS_SLUG
    ? `${PLANS_DIR_REL}/${slug}.md`
    : `${harnessSlug}/${DEFAULT_HARNESS_PLANS_REL}/${slug}.md`;
}

// ── Filesystem dir helpers (repo-root / cwd resolution only — NOT plan bytes) ──

function resolveCanonicalRoots(opts: PlanSourceOpts): { plans: string; archive: string } {
  const candidates: string[] = [];
  if (opts.repoRoot) {
    candidates.push(opts.repoRoot);
  } else {
    // Prefer the registry-detected papercup root (same preference as
    // getRepoRoot): the papercup plans dir is a property of THE papercup
    // checkout, not of whichever host cwd happens to be running this code.
    // (A host whose cwd is another checkout — e.g. the :3070 release artifact —
    // must still resolve the canonical tree's mirror dir.)
    const detected = detectPapercupRoot();
    if (detected) candidates.push(detected);
    const cwd = process.cwd();
    candidates.push(cwd);
    if (cwd.endsWith(path.sep + 'apps' + path.sep + 'operator')) {
      candidates.push(path.dirname(path.dirname(cwd)));
    } else if (cwd.endsWith('/apps/operator')) {
      candidates.push(path.resolve(cwd, '..', '..'));
    }
  }
  for (const root of candidates) {
    const direct = path.join(root, PLANS_DIR_REL);
    // NB: must be a static import — a runtime `require('node:fs')` here threw
    // under the tsx/ESM host, silently failing EVERY candidate and falling
    // back to cwd, which mis-rooted the plan-markdown mirror into a nested
    // apps/operator/apps/operator/docs/plans/ (found live 2026-06-06).
    if (existsSync(direct)) {
      return { plans: direct, archive: path.join(root, ARCHIVE_DIR_REL) };
    }
  }
  const root = candidates[0] ?? process.cwd();
  return { plans: path.join(root, PLANS_DIR_REL), archive: path.join(root, ARCHIVE_DIR_REL) };
}

export function getPlansDir(opts: PlanSourceOpts = {}): string {
  return resolveCanonicalRoots(opts).plans;
}
export function getArchiveDir(opts: PlanSourceOpts = {}): string {
  return resolveCanonicalRoots(opts).archive;
}

/**
 * The repo root — where a launched plan agent starts its process
 * (plan-agent-launch-2026-05-21). Prefer the registry-detected root so it stays
 * correct after the FS retirement (the `docs/plans/` dir is empty/absent once
 * plans are PG-canonical); fall back to the legacy dir-walk for tests that pass
 * an explicit `repoRoot`.
 */
export function getRepoRoot(opts: PlanSourceOpts = {}): string {
  if (!opts.repoRoot) {
    const detected = detectPapercupRoot();
    if (detected) return detected;
  }
  return path.resolve(getPlansDir(opts), '..', '..', '..', '..');
}

/**
 * Resolve a harness slug to its canonical slug + workspace + repo-root dirs.
 * Now a VALIDATOR + repo-dir resolver (the `plans`/`archive` paths are the
 * harness's docs/plans location, used for cwd/launch and synthetic locators —
 * not for reading plan bytes, which come from PG). Throws if the harness isn't
 * registered (preserved behavior).
 */
export async function resolveHarnessPlansDir(
  harnessSlug?: string,
  opts: { workspaceId?: string } = {},
): Promise<{ harnessSlug: string; workspaceId: string; plans: string; archive: string }> {
  const reg = await loadHarnessRegistry(opts.workspaceId);
  const raw = harnessSlug?.trim();

  let project: (typeof reg.projects)[number] | undefined;
  let resolved: string;

  if (!raw || raw === '*') {
    const detected = detectPapercupRoot();
    if (detected) {
      project = reg.projects.find((p) => path.resolve(p.path) === path.resolve(detected));
    }
    project = project ?? reg.projects.find((p) => p.slug === PAPERCUP_HARNESS_SLUG);
    if (!project) {
      throw new Error(
        `resolveHarnessPlansDir: no harness in ctx and no primary harness findable ` +
          `(no path-match for repo root '${detected}', no '${PAPERCUP_HARNESS_SLUG}' slug). ` +
          `Available: ${reg.projects.map((p) => p.slug).join(', ') || '(none)'}`,
      );
    }
    resolved = project.slug;
  } else {
    resolved = raw;
    project = (await resolveProject(resolved, opts.workspaceId)) ?? undefined;
    if (!project) {
      const didYouMean = resolved === 'papercusp' ? ` Did you mean '${PAPERCUP_HARNESS_SLUG}'?` : '';
      throw new Error(
        `resolveHarnessPlansDir: harness '${resolved}' not registered in any workspace.${didYouMean} ` +
          `Active-workspace harnesses: ${reg.projects.map((p) => p.slug).join(', ') || '(none)'}`,
      );
    }
  }
  if (resolved === PAPERCUP_HARNESS_SLUG) {
    const detected = detectPapercupRoot();
    if (detected && path.resolve(project.path) !== path.resolve(detected)) {
      throw new Error(
        `P-014 runtime guard: papercup harness path '${project.path}' does not match ` +
          `detected repo root '${detected}'. The registry is out of sync.`,
      );
    }
  }
  const plans = path.join(project.path, plansRelFor(project.path));
  const workspaceId =
    (project as { workspaceId?: string }).workspaceId ?? opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
  return { harnessSlug: resolved, workspaceId, plans, archive: path.join(plans, 'archive') };
}

/**
 * Whitelist of characters legal in a plan slug. Rejecting `/` is what stops a
 * `../../../etc/passwd`-style traversal in the synthetic lock path; the read
 * path no longer touches the filesystem, but the slug is still the PG key and
 * the lock key, so the guard stays.
 */
export const VALID_PLAN_SLUG = /^[A-Za-z0-9._-]+$/;

export interface ListEntry {
  slug: string;
  /** Synthetic stable locator (the old `.md` path) — no file exists under PG storage. */
  filePath: string;
  archived: boolean;
}

/** List plan slugs for a harness (PG). Sorted by slug for a stable directory. */
export async function listPlanFiles(
  opts: PlanSourceOpts & { includeArchived?: boolean } = {},
): Promise<ListEntry[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ plan_slug: string; archived: boolean }[]>`
      SELECT plan_slug, archived
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       ORDER BY plan_slug ASC
    `;
  });
  return rows
    .filter((r) => opts.includeArchived || !r.archived)
    .map((r) => ({
      slug: r.plan_slug,
      filePath: syntheticPlanPath(harnessSlug, r.plan_slug),
      archived: r.archived,
    }));
}

/** Fetch one plan's raw row (PG), or null when it doesn't exist. */
export async function getPlanRow(
  slug: string,
  opts: PlanSourceOpts = {},
): Promise<PlanRow | null> {
  if (typeof slug !== 'string' || !VALID_PLAN_SLUG.test(slug)) return null;
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<PlanDbRow[]>`
      SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
             title, status, created, updated, owner, initiative, supersedes, superseded_by,
             op_status, op_started_at, op_updated_at, current_wave, op_priority,
             archived, is_legacy, updated_at, items, decisions, now_state, now_next
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND plan_slug = ${slug}
    `;
  });
  return rows[0] ? rowFromDb(rows[0]) : null;
}

/** All plan rows for a harness (PG), live + optionally archived. The archived
 *  filter runs in SQL — excluded rows' content blobs never leave PG (P-042). */
export async function listPlanRows(
  opts: PlanSourceOpts & { includeArchived?: boolean } = {},
): Promise<PlanRow[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const rows = await withWorkspace(workspaceId, async (tx) => {
    const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
    return tx<PlanDbRow[]>`
      SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
             title, status, created, updated, owner, initiative, supersedes, superseded_by,
             op_status, op_started_at, op_updated_at, current_wave, op_priority,
             archived, is_legacy, updated_at, items, decisions, now_state, now_next
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       ${archivedFilter}
       ORDER BY plan_slug ASC
    `;
  });
  return rows.map(rowFromDb);
}

/** A plan row WITHOUT the content blob — the derived/frontmatter projection
 *  columns only. What `plans:list` renders from (audit P-042). */
export type PlanIndexRow = Omit<PlanRow, 'content'>;

/**
 * Index-only listing: every projection column, never the content blob, with
 * the archived/status filters pushed into SQL and an optional LIMIT
 * (audit P-042 — EI-98/EI-174/EI-175 were `plans:list` loading + parsing
 * every body per request). Rows arrive parse-free; a consumer needing item
 * statuses reads the Stage-3 `items` jsonb already on the row.
 */
export async function listPlanIndexRows(
  opts: PlanSourceOpts & { includeArchived?: boolean; status?: string; limit?: number } = {},
): Promise<PlanIndexRow[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const rows = await withWorkspace(workspaceId, async (tx) => {
    const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
    const statusFilter = opts.status ? tx`AND status = ${opts.status}` : tx``;
    const limitClause = opts.limit && opts.limit > 0 ? tx`LIMIT ${opts.limit}` : tx``;
    return tx<Array<Omit<PlanDbRow, 'content'>>>`
      SELECT workspace_id, harness_slug, plan_slug, content_hash, version,
             title, status, created, updated, owner, initiative, supersedes, superseded_by,
             op_status, op_started_at, op_updated_at, current_wave, op_priority,
             archived, is_legacy, updated_at, items, decisions, now_state, now_next
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       ${archivedFilter}
       ${statusFilter}
       ORDER BY plan_slug ASC
       ${limitClause}
    `;
  });
  return rows.map((r) => {
    const { content: _content, ...rest } = rowFromDb({ ...r, content: '' } as PlanDbRow);
    return rest;
  });
}

/**
 * Batched content fetch for a small, known slug set — the targeted fallback
 * for index rows whose Stage-3 `items` projection is empty (a federated
 * remote row whose projection didn't fill, audit P-042). One query, only
 * the named rows' blobs.
 */
export async function getPlanContentsBySlugs(
  slugs: string[],
  opts: PlanSourceOpts = {},
): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<Array<{ plan_slug: string; content: string }>>`
      SELECT plan_slug, content
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND plan_slug = ANY(${slugs}::text[])
    `;
  });
  return new Map(rows.map((r) => [r.plan_slug, r.content]));
}

/** Escape LIKE/ILIKE wildcards in a user token so it matches literally. */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * SQL candidate prefilter for `plans:search` (audit P-042): only rows whose
 * content contains ≥1 query token (case-insensitive) come back — every
 * search scope (title/now/items/decisions/prose) is a substring of the
 * content blob, so a plan with zero token hits can never score and is
 * lossless to exclude. `limit` caps the candidate set; `truncated` reports
 * when the cap bit (no silent caps).
 */
export async function listPlanRowsMatchingAnyToken(
  tokens: string[],
  opts: PlanSourceOpts & { includeArchived?: boolean; limit?: number } = {},
): Promise<{ rows: PlanRow[]; truncated: boolean }> {
  if (tokens.length === 0) return { rows: [], truncated: false };
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;
  const patterns = tokens.map((t) => `%${escapeLike(t)}%`);
  const rows = await withWorkspace(workspaceId, async (tx) => {
    const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
    return tx<PlanDbRow[]>`
      SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
             title, status, created, updated, owner, initiative, supersedes, superseded_by,
             op_status, op_started_at, op_updated_at, current_wave, op_priority,
             archived, is_legacy, updated_at, items, decisions, now_state, now_next
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       ${archivedFilter}
         AND content ILIKE ANY(${patterns}::text[])
       ORDER BY plan_slug ASC
       LIMIT ${limit + 1}
    `;
  });
  const truncated = rows.length > limit;
  return { rows: (truncated ? rows.slice(0, limit) : rows).map(rowFromDb), truncated };
}

/**
 * Read one plan by slug, parsing its canonical content blob into a ParsedPlan.
 * Shape preserved from the FS reader (`{ parsed, archived }`) + the raw `row`
 * for callers needing version / op_* state. Returns null on an invalid slug or
 * a missing plan.
 */
export async function readPlanBySlug(
  slug: string,
  opts: PlanSourceOpts = {},
): Promise<{ parsed: ParsedPlan; archived: boolean; row: PlanRow } | null> {
  const row = await getPlanRow(slug, opts);
  if (!row) return null;
  return {
    parsed: parsePlan(row.content, { filePath: syntheticPlanPath(row.harnessSlug, row.planSlug) }),
    archived: row.archived,
    row,
  };
}

/** All plans for a harness, parsed. Mirrors the old FS `readAllPlans`. */
export async function readAllPlans(
  opts: PlanSourceOpts & { includeArchived?: boolean } = {},
): Promise<Array<{ parsed: ParsedPlan; archived: boolean; row: PlanRow }>> {
  const rows = await listPlanRows(opts);
  return rows.map((row) => ({
    parsed: parsePlan(row.content, { filePath: syntheticPlanPath(row.harnessSlug, row.planSlug) }),
    archived: row.archived,
    row,
  }));
}

/** A plan item as stored in the derived `items` jsonb column (Stage 3 normalize). */
export interface PlanIndexItem {
  id: string;
  status: string;
  text: string;
  importance: string;
  blockedBy: string[];
  decisionRefs: string[];
  phase: string | null;
}

/** A decision as stored in the derived `decisions` jsonb column (Stage 3 normalize). */
export interface PlanIndexDecision {
  id: string;
  title: string;
  body: string;
  date: string | null;
  itemRefs: string[];
}

/**
 * Frontmatter + structured derived index for a plan, recomputed from the
 * canonical markdown on every write + backfill (D-006 — content is canonical;
 * these are a queryable derived index).
 */
export interface PlanIndex {
  title: string | null;
  status: PlanStatus | null;
  created: string | null;
  updated: string | null;
  owner: string | null;
  initiative: string | null;
  supersedes: string[];
  supersededBy: string | null;
  isLegacy: boolean;
  // Stage-3 structured index (normalize).
  items: PlanIndexItem[];
  decisions: PlanIndexDecision[];
  nowState: string | null;
  nowNext: string | null;
}

/** Parse a plan body into its derived index (frontmatter + structured sections). */
export function deriveIndexFromContent(content: string): PlanIndex {
  const p = parsePlan(content);
  const fm = p.frontmatter;
  return {
    title: fm.title ?? null,
    status: fm.status ?? null,
    created: fm.created ?? null,
    updated: fm.updated ?? null,
    owner: fm.owner ?? null,
    initiative: fm.initiative ?? null,
    supersedes: fm.supersedes ?? [],
    supersededBy: fm.supersededBy ?? null,
    isLegacy: p.isLegacy,
    items: p.items.map((i) => ({
      id: i.id,
      status: i.storedStatus,
      text: i.text,
      importance: i.importance,
      blockedBy: i.blockedBy,
      decisionRefs: i.decisionRefs,
      phase: i.phase,
    })),
    decisions: p.decisions.map((d) => ({
      id: d.id,
      title: d.title,
      body: d.body,
      date: d.date,
      itemRefs: d.itemRefs,
    })),
    nowState: p.now?.state ?? null,
    nowNext: p.now?.next ?? null,
  };
}

/**
 * Resolve a plan row's items from the PG-canonical structured `items` index
 * (plans-pg-canonical-migration Stage 3) — no content-blob parse. Falls back to
 * parsing `content` only when the structured index is empty/absent (a federated
 * remote row whose projection didn't fill the derived columns, or a genuinely
 * itemless plan — the parse is cheap either way). The ONE answer to "what items
 * does this plan have" — plans:items, set-status's flip, and declare-intent's
 * lane validation must all agree (EI-356).
 */
export function planItemsForRow(row: PlanRow): PlanItem[] {
  if (row.items.length > 0) {
    return row.items.map((i) => ({
      id: i.id,
      text: i.text,
      storedStatus: i.status as PlanItem['storedStatus'],
      importance: i.importance as PlanItem['importance'],
      blockedBy: i.blockedBy,
      decisionRefs: i.decisionRefs,
      phase: i.phase,
      lineNumber: 0,
      rawLine: '',
    }));
  }
  return parsePlan(row.content).items;
}
