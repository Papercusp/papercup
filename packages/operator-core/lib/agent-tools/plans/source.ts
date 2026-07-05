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
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { parsePlan, type ParsedPlan, type PlanItem, type PlanStatus } from './parser';
import { hashPlanContent } from './content-hash';
import { parsePromotePolicy, type ParsePromoteResult } from './promote-policy';
import type { Sql } from 'postgres';
import { withWorkspace } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { loadHarnessRegistry } from '../../harness-registry';
import { resolveProject, resolveWorkspaceForHarnessSlug } from '../../harness-core';
import { detectPapercupRoot } from '../../harness/register-papercusp';
import { canonicalHarnessSlug, operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { PAPERCUSP_WORKSPACE_ID } from '../../harness/papercusp-workspace';
import { hiveHomeSlugForHarness } from '../../hive-federation';

export const PLANS_DIR_REL = 'apps/operator/docs/plans';
export const ARCHIVE_DIR_REL = 'apps/operator/docs/plans/archive';

const PAPERCUP_PLANS_REL = 'apps/operator/docs/plans';
const DEFAULT_HARNESS_PLANS_REL = 'docs/plans';

/**
 * Normalize a path for a same-directory comparison, resolving symlinks.
 *
 * `path.resolve` is string-only (it never touches the filesystem), so it
 * treats a symlink and its target as DIFFERENT paths — and the canonical
 * checkout is reachable via a `papercup` symlink → `papercusp`, so two
 * strings naming the SAME directory compare unequal. `fs.realpathSync`
 * collapses the symlink, so the two forms match. Falls back to
 * `path.resolve` when the path doesn't exist yet (realpath throws ENOENT),
 * wrapped so a missing dir never crashes the caller (mirrors
 * `realpathOrSelf` in file-lock-authority-wiring.ts).
 */
function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function plansRelFor(harnessPath: string): string {
  const detected = detectPapercupRoot();
  if (detected && realpathOrResolve(harnessPath) === realpathOrResolve(detected)) {
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
/**
 * The authored schedule of a scheduled/recurring plan (scheduled-recurring-plans-2026-06-16
 * D-004). Stored in the `schedule` jsonb column; NULL ⇒ the plan is not scheduled. The
 * recurrence SET is RRULE-native (rrule + rdate + exdate, anchored on dtstart/tzid); `cron`
 * is an alternate input dialect. The engine computes next_fire_at directly from this — it is
 * never converted to cron.
 */
export interface PlanSchedule {
  kind: 'rrule' | 'cron';
  rrule?: string;
  dtstart?: string;
  tzid?: string;
  rdate?: string[];
  exdate?: string[];
  cron?: string;
  concurrency?: 'queue' | 'skip' | 'cancel-prev';
  catchup?: 'skip-old' | 'run-all-backlog';
  carryState?: boolean;
  costCapCents?: number;
  /**
   * The frontier item_kind each run mints (D-006/P-009). Default 'feature' (coding
   * spine). Validated against the feature-family kinds at author time (plans:set-schedule).
   */
  executorKind?: 'feature' | 'chunk';
}

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
  /** Template TYPE a plan conforms to (plan-templates-and-rubric-v2 P-004/P-005) —
   *  a code-registry zod schema name (e.g. 'rubric'); frontmatter-derived (mirrors
   *  `initiative`), null for ordinary plans. Distinct from `templateSlug` (the
   *  scheduled-instance back-pointer). */
  template: string | null;
  /** Per-plan structured template instance data (jsonb), validated against the
   *  template's registry zod schema on write (plans:set-template-data, P-005);
   *  null until set, never parsed from frontmatter. */
  templateData: unknown;
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
  /** v2 P-001: the parsed `## Promote` policy ({ policy, warnings }); NULL when the row hasn't been
   *  repopulated since mig 331 (consumers fall back to parsing content until the next write). */
  promotePolicy: ParsePromoteResult | null;
  // Scheduled/recurring plans (scheduled-recurring-plans-2026-06-16, mig 299).
  /** Authored recurrence set + policy; NULL ⇒ not scheduled (D-004). */
  schedule: PlanSchedule | null;
  /** Armed/active — false until armed via the autonomy-governed flow (D-010). */
  scheduleActive: boolean;
  /** One-shot fire time (drag-onto-a-day); NULL for pure recurrence/unscheduled (D-004). */
  scheduledAt: string | null;
  /** Recurrence end / deadline; on expiry the schedule deactivates (D-004). */
  expiresAt: string | null;
  /** Per-plan timezone for calendar-time recurrence; NULL ⇒ workspace/user default (D-013). */
  tzid: string | null;
  /** Instance→template back-pointer (Option C, D-003); NULL for templates + ordinary plans. */
  templateSlug: string | null;
  /** Run ordinal for an instance plan (D-003). */
  runSeq: number | null;
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
  template: string | null;
  template_data: unknown;
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
  promote_policy: unknown;
  schedule: unknown;
  schedule_active: boolean;
  scheduled_at: string | null;
  expires_at: string | null;
  tzid: string | null;
  template_slug: string | null;
  run_seq: number | null;
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
    template: r.template ?? null,
    templateData: r.template_data ?? null,
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
    // v2 P-001: surface the structured promote-policy; null when the column hasn't been repopulated
    // (the row predates mig 331's lazy-populate) → consumers fall back to parsing content.
    promotePolicy: (r.promote_policy as ParsePromoteResult | null) ?? null,
    schedule: (r.schedule as PlanSchedule | null) ?? null,
    scheduleActive: r.schedule_active ?? false,
    scheduledAt: r.scheduled_at,
    expiresAt: r.expires_at,
    tzid: r.tzid,
    templateSlug: r.template_slug,
    runSeq: r.run_seq,
  };
}

/**
 * True for the harness slugs that resolve to the operator-home harness:
 * the empty / unset case, the SU wildcards `'*'` / `'all'`, and the literal
 * operator-home slug. Shared by `fill_workspace_id_from_projects` and
 * `resolvePlanScope` so the "this is the operator home" predicate is defined once.
 */
function isOperatorHomeScope(raw: string | undefined): boolean {
  const canonical = raw ? canonicalHarnessSlug(raw) : raw;
  return !canonical || canonical === '*' || canonical === 'all' || canonical === operatorHomeHarnessSlug();
}

/** Injectable seam for the projects-table lookup — overridden in unit tests
 *  so the slug→workspace resolution is exercised without a live PG. Returns
 *  the DISTINCT set of workspace_ids that carry the slug. */
export type ProjectsWorkspaceLookup = (slug: string) => Promise<string[]>;

/** Injectable seam for the AUTHORITATIVE-registry fallback (resolveWorkspaceForHarnessSlug):
 *  slug → its workspace_id (or null), used when the projects projection has no row.
 *  Overridden in unit tests so the fallback branch is exercised without a live PG. */
export type RegistryWorkspaceResolver = (slug: string) => Promise<string | null>;

/**
 * Which workspace_id(s) carry `harness_slug` in `harness_shared.projects`.
 *
 * NB (2026-06-18): `harness_shared.projects` is NOT the universal harness
 * registry — it is the org/department blueprint's PROJECTION (business columns
 * owning_dept/vertical/budget_cents; the sole non-test writer is the
 * `execute-action.ts` project-create action), so it is sparse and a hive/generic
 * harness never appears in it. The de-facto AUTHORITATIVE slug→workspace registry
 * is `harness_shared.harness_registry` (resolveProject / resolveWorkspaceForHarnessSlug),
 * which pot:create/harness:create write and the work-items path reads. The older
 * "projects is authoritative" framing (migration 221 leg 1) is STALE — kept here
 * only as the FIRST consult; `fill_workspace_id_from_projects` falls back to the
 * registry when this returns 0 (peers su-a7f66 / su-632e0166, sibling EI-1511).
 * UNIQUE (workspace_id, slug) still holds, so a slug appears at most once per
 * workspace but MAY appear in several (a same-name collision). The cross-workspace
 * read uses the admin-bypass connection (harness_admin, RLS off) because the
 * calling context's workspace GUC is not necessarily the one that owns the slug.
 */
async function lookupProjectWorkspaceIds(slug: string): Promise<string[]> {
  return withWorkspace(
    '',
    async (tx) => {
      const rows = await tx<{ workspace_id: string }[]>`
        SELECT DISTINCT workspace_id
          FROM harness_shared.projects
         WHERE slug = ${slug}
           AND COALESCE(workspace_id, '') <> ''
      `;
      return rows.map((r) => r.workspace_id);
    },
    { bypassRlsForAdmin: true },
  );
}

/**
 * Resolve a harness slug → its workspace_id from the projects/registry source
 * of truth (WI-148 / P-013 workspace-identity reconciliation, the SAFE forward
 * half).
 *
 * Rules (fail-loud, no silent cross-workspace default):
 *   - operator-home / empty / '*' / 'all' / operatorHomeHarnessSlug() → PAPERCUSP_WORKSPACE_ID.
 *     WI-148 PART-B CUTOVER (owner GO 2026-06-16): flipped from DEFAULT_WORKSPACE_ID
 *     to PAPERCUSP_WORKSPACE_ID *in LOCKSTEP* with migration 295, which moves
 *     papercup's plan/feature/issue rows 'default' → 'papercusp-workspace' in the
 *     SAME release. The flip and the data move MUST ship together (either alone
 *     404s every papercup read) — they apply atomically on the :3070 deploy
 *     (migrations-before-serve + papercup-read path-verify → rollback). See WI-148.
 *   - a concrete other slug: look it up in harness_shared.projects.
 *       0 matches  → null (caller decides how to fail).
 *       1 match    → that workspace_id.
 *       2+ matches → THROW (same-name collision across workspaces — fail loud
 *                    rather than silently pick the wrong workspace).
 */
export async function fill_workspace_id_from_projects(
  harnessSlug: string | undefined,
  opts: { lookup?: ProjectsWorkspaceLookup; registryFallback?: RegistryWorkspaceResolver } = {},
): Promise<string | null> {
  const raw = harnessSlug?.trim();
  // WI-148 part-B cutover (owner GO 2026-06-16): papercup → PAPERCUSP_WORKSPACE_ID,
  // in lockstep with migration 295's data move (see the doc-comment above).
  if (isOperatorHomeScope(raw)) return PAPERCUSP_WORKSPACE_ID;

  const lookup = opts.lookup ?? lookupProjectWorkspaceIds;
  const matches = await lookup(raw!);
  const distinct = [...new Set(matches.filter((w) => w && w.trim()))];
  if (distinct.length > 1) {
    throw new Error(
      `fill_workspace_id_from_projects: harness slug '${raw}' resolves to ` +
        `${distinct.length} workspaces (${distinct.join(', ')}). Ambiguous same-name ` +
        `collision across workspaces — pass an explicit workspaceId to disambiguate.`,
    );
  }
  if (distinct.length === 1) return distinct[0]!;
  // 0 rows in harness_shared.projects — expected for a hive/generic harness, which
  // lives only in the AUTHORITATIVE harness registry (the projects table is just
  // the org/department projection — see lookupProjectWorkspaceIds). Fall back to
  // that registry, which is what the work-items path already resolves through, so
  // a hive's plans resolve the same way its work-items do. Active-workspace-first +
  // collision-aware (su-a7f66 / su-632e0166, EI-1511 / P-017). Additive: only turns
  // a former null (→ caller throw) into a resolution; never regresses papercup
  // (isOperatorHomeScope) or explicit-workspaceId callers (both short-circuit earlier).
  const registryFallback = opts.registryFallback ?? resolveWorkspaceForHarnessSlug;
  return await registryFallback(raw!);
}

/**
 * Resolve a `PlanSourceOpts` to the concrete (workspaceId, hive home slug) PG key.
 * Plans are Hive-scoped: a member harness passed by a caller collapses to its
 * home Hive slug before touching `harness_shared.harness_plans`. No harness / the
 * SU wildcard `'*'` / `'all'` / the operator-home slug → the Papercusp home Hive
 * in PAPERCUSP_WORKSPACE_ID. A concrete slug not belonging to a Hive THROWS, so
 * future plan rows cannot be written at member/standalone harness grain.
 */
export async function resolvePlanScope(
  opts: PlanSourceOpts & {
    lookup?: ProjectsWorkspaceLookup;
    registryFallback?: RegistryWorkspaceResolver;
  } = {},
): Promise<{ workspaceId: string; harnessSlug: string }> {
  const rawInput = opts.harnessSlug?.trim();
  const raw = rawInput && rawInput !== '*' && rawInput !== 'all'
    ? canonicalHarnessSlug(rawInput)
    : rawInput;
  if (isOperatorHomeScope(raw)) {
    // Operator-home / wildcard branch — WI-148 part-B (owner GO 2026-06-16): honor an
    // explicit workspaceId, else PAPERCUSP_WORKSPACE_ID (flipped from
    // DEFAULT_WORKSPACE_ID in lockstep with migration 295's data move).
    return {
      workspaceId: opts.workspaceId ?? PAPERCUSP_WORKSPACE_ID,
      harnessSlug: operatorHomeHarnessSlug(),
    };
  }
  // A concrete non-papercup slug. An explicit workspaceId pins the workspace,
  // but the plan key still collapses member → Hive home below.
  const workspaceIdFromArg = opts.workspaceId;
  // Otherwise resolve the workspace: first the projects projection, then (when it
  // has no row — the common case for a hive/generic harness) the AUTHORITATIVE
  // harness registry. FAIL LOUD only when NEITHER resolves, instead of silently
  // defaulting to 'default' (which wrote a named harness's plans into the wrong
  // workspace — the WI-148 bug).
  const workspaceId =
    workspaceIdFromArg ??
    (await fill_workspace_id_from_projects(raw, {
      ...(opts.lookup ? { lookup: opts.lookup } : {}),
      ...(opts.registryFallback ? { registryFallback: opts.registryFallback } : {}),
    }));
  if (workspaceId === null) {
    throw new Error(
      `resolvePlanScope: harness '${raw}' is not registered in the harness registry ` +
        `(harness_shared.harness_registry) or harness_shared.projects in any workspace, so ` +
        `its plan workspace cannot be resolved. Register the harness, or pass an explicit ` +
        `workspaceId. (Refusing to silently default to '${DEFAULT_WORKSPACE_ID}' — WI-148.)`,
    );
  }
  const hiveHome = await hiveHomeSlugForHarness(workspaceId, raw!);
  if (!hiveHome) {
    throw new Error(
      `resolvePlanScope: plans are Hive-scoped, but '${raw}' is not a Hive home and ` +
        `does not belong to one in workspace '${workspaceId}'. Add it to a Hive or pass ` +
        `the Hive home slug explicitly; refusing to create/read a non-Hive-scoped plan.`,
    );
  }
  return { workspaceId, harnessSlug: hiveHome };
}

/** Synthetic stable locator for a plan (the old `.md` path) — display + lock key. */
export function syntheticPlanPath(harnessSlug: string, slug: string): string {
  return harnessSlug === operatorHomeHarnessSlug()
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
      project = reg.projects.find((p) => realpathOrResolve(p.path) === realpathOrResolve(detected));
    }
    project = project ?? reg.projects.find((p) => p.slug === operatorHomeHarnessSlug());
    if (!project) {
      throw new Error(
        `resolveHarnessPlansDir: no harness in ctx and no primary harness findable ` +
          `(no path-match for repo root '${detected}', no '${operatorHomeHarnessSlug()}' slug). ` +
          `Available: ${reg.projects.map((p) => p.slug).join(', ') || '(none)'}`,
      );
    }
    resolved = project.slug;
  } else {
    resolved = raw;
    project = (await resolveProject(resolved, opts.workspaceId)) ?? undefined;
    if (!project) {
      const didYouMean = resolved === 'papercusp' ? ` Did you mean '${operatorHomeHarnessSlug()}'?` : '';
      throw new Error(
        `resolveHarnessPlansDir: harness '${resolved}' not registered in any workspace.${didYouMean} ` +
          `Active-workspace harnesses: ${reg.projects.map((p) => p.slug).join(', ') || '(none)'}`,
      );
    }
  }
  if (resolved === operatorHomeHarnessSlug()) {
    const detected = detectPapercupRoot();
    // Compare realpath-normalized forms: the canonical checkout is reachable
    // via a `papercup` → `papercusp` symlink, and string-only path.resolve
    // treats the two identical dirs as a mismatch → the guard false-alarmed
    // and broke fleet:launch-on-plan (WI-1341). realpathOrResolve collapses
    // the symlink so a genuine registry mismatch still throws.
    if (detected && realpathOrResolve(project.path) !== realpathOrResolve(detected)) {
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
  try {
    const rows = await withWorkspace(workspaceId, async (tx) => {
      return tx<PlanDbRow[]>`
        SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
               title, status, created, updated, owner, initiative, supersedes, superseded_by,
               op_status, op_started_at, op_updated_at, current_wave, op_priority,
               archived, is_legacy, updated_at, items, now_state, now_next, promote_policy,
               schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
               template, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
           AND plan_slug = ${slug}
      `;
    });
    return rows[0] ? rowFromDb(rows[0]) : null;
  } catch (err: unknown) {
    // Fallback for databases where migration 299 hasn't been applied yet
    // (schedule columns don't exist). Gracefully default them to null/false.
    if (
      err instanceof Error &&
      err.message?.includes('column') &&
      err.message?.includes('does not exist')
    ) {
      const rows = await withWorkspace(workspaceId, async (tx) => {
        return tx<Omit<PlanDbRow, 'schedule' | 'schedule_active' | 'scheduled_at' | 'expires_at' | 'tzid' | 'template_slug' | 'run_seq' | 'template' | 'template_data'>[]>`
          SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
                 title, status, created, updated, owner, initiative, supersedes, superseded_by,
                 op_status, op_started_at, op_updated_at, current_wave, op_priority,
                 archived, is_legacy, updated_at, items, now_state, now_next
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
             AND plan_slug = ${slug}
        `;
      });
      if (!rows[0]) return null;
      return rowFromDb({
        ...rows[0],
        schedule: null,
        schedule_active: false,
        scheduled_at: null,
        expires_at: null,
        tzid: null,
        template_slug: null,
        run_seq: null,
        template: null,
        template_data: null,
      } as PlanDbRow);
    }
    throw err;
  }
}

/** All plan rows for a harness (PG), live + optionally archived. The archived
 *  filter runs in SQL — excluded rows' content blobs never leave PG (P-042). */
export async function listPlanRows(
  opts: PlanSourceOpts & { includeArchived?: boolean } = {},
): Promise<PlanRow[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  try {
    const rows = await withWorkspace(workspaceId, async (tx) => {
      const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
      return tx<PlanDbRow[]>`
        SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
               title, status, created, updated, owner, initiative, supersedes, superseded_by,
               op_status, op_started_at, op_updated_at, current_wave, op_priority,
               archived, is_legacy, updated_at, items, now_state, now_next,
               schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
               template, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         ${archivedFilter}
         ORDER BY plan_slug ASC
      `;
    });
    return rows.map(rowFromDb);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message?.includes('column') &&
      err.message?.includes('does not exist')
    ) {
      const rows = await withWorkspace(workspaceId, async (tx) => {
        const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
        return tx<Omit<PlanDbRow, 'schedule' | 'schedule_active' | 'scheduled_at' | 'expires_at' | 'tzid' | 'template_slug' | 'run_seq' | 'template' | 'template_data'>[]>`
          SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
                 title, status, created, updated, owner, initiative, supersedes, superseded_by,
                 op_status, op_started_at, op_updated_at, current_wave, op_priority,
                 archived, is_legacy, updated_at, items, now_state, now_next
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
           ${archivedFilter}
           ORDER BY plan_slug ASC
        `;
      });
      return rows.map((r) =>
        rowFromDb({
          ...r,
          schedule: null,
          schedule_active: false,
          scheduled_at: null,
          expires_at: null,
          tzid: null,
          template_slug: null,
          run_seq: null,
          template: null,
          template_data: null,
        } as PlanDbRow),
      );
    }
    throw err;
  }
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
  opts: PlanSourceOpts & {
    includeArchived?: boolean;
    status?: string;
    limit?: number;
    /** Include per-run instance plans (template_slug IS NOT NULL). Default false (D-003). */
    includeInstances?: boolean;
    /** Filter to plans of a given template TYPE (P-005) — uses the
     *  harness_plans_template_idx filter index (mig 329). */
    template?: string;
    /** Filter to per-run instances of a given template plan (template_slug
     *  back-pointer, P-005). Implies including instances. */
    templateSlug?: string;
    /** Only plans whose row `created_at >= this` (ISO timestamp). Server-side
     *  recency filter so callers stop fetching every plan + post-filtering. */
    createdSince?: string;
    /** Only plans whose row `updated_at >= this` (ISO timestamp). */
    updatedSince?: string;
    /** Row order: 'updated'/'created' = recency DESC, 'slug' (default) = slug ASC. */
    order?: 'updated' | 'created' | 'slug';
  } = {},
): Promise<PlanIndexRow[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  try {
    const rows = await withWorkspace(workspaceId, async (tx) => {
      const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
      const statusFilter = opts.status ? tx`AND status = ${opts.status}` : tx``;
      // Hide per-run instance plans (Option C, D-003) by default — they are reached
      // via the template's Runs history, not the main plan directory. A templateSlug
      // filter (P-005) is itself an instance selector, so it overrides the hiding.
      const instanceFilter = opts.templateSlug
        ? tx``
        : opts.includeInstances
          ? tx``
          : tx`AND template_slug IS NULL`;
      // P-005 template filters — `template` rides the harness_plans_template_idx index (mig 329).
      const templateFilter = opts.template ? tx`AND template = ${opts.template}` : tx``;
      const templateSlugFilter = opts.templateSlug
        ? tx`AND template_slug = ${opts.templateSlug}`
        : tx``;
      const createdSinceFilter = opts.createdSince ? tx`AND created_at >= ${opts.createdSince}` : tx``;
      const updatedSinceFilter = opts.updatedSince ? tx`AND updated_at >= ${opts.updatedSince}` : tx``;
      const orderClause =
        opts.order === 'updated'
          ? tx`ORDER BY updated_at DESC NULLS LAST`
          : opts.order === 'created'
            ? tx`ORDER BY created_at DESC NULLS LAST`
            : tx`ORDER BY plan_slug ASC`;
      const limitClause = opts.limit && opts.limit > 0 ? tx`LIMIT ${opts.limit}` : tx``;
      return tx<Array<Omit<PlanDbRow, 'content'>>>`
        SELECT workspace_id, harness_slug, plan_slug, content_hash, version,
               title, status, created, updated, owner, initiative, supersedes, superseded_by,
               op_status, op_started_at, op_updated_at, current_wave, op_priority,
               archived, is_legacy, updated_at, items, now_state, now_next,
               schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
               template, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         ${archivedFilter}
         ${statusFilter}
         ${instanceFilter}
         ${templateFilter}
         ${templateSlugFilter}
         ${createdSinceFilter}
         ${updatedSinceFilter}
         ${orderClause}
         ${limitClause}
      `;
    });
    return rows.map((r) => {
      const { content: _content, ...rest } = rowFromDb({ ...r, content: '' } as PlanDbRow);
      return rest;
    });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message?.includes('column') &&
      err.message?.includes('does not exist')
    ) {
      const rows = await withWorkspace(workspaceId, async (tx) => {
        const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
        const statusFilter = opts.status ? tx`AND status = ${opts.status}` : tx``;
        const instanceFilter = opts.includeInstances ? tx`` : tx`AND template_slug IS NULL`;
        const limitClause = opts.limit && opts.limit > 0 ? tx`LIMIT ${opts.limit}` : tx``;
        return tx<Array<Omit<PlanDbRow, 'content'>>>`
          SELECT workspace_id, harness_slug, plan_slug, content_hash, version,
                 title, status, created, updated, owner, initiative, supersedes, superseded_by,
                 op_status, op_started_at, op_updated_at, current_wave, op_priority,
                 archived, is_legacy, updated_at, items, now_state, now_next
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
           ${archivedFilter}
           ${statusFilter}
           ${instanceFilter}
           ORDER BY plan_slug ASC
           ${limitClause}
        `;
      });
      return rows.map((r) => {
        const { content: _content, ...rest } = rowFromDb({
          ...r,
          content: '',
          schedule: null,
          schedule_active: false,
          scheduled_at: null,
          expires_at: null,
          tzid: null,
          template_slug: null,
          run_seq: null,
          template: null,
          template_data: null,
        } as PlanDbRow);
        return rest;
      });
    }
    throw err;
  }
}

/**
 * Index-only listing across the WHOLE active workspace — every plan in
 * `workspaceId` regardless of harness (workspace-data-isolation-leaks F-A1).
 *
 * The UI "all plans" view must show the ACTIVE workspace's plans, not a single
 * hardcoded harness. The legacy `harness:'all'` sentinel resolves to
 * papercup/PAPERCUSP_WORKSPACE_ID (the SU wildcard for Papercusp's own plans) —
 * correct for the dogfood, but a cross-workspace LEAK for any other workspace.
 * This lists by `workspace_id` only (RLS + the explicit filter both scope it),
 * so each workspace sees exactly its own plans. Output rows carry their own
 * `harnessSlug`. (In papercup's own workspace every plan is under the papercup
 * harness, so this returns the same set the old `harness:'all'` path did.)
 */
export async function listPlanIndexRowsForWorkspace(
  opts: {
    workspaceId: string;
    includeArchived?: boolean;
    status?: string;
    limit?: number;
    includeInstances?: boolean;
    /** Filter to plans of a given template TYPE (P-005). */
    template?: string;
    /** Filter to per-run instances of a given template plan (P-005); implies instances. */
    templateSlug?: string;
    /** Only plans whose row `created_at >= this` (ISO timestamp). */
    createdSince?: string;
    /** Only plans whose row `updated_at >= this` (ISO timestamp). */
    updatedSince?: string;
    /** Row order: 'updated'/'created' = recency DESC, default = harness+slug ASC. */
    order?: 'updated' | 'created' | 'slug';
  },
): Promise<PlanIndexRow[]> {
  const { workspaceId } = opts;
  try {
    const rows = await withWorkspace(workspaceId, async (tx) => {
      const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
      const statusFilter = opts.status ? tx`AND status = ${opts.status}` : tx``;
      // A templateSlug filter (P-005) is itself an instance selector, so it overrides
      // the default instance-hiding.
      const instanceFilter = opts.templateSlug
        ? tx``
        : opts.includeInstances
          ? tx``
          : tx`AND template_slug IS NULL`;
      const templateFilter = opts.template ? tx`AND template = ${opts.template}` : tx``;
      const templateSlugFilter = opts.templateSlug
        ? tx`AND template_slug = ${opts.templateSlug}`
        : tx``;
      const createdSinceFilter = opts.createdSince ? tx`AND created_at >= ${opts.createdSince}` : tx``;
      const updatedSinceFilter = opts.updatedSince ? tx`AND updated_at >= ${opts.updatedSince}` : tx``;
      const orderClause =
        opts.order === 'updated'
          ? tx`ORDER BY updated_at DESC NULLS LAST`
          : opts.order === 'created'
            ? tx`ORDER BY created_at DESC NULLS LAST`
            : tx`ORDER BY harness_slug ASC, plan_slug ASC`;
      const limitClause = opts.limit && opts.limit > 0 ? tx`LIMIT ${opts.limit}` : tx``;
      return tx<Array<Omit<PlanDbRow, 'content'>>>`
        SELECT workspace_id, harness_slug, plan_slug, content_hash, version,
               title, status, created, updated, owner, initiative, supersedes, superseded_by,
               op_status, op_started_at, op_updated_at, current_wave, op_priority,
               archived, is_legacy, updated_at, items, now_state, now_next,
               schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
               template, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId}
         ${archivedFilter}
         ${statusFilter}
         ${instanceFilter}
         ${templateFilter}
         ${templateSlugFilter}
         ${createdSinceFilter}
         ${updatedSinceFilter}
         ${orderClause}
         ${limitClause}
      `;
    });
    return rows.map((r) => {
      const { content: _content, ...rest } = rowFromDb({ ...r, content: '' } as PlanDbRow);
      return rest;
    });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message?.includes('column') &&
      err.message?.includes('does not exist')
    ) {
      const rows = await withWorkspace(workspaceId, async (tx) => {
        const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
        const statusFilter = opts.status ? tx`AND status = ${opts.status}` : tx``;
        const instanceFilter = opts.includeInstances ? tx`` : tx`AND template_slug IS NULL`;
        const limitClause = opts.limit && opts.limit > 0 ? tx`LIMIT ${opts.limit}` : tx``;
        return tx<Array<Omit<PlanDbRow, 'content'>>>`
          SELECT workspace_id, harness_slug, plan_slug, content_hash, version,
                 title, status, created, updated, owner, initiative, supersedes, superseded_by,
                 op_status, op_started_at, op_updated_at, current_wave, op_priority,
                 archived, is_legacy, updated_at, items, now_state, now_next
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId}
           ${archivedFilter}
           ${statusFilter}
           ${instanceFilter}
           ORDER BY harness_slug ASC, plan_slug ASC
           ${limitClause}
        `;
      });
      return rows.map((r) => {
        const { content: _content, ...rest } = rowFromDb({
          ...r,
          content: '',
          schedule: null,
          schedule_active: false,
          scheduled_at: null,
          expires_at: null,
          tzid: null,
          template_slug: null,
          run_seq: null,
          template: null,
          template_data: null,
        } as PlanDbRow);
        return rest;
      });
    }
    throw err;
  }
}

/**
 * Author a plan's SCHEDULE — the operational schedule columns (scheduled-recurring-plans
 * D-004/D-016, P-014), distinct from the markdown blob (like the op_* columns). Writes
 * `schedule` (jsonb), `scheduled_at`, `expires_at`, `tzid`. Does NOT arm the schedule
 * (`schedule_active` is left untouched — arming is the autonomy-gated flow, Phase 3).
 * Pass `schedule: null` to clear a recurrence (un-schedule). `sql` is a test seam (an
 * admin client); production uses `withWorkspace`. Returns true iff a plan row matched.
 */
export async function setPlanSchedule(
  opts: PlanSourceOpts & {
    slug: string;
    schedule?: PlanSchedule | null;
    scheduledAt?: string | null;
    expiresAt?: string | null;
    tzid?: string | null;
    sql?: Sql;
  },
): Promise<boolean> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const scheduleJson = opts.schedule ? JSON.stringify(opts.schedule) : null;
  const run = (tx: Sql) =>
    tx<{ plan_slug: string }[]>`
      UPDATE harness_shared.harness_plans
         SET schedule = ${scheduleJson}::text::jsonb,
             scheduled_at = ${opts.scheduledAt ?? null}::timestamptz,
             expires_at = ${opts.expiresAt ?? null}::timestamptz,
             tzid = ${opts.tzid ?? null},
             updated_at = now()
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND plan_slug = ${opts.slug}
      RETURNING plan_slug
    `;
  const rows = opts.sql
    ? await run(opts.sql)
    : await withWorkspace(workspaceId, (tx) => run(tx as unknown as Sql));
  return rows.length > 0;
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
 * content OR plan_slug contains ≥1 query token (case-insensitive) come back.
 * Every content scope (title/now/items/decisions/prose) is a substring of the
 * content blob; the `slug` scope matches the PG plan_slug — which is NOT part of
 * what the scorer sees (the parser strips frontmatter from prose), so a
 * slug-only match (searching a plan's own slug, whose hyphenated tokens never
 * appear verbatim in its title/body) needs the explicit plan_slug arm or the
 * plan is lossily excluded (F-FIX-028/029). A plan with zero token hits in
 * either can never score and is lossless to exclude. `limit` caps the candidate
 * set; `truncated` reports when the cap bit (no silent caps).
 */
export async function listPlanRowsMatchingAnyToken(
  tokens: string[],
  opts: PlanSourceOpts & { includeArchived?: boolean; limit?: number } = {},
): Promise<{ rows: PlanRow[]; truncated: boolean }> {
  if (tokens.length === 0) return { rows: [], truncated: false };
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;
  const patterns = tokens.map((t) => `%${escapeLike(t)}%`);
  try {
    const rows = await withWorkspace(workspaceId, async (tx) => {
      const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
      return tx<PlanDbRow[]>`
        SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
               title, status, created, updated, owner, initiative, supersedes, superseded_by,
               op_status, op_started_at, op_updated_at, current_wave, op_priority,
               archived, is_legacy, updated_at, items, now_state, now_next,
               schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
               template, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         ${archivedFilter}
           AND (content ILIKE ANY(${patterns}::text[]) OR plan_slug ILIKE ANY(${patterns}::text[]))
         ORDER BY plan_slug ASC
         LIMIT ${limit + 1}
      `;
    });
    const truncated = rows.length > limit;
    return { rows: (truncated ? rows.slice(0, limit) : rows).map(rowFromDb), truncated };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message?.includes('column') &&
      err.message?.includes('does not exist')
    ) {
      const rows = await withWorkspace(workspaceId, async (tx) => {
        const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
        return tx<Omit<PlanDbRow, 'schedule' | 'schedule_active' | 'scheduled_at' | 'expires_at' | 'tzid' | 'template_slug' | 'run_seq' | 'template' | 'template_data'>[]>`
          SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
                 title, status, created, updated, owner, initiative, supersedes, superseded_by,
                 op_status, op_started_at, op_updated_at, current_wave, op_priority,
                 archived, is_legacy, updated_at, items, now_state, now_next
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
           ${archivedFilter}
             AND (content ILIKE ANY(${patterns}::text[]) OR plan_slug ILIKE ANY(${patterns}::text[]))
           ORDER BY plan_slug ASC
           LIMIT ${limit + 1}
        `;
      });
      const truncated = rows.length > limit;
      return {
        rows: (truncated ? rows.slice(0, limit) : rows).map((r) =>
          rowFromDb({
            ...r,
            schedule: null,
            schedule_active: false,
            scheduled_at: null,
            expires_at: null,
            tzid: null,
            template_slug: null,
            run_seq: null,
            template: null,
            template_data: null,
          } as PlanDbRow),
        ),
        truncated,
      };
    }
    throw err;
  }
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
  /** Template TYPE (frontmatter-derived, mirrors `initiative`) — P-004/P-005. */
  template: string | null;
  supersedes: string[];
  supersededBy: string | null;
  isLegacy: boolean;
  // Stage-3 structured index (normalize).
  items: PlanIndexItem[];
  decisions: PlanIndexDecision[];
  nowState: string | null;
  nowNext: string | null;
  /** v2 P-001: the operator-side parsed `## Promote` policy ({ policy, warnings }), recomputed
   *  on every write so consumers read it structured instead of re-parsing the markdown. */
  promotePolicy: ParsePromoteResult;
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
    // P-004/P-005: the template TYPE is frontmatter-derived (like initiative); the
    // structured template_data is written separately + never parsed from frontmatter.
    template: fm.template ?? null,
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
    // v2 P-001: parse the `## Promote` policy ONCE here (operator-side; the pure @papercusp/plan-parser
    // has no YAML dep) so the write stores it structured + the consumers (lint/expand-generators/promote)
    // stop re-parsing the markdown at read time.
    promotePolicy: parsePromotePolicy(content),
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
