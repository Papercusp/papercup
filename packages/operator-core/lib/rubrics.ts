/**
 * rubrics store — the shared-standards library (rubric-driven-observations-2026-06-20
 * P-002 / brief B2). A RUBRIC is the reusable STANDARD for a system characteristic:
 * the MODEL (how it's supposed to work) + the METHOD (how to investigate; may point at
 * an agent-insights runbook via method_ref) + the RATING scale + DRIFT markers. Agents
 * grade STRUCTURED OBSERVATIONS against an ACTIVE rubric, so Scout/Queen/Overwatch get
 * measurements, not just free-text anecdotes (plan D-001/D-002).
 *
 * Shape (Model A — the interface contract locked with su-f8ee5 [obs-schema consumer]
 * and su-5695e [P-003 seed author]): a rubric_id slug names ONE rubric; its `criteria`
 * jsonb holds the per-characteristic gradeable items. A structured observation's
 * rubricRef = rubrics.rubric_id, and a structured observation's ratings is a
 * Record keyed by criteria[].key (Record<criterionKey, { rating, evidence }>).
 *
 * Authorship (D-001): any agent PROPOSEs (status='proposed'); the Queen/owner RATIFIES
 * (proposed → active). v1 is workspace-LOCAL (not federated) and runs in the single
 * coordination workspace (DEFAULT_COORD_WORKSPACE), so a ratified rubric is visible to
 * Overwatch/Scout wherever they run. Table: migration 326 (harness_shared.rubrics).
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { rubricTemplateDataSchema, RUBRIC_TEMPLATE_NAME } from './agent-tools/plans/rubric-template';

export type RubricStatus = 'proposed' | 'active' | 'retired';
export const RUBRIC_STATUSES: readonly RubricStatus[] = ['proposed', 'active', 'retired'];

/** The default rating vocabulary shared by criteria that don't override it.
 *  Locked with the Overwatch scorecard + Scout digest consumers (interface contract). */
export const DEFAULT_RATING_SCALE: readonly string[] = ['healthy', 'degraded', 'broken', 'unknown'];

/** One gradeable item within a rubric (the per-characteristic criterion). */
export interface RubricCriterion {
  /** Stable kebab id; a structured observation's ratings Record is keyed by this. */
  key: string;
  title: string;
  /** How this criterion is supposed to work (the MODEL). */
  model: string;
  /** How to investigate it (the METHOD: signals / queries). */
  method: string;
  /** Optional per-criterion override of the rubric's default rating_scale. */
  ratingScale?: string[];
  /** What a 'big drift' / degraded / broken looks like. */
  driftMarkers: string;
}

export interface Rubric {
  rubricId: string;
  workspaceId: string;
  /** Umbrella domain, e.g. 'hive-coordination' — Scout's digest groups by this. */
  characteristic: string;
  title: string;
  description: string;
  criteria: RubricCriterion[];
  ratingScale: string[];
  /** agent-insights runbook slug holding the long-form METHOD (no prose duplication). */
  methodRef: string | null;
  status: RubricStatus;
  createdBy: string | null;
  proposedBy: string | null;
  ratifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Rubrics live in the single coordination workspace (the same constant the
 * coordination layer uses), so a ratified rubric is visible to Overwatch/Scout
 * wherever they run. v1 is workspace-local; if rubrics ever become genuinely
 * per-workspace, the WRITE path changes first and reads follow (the engineer_issues
 * pattern). The PRIMARY KEY already carries workspace_id, leaving room for that.
 */
function rubricsScopeWorkspace(): string {
  return DEFAULT_COORD_WORKSPACE;
}

interface RubricRowDb {
  rubric_id: string;
  workspace_id: string;
  characteristic: string;
  title: string;
  description: string;
  criteria: RubricCriterion[] | null; // jsonb — postgres.js returns it parsed
  rating_scale: string[] | null;
  method_ref: string | null;
  status: string;
  created_by: string | null;
  proposed_by: string | null;
  ratified_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const RUBRIC_COLS = `rubric_id, workspace_id, characteristic, title, description, criteria,
  rating_scale, method_ref, status, created_by, proposed_by, ratified_by, created_at, updated_at`;

function tsIso(v: string | Date): string {
  return typeof v === 'string' ? v : v.toISOString();
}

function toRubric(r: RubricRowDb): Rubric {
  return {
    rubricId: r.rubric_id,
    workspaceId: r.workspace_id,
    characteristic: r.characteristic,
    title: r.title,
    description: r.description,
    criteria: Array.isArray(r.criteria) ? r.criteria : [],
    ratingScale: Array.isArray(r.rating_scale) ? r.rating_scale : [...DEFAULT_RATING_SCALE],
    methodRef: r.method_ref,
    status: (RUBRIC_STATUSES as readonly string[]).includes(r.status) ? (r.status as RubricStatus) : 'proposed',
    createdBy: r.created_by,
    proposedBy: r.proposed_by,
    ratifiedBy: r.ratified_by,
    createdAt: tsIso(r.created_at),
    updatedAt: tsIso(r.updated_at),
  };
}

// ─── v2 re-point: a rubric IS a plan (plan-templates-and-rubric-v2 P-006) ───────────
//
// The reads below resolve rubrics from TWO legs, de-duped with PLANS winning:
//   • rubric-template PLANS — harness_plans rows with template='rubric', their
//     `template_data` jsonb validated against the rubric schema and mapped to the v1
//     `Rubric` shape (so rubrics:list/get/search + the Overwatch scorecard-emit read
//     the SAME shape with the backing changed — the scorecards.ts getRubric seam, D-003);
//   • the v1 standalone TABLE — harness_shared.rubrics, the transitional leg.
// The union keeps the seeded hive-coordination-health rubric (still a table row) live
// across the P-006→P-007 gap. P-007 migrates the seed → a plan, drops the table, and
// removes the table leg (leaving only the plan leg). The writes (proposeRubric /
// ratifyRubric, below) still target the table — re-pointed to plan-create/promote in
// P-007/P-009; until then a table-proposed rubric still surfaces via the table leg.

/** The harness_plans columns the rubric re-point reads (a rubric-template plan). */
interface RubricPlanRow {
  plan_slug: string;
  workspace_id: string;
  title: string | null;
  status: string | null;
  created: string | null;
  updated: string | null;
  updated_at: string | Date;
  owner: string | null;
  archived: boolean;
  template_data: unknown;
}

/**
 * Map a rubric-template PLAN's state → the rubric status vocabulary. D-002/D-009: the
 * Queen RATIFIES a rubric by promoting its plan (proposed→active); deprecation/archive
 * retires it. An `active`|`ready` plan = an `active` rubric (the brief: "plans WHERE
 * template='rubric' AND status active/ready"); `draft` = `proposed`; an archived plan
 * or a `superseded`/`shipped` plan = `retired`.
 */
export function planStatusToRubricStatus(planStatus: string | null, archived = false): RubricStatus {
  if (archived) return 'retired';
  switch (planStatus) {
    case 'active':
    case 'ready':
      return 'active';
    case 'superseded':
    case 'shipped':
      return 'retired';
    default: // 'draft' + anything unknown → not yet ratified
      return 'proposed';
  }
}

/**
 * Reconstruct the v1 `Rubric` from a rubric-template plan row: slug = rubricId,
 * frontmatter title = title, validated `template_data` = the structured fields.
 * Returns null when `template_data` is absent or fails the rubric schema (degrade,
 * never throw — mirrors `toRubric`), so a half-authored rubric plan is skipped rather
 * than surfaced broken.
 */
export function planRowToRubric(row: RubricPlanRow): Rubric | null {
  const parsed = rubricTemplateDataSchema.safeParse(row.template_data);
  if (!parsed.success) return null;
  const d = parsed.data;
  const updatedAt = tsIso(row.updated_at);
  return {
    rubricId: row.plan_slug,
    workspaceId: row.workspace_id,
    characteristic: d.characteristic,
    title: row.title ?? row.plan_slug,
    description: d.description ?? '',
    criteria: d.criteria.map((c) => ({
      key: c.key,
      title: c.title,
      model: c.model,
      method: c.method,
      driftMarkers: c.driftMarkers,
      ...(c.ratingScale ? { ratingScale: c.ratingScale } : {}),
    })),
    ratingScale: d.ratingScale,
    methodRef: d.methodRef ?? null,
    status: planStatusToRubricStatus(row.status, row.archived),
    createdBy: row.owner ?? null,
    proposedBy: row.owner ?? null,
    ratifiedBy: planStatusToRubricStatus(row.status, row.archived) === 'active' ? (row.owner ?? null) : null,
    createdAt: row.created ?? updatedAt,
    updatedAt,
  };
}

/** active → proposed → retired, then most-recently-updated first (the v1 SQL order). */
const RUBRIC_STATUS_ORDER: Record<RubricStatus, number> = { active: 0, proposed: 1, retired: 2 };
function sortRubrics(rubrics: Rubric[]): Rubric[] {
  return rubrics.sort(
    (a, b) =>
      RUBRIC_STATUS_ORDER[a.status] - RUBRIC_STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt),
  );
}

/**
 * The transitional UNION: rubric-template PLANS ∪ the v1 TABLE, de-duped by rubricId
 * with PLANS winning on collision (the new backing supersedes the legacy row). Pure —
 * the two legs are fetched by the callers; unit-tested without PG.
 */
export function mergeRubricLegs(planRubrics: Rubric[], tableRubrics: Rubric[]): Rubric[] {
  const byId = new Map<string, Rubric>();
  for (const r of tableRubrics) byId.set(r.rubricId, r);
  for (const r of planRubrics) byId.set(r.rubricId, r); // plans win
  return [...byId.values()];
}

/** The plan leg: every rubric-template plan in the rubric workspace, mapped to Rubric.
 *  Degrades to [] if the plans store is unavailable (so the table leg always serves). */
async function listRubricPlans(): Promise<Rubric[]> {
  try {
    const { sql } = getOrgPg();
    // Exclude per-run instance plans (template_slug IS NOT NULL) — a rubric is a
    // top-level plan, not a scheduled instance (D-003).
    const rows = await sql<RubricPlanRow[]>`
      SELECT plan_slug, workspace_id, title, status, created, updated, updated_at, owner,
             archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
       LIMIT 500`;
    if (process.env.PAPERCUSP_DEBUG_RUBRIC_PLANLEG) {
      // eslint-disable-next-line no-console
      console.error('[planleg] rows=', rows.length, 'mapped=', rows.map(planRowToRubric).filter(Boolean).length, rows[0]);
    }
    return rows.map(planRowToRubric).filter((r): r is Rubric => r !== null);
  } catch (e) {
    if (process.env.PAPERCUSP_DEBUG_RUBRIC_PLANLEG) {
      // eslint-disable-next-line no-console
      console.error('[planleg] THREW:', e);
    }
    // No harness_plans table (e.g. a rubrics-only test DB) / workspace not provisioned —
    // the rubric reads still serve the v1 table leg. Degrade, never throw.
    return [];
  }
}

/** The table leg: every v1 table-backed rubric in the rubric workspace (unfiltered;
 *  filtering/sort/limit happen in-process after the union). */
async function listTableRubrics(): Promise<Rubric[]> {
  const { sql } = getOrgPg();
  const rows = await sql<RubricRowDb[]>`
    SELECT ${sql.unsafe(RUBRIC_COLS)} FROM harness_shared.rubrics
     WHERE workspace_id = ${rubricsScopeWorkspace()}
     LIMIT 500`;
  return rows.map(toRubric);
}

/** Load + union both legs (plans ∪ table, plans win). The single read path the three
 *  public reads filter/search over. */
async function loadAllRubrics(): Promise<Rubric[]> {
  const [planRubrics, tableRubrics] = await Promise.all([listRubricPlans(), listTableRubrics()]);
  return mergeRubricLegs(planRubrics, tableRubrics);
}

export interface ListRubricsFilter {
  status?: RubricStatus;
  characteristic?: string;
  limit?: number;
}

/** List rubrics (active first, then proposed, then retired), optionally filtered by
 *  status / characteristic. Reads the plans ∪ table union (P-006). */
export async function listRubrics(filter: ListRubricsFilter = {}): Promise<Rubric[]> {
  let rubrics = await loadAllRubrics();
  if (filter.status) rubrics = rubrics.filter((r) => r.status === filter.status);
  if (filter.characteristic) rubrics = rubrics.filter((r) => r.characteristic === filter.characteristic);
  return sortRubrics(rubrics).slice(0, Math.min(filter.limit ?? 100, 500));
}

/** Fetch one rubric in full by its slug id (plans ∪ table; a plan wins over a same-id
 *  table row). Returns null when no rubric carries that id. */
export async function getRubric(rubricId: string): Promise<Rubric | null> {
  return (await loadAllRubrics()).find((r) => r.rubricId === rubricId) ?? null;
}

/**
 * Search rubrics by id / characteristic / title / description. Case-insensitive,
 * all-tokens-must-match (websearch's AND semantics), over the plans ∪ table union —
 * a uniform in-process match since the rubric-template plans are not in the v1 FTS
 * index. At this scale (tens of rubrics) an in-process scan is as fast as the table FTS.
 */
export async function searchRubrics(query: string, limit = 50): Promise<Rubric[]> {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const matched = (await loadAllRubrics()).filter((r) => {
    const hay = `${r.rubricId} ${r.characteristic} ${r.title} ${r.description}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  return sortRubrics(matched).slice(0, Math.min(limit, 200));
}

export interface ProposeRubricInput {
  rubricId: string;
  characteristic: string;
  title: string;
  description?: string;
  criteria: RubricCriterion[];
  ratingScale?: string[];
  methodRef?: string;
  /** Who is proposing (ownerId). Recorded as proposed_by (and created_by on insert). */
  by?: string;
  /**
   * Lifecycle status to write. Defaults to 'proposed' (the rubrics:propose tool path,
   * D-001: agents propose, the Queen ratifies). Seed/test paths may pass 'active' to
   * upsert a ratified rubric directly (idempotent at-boot seeding). On CONFLICT the
   * content is updated; status is overwritten with this value.
   */
  status?: RubricStatus;
}

/**
 * Propose (idempotent upsert) a rubric. New → status (default 'proposed'); existing →
 * content is updated and status is set to the given value. The single write path behind
 * rubrics:propose (status omitted) and programmatic seeding (status:'active').
 */
export async function proposeRubric(input: ProposeRubricInput): Promise<Rubric> {
  const { sql } = getOrgPg();
  const status: RubricStatus = input.status ?? 'proposed';
  const ratifiedBy = status === 'active' ? (input.by ?? null) : null;
  const rows = await sql<RubricRowDb[]>`
    INSERT INTO harness_shared.rubrics
      (workspace_id, rubric_id, characteristic, title, description, criteria, rating_scale,
       method_ref, status, created_by, proposed_by, ratified_by, created_at, updated_at)
    VALUES (${rubricsScopeWorkspace()}, ${input.rubricId}, ${input.characteristic}, ${input.title},
            ${input.description ?? ''}, ${JSON.stringify(input.criteria)}::text::jsonb,
            ${JSON.stringify(input.ratingScale ?? DEFAULT_RATING_SCALE)}::text::jsonb,
            ${input.methodRef ?? null}, ${status}, ${input.by ?? null}, ${input.by ?? null},
            ${ratifiedBy}, now(), now())
    ON CONFLICT (workspace_id, rubric_id) DO UPDATE SET
      characteristic = EXCLUDED.characteristic,
      title          = EXCLUDED.title,
      description    = EXCLUDED.description,
      criteria       = EXCLUDED.criteria,
      rating_scale   = EXCLUDED.rating_scale,
      method_ref     = EXCLUDED.method_ref,
      status         = EXCLUDED.status,
      proposed_by    = EXCLUDED.proposed_by,
      ratified_by    = CASE WHEN EXCLUDED.status = 'active'
                            THEN COALESCE(EXCLUDED.ratified_by, harness_shared.rubrics.ratified_by)
                            ELSE harness_shared.rubrics.ratified_by END,
      updated_at     = now()
    RETURNING ${sql.unsafe(RUBRIC_COLS)}`;
  return toRubric(rows[0]);
}

/**
 * Ratify a proposed rubric → active (D-001: the Queen/owner gate). Returns the updated
 * rubric, or null if no rubric with that id exists.
 */
export async function ratifyRubric(rubricId: string, by?: string): Promise<Rubric | null> {
  const { sql } = getOrgPg();
  const rows = await sql<RubricRowDb[]>`
    UPDATE harness_shared.rubrics
       SET status = 'active', ratified_by = ${by ?? null}, updated_at = now()
     WHERE workspace_id = ${rubricsScopeWorkspace()} AND rubric_id = ${rubricId}
    RETURNING ${sql.unsafe(RUBRIC_COLS)}`;
  return rows[0] ? toRubric(rows[0]) : null;
}
