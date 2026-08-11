/**
 * rubrics store — the shared-standards library. A RUBRIC is the reusable STANDARD for a
 * system characteristic: the MODEL (how it's supposed to work) + the METHOD (how to
 * investigate; may point at an agent-insights runbook via methodRef) + the RATING scale
 * + DRIFT markers. Agents grade STRUCTURED OBSERVATIONS against an ACTIVE rubric, so
 * Scout/Queen/Overwatch get measurements, not just free-text anecdotes.
 *
 * ── v2: A RUBRIC IS A PLAN (plan-templates-and-rubric-v2-2026-06-20, D-002) ──────────
 * As of P-007, the rubrics store is PLANS-ONLY: a rubric is a `template: rubric` plan
 * (harness_shared.harness_plans). Its STRUCTURED fields (characteristic, criteria,
 * ratingScale, methodRef, description) live in the plan's `template_data` jsonb,
 * validated against the rubric template schema (rubric-template.ts); its NARRATIVE
 * model/method prose lives in the plan body; its top-level title in the plan frontmatter.
 *   • READS (list/get/search) query rubric-template plans, map `template_data` → the v1
 *     `Rubric` shape (planRowToRubric), so rubrics:list/get/search + the Overwatch
 *     scorecard-emit read the SAME shape with the backing changed (the scorecards.ts
 *     getRubric seam, D-003).
 *   • WRITES (proposeRubric / ratifyRubric) author/promote a rubric-template plan through
 *     the canonical plan-write path (withPlanLock): propose upserts the plan + its
 *     validated template_data (status draft = a "proposed" rubric); ratify flips the
 *     plan status → active. The Queen ratifies a rubric by promoting its plan.
 *
 * The v1 standalone table (harness_shared.rubrics, mig 326/327) and the P-006
 * transitional plans∪table union are GONE (P-007 Stage 2): the seeded
 * pot-coordination-health rubric is served from its migrated rubric-template plan
 * (mig 338, ws='default', harness='papercusp'), and the table is dropped by a follow-on
 * migration. Versioning falls out of the plan revision spine (no separate machinery).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import {
  rubricTemplateDataSchema,
  rubricKindOf,
  RUBRIC_TEMPLATE_NAME,
  type RubricKind,
  type RubricCriterionWindow,
} from './agent-tools/plans/rubric-template';

// Structured criterion grading-window (EI-12146): schema + the pure resolver live in
// rubric-template.ts (dependency-free, so instruments can import them without this
// module's PG edge). Re-exported here so rubric consumers find them where the Rubric
// shape lives.
export {
  rubricCriterionWindowSchema,
  resolveCriterionWindow,
  DEFAULT_CRITERION_WINDOW_MS,
  type RubricCriterionWindow,
  type ResolvedCriterionWindow,
} from './agent-tools/plans/rubric-template';
import { withPlanLock, bumpUpdatedDate } from './agent-tools/plans/with-plan-lock';
import { recordPlanRevision } from './agent-tools/plans/revisions';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';
import {
  listLocalRubrics,
  rubricsNeedingSeed,
  FIRST_PARTY_RUBRIC_SEED_OWNER,
  seedContentHash as computeSeedContentHash,
  type ExistingRubricRow,
  type LocalRubric,
} from './cupboard/rubric-store';
import { pgTimestampToIso } from './pg-timestamp';

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
  /** The criterion's own REPLICATION DRILL — the full end-to-end testing procedure a future
   *  agent can copy-run to re-grade this criterion (fixtures → verbatim subject prompt →
   *  spawn/measurement → grading queries → cleanup). Optional; WI-4287's loss-guards keep it
   *  from being silently dropped on re-propose, and rubricCompleteness reports criteria
   *  still lacking one. */
  replication?: string;
  /** Stable machine-readable instrument binding. `none` means explicitly manual. */
  instrumentKey?: string;
  /** The criterion's STRUCTURED evidence window (EI-12146) — resolve via
   *  resolveCriterionWindow() instead of re-hardcoding a look-back in prose. Omitted =
   *  the consumer's default (48h rolling). */
  window?: RubricCriterionWindow;
}

export interface Rubric {
  rubricId: string;
  workspaceId: string;
  /**
   * The rubric's kind (acceptance-rubrics-on-every-plan-2026-08-11): 'standard' = a
   * reusable shared-standards library entry (every pre-kind rubric); 'acceptance' = a
   * one-shot per-plan definition-of-done (see subjectPlan), hidden from the DEFAULT
   * list/search library reads, the staleness watchdog, and the ratification queue —
   * always resolvable by explicit id (getRubric) so the shared grading path works
   * unchanged (plan D-010).
   */
  kind: RubricKind;
  /** acceptance-kind only: the plan this rubric is the definition-of-done FOR. */
  subjectPlan?: string | null;
  /** acceptance-kind only: the standard-kind CLASS rubric it builds on (plan D-006/D-009). */
  classRef?: string | null;
  /** Umbrella domain, e.g. 'hive-coordination' — Scout's digest groups by this. */
  characteristic: string;
  title: string;
  description: string;
  criteria: RubricCriterion[];
  ratingScale: string[];
  /** agent-insights runbook slug holding the long-form METHOD (no prose duplication). */
  methodRef: string | null;
  /** This rubric GATES a release verdict (EI-12149) — the rubric-staleness watchdog
   *  alerts when an ACTIVE releaseGating rubric goes ungraded past its threshold. */
  releaseGating?: boolean;
  /**
   * CONTRACT-GENERATION BOUNDARY (goal-mode-rubric-v2-2026-08-10 D-015). ISO instant
   * before which gradings against this rubric measured a MATERIALLY DIFFERENT contract,
   * and are therefore excluded from `scorecardTrend` by default.
   *
   * WHY A DECLARED BOUNDARY AND NOT THE `version` COLUMN: rubric plans already carry a
   * version that bumps on EVERY propose, so it cannot distinguish a prose fix from a
   * clause-by-clause rewrite. Keying exclusion off it would orphan perfectly comparable
   * history on every typo. Only the author of the rewrite knows where the semantic edge
   * falls, so the edge is declared rather than inferred.
   *
   * WHY NOT per-scorecard `revises` edges: that rel means "this filing CORRECTS that
   * one". A post-rewrite scorecard does not correct a pre-rewrite one — it grades a
   * different run against a different contract. Reusing it would make scorecardCount
   * read as if someone had re-graded the same subject: wrong semantics, right-looking
   * number.
   *
   * MEASURED CASE: goal-mode-e2e v1 and v2 share 13 criterion keys, but v1's
   * `dedup-before-creating` also graded a container judgment v2 re-homed under a new key
   * (D-009), and v1's `child-execution-proven` drill could not measure at all (5/5
   * unknown, D-012). Same key, different question / dead instrument — neither is
   * expressible by dropping keys, which is what the trend already does.
   */
  historyResetAt?: string | null;
  status: RubricStatus;
  createdBy: string | null;
  proposedBy: string | null;
  ratifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The workspace the rubric-template PLANS are homed in — the ACTIVE workspace, resolved
 * the same way every other workspace-scoped operator-core store resolves it
 * (activeWorkspaceId(): request-scoped ALS → PAPERCUSP_WORKSPACE_ID → registry current →
 * DEFAULT_WORKSPACE_ID='default'). So a ratified rubric is visible to Overwatch/Scout,
 * who run in that same active workspace.
 *
 * WHY NOT the hardcoded DEFAULT_COORD_WORKSPACE='default' (WI-976): the coordination
 * layer, harness_plans, and every sibling store (notes/audit/telemetry/grants) resolve
 * the REAL workspace at request/write time — on this install that is 'papercusp-workspace'
 * (97k coord rows, all 643 plans), NOT the literal 'default' (327 legacy coord rows, 0
 * plans). The old code used the 'default' FALLBACK constant as the PRIMARY scope, so the
 * read looked in a near-dead workspace and missed the active `pot-coordination-health`
 * rubric plan that actually lives in the active workspace — rubrics:list returned 0 and
 * the Overwatch could not emit its required scorecard. Reads AND writes both call this,
 * so they stay consistent. On a fresh/test DB with no active-workspace pin this resolves
 * 'default', matching mig 338's seed — so the seeded rubric still resolves there.
 *
 * NOTE: only workspace + template gate the read — harness_slug is NOT read (the plans leg,
 * loadAllRubrics), so a rubric plan in any harness within this workspace resolves.
 */
function rubricsScopeWorkspace(): string {
  return activeWorkspaceId();
}

/**
 * The harness a rubric-template plan is HOMED under for WRITES (the plan PK is
 * (workspace, harness, slug)). The seeded rubric (mig 338) used operatorHomeHarnessSlug()
 * = 'papercusp'; propose/ratify resolve an EXISTING plan's own harness so a re-write
 * targets the same PK row, falling back to the operator home for a brand-new rubric. The
 * READ path does not filter on harness, so this only governs the write PK (no dual-row).
 */
function defaultRubricWriteHarness(): string {
  return operatorHomeHarnessSlug();
}

// EI-18691099450966094: was `typeof v === 'string' ? v : ...` — a raw
// Postgres-text timestamptz string (session-offset, no 'Z') passed straight
// through unparsed. Delegate to the shared helper, which parses+re-emits any
// string as an explicit UTC ISO value instead.
const tsIso = pgTimestampToIso;

// ─── plans leg: a rubric IS a `template: rubric` plan (P-006/P-007) ──────────────────

/** The harness_plans columns the rubric re-point reads (a rubric-template plan). */
interface RubricPlanRow {
  plan_slug: string;
  workspace_id: string;
  harness_slug: string;
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

/** The inverse of planStatusToRubricStatus, for the WRITE path: a rubric status → the
 *  plan frontmatter status to author. proposed → draft (awaiting Queen ratification),
 *  active → active (ratified), retired → superseded. */
export function rubricStatusToPlanStatus(status: RubricStatus): string {
  switch (status) {
    case 'active':
      return 'active';
    case 'retired':
      return 'superseded';
    default: // 'proposed'
      return 'draft';
  }
}

/**
 * Reconstruct the v1 `Rubric` from a rubric-template plan row: slug = rubricId,
 * frontmatter title = title, validated `template_data` = the structured fields.
 * Returns null when `template_data` is absent or fails the rubric schema (degrade,
 * never throw), so a half-authored rubric plan is skipped rather than surfaced broken.
 *
 * Identity (EI-10751): the old "collapse everything onto the plan owner" projection
 * fabricated provenance — the owner column is the ORIGINAL plan creator, so a re-propose
 * by a reviewer still projected the creator as proposer, and ratification projected the
 * creator as ratifier (a false self-ratification record, exactly what D-012's
 * author ≠ ratifier exists to prevent — a reviewer rightly REFUSED to ratify through it).
 * proposedBy/ratifiedBy now persist in template_data (written by proposeRubric /
 * ratifyRubric) and project from there; the owner column stays the createdBy + the
 * legacy fallback for rows written before the fix.
 */
export function planRowToRubric(row: RubricPlanRow): Rubric | null {
  const parsed = rubricTemplateDataSchema.safeParse(row.template_data);
  if (!parsed.success) return null;
  const d = parsed.data;
  const updatedAt = tsIso(row.updated_at);
  const status = planStatusToRubricStatus(row.status, row.archived);
  return {
    rubricId: row.plan_slug,
    workspaceId: row.workspace_id,
    kind: rubricKindOf(d),
    ...(d.subjectPlan ? { subjectPlan: d.subjectPlan } : {}),
    ...(d.classRef ? { classRef: d.classRef } : {}),
    characteristic: d.characteristic,
    title: row.title ?? row.plan_slug,
    description: d.description ?? '',
    // Acceptance-kind criteria may omit model/method/driftMarkers (the light profile —
    // per-kind superRefine guarantees standard-kind criteria always carry them), so the
    // v1 required-string shape maps absent → '' rather than loosening every consumer.
    criteria: d.criteria.map((c) => ({
      key: c.key,
      title: c.title,
      model: c.model ?? '',
      method: c.method ?? '',
      driftMarkers: c.driftMarkers ?? '',
      ...(c.ratingScale ? { ratingScale: c.ratingScale } : {}),
      ...(c.replication ? { replication: c.replication } : {}),
      ...(c.instrumentKey ? { instrumentKey: c.instrumentKey } : {}),
      ...(c.window ? { window: c.window } : {}),
    })),
    ratingScale: d.ratingScale,
    methodRef: d.methodRef ?? null,
    ...(d.releaseGating !== undefined ? { releaseGating: d.releaseGating } : {}),
    ...(typeof d.historyResetAt === 'string' ? { historyResetAt: d.historyResetAt } : {}),
    status,
    createdBy: row.owner ?? null,
    proposedBy: d.proposedBy ?? row.owner ?? null,
    ratifiedBy: status === 'active' ? (d.ratifiedBy ?? row.owner ?? null) : null,
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

/** A kind scope for the library reads: one kind, or 'any' (explicit opt-in to both). */
export type RubricKindFilter = RubricKind | 'any';

/** Every rubric-template plan in the rubric workspace, mapped to Rubric. The single read
 *  path the three public reads filter/search over — which makes it the ONE choke point
 *  where the first-party seed hooks (any rubrics:list/get/search or Overwatch getRubric
 *  triggers it). Degrades to [] if the plans store is unavailable (e.g. a test DB with
 *  no harness_plans) — reads never throw.
 *
 *  DEFAULT SCOPE IS 'standard' (acceptance-rubrics-on-every-plan-2026-08-11): the
 *  shared-standards library must not grow one entry per completed plan, so acceptance
 *  rubrics are excluded here AND at the SQL level (they'd otherwise consume the row cap
 *  as they accumulate — one per plan). Explicit-id reads (getRubric) and the subject-plan
 *  lookup (getAcceptanceRubricForPlan) resolve them regardless. */
async function loadAllRubrics(kind: RubricKindFilter = 'standard'): Promise<Rubric[]> {
  // Auto-seed on read in REAL processes only. Under vitest the established fixture
  // pattern mocks getOrgPg but often not withWorkspace — the seed's proposeRubric
  // writes would escape the testcontainer onto the real org PG (observed while
  // building rubrics-first-party-seed.integration.test.ts, which now mocks both and
  // exercises the seed EXPLICITLY via ensureFirstPartyRubricsSeeded()).
  if (!process.env.VITEST) await ensureFirstPartyRubricsSeeded();
  return queryRubricPlans(kind);
}

/** The raw plan-row read behind loadAllRubrics, seed-free (the seed itself reads/writes
 *  through paths that land back here — the seed gate above breaks the recursion). */
async function queryRubricPlans(kind: RubricKindFilter = 'standard'): Promise<Rubric[]> {
  try {
    const { sql } = getOrgPg();
    // Exclude per-run instance plans (template_slug IS NOT NULL) — a rubric is a
    // top-level plan, not a scheduled instance (D-003). The kind predicate is pushed to
    // SQL so acceptance rows (one per completed plan, unbounded) never eat the row cap;
    // the in-process re-filter below keeps the scope honest under mocked-sql tests too.
    const kindCond =
      kind === 'any'
        ? sql`TRUE`
        : kind === 'acceptance'
          ? sql`template_data->>'kind' = 'acceptance'`
          : sql`(template_data->>'kind' IS DISTINCT FROM 'acceptance')`;
    const rows = await sql<RubricPlanRow[]>`
      SELECT plan_slug, workspace_id, harness_slug, title, status, created, updated, updated_at,
             owner, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND ${kindCond}
       LIMIT 500`;
    return rows
      .map(planRowToRubric)
      .filter((r): r is Rubric => r !== null && (kind === 'any' || r.kind === kind));
  } catch {
    return [];
  }
}

// ─── first-party seed (local-first-party-rubric-bundling-2026-07-07 P-003) ───────────
// Templates-v1 design applied to rubrics, with the one structural difference: a rubric
// IS a plan row with ratify/trend/scorecard machinery keyed off the DB, so the bundled
// layer (cupboard/rubric-store.ts) SEEDS into the workspace store instead of being read
// through. Idempotent + no-clobber: an existing workspace rubricId (any status) always
// wins — a local ratified edit is never overwritten; the bundle only fills gaps. Also
// the cold-start fix: a fresh install has ZERO rubric rows until this runs.

/** The recorded plan owner for a seeded rubric (createdBy/proposedBy/ratifiedBy in
 *  reads). Defined in cupboard/rubric-store.ts (the seed decision core gates on it);
 *  re-exported here for the established import surface. The content VERSION lives in
 *  the bundle (rubric.json/listing.json), not in template_data —
 *  rubricTemplateDataSchema is .strict() and a version field there would fail loud;
 *  v1 has no upgrade semantics anyway (existing rows always win).
 *
 *  ⚠ Renaming a first-party rubric's on-disk dir? This seeder WILL race you: the
 *  moment the new dir is on disk with no plan row under the new id yet, any lazy
 *  seed pass (this function, fired by any rubrics read) auto-creates a blank
 *  placeholder row owner=FIRST_PARTY_RUBRIC_SEED_OWNER under the NEW id — ahead of
 *  whatever DB migration renames the real row. That migration must DELETE a
 *  same-id owner=FIRST_PARTY_RUBRIC_SEED_OWNER placeholder before renaming the real
 *  row into place. (Since WI-3617 the seed also RECLAIMS a seeder-owned row whose
 *  template_data fails the schema — so a wedged placeholder self-heals on a later
 *  read instead of blocking its own repair forever — but the migration rule stands:
 *  the placeholder squatting the new id has no ratification lineage and must not
 *  survive as the renamed row's identity.) Full writeup + copy-paste SQL:
 *  agent-insights/renaming-a-first-party-rubric-races-the-cold-start-seeder
 *  (EI-8912 / WI-3618, worked example: sql/531-rename-hive-coordination-health-rubric-to-pot.sql). */
export { FIRST_PARTY_RUBRIC_SEED_OWNER };

type RubricSeedState = 'pending' | 'running' | 'done';
let rubricSeedState: RubricSeedState = 'pending';

/** Test-only: re-arm the once-per-process seed gate. */
export function __resetRubricSeedStateForTests(): void {
  rubricSeedState = 'pending';
}

/** Existing rubric plan rows for the no-clobber check, with the validity flag the seed
 *  decision core gates its reclaim exception on (see rubricsNeedingSeed). Deliberately
 *  raw rows, NOT planRowToRubric (which nulls out invalid rows): a half-authored row
 *  under a real owner must still block the seed rather than be silently overwritten —
 *  only a seeder-owned invalid row is reclaimable. THROWS on a DB error so the caller
 *  can defer the seed instead of mistaking "unreachable" for "empty". */
async function existingRubricPlanRows(): Promise<ExistingRubricRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ plan_slug: string; owner: string | null; template_data: unknown }[]>`
    SELECT plan_slug, owner, template_data
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${rubricsScopeWorkspace()}
       AND template = ${RUBRIC_TEMPLATE_NAME}`;
  return rows.map((r) => {
    const parsed = rubricTemplateDataSchema.safeParse(r.template_data);
    return {
      rubricId: r.plan_slug,
      owner: r.owner,
      valid: parsed.success,
      // EI-12932: the comparable fields the seed's content-drift detection needs — only
      // meaningful (and only supplied) for a row that actually parses.
      ...(parsed.success ? { templateData: parsed.data } : {}),
    };
  });
}

/**
 * Build the proposeRubric input for ONE bundled rubric's seed/upgrade write. `existingRow`
 * is the row's pre-write state (undefined for a brand-new seed, `valid:false` for a WI-3617
 * reclaim, `valid:true` for an EI-12932 content-drift upgrade). For the upgrade case, the
 * caller has already fetched the live `Rubric` so provenance fields the bundle never
 * carries (releaseGating, ratifiedBy, status) survive the whole-document replace instead
 * of being silently dropped.
 */
function buildSeedProposeInput(
  r: LocalRubric,
  upgrading: Rubric | null,
): ProposeRubricInput {
  return {
    rubricId: r.rubricId,
    characteristic: r.characteristic,
    title: r.title,
    ...(r.description ? { description: r.description } : {}),
    criteria: r.criteria,
    ratingScale: r.ratingScale,
    ...(r.methodRef ? { methodRef: r.methodRef } : {}),
    by: FIRST_PARTY_RUBRIC_SEED_OWNER,
    // EI-12932: an upgrade preserves the EXISTING row's status/provenance rather than
    // unconditionally (re-)authoring 'active' — a human who retired a bundled rubric, or
    // set releaseGating/ratifiedBy on it, must never have that silently reverted by an
    // automatic content sync.
    status: upgrading?.status ?? 'active',
    ...(upgrading?.releaseGating !== undefined ? { releaseGating: upgrading.releaseGating } : {}),
    // D-015: a declared contract-generation boundary is governance state, not content —
    // a content sync that silently dropped it would re-blend a retired contract's
    // gradings into the live trend, which is exactly what declaring it prevented.
    ...(upgrading?.historyResetAt ? { historyResetAt: upgrading.historyResetAt } : {}),
    ...(upgrading?.ratifiedBy ? { ratifiedBy: upgrading.ratifiedBy } : {}),
    seedContentHash: computeSeedContentHash(r),
  };
}

/**
 * Seed the bundled first-party rubrics into the workspace store, once per process —
 * wired into loadAllRubrics, so any rubrics:list/get/search (or the Overwatch scorecard
 * getRubric) triggers it lazily. Seeded rubrics are authored ACTIVE (they shipped
 * ratified) with owner FIRST_PARTY_RUBRIC_SEED_OWNER, via the canonical proposeRubric
 * path (fail-loud schema validation, plan-lock writes).
 *
 * EI-12932: beyond authoring MISSING rubrics, this also UPGRADES an already-seeded rubric
 * in place when the bundle's content has changed since it was last seeded (rubricsNeedingSeed
 * gates this on the row still matching its own recorded `seedContentHash` — a genuinely
 * locally-amended row is never touched). The WI-4287 loss-guards (assertNoSilentRubricLoss)
 * still apply to an upgrade write exactly as to any propose: a bundle edit that would DROP a
 * stored criterion or gut its procedure text fails loud here (caught below, logged, retried
 * on a later read) rather than silently losing content.
 *
 * Re-entrancy: the seed's own writes read back through loadAllRubrics — the 'running'
 * state short-circuits those (and, benignly, a concurrent first read races the seed and
 * may see the pre-seed set once). Any failure re-arms 'pending' so a later read retries
 * (e.g. the DB was briefly unavailable at first read); the per-id existence check makes
 * the retry cheap and clobber-free. Never throws — reads stay degrade-only.
 */
export async function ensureFirstPartyRubricsSeeded(): Promise<void> {
  if (rubricSeedState !== 'pending') return;
  rubricSeedState = 'running';
  let ok = true;
  try {
    const bundled = listLocalRubrics();
    if (bundled.length > 0) {
      const existingRows = await existingRubricPlanRows();
      const existingById = new Map(existingRows.map((e) => [e.rubricId, e] as const));
      const needsSeed = rubricsNeedingSeed(bundled, existingRows);
      for (const r of needsSeed) {
        try {
          const existingRow = existingById.get(r.rubricId);
          // Only a VALID pre-existing row (the EI-12932 upgrade case) has provenance worth
          // reading back — a missing or WI-3617-invalid row gets a plain fresh seed.
          const upgrading = existingRow?.valid ? await getRubric(r.rubricId) : null;
          await proposeRubric(buildSeedProposeInput(r, upgrading));
        } catch (err) {
          ok = false; // one broken/blocked rubric never stops the rest
          console.warn(
            `[rubrics] first-party seed failed for '${r.rubricId}' (will retry on a later read):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  } catch (err) {
    ok = false;
    console.warn(
      '[rubrics] first-party seed deferred (store/bundle unavailable; will retry on a later read):',
      err instanceof Error ? err.message : err,
    );
  }
  rubricSeedState = ok ? 'done' : 'pending';
}

export interface ListRubricsFilter {
  status?: RubricStatus;
  characteristic?: string;
  limit?: number;
  /**
   * Kind scope (acceptance-rubrics-on-every-plan-2026-08-11). DEFAULT 'standard': the
   * library reads (and everything downstream of them — the learning surfaces, the
   * ratification queue, the staleness watchdog) see only reusable standards. Pass
   * 'acceptance' or 'any' to opt into per-plan acceptance rubrics explicitly.
   */
  kind?: RubricKindFilter;
}

/** List rubrics (active first, then proposed, then retired), optionally filtered by
 *  status / characteristic. Reads rubric-template plans (P-006/P-007). Standard-kind
 *  only unless `kind` opts in (see ListRubricsFilter.kind). */
export async function listRubrics(filter: ListRubricsFilter = {}): Promise<Rubric[]> {
  let rubrics = await loadAllRubrics(filter.kind ?? 'standard');
  if (filter.status) rubrics = rubrics.filter((r) => r.status === filter.status);
  if (filter.characteristic) rubrics = rubrics.filter((r) => r.characteristic === filter.characteristic);
  return sortRubrics(rubrics).slice(0, Math.min(filter.limit ?? 100, 500));
}

/** Fetch one rubric in full by its slug id — ANY kind: an explicit id is an explicit
 *  opt-in, so the shared grading path resolves acceptance rubrics through the same seam
 *  standards use (plan D-010). Returns null when no rubric carries that id. */
export async function getRubric(rubricId: string): Promise<Rubric | null> {
  const std = (await loadAllRubrics()).find((r) => r.rubricId === rubricId);
  if (std) return std;
  // Not in the standard library — a direct id-addressed lookup of any kind (acceptance
  // rubrics are hidden from the library scan, never from an explicit id).
  try {
    const { sql } = getOrgPg();
    const rows = await sql<RubricPlanRow[]>`
      SELECT plan_slug, workspace_id, harness_slug, title, status, created, updated, updated_at,
             owner, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND plan_slug = ${rubricId}
       LIMIT 1`;
    // Client-side slug guard: keeps behavior identical under mocked-sql test fixtures
    // that return the full row set for any query.
    const row = rows.find((r) => r.plan_slug === rubricId);
    return row ? planRowToRubric(row) : null;
  } catch {
    return null;
  }
}

/**
 * The acceptance rubric FOR a plan (acceptance-rubrics-on-every-plan-2026-08-11): the
 * most recently updated valid acceptance-kind rubric whose subjectPlan names `planSlug`.
 * The read behind the completion gate and the plans:get surfacing. Never throws.
 */
export async function getAcceptanceRubricForPlan(planSlug: string): Promise<Rubric | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<RubricPlanRow[]>`
      SELECT plan_slug, workspace_id, harness_slug, title, status, created, updated, updated_at,
             owner, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND template_data->>'kind' = 'acceptance'
         AND template_data->>'subjectPlan' = ${planSlug}
       ORDER BY updated_at DESC
       LIMIT 5`;
    const mapped = rows
      .map(planRowToRubric)
      .filter((r): r is Rubric => r !== null && r.kind === 'acceptance' && r.subjectPlan === planSlug);
    return mapped[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Search rubrics by id / characteristic / title / description. Case-insensitive,
 * all-tokens-must-match (websearch's AND semantics). At this scale (tens of rubrics) an
 * in-process scan over the rubric-template plans is as fast as a table FTS. Standard-kind
 * only unless `kind` opts in.
 */
export async function searchRubrics(
  query: string,
  limit = 50,
  kind: RubricKindFilter = 'standard',
): Promise<Rubric[]> {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const matched = (await loadAllRubrics(kind)).filter((r) => {
    const hay = `${r.rubricId} ${r.characteristic} ${r.title} ${r.description}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  return sortRubrics(matched).slice(0, Math.min(limit, 200));
}

// ─── writes: author / ratify a rubric-template plan (P-007 Stage 2) ──────────────────

/** A propose-input criterion: the v1 shape with the heavyweight prose fields optional,
 *  so acceptance-kind proposals may author light criteria (the per-kind schema refuses
 *  a STANDARD rubric whose criteria omit them — nothing is silently loosened). */
export type ProposeRubricCriterion = Omit<RubricCriterion, 'model' | 'method' | 'driftMarkers'> &
  Partial<Pick<RubricCriterion, 'model' | 'method' | 'driftMarkers'>>;

export interface ProposeRubricInput {
  rubricId: string;
  /**
   * The rubric's kind (acceptance-rubrics-on-every-plan-2026-08-11). Default 'standard'.
   * 'acceptance' additionally requires subjectPlan (validated to EXIST — a dangling link
   * would never gate anything), defaults status → 'active' (acceptance rubrics are not
   * ratified, plan D-008), and allows empty criteria when classRef is set (D-009).
   */
  kind?: RubricKind;
  /** acceptance-kind only: the plan this rubric is the definition-of-done FOR. */
  subjectPlan?: string;
  /** acceptance-kind only: the standard-kind class rubric it builds on (validated to exist). */
  classRef?: string;
  characteristic: string;
  title: string;
  description?: string;
  criteria: ProposeRubricCriterion[];
  ratingScale?: string[];
  methodRef?: string;
  /** Mark this rubric release-gating (EI-12149) — the staleness watchdog then alerts
   *  when it goes ungraded past its threshold while active. */
  releaseGating?: boolean;
  /** Contract-generation boundary (D-015) — see Rubric.historyResetAt. Normally set via
   *  setRubricHistoryReset() rather than here, because a propose demotes to 'proposed'. */
  historyResetAt?: string;
  /** Who is proposing (ownerId). Recorded as the plan owner. */
  by?: string;
  /**
   * Lifecycle status to write. Defaults to 'proposed' (the rubrics:propose tool path,
   * D-001: agents propose, the Queen ratifies). Seed/test paths may pass 'active' to
   * author a ratified rubric directly. Idempotent on rubricId: re-propose updates the
   * plan content + template_data and sets the status.
   */
  status?: RubricStatus;
  /**
   * WI-4287 loss-guard ack: keys of STORED criteria this proposal INTENTIONALLY drops.
   * proposeRubric is a whole-document replace — a stored criterion key absent from
   * `criteria` is rejected unless listed here (a partial criteria list otherwise
   * silently deletes the rest).
   */
  dropKeys?: string[];
  /**
   * WI-4287 loss-guard ack: allow a criterion's method+replication procedure text to
   * shrink sharply (>40%) or lose its REPLICATION DRILL marker. Requires a non-empty
   * `shrinkReason` — the intent is a conscious, explained edit, never a silent one.
   */
  allowMethodShrink?: boolean;
  /** Why the procedure shrink is intentional (required with allowMethodShrink). */
  shrinkReason?: string;
  /**
   * EI-10751: carry an EXISTING ratification through a whole-document replace. Only the
   * amendRubric path sets this (a small amendment to an already-active rubric keeps its
   * ratifier of record); a plain propose/re-propose leaves it unset, which DROPS the
   * stored ratifiedBy — a fresh revision needs a fresh ratification.
   */
  ratifiedBy?: string;
  /**
   * EI-12932: the first-party-bundle seed/upgrade path stamps its own content hash here
   * (see cupboard/rubric-store.ts seedContentHash) so a later seed pass can tell whether
   * this rubric's live content still matches what the seeder last wrote. Never set by a
   * plain rubrics:propose / amendRubric call — a real edit should DROP it (a whole-
   * document replace that omits it clears the field), which is exactly what un-blesses
   * the row for a future silent auto-upgrade.
   */
  seedContentHash?: string;
}

// ─── WI-4287: loss-guards + completeness — never silently drop a testing procedure ────
// [owner 2026-07-12] "how can we improve our system so that the next agent who
// updates the rubric also knows to add the full detailed testing procedure and doesn't
// drop it? … i think each aspect should come with its own testing procedure in addition
// to one main one for the whole rubric." proposeRubric REPLACES the whole document, so
// a revision rebuilt from a stale copy silently deletes criteria or their embedded
// procedures (the 4.6k-char batched-tool-calls REPLICATION DRILL was the live example).
// These guards make that loss LOUD: enforced here in the LIB write path so every caller
// (MCP tool, code:run facade, future surfaces) inherits them. A brand-new first-party seed
// write is unaffected (stored=null ⇒ no guard); an EI-12932 content-drift UPGRADE of an
// already-seeded rubric goes through this same guard like any other propose — a bundle
// edit that would drop a stored criterion or gut its procedure text fails loud instead of
// silently losing content (caught by ensureFirstPartyRubricsSeeded, logged, retried later).

/** The marker string that tags an embedded replication drill in method/replication
 *  prose. Losing it from a criterion's combined procedure text is a guard violation. */
export const REPLICATION_DRILL_MARKER = 'REPLICATION DRILL';

/** A criterion's combined procedure text must not shrink below this fraction of the
 *  stored text (0.6 ⇒ a >40% shrink violates) without an explicit allowMethodShrink. */
export const METHOD_SHRINK_GUARD_RATIO = 0.6;

/** The shrink-ratio guard only applies when the STORED procedure text is at least this
 *  long — a 50-char method being reworded shouldn't trip a loss guard; a 4,600-char
 *  drill being gutted must. The MARKER guard applies regardless of length. */
export const METHOD_SHRINK_GUARD_MIN_CHARS = 200;

/** A criterion's full procedure text: method + replication drill combined. Comparing
 *  the COMBINED text (D-002) means moving a drill between the two fields is never a
 *  violation — only genuine text loss is. */
function criterionProcedureText(c: { method?: string; replication?: string }): string {
  return `${c.method ?? ''}${c.replication ? `\n${c.replication}` : ''}`;
}

/**
 * PURE: the WI-4287 loss-guard. Compares a propose input against the STORED rubric and
 * THROWS a teaching error naming exactly what would be silently lost:
 *   • a stored criterion key absent from the proposal → requires a `dropKeys` ack;
 *   • a surviving criterion whose method+replication text shrinks >40% (stored ≥200
 *     chars) or loses its REPLICATION DRILL marker → requires `allowMethodShrink:true`
 *     + a non-empty `shrinkReason`.
 * `stored === null` (a brand-new rubric) and an identical re-propose both pass.
 */
export function assertNoSilentRubricLoss(stored: Rubric | null, input: ProposeRubricInput): void {
  if (!stored) return;

  const proposedByKey = new Map(input.criteria.map((c) => [c.key, c]));
  const acked = new Set(input.dropKeys ?? []);
  const violations: string[] = [];

  // 1) dropped criteria — every stored key must survive or be explicitly acknowledged.
  const dropped = stored.criteria.filter((c) => !proposedByKey.has(c.key) && !acked.has(c.key));
  if (dropped.length > 0) {
    violations.push(
      `DROPS ${dropped.length} stored criteri${dropped.length === 1 ? 'on' : 'a'}: ${dropped
        .map((c) => `'${c.key}'`)
        .join(', ')} — acknowledge intentional removal with dropKeys:[${dropped
        .map((c) => `"${c.key}"`)
        .join(', ')}], or rubrics:get the stored rubric and resubmit ALL criteria (a partial list silently deletes the rest)`,
    );
  }

  // 2) procedure loss on surviving criteria — marker loss or a sharp combined shrink.
  const shrinkViolations: string[] = [];
  for (const storedCrit of stored.criteria) {
    const proposed = proposedByKey.get(storedCrit.key);
    if (!proposed) continue; // handled by the drop guard above
    const before = criterionProcedureText(storedCrit);
    const after = criterionProcedureText(proposed);
    if (before.includes(REPLICATION_DRILL_MARKER) && !after.includes(REPLICATION_DRILL_MARKER)) {
      shrinkViolations.push(
        `criterion '${storedCrit.key}' LOSES its '${REPLICATION_DRILL_MARKER}' testing procedure (stored method+replication carries the marker; the proposal's doesn't)`,
      );
    } else if (
      before.length >= METHOD_SHRINK_GUARD_MIN_CHARS &&
      after.length < before.length * METHOD_SHRINK_GUARD_RATIO
    ) {
      const pct = Math.round((1 - after.length / before.length) * 100);
      shrinkViolations.push(
        `criterion '${storedCrit.key}' procedure text (method+replication) shrinks ${before.length} → ${after.length} chars (−${pct}%)`,
      );
    }
  }
  if (shrinkViolations.length > 0) {
    if (input.allowMethodShrink && (input.shrinkReason ?? '').trim() !== '') {
      // conscious, explained shrink — allowed.
    } else if (input.allowMethodShrink) {
      violations.push(
        `${shrinkViolations.join('; ')} — allowMethodShrink is set but shrinkReason is empty: explain WHY the procedure is intentionally shrinking`,
      );
    } else {
      violations.push(
        `${shrinkViolations.join('; ')} — if intentional, pass allowMethodShrink:true + shrinkReason; otherwise restore the full procedure text (rubrics:get the stored rubric and edit from it)`,
      );
    }
  }

  if (violations.length > 0) {
    // EI-10148: this is a CALLER error (the proposal args would silently lose stored
    // content — the caller must ack via dropKeys / allowMethodShrink), NOT a tool bug.
    // Prefix with the `invalid_args:` convention so the tool-error classifier buckets
    // it `caller` (DX/schema) instead of falling through to `structural` — otherwise
    // the improvement-watchdog mis-files this deterministic loss-guard rejection as a
    // structural tool-bug into the auto-implement lane (the false alarm this fixes).
    throw new Error(
      `invalid_args: proposeRubric: rubrics:propose REPLACES the whole rubric document, and this proposal would SILENTLY LOSE content from stored rubric '${stored.rubricId}':\n` +
        violations.map((v) => `  • ${v}`).join('\n'),
    );
  }
}

/** WI-4287 completeness report: which aspects still lack their own testing procedure,
 *  and whether the rubric-level main procedure (methodRef) is set. */
export interface RubricCompleteness {
  /** Criterion keys with neither a `replication` drill nor a REPLICATION DRILL marker
   *  embedded in `method`. */
  criteriaWithoutReplication: string[];
  /** True when the rubric has no methodRef (the ONE main long-form procedure). */
  methodRefMissing: boolean;
  /** Release-gating criterion keys with no structured/legacy instrument binding. */
  criteriaWithoutInstrument: string[];
  /** Real instrument keys bound by more than one release criterion. */
  duplicateInstrumentKeys: string[];
  /** True when procedures, methodRef, and release instrumentation are complete. */
  complete: boolean;
  /** Human-readable gap summary; absent when complete. */
  note?: string;
}

/** Backward-compatible instrument binding: structured field first, then legacy token. */
export function effectiveCriterionInstrumentKey(
  criterion: { model?: string; instrumentKey?: string },
): string | null {
  if (criterion.instrumentKey?.trim()) return criterion.instrumentKey.trim();
  const match = /\[instrumentKey:\s*([a-z0-9-]+|none)\]\s*$/.exec(criterion.model ?? '');
  return match?.[1] ?? null;
}

export interface RubricInstrumentContract {
  valid: boolean;
  bindings: Record<string, string | null>;
  criteriaWithoutInstrument: string[];
  duplicateInstrumentKeys: string[];
}

/** Pure one-criterion↔one-instrument contract used by writes, ratification, and grading. */
export function rubricInstrumentContract(
  // Accepts the propose-input criterion shape too (model optional on acceptance-kind
  // criteria) — the contract only reads key + the effective instrument binding.
  rubric: { releaseGating?: boolean; criteria: ProposeRubricCriterion[] },
): RubricInstrumentContract {
  const bindings = Object.fromEntries(
    rubric.criteria.map((criterion) => [criterion.key, effectiveCriterionInstrumentKey(criterion)]),
  );
  if (!rubric.releaseGating) {
    return { valid: true, bindings, criteriaWithoutInstrument: [], duplicateInstrumentKeys: [] };
  }
  const criteriaWithoutInstrument = rubric.criteria
    .filter((criterion) => !bindings[criterion.key])
    .map((criterion) => criterion.key);
  const seen = new Set<string>();
  const duplicateInstrumentKeys = [...new Set(
    Object.values(bindings)
      .filter((key): key is string => Boolean(key) && key !== 'none')
      .filter((key) => (seen.has(key) ? true : (seen.add(key), false))),
  )];
  return {
    valid: criteriaWithoutInstrument.length === 0 && duplicateInstrumentKeys.length === 0,
    bindings,
    criteriaWithoutInstrument,
    duplicateInstrumentKeys,
  };
}

/**
 * PURE: report a rubric's testing-procedure completeness — the owner's target shape is
 * "each aspect comes with its own testing procedure in addition to one main one for the
 * whole rubric". Non-blocking: rubrics:propose/ratify SURFACE this so gaps stay visible
 * on every revision; they never reject on it.
 */
export function rubricCompleteness(rubric: Rubric): RubricCompleteness {
  const criteriaWithoutReplication = rubric.criteria
    .filter((c) => !(c.replication ?? '').trim() && !c.method.includes(REPLICATION_DRILL_MARKER))
    .map((c) => c.key);
  const methodRefMissing = !rubric.methodRef;
  const instrumentContract = rubricInstrumentContract(rubric);
  const { criteriaWithoutInstrument, duplicateInstrumentKeys } = instrumentContract;
  const complete =
    criteriaWithoutReplication.length === 0 &&
    !methodRefMissing &&
    criteriaWithoutInstrument.length === 0 &&
    duplicateInstrumentKeys.length === 0;
  const parts: string[] = [];
  if (criteriaWithoutReplication.length > 0) {
    parts.push(
      `${criteriaWithoutReplication.length}/${rubric.criteria.length} criteria lack their own replication drill (each aspect should carry a copy-runnable testing procedure in criterion.replication): ${criteriaWithoutReplication.join(', ')}`,
    );
  }
  if (methodRefMissing) {
    parts.push('rubric methodRef is unset (the ONE main long-form procedure runbook for the whole rubric)');
  }
  if (criteriaWithoutInstrument.length > 0) {
    parts.push(
      `release-gating criteria lack instrument bindings: ${criteriaWithoutInstrument.join(', ')} (set criterion.instrumentKey; legacy trailing model tokens remain readable)`,
    );
  }
  if (duplicateInstrumentKeys.length > 0) {
    parts.push(`release-gating instrument keys are duplicated: ${duplicateInstrumentKeys.join(', ')}`);
  }
  return {
    criteriaWithoutReplication,
    methodRefMissing,
    criteriaWithoutInstrument,
    duplicateInstrumentKeys,
    complete,
    ...(parts.length > 0 ? { note: parts.join('; ') } : {}),
  };
}

/** Build the validated `template_data` for a rubric-template plan from a propose input.
 *  Throws (fail-loud, D-004) if the rubric data is malformed — never persists a broken
 *  rubric. Returns the schema-coerced data. */
function buildRubricTemplateData(input: ProposeRubricInput): unknown {
  const instrumentContract = rubricInstrumentContract({
    releaseGating: input.releaseGating,
    criteria: input.criteria,
  });
  if (!instrumentContract.valid) {
    throw new Error(
      `invalid_args: proposeRubric: release-gating rubric '${input.rubricId}' has an invalid instrument contract — ` +
        [
          instrumentContract.criteriaWithoutInstrument.length
            ? `missing bindings: ${instrumentContract.criteriaWithoutInstrument.join(', ')}`
            : '',
          instrumentContract.duplicateInstrumentKeys.length
            ? `duplicate bindings: ${instrumentContract.duplicateInstrumentKeys.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('; '),
    );
  }
  const data = {
    // Kind + acceptance links (acceptance-rubrics-on-every-plan-2026-08-11) — the schema's
    // per-kind superRefine validates the combination (subjectPlan/classRef acceptance-only,
    // standard criteria fully-specified, …).
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.subjectPlan ? { subjectPlan: input.subjectPlan } : {}),
    ...(input.classRef ? { classRef: input.classRef } : {}),
    characteristic: input.characteristic,
    criteria: input.criteria,
    ratingScale: input.ratingScale ?? [...DEFAULT_RATING_SCALE],
    ...(input.methodRef ? { methodRef: input.methodRef } : {}),
    ...(input.releaseGating !== undefined ? { releaseGating: input.releaseGating } : {}),
    ...(input.historyResetAt !== undefined ? { historyResetAt: input.historyResetAt } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    // EI-10751 provenance: the proposer of record is whoever authored THIS revision —
    // the plan owner column stays the original creator and never tracks a re-propose.
    ...(input.by ? { proposedBy: input.by } : {}),
    // A propose is a whole-document replace, so ratifiedBy is deliberately DROPPED
    // unless explicitly carried (amendRubric threads it through for an already-active
    // rubric): a fresh revision needs a fresh ratification.
    ...(input.ratifiedBy ? { ratifiedBy: input.ratifiedBy } : {}),
    // EI-12932: likewise dropped unless the first-party seed/upgrade path explicitly
    // stamps it — a real propose/amend clearing it is exactly what un-blesses the row
    // for a future auto-upgrade (see rubricsNeedingSeed).
    ...(input.seedContentHash ? { seedContentHash: input.seedContentHash } : {}),
  };
  const parsed = rubricTemplateDataSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`proposeRubric: invalid rubric data for '${input.rubricId}': ${issues}`);
  }
  return parsed.data;
}

/**
 * Acceptance-kind link guards (acceptance-rubrics-on-every-plan-2026-08-11 P-003), run
 * BEFORE any write: the completion gate keys off subjectPlan, so a dangling link is a
 * rubric that never gates anything — refused loudly, never persisted.
 */
async function assertAcceptanceLinksResolve(input: ProposeRubricInput): Promise<void> {
  const subjectPlan = input.subjectPlan;
  if (!subjectPlan) return; // schema already refuses acceptance without subjectPlan
  const { sql } = getOrgPg();
  const subj = await sql<{ plan_slug: string; template: string | null }[]>`
    SELECT plan_slug, template
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${rubricsScopeWorkspace()}
       AND plan_slug = ${subjectPlan}
     LIMIT 1`;
  const subjRow = subj.find((r) => r.plan_slug === subjectPlan);
  if (!subjRow) {
    throw new Error(
      `invalid_args: proposeRubric: acceptance rubric '${input.rubricId}' names subjectPlan '${subjectPlan}', ` +
        'but no such plan exists in this workspace — the completion gate keys off this link, so a dangling ' +
        'subjectPlan would never gate anything. Fix the slug (or create the plan first).',
    );
  }
  if (subjRow.template === RUBRIC_TEMPLATE_NAME) {
    throw new Error(
      `invalid_args: proposeRubric: subjectPlan '${subjectPlan}' is itself a rubric-template plan — ` +
        'rubrics do not get acceptance rubrics (infinite regress); point subjectPlan at the WORK plan.',
    );
  }
  if (input.classRef) {
    const cls = await getRubric(input.classRef);
    if (!cls) {
      throw new Error(
        `invalid_args: proposeRubric: acceptance rubric '${input.rubricId}' references classRef '${input.classRef}', ` +
          'but no rubric carries that id — rubrics:list the standard library and pick the class rubric ' +
          '(feature-ship / bugfix / migration / investigation) this plan belongs to.',
      );
    }
    if (cls.kind !== 'standard') {
      throw new Error(
        `invalid_args: proposeRubric: classRef '${input.classRef}' is an ${cls.kind}-kind rubric — a class ` +
          'reference must point at a STANDARD-kind rubric (the reusable class carrying the shared invariants).',
      );
    }
  }
}

/** The `template: rubric` plan body (frontmatter + Now + Background + Decisions). The
 *  structured fields live in `template_data` (written separately); the body is narrative
 *  context. Mirrors the Scout rubric-rail draft shape so the plan parses + derives the
 *  `template` column. */
function buildRubricPlanBody(args: {
  slug: string;
  title: string;
  planStatus: string;
  owner: string | null;
  date: string;
  description?: string;
}): string {
  const { slug, title, planStatus, owner, date, description } = args;
  const ownerLine = owner ? `\nowner: ${owner}` : '';
  const blurb = description?.trim()
    ? description.trim()
    : 'A shared standard for a system characteristic — its criteria grade structured observations.';
  return `---
title: ${title}
slug: ${slug}
status: ${planStatus}
template: ${RUBRIC_TEMPLATE_NAME}
created: ${date}
updated: ${date}${ownerLine}
---

# ${title}

## Now

**State:** Rubric-template plan (template:rubric). Its structured fields (characteristic,
criteria, ratingScale, methodRef) live in \`template_data\`, queried via
rubrics:list/get/search; this body is the narrative model/method context. Status
\`${planStatus}\` ⇒ a ${planStatusToRubricStatus(planStatus)} rubric.

**Next:** The Mug ratifies a proposed rubric by promoting this plan to \`active\`
(rubrics:ratify / plans:set-plan-status). Revise the criteria via plans:set-template-data.

## Background

${blurb}

## Criteria — the structured \`template_data\`

The per-criterion model / method / drift markers live in \`template_data\` (read via
rubrics:get or plans:get-template-data). Agents read/write the rubric structured, never
by parsing this markdown.

## Decisions

(Use plans:add-decision to append.)
`;
}

/** Resolve the (workspace, harness) PK scope for a rubric-template plan write. Reuses an
 *  EXISTING plan's own harness so a re-propose/ratify targets the same PK row; falls back
 *  to the operator-home harness for a brand-new rubric. */
async function resolveRubricWriteScope(
  rubricId: string,
): Promise<{ workspaceId: string; harnessSlug: string }> {
  const workspaceId = rubricsScopeWorkspace();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ harness_slug: string }[]>`
      SELECT harness_slug
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND plan_slug = ${rubricId}
         AND template = ${RUBRIC_TEMPLATE_NAME}
       LIMIT 1`;
    if (rows[0]?.harness_slug) return { workspaceId, harnessSlug: rows[0].harness_slug };
  } catch {
    /* fall through to the default home harness */
  }
  return { workspaceId, harnessSlug: defaultRubricWriteHarness() };
}

/**
 * EI-10443 audit trail: build the `withPlanLock` afterWrite that appends ONE
 * `plan_revisions` row for a rubric propose/ratify write. The rubric write path went
 * through withPlanLock with NO afterWrite, so the plan revision spine had ZERO rows for
 * every rubric plan (`plan_slug='pot-coordination-health'` returned 0 revisions) — a
 * destructive rubric write (e.g. the loss-guard strip that filed this bug) left no audit
 * trail and could be neither detected nor recovered via `plans:revisions`. Wiring this in
 * gives rubric writes the SAME revision spine every other plans:* write already records.
 *
 * `by` is the acting identity (the proposer/ratifier ownerId the MCP handler resolves and
 * threads through); when absent the row is attributed to a stable system actor so the audit
 * row still lands (auditability > attribution precision). Best-effort by construction —
 * `recordPlanRevision` never throws, so this can never fail the rubric write (it runs
 * post-commit, and withPlanLock awaits it).
 */
function rubricRevisionAfterWrite(
  rubricId: string,
  by: string | undefined,
  rationale: string,
): (writtenBody: string, scope?: { workspaceId: string; harnessSlug: string }) => Promise<void> {
  const identity: AgentIdentity = {
    ownerId: by ?? 'rubrics:system',
    ownerLabel: by ?? 'rubrics:system',
    // Not a `principal` (in-process human) — a rubric write is an agent/Queen action, so
    // classifyAuthor records author_kind='agent'.
    source: 'static-client',
    workspaceId: null,
    userId: null,
  };
  return async (writtenBody, scope) => {
    // Thread the (workspaceId, harnessSlug) withPlanLock resolved for THIS write so the
    // revision lands on the rubric plan's own PK (recordPlanRevision re-resolves through
    // the same resolvePlanScope — the operator-home short-circuit for the rubric harness).
    await recordPlanRevision({
      planSlug: rubricId,
      ...(scope?.harnessSlug ? { harnessSlug: scope.harnessSlug } : {}),
      ...(scope?.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      content: writtenBody,
      rationale,
      identity,
    });
  };
}

/**
 * Propose (idempotent upsert) a rubric → a `template: rubric` plan. status defaults to
 * 'proposed' (draft plan); 'active' authors a ratified rubric directly. Re-proposing the
 * same rubricId updates the plan content + template_data.
 *
 * The body (frontmatter → title/status/template columns) and the validated template_data
 * jsonb are written in ONE atomic locked transaction — withPlanLock writes template_data
 * alongside a non-null newBody (the same combined form ratifyRubric uses). This replaces a
 * former two-transaction split (body, then a SEPARATE structured-only template_data write):
 * that split was (a) NON-ATOMIC — a crash or busy advisory lock on the second write, after
 * the first had already committed, left the row with a fresh body/status but STALE
 * template_data — and (b) carried a silent `current === null` skip that could persist
 * nothing while the caller reported ok (EI-11070, the silent-no-op class). Combined, the
 * template_data can never lag the body and there is no skip branch to no-op through.
 */
export async function proposeRubric(input: ProposeRubricInput): Promise<Rubric> {
  const kind = input.kind ?? 'standard';
  // Acceptance rubrics are never ratified (plan D-008): they activate on propose and are
  // judged at plan completion by a NON-implementer grading them, not by a Queen ratify.
  const rubricStatus: RubricStatus = input.status ?? (kind === 'acceptance' ? 'active' : 'proposed');
  const planStatus = rubricStatusToPlanStatus(rubricStatus);
  // Validate FIRST (fail-loud) before any write, so a malformed rubric never persists a
  // half-state (a body with no/invalid template_data).
  const templateData = buildRubricTemplateData(input);
  // Acceptance links must RESOLVE before anything persists (plan P-003): a dangling
  // subjectPlan would never gate anything, silently.
  if (kind === 'acceptance') await assertAcceptanceLinksResolve(input);
  // WI-4287 loss-guard: propose is a whole-document replace — refuse to silently drop
  // stored criteria or gut their testing procedures (see assertNoSilentRubricLoss).
  assertNoSilentRubricLoss(await getRubric(input.rubricId), input);
  const scope = await resolveRubricWriteScope(input.rubricId);
  const date = new Date().toISOString().slice(0, 10);
  const body = buildRubricPlanBody({
    slug: input.rubricId,
    title: input.title,
    planStatus,
    owner: input.by ?? null,
    date,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });

  // Single atomic write: upsert the body AND the validated template_data jsonb in one
  // locked transaction (one version bump). The mutator ignores `current` — an upsert, not a
  // read-modify-write — so template_data lands regardless of the in-transaction row read.
  const result = await withPlanLock<true>(
    null,
    {
      slug: input.rubricId,
      intent: `rubrics:propose ${input.rubricId}`,
      ...scope,
      // EI-10443: record a plan_revisions audit row for the propose write.
      afterWrite: rubricRevisionAfterWrite(input.rubricId, input.by, `rubrics:propose (${rubricStatus})`),
    },
    async () => ({ newBody: body, templateData: { data: templateData }, value: true }),
  );
  if (result.kind === 'busy') {
    throw new Error(`proposeRubric: plan '${input.rubricId}' is being written by another caller`);
  }

  const rubric = await getRubric(input.rubricId);
  if (!rubric) {
    throw new Error(`proposeRubric: rubric '${input.rubricId}' did not resolve after write`);
  }
  return rubric;
}

// ─── rubric-system-improvements-2026-07-12 P-003: the small-amendment path ────────────

/** The criterion prose fields rubrics:amend may patch. `key` is identity (not patchable);
 *  `ratingScale` changes re-score history, so they stay whole-doc-propose territory. */
export const AMENDABLE_CRITERION_FIELDS = ['title', 'model', 'method', 'driftMarkers', 'replication'] as const;
export type AmendableCriterionField = (typeof AMENDABLE_CRITERION_FIELDS)[number];

export interface AmendRubricInput {
  rubricId: string;
  /** Patch ONE criterion's prose field. `append` adds a paragraph (never guarded — it
   *  can only grow the procedure); `replace` swaps the field and inherits the WI-4287
   *  shrink guard via proposeRubric. */
  criterion?: {
    key: string;
    field: AmendableCriterionField;
    mode: 'append' | 'replace';
    text: string;
  };
  /** Set/replace the rubric-level runbook slug (agent-insights). */
  methodRef?: string;
  allowMethodShrink?: boolean;
  shrinkReason?: string;
  by?: string;
}

/**
 * Pure core of amendRubric: patch the stored rubric per the amendment and shape the
 * whole-document ProposeRubricInput that persists it — STORED status preserved
 * (amending an active rubric never demotes it to proposed). Exported for unit tests;
 * throws teaching errors on an unknown criterion key / an empty amendment.
 */
export function applyRubricAmendment(stored: Rubric, input: AmendRubricInput): ProposeRubricInput {
  if (!input.criterion && input.methodRef === undefined) {
    throw new Error('amendRubric: nothing to amend — pass criterion and/or methodRef');
  }

  let criteria = stored.criteria;
  if (input.criterion) {
    const { key, field, mode, text } = input.criterion;
    const target = stored.criteria.find((c) => c.key === key);
    if (!target) {
      throw new Error(
        `amendRubric: rubric '${input.rubricId}' has no criterion '${key}' — keys: ${stored.criteria
          .map((c) => c.key)
          .join(', ')}`,
      );
    }
    const current = target[field] ?? '';
    const next = mode === 'append' ? (current ? `${current}\n\n${text}` : text) : text;
    criteria = stored.criteria.map((c) => (c.key === key ? { ...c, [field]: next } : c));
  }

  return {
    rubricId: stored.rubricId,
    // Kind + acceptance links round-trip (acceptance-rubrics-on-every-plan-2026-08-11):
    // dropping them from an amendment would flip an acceptance rubric to standard and
    // orphan its subjectPlan link — the WI-4287 loss class, on identity fields.
    ...(stored.kind !== 'standard' ? { kind: stored.kind } : {}),
    ...(stored.subjectPlan ? { subjectPlan: stored.subjectPlan } : {}),
    ...(stored.classRef ? { classRef: stored.classRef } : {}),
    characteristic: stored.characteristic,
    title: stored.title,
    description: stored.description,
    criteria,
    ratingScale: stored.ratingScale,
    // EI-12149: an amendment must carry the stored release-gating mark — dropping it
    // would silently un-gate the rubric (the WI-4287 loss class, on a boolean).
    ...(stored.releaseGating !== undefined ? { releaseGating: stored.releaseGating } : {}),
    ...(input.methodRef ?? stored.methodRef ? { methodRef: (input.methodRef ?? stored.methodRef)! } : {}),
    ...(input.by ?? stored.createdBy ? { by: (input.by ?? stored.createdBy)! } : {}),
    status: stored.status,
    // EI-10751: an amendment preserves the rubric's status, so it must also preserve the
    // ratifier of record — otherwise amending an active rubric leaves it active with the
    // stored ratifiedBy dropped, and the projection falls back to the plan owner (the
    // exact false-provenance record this fix removes).
    ...(stored.status === 'active' && stored.ratifiedBy ? { ratifiedBy: stored.ratifiedBy } : {}),
    ...(input.allowMethodShrink !== undefined ? { allowMethodShrink: input.allowMethodShrink } : {}),
    ...(input.shrinkReason !== undefined ? { shrinkReason: input.shrinkReason } : {}),
  };
}

/**
 * Amend ONE criterion field and/or the rubric's methodRef WITHOUT the whole-document
 * rubrics:propose replace (rubric-system-improvements-2026-07-12 P-003: the replace
 * ceremony — refetch, resubmit every criterion, ack loss-guards — deterred a same-day
 * one-paragraph amendment; small improvements were being skipped). Loads the stored
 * rubric, patches via applyRubricAmendment, and delegates persistence to proposeRubric
 * — every WI-4287 loss-guard still applies to a `replace` (an `append` can only grow).
 * Returns null for an unknown rubricId; throws (like proposeRubric) on guard violations.
 */
export async function amendRubric(input: AmendRubricInput): Promise<Rubric | null> {
  const stored = await getRubric(input.rubricId);
  if (!stored) return null;
  return proposeRubric(applyRubricAmendment(stored, input));
}

/** Raw template_data for one rubric plan (the un-projected jsonb) — the merge base for
 *  ratifyRubric's provenance patch. Reads by the same predicates as queryRubricPlans. */
async function readRawRubricTemplateData(rubricId: string): Promise<Record<string, unknown> | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ template_data: unknown }[]>`
    SELECT template_data
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${rubricsScopeWorkspace()}
       AND template = ${RUBRIC_TEMPLATE_NAME}
       AND template_slug IS NULL
       AND plan_slug = ${rubricId}
     LIMIT 1`;
  const d = rows[0]?.template_data;
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
}

/**
 * Ratify a proposed rubric → active (D-001: the Queen/owner gate) by promoting its plan
 * (status → active). Returns the activated rubric, or null if no rubric-template plan
 * with that id exists.
 *
 * EI-10751: `by` (the ratifying identity) is PERSISTED into template_data.ratifiedBy in
 * the SAME locked write that flips the status — it used to be discarded, and the read
 * projection then rendered the plan OWNER (the author) as ratifier: a fabricated
 * self-ratification record that made honest D-012 governance impossible (the reviewer
 * who found this rightly refused to ratify through it). D-012 is also ENFORCED here for
 * rubrics whose proposer is persisted: the recorded proposer cannot ratify their own
 * proposal. (Legacy rows without a persisted proposedBy can't be judged — the owner
 * fallback misattributes re-proposals — so the guard only fires on honest data.)
 */
export async function ratifyRubric(rubricId: string, by?: string): Promise<Rubric | null> {
  const existing = await getRubric(rubricId);
  if (!existing) return null;
  if (existing.kind === 'acceptance') {
    throw new Error(
      `invalid_args: ratifyRubric: '${rubricId}' is an acceptance-kind rubric (the definition-of-done for plan ` +
        `'${existing.subjectPlan ?? '?'}') — acceptance rubrics are never ratified (acceptance-rubrics-on-every-plan ` +
        'D-008): they activate on propose, and their judgment is a NON-implementer grading them at plan completion.',
    );
  }
  const completeness = rubricCompleteness(existing);
  if (
    existing.releaseGating &&
    (completeness.criteriaWithoutInstrument.length > 0 || completeness.duplicateInstrumentKeys.length > 0)
  ) {
    throw new Error(
      `invalid_args: ratifyRubric: release-gating rubric '${rubricId}' has an invalid instrument contract — ${completeness.note ?? 'instrument mapping incomplete'}`,
    );
  }
  const scope = await resolveRubricWriteScope(rubricId);
  // Merge base read just before the locked write; plan writes serialize on the advisory
  // lock, so the window is a propose racing this exact ratify — a governance conflict
  // that re-proposing resolves regardless (a re-propose resets status to proposed).
  const rawData = await readRawRubricTemplateData(rubricId);
  const persistedProposer =
    rawData && typeof rawData.proposedBy === 'string' ? rawData.proposedBy : null;
  if (by && persistedProposer && persistedProposer === by) {
    throw new Error(
      `ratifyRubric: '${rubricId}' was proposed by ${by} — the proposer cannot ratify their own proposal (D-012 author ≠ ratifier); a different reviewer must ratify it`,
    );
  }
  const result = await withPlanLock<boolean>(
    null,
    {
      slug: rubricId,
      intent: `rubrics:ratify ${rubricId}`,
      ...scope,
      // EI-10443: record a plan_revisions audit row for the status-flip write. afterWrite
      // only fires when a body was actually written (a no-op ratify — no frontmatter status
      // line — returns newBody:null and records nothing).
      afterWrite: rubricRevisionAfterWrite(rubricId, by, 'rubrics:ratify → active'),
    },
    async (current) => {
      if (current === null) return { newBody: null, value: false };
      const flipped = setPlanFrontmatterStatus(current, 'active');
      if (flipped === null) return { newBody: null, value: false };
      return {
        newBody: bumpUpdatedDate(flipped),
        value: true,
        ...(by && rawData ? { templateData: { data: { ...rawData, ratifiedBy: by } } } : {}),
      };
    },
  );
  if (result.kind === 'busy') {
    throw new Error(`ratifyRubric: plan '${rubricId}' is being written by another caller`);
  }
  return getRubric(rubricId);
}

/**
 * Retire the acceptance rubric of a completed plan (acceptance-rubrics-on-every-plan-
 * 2026-08-11 P-005 lifecycle: an acceptance rubric archives WITH its subject plan —
 * one-shot, never a lingering library entry). Best-effort BY DESIGN: returns the retired
 * rubricId, or null when there is nothing to do (no rubric / already retired / write
 * busy) or on any failure — a ship must never be failed by its lifecycle tidy-up.
 */
export async function retireAcceptanceRubricForPlan(planSlug: string, by?: string): Promise<string | null> {
  try {
    const rubric = await getAcceptanceRubricForPlan(planSlug);
    if (!rubric || rubric.status === 'retired') return null;
    const scope = await resolveRubricWriteScope(rubric.rubricId);
    const result = await withPlanLock<boolean>(
      null,
      {
        slug: rubric.rubricId,
        intent: `acceptance-rubric retire (subject plan '${planSlug}' shipped)`,
        ...scope,
        afterWrite: rubricRevisionAfterWrite(rubric.rubricId, by, 'acceptance rubric retired with its shipped subject plan'),
      },
      async (current) => {
        if (current === null) return { newBody: null, value: false };
        const flipped = setPlanFrontmatterStatus(current, 'superseded');
        if (flipped === null) return { newBody: null, value: false };
        return { newBody: bumpUpdatedDate(flipped), value: true };
      },
    );
    if (result.kind === 'busy') return null;
    return result.value ? rubric.rubricId : null;
  } catch {
    return null;
  }
}

/**
 * Declare the CONTRACT-GENERATION BOUNDARY on a rubric (D-015) — gradings filed before
 * `at` measured a materially different contract and drop out of `scorecardTrend`.
 *
 * WHY THIS IS NOT `amendRubric`, which is the obvious place to put it. `amendRubric` is
 * `proposeRubric(applyRubricAmendment(...))`, and a propose is a whole-document replace
 * that resets status to 'proposed' and drops `ratifiedBy` — a fresh revision needs a
 * fresh ratification, correctly, because its CONTENT changed. Declaring where an old
 * contract ended changes NO criterion: routing it through propose would demote a live
 * ratified instrument, and (worse) invite whoever needed the boundary to skip declaring
 * it rather than trigger a re-ratification mid-grading. So this takes the same shape
 * ratifyRubric already uses for governance state — a targeted, audited, locked
 * template_data merge patch that preserves status, criteria and provenance.
 *
 * THE JUDGEMENT IS DELIBERATELY THE AUTHOR'S. Nothing can infer where a contract's
 * semantic edge falls: the `version` column bumps on every propose (typo and rewrite
 * alike), and the criterion key set is unchanged for exactly the cases that matter most
 * — a kept key whose question narrowed, or whose instrument was broken. Both were
 * measured on goal-mode-e2e (D-009, D-012).
 *
 * Passing an `at` in the FUTURE is legal and load-bearing: a rewrite lands before its
 * first post-rewrite grading, so the boundary is normally the ratification instant of
 * the new revision.
 */
export async function setRubricHistoryReset(
  rubricId: string,
  at: string,
  by?: string,
): Promise<Rubric | null> {
  const existing = await getRubric(rubricId);
  if (!existing) return null;
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `invalid_args: setRubricHistoryReset: '${at}' is not a parseable ISO instant — the boundary is compared against scorecard createdAt, so an unparseable value would silently exclude nothing`,
    );
  }
  const iso = new Date(parsed).toISOString();
  const scope = await resolveRubricWriteScope(rubricId);
  const rawData = await readRawRubricTemplateData(rubricId);
  if (!rawData) return null;
  const result = await withPlanLock<boolean>(
    null,
    {
      slug: rubricId,
      intent: `rubrics:set-history-reset ${rubricId}`,
      ...scope,
      afterWrite: rubricRevisionAfterWrite(rubricId, by, `rubrics:set-history-reset → ${iso}`),
    },
    async (current) => {
      if (current === null) return { newBody: null, value: false };
      return {
        newBody: bumpUpdatedDate(current),
        value: true,
        templateData: { data: { ...rawData, historyResetAt: iso } },
      };
    },
  );
  if (result.kind === 'busy') {
    throw new Error(`setRubricHistoryReset: plan '${rubricId}' is being written by another caller`);
  }
  return getRubric(rubricId);
}

/**
 * Auto-ratify-on-first-scorecard (WI-5415, owner ask 2026-07-19): "why are agents
 * grading unratified rubrics — if an agent starts USING a rubric it should
 * automatically get ratified." Grading a still-`proposed` rubric IS adoption, so the
 * scorecard write path (capture-core.ts's captureImprovement, the ONE choke point for
 * both `scorecards:emit` and a raw `improvements:capture { lane:'observation' }`) calls
 * this the moment a scorecard lands against a rubric whose status is `proposed`.
 *
 * D-012 (author ≠ ratifier) still applies: when the grader IS the rubric's own
 * proposer, this is a no-op — that rubric stays `proposed` until a DIFFERENT agent
 * grades it or a human explicitly ratifies (`rubrics:ratify`). ratifyRubric() itself
 * enforces the same rule against the persisted proposer (defense in depth for a race
 * between this pre-check and the write), so a self-grade can never silently ratify
 * even if this function's own check were bypassed.
 *
 * Never throws — a transient write failure (a concurrent propose racing this ratify,
 * a busy plan lock) is logged and simply leaves the rubric `proposed`; the NEXT
 * scorecard against it retries the auto-ratify. A scorecard write must never fail
 * because its side-effect ratification hit a lock.
 */
export async function autoRatifyRubricOnFirstScorecard(
  rubricId: string,
  graderId: string,
): Promise<Rubric | null> {
  try {
    const rubric = await getRubric(rubricId);
    if (!rubric || rubric.status !== 'proposed') return null; // only a still-proposed rubric is "adopted" by grading
    if (rubric.proposedBy && rubric.proposedBy === graderId) return null; // D-012: grader === proposer, leave proposed
    return await ratifyRubric(rubricId, graderId);
  } catch (err) {
    console.warn(
      `[rubrics] auto-ratify-on-first-scorecard failed for '${rubricId}' (non-fatal — rubric stays proposed, next scorecard retries):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Pure: flip the frontmatter `status:` line within the leading `---`…`---` block only.
 *  Returns null when there is no frontmatter status line (legacy/malformed). Mirrors
 *  flipPlanFrontmatterStatus (set-plan-status.ts) — inlined to keep this lib off the
 *  agent-tools/MCP dependency graph. */
function setPlanFrontmatterStatus(body: string, target: string): string | null {
  if (!body.startsWith('---')) return null;
  const close = body.indexOf('\n---', 3);
  if (close === -1) return null;
  const fm = body.slice(0, close);
  const rest = body.slice(close);
  const re = /^(status:[ \t]*)([A-Za-z][\w-]*)([ \t]*)$/m;
  if (!re.test(fm)) return null;
  return fm.replace(re, `$1${target}$3`) + rest;
}
