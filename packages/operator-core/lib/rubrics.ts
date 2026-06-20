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
 * rubricRef = rubrics.rubric_id, and ratings[].criterion = a criteria[].key.
 *
 * Authorship (D-001): any agent PROPOSEs (status='proposed'); the Queen/owner RATIFIES
 * (proposed → active). v1 is workspace-LOCAL (not federated) and runs in the single
 * coordination workspace (DEFAULT_COORD_WORKSPACE), so a ratified rubric is visible to
 * Overwatch/Scout wherever they run. Table: migration 326 (harness_shared.rubrics).
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

export type RubricStatus = 'proposed' | 'active' | 'retired';
export const RUBRIC_STATUSES: readonly RubricStatus[] = ['proposed', 'active', 'retired'];

/** The default rating vocabulary shared by criteria that don't override it.
 *  Locked with the Overwatch scorecard + Scout digest consumers (interface contract). */
export const DEFAULT_RATING_SCALE: readonly string[] = ['healthy', 'degraded', 'broken', 'unknown'];

/** One gradeable item within a rubric (the per-characteristic criterion). */
export interface RubricCriterion {
  /** Stable kebab id; an observation's ratings[].criterion references this. */
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

export interface ListRubricsFilter {
  status?: RubricStatus;
  characteristic?: string;
  limit?: number;
}

/** List rubrics (active first, then proposed), optionally filtered by status / characteristic. */
export async function listRubrics(filter: ListRubricsFilter = {}): Promise<Rubric[]> {
  const { sql } = getOrgPg();
  const rows = await sql<RubricRowDb[]>`
    SELECT ${sql.unsafe(RUBRIC_COLS)}
      FROM harness_shared.rubrics
     WHERE workspace_id = ${rubricsScopeWorkspace()}
       AND ${filter.status ? sql`status = ${filter.status}` : sql`TRUE`}
       AND ${filter.characteristic ? sql`characteristic = ${filter.characteristic}` : sql`TRUE`}
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
              updated_at DESC
     LIMIT ${Math.min(filter.limit ?? 100, 500)}`;
  return rows.map(toRubric);
}

/** Fetch one rubric in full by its slug id. */
export async function getRubric(rubricId: string): Promise<Rubric | null> {
  const { sql } = getOrgPg();
  const rows = await sql<RubricRowDb[]>`
    SELECT ${sql.unsafe(RUBRIC_COLS)} FROM harness_shared.rubrics
     WHERE workspace_id = ${rubricsScopeWorkspace()} AND rubric_id = ${rubricId}`;
  return rows[0] ? toRubric(rows[0]) : null;
}

/** Full-text search over rubric id / characteristic / title / description. */
export async function searchRubrics(query: string, limit = 50): Promise<Rubric[]> {
  const { sql } = getOrgPg();
  const rows = await sql<RubricRowDb[]>`
    SELECT ${sql.unsafe(RUBRIC_COLS)} FROM harness_shared.rubrics
     WHERE workspace_id = ${rubricsScopeWorkspace()}
       AND _search @@ websearch_to_tsquery('english', ${query})
     ORDER BY ts_rank(_search, websearch_to_tsquery('english', ${query})) DESC
     LIMIT ${Math.min(limit, 200)}`;
  return rows.map(toRubric);
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
