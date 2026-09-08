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
 *     plan status → active. An independent reviewer or owner/su ratifies a rubric by
 *     promoting its plan; the proposer≠ratifier invariant is enforced in this module.
 *
 * The v1 standalone table (harness_shared.rubrics, mig 326/327) and the P-006
 * transitional plans∪table union are GONE (P-007 Stage 2): the seeded
 * pot-coordination-health rubric is served from its migrated rubric-template plan
 * (mig 338, ws='default', harness='papercusp'), and the table is dropped by a follow-on
 * migration. Versioning falls out of the plan revision spine (no separate machinery).
 */
import { getOrgPg } from '@papercusp/db-org';
import { parsePlan } from '@papercusp/plan-parser';
import { activeWorkspaceId } from './workspace-registry';
import {
  normalizeRequirementSections,
  type RequirementIntent,
  type RequirementAcceptance,
  type RequirementVerification,
} from './requirement-contract';
import {
  rubricTemplateDataSchema,
  rubricTemplateDataAuthoringSchema,
  rubricKindOf,
  isUnknownRatingEquivalent,
  RUBRIC_TEMPLATE_NAME,
  type RubricKind,
  type RubricCriterionWindow,
  type RubricCriterionCheck,
  type AcceptanceEvidencePlane as TemplateAcceptanceEvidencePlane,
  type AcceptanceBarContract as TemplateAcceptanceBarContract,
} from './agent-tools/plans/rubric-template';
import {
  collectRubricLossViolations,
  REPLICATION_DRILL_MARKER,
  type RubricLossAck,
} from './agent-tools/plans/rubric-loss-guard';
import { isConversationAuditRequiredValue } from './agent-tools/plans/plan-activation-gate';
import { assertCriterionCheckPathsResolve } from './rubrics-criterion-checks';
import { assertAcceptanceRubricCitationPathsResolve } from './rubrics-citation-checks';
import { assertRubricRatingVocabulary } from './rubric-rating-vocabulary';

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
import {
  withAcceptanceBarAmendmentTransaction,
  acceptanceBarAmendmentKey,
  synchronizeAcceptanceBarRevision,
  resolveAcceptanceBarApproval,
  type AcceptanceBarApproval,
  type AcceptanceBarAmendmentSql,
} from './acceptance-bar-amendment';
import {
  guardAcceptanceBarTemplateDataWrite,
  nextAcceptanceBarMeaningRevision,
} from './agent-tools/plans/rubric-loss-guard';
import type { SpecClauseRevision } from './agent-tools/plans/spec-clauses-store';
// `decision-body` (pure), NOT `add-decision` (the tool module): the tool reads
// `VALID_PLAN_SLUG` from `./source` at module scope, so importing it from a lib
// stranded every plans test that mocks `./source` with a bare factory
// (2026-09-05: arm-schedule / run-now / list.delta / shape-clip / launch.goal-stamp).
import { appendDecisionToBody, allocateNextDecisionId } from './agent-tools/plans/decision-body';
import { setFrontmatterScalar } from './agent-tools/plans/transfer-owner';
import { deriveIndexFromContent } from './agent-tools/plans/source';
import { writePlanIndexRows } from './agent-tools/plans/plan-index-rows';
import { summarizeForcedPast } from './agent-tools/plans/forced-past-stamp';
import { getPlanRevisionSnapshot, recordPlanRevision } from './agent-tools/plans/revisions';
import { hashPlanContent } from './agent-tools/plans/content-hash';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { areAcceptanceLineageRelated, resolvePlanImplementerIdentities } from './acceptance-author-identity';
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
import type { AcceptanceBarContractSnapshot, AcceptanceBarTrace } from './acceptance-bar-contract-snapshot';

export type RubricStatus = 'proposed' | 'active' | 'retired';
export const RUBRIC_STATUSES: readonly RubricStatus[] = ['proposed', 'active', 'retired'];

/** The default rating vocabulary shared by criteria that don't override it.
 *  Locked with the Overwatch scorecard + Scout digest consumers (interface contract). */
export const DEFAULT_RATING_SCALE: readonly string[] = ['healthy', 'degraded', 'broken', 'unknown'];

/** A criterion's grading class (EI-20581177540737568, P-008): 'violatable' = monotonic-
 *  downward — one violation falsifies it permanently, so a mid-run rating is provisional
 *  until the graded subject terminates. 'settle-once' (the omitted default) = settled
 *  permanently once its phase ends. */
export type CriterionClass = 'settle-once' | 'violatable';

/** Acceptance criteria distinguish the thing that must become true from a
 * disclosure ABOUT that thing. The distinction is structural so prose cannot
 * game coverage or substitute an accurate post-hoc report for the outcome. */
export type AcceptanceCriterionRole = 'outcome' | 'disclosure';
export type AcceptanceEvidencePlane = TemplateAcceptanceEvidencePlane;
export type AcceptanceBarContract = TemplateAcceptanceBarContract;

function isAcceptanceEvidencePlane(value: string): value is AcceptanceEvidencePlane {
  return value === 'tree' || value === 'deployed' || value === 'live';
}

/** When an acceptance BAR entered the subject plan's lifecycle. Historical rows
 * omit this; every post-adoption writer supplies it before the lifecycle gates
 * introduced by requirements-with-teeth-bar-before-method-2026-09-04 apply. */
export interface AcceptanceBarProvenance {
  lifecycle: 'pre-implementation' | 'legacy-backfilled';
  declaredAt: string;
  declaredBy: string;
}

/** One gradeable item within a rubric (the per-characteristic criterion). */
export interface RubricCriterion {
  /** Stable kebab id; a structured observation's ratings Record is keyed by this. */
  key: string;
  title: string;
  /** Original requirement metadata. Never reconstructed from the BAR on legacy reads. */
  intent?: RequirementIntent;
  /** Authoring aliases; normalized to existing canonical fields before persistence. */
  acceptance?: RequirementAcceptance;
  verification?: RequirementVerification;
  /** How this criterion is supposed to work (the MODEL). */
  model: string;
  /** Acceptance-kind only: clearer wire/UI alias of `model`. It is projected on
   * reads and accepted on writes, but is NEVER persisted as a second text field. */
  bar?: string;
  /** Acceptance-kind only: stable source identity (normally the originating R-N). */
  barKey?: string;
  /** Server-derived SHA-256 over the BAR's stable meaning. Caller values are ignored
   * and recomputed at the canonical rubric writer. */
  barHash?: string;
  /** Acceptance-kind only: outcome is gradeable truth; disclosure can only report it. */
  role?: AcceptanceCriterionRole;
  /** Whether this outcome is part of the non-waivable ship floor. */
  mandatory?: boolean;
  /** Stable scope tokens the BAR promises to cover (surfaces, cohorts, or subjects). */
  requiredScope?: string[];
  /** Structural evidence plane; tree proof cannot satisfy deployed/live promises. */
  evidencePlane?: AcceptanceEvidencePlane;
  requiredTestLayers?: string[];
  /** Ratings that satisfy this BAR. Empty/absent remains legacy/unbound. */
  passRatings?: string[];
  /** Disclosure-only mapping to the outcome BAR keys it reports on. */
  coversBarKeys?: string[];
  /** Predeclared versus explicitly post-implementation/backfilled provenance. */
  barProvenance?: AcceptanceBarProvenance;
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
  /** Grading class — see {@link CriterionClass}. Omitted = 'settle-once'. */
  criterionClass?: CriterionClass;
  /** The criterion's STRUCTURED CHECK (P-011 / owner-ratified D-006): kind:'tests'
   *  { files } = deterministic must-pass (paths validated at propose time, actually RUN
   *  by scorecards:emit at grading time); kind:'instrument' = the generalized instrument
   *  binding. Omitted = a fuzzy judgment criterion (unchanged default). */
  check?: RubricCriterionCheck;
}

export interface Rubric {
  rubricId: string;
  /** Current `harness_plans.version`; omitted for legacy/unversioned rows. */
  revision?: number;
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
  /** Subject plan identity; independent of the harness storing this rubric. */
  subjectHarnessSlug?: string;
  /** acceptance-kind only: the GOAL this rubric is the definition-of-done FOR — the
   *  goal-mode 'achieved' gate keys off it (consult-min-max-…-2026-08-17 D-004 §2).
   *  Exactly one of subjectPlan/subjectGoal on an acceptance rubric. */
  subjectGoal?: string | null;
  /** acceptance-kind only: the standard-kind CLASS rubric it builds on (plan D-006/D-009). */
  classRef?: string | null;
  /** Standard rubrics this rubric composes. Refs are intentionally unpinned: each
   * rubric resolves its current independent definition at grading time. */
  composes?: string[];
  /** Server-derived complete BAR-set identity and the cohort/revision pin that produced it. */
  barSetHash?: string;
  barContract?: AcceptanceBarContract;
  /** Umbrella domain, e.g. 'hive-coordination' — Scout's digest groups by this. */
  characteristic: string;
  title: string;
  description: string;
  criteria: RubricCriterion[];
  ratingScale: string[];
  /**
   * Stable hash over the fields that actually GRADE (characteristic, criteria,
   * ratingScale, methodRef, description). For an acceptance rubric that delegates
   * criteria to a standard class, the read path also folds in the class identity and
   * current class revision — the field to pin/compare to prove "the rubric's graded
   * substance did not change under my grade" (EI-21917124475387201).
   *
   * `harness_plans.content_hash` / `plan_revisions.content_hash` CANNOT answer that:
   * they hash only the plan's markdown prose body, and every rubric criterion lives in
   * `template_data` jsonb, which that hash never touches — so two revisions whose
   * criteria differ can share byte-identical content_hash (measured: seq 2/3/4 same
   * hash while criteria md5 changed). Compare THIS field across reads instead; it is
   * the same stableStringify+sha256 construction rubric-store.ts already uses for
   * first-party seed-drift detection (seedContentHash), computed fresh from the live
   * template_data on every read rather than a write-time-only stored value. Optional
   * only for the rare degraded/mocked read that cannot compute it; every real
   * planRowToRubric projection populates it.
   */
  criteriaHash?: string;
  /** agent-insights runbook slug holding the long-form METHOD (no prose duplication). */
  methodRef: string | null;
  /** This rubric GATES a release verdict (EI-12149) — the rubric-staleness watchdog
   *  alerts when an ACTIVE releaseGating rubric goes ungraded past its threshold. */
  releaseGating?: boolean;
  /** This rubric must keep being GRADED without gating a release (P-011). Watched by the
   *  same staleness watchdog, which selects `releaseGating || stalenessWatched`. Split
   *  from releaseGating because they answer different questions: a HEALTH rubric that had
   *  to claim release-gating to get watched would inherit the machine-instrument contract
   *  it does not need and block ships it should not — so it stayed unwatched instead, and
   *  a dead health loop became indistinguishable from a healthy one. */
  stalenessWatched?: boolean;
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
  version?: string | number | null;
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
 *  plan frontmatter status to author. proposed → draft (awaiting independent ratification),
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
export function planRowToRubric(row: RubricPlanRow, delegatedClassRevision?: number | null): Rubric | null {
  const parsed = rubricTemplateDataSchema.safeParse(row.template_data);
  if (!parsed.success) return null;
  const d = parsed.data;
  const kind = rubricKindOf(d);
  const updatedAt = tsIso(row.updated_at);
  const status = planStatusToRubricStatus(row.status, row.archived);
  const revision =
    row.version == null || (typeof row.version === 'string' && row.version.trim() === '')
      ? undefined
      : Number(row.version);
  return {
    rubricId: row.plan_slug,
    ...(revision !== undefined && Number.isFinite(revision) ? { revision } : {}),
    workspaceId: row.workspace_id,
    kind,
    ...(d.subjectPlan ? { subjectPlan: d.subjectPlan } : {}),
    ...(d.subjectHarnessSlug ? { subjectHarnessSlug: d.subjectHarnessSlug } : {}),
    ...(d.subjectGoal ? { subjectGoal: d.subjectGoal } : {}),
    ...(d.classRef ? { classRef: d.classRef } : {}),
    ...(d.composes ? { composes: d.composes } : {}),
    ...(d.barSetHash ? { barSetHash: d.barSetHash } : {}),
    ...(d.barContract ? { barContract: d.barContract } : {}),
    characteristic: d.characteristic,
    title: row.title ?? row.plan_slug,
    description: d.description ?? '',
    // Acceptance-kind criteria may omit model/method/driftMarkers (the light profile —
    // per-kind superRefine guarantees standard-kind criteria always carry them), so the
    // v1 required-string shape maps absent → '' rather than loosening every consumer.
    criteria: d.criteria.map((c) => {
      // The template schema is the persisted authority. Keep the cast local while
      // legacy rows omit every BAR field; a missing optional value projects absent.
      const barFields = c as typeof c & {
        barKey?: string;
        barHash?: string;
        role?: AcceptanceCriterionRole;
        mandatory?: boolean;
        requiredScope?: string[];
        evidencePlane?: AcceptanceEvidencePlane;
        passRatings?: string[];
        coversBarKeys?: string[];
        barProvenance?: AcceptanceBarProvenance;
      };
      const model = c.model ?? '';
      return {
        key: c.key,
        title: c.title,
        ...(c.intent ? { intent: c.intent } : {}),
        model,
        // `bar` is deliberately a projection, not template_data. `model` remains
        // the one canonical stored text field (D-001/D-003).
        ...(kind === 'acceptance' && model ? { bar: model } : {}),
        ...(barFields.barKey ? { barKey: barFields.barKey } : {}),
        ...(barFields.barHash ? { barHash: barFields.barHash } : {}),
        ...(barFields.role ? { role: barFields.role } : {}),
        ...(barFields.mandatory !== undefined ? { mandatory: barFields.mandatory } : {}),
        ...(barFields.requiredScope ? { requiredScope: barFields.requiredScope } : {}),
        ...(barFields.evidencePlane ? { evidencePlane: barFields.evidencePlane } : {}),
        ...(c.requiredTestLayers ? { requiredTestLayers: c.requiredTestLayers } : {}),
        ...(barFields.passRatings ? { passRatings: barFields.passRatings } : {}),
        ...(barFields.coversBarKeys ? { coversBarKeys: barFields.coversBarKeys } : {}),
        ...(barFields.barProvenance ? { barProvenance: barFields.barProvenance } : {}),
        method: c.method ?? '',
        driftMarkers: c.driftMarkers ?? '',
        ...(c.ratingScale ? { ratingScale: c.ratingScale } : {}),
        ...(c.replication ? { replication: c.replication } : {}),
        ...(c.instrumentKey ? { instrumentKey: c.instrumentKey } : {}),
        ...(c.window ? { window: c.window } : {}),
        ...(c.criterionClass ? { criterionClass: c.criterionClass } : {}),
        ...(c.check ? { check: c.check } : {}),
      };
    }),
    ratingScale: d.ratingScale,
    criteriaHash: computeRubricCriteriaHash(d, delegatedClassRevision),
    methodRef: d.methodRef ?? null,
    ...(d.releaseGating !== undefined ? { releaseGating: d.releaseGating } : {}),
    ...(d.stalenessWatched !== undefined ? { stalenessWatched: d.stalenessWatched } : {}),
    ...(typeof d.historyResetAt === 'string' ? { historyResetAt: d.historyResetAt } : {}),
    status,
    createdBy: row.owner ?? null,
    proposedBy: d.proposedBy ?? row.owner ?? null,
    // Acceptance rubrics activate on propose and are never ratified, so their
    // projection must not inherit the standard-rubric legacy owner fallback.
    ratifiedBy: status === 'active' && kind === 'standard' ? (d.ratifiedBy ?? row.owner ?? null) : null,
    createdAt: row.created ?? updatedAt,
    updatedAt,
  };
}

type ParsedRubricTemplateData = ReturnType<typeof rubricTemplateDataSchema.parse>;

/**
 * Keep the grading hash construction in one place so current reads and the
 * write-time revision snapshot record exactly the same identity. The delegated
 * class revision is intentionally optional: a failed class lookup preserves the
 * pre-existing degraded-read behavior, while a successful lookup pins the class
 * revision into the hash.
 */
function computeRubricCriteriaHash(
  templateData: ParsedRubricTemplateData,
  delegatedClassRevision?: number | null,
): string {
  return computeSeedContentHash({
    ...templateData,
    ...(templateData.classRef ? { delegatedClassRef: templateData.classRef } : {}),
    ...(templateData.classRef && delegatedClassRevision !== undefined ? { delegatedClassRevision } : {}),
  });
}

const RUBRIC_REVISION_SNAPSHOT_HEADING = '## Structured rubric data (`template_data`)';
const RUBRIC_REVISION_SNAPSHOT_SCHEMA_VERSION = 2;

interface ParsedRubricRevisionSnapshot {
  templateData: unknown;
  /** Hash captured when the revision was written; absent on legacy snapshots. */
  criteriaHash?: string | null;
  schemaVersion?: number;
}

/**
 * Parse the enriched revision envelope, while retaining compatibility with the
 * original raw-template-data snapshots. The latter can still be read, but their
 * criteriaHash necessarily follows the current hash algorithm because no
 * write-time hash was persisted.
 */
function parseRubricRevisionSnapshot(snapshot: string): ParsedRubricRevisionSnapshot | null {
  const marker = snapshot.lastIndexOf(RUBRIC_REVISION_SNAPSHOT_HEADING);
  if (marker < 0) return null;
  const fenced = snapshot
    .slice(marker + RUBRIC_REVISION_SNAPSHOT_HEADING.length)
    .match(/~~~json\s*\n([\s\S]*?)\n~~~/);
  if (!fenced) return null;
  try {
    const parsed: unknown = JSON.parse(fenced[1]);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'schemaVersion' in parsed &&
      parsed.schemaVersion === RUBRIC_REVISION_SNAPSHOT_SCHEMA_VERSION &&
      'templateData' in parsed
    ) {
      const envelope = parsed as {
        schemaVersion: number;
        templateData: unknown;
        criteriaHash?: unknown;
      };
      return {
        schemaVersion: envelope.schemaVersion,
        templateData: envelope.templateData,
        criteriaHash: typeof envelope.criteriaHash === 'string' ? envelope.criteriaHash : null,
      };
    }
    // Legacy revisions stored template_data directly under the fence.
    return { templateData: parsed };
  } catch {
    return null;
  }
}

/**
 * Recover the structured rubric document appended by rubricRevisionSnapshot.
 * Historical reads fail closed when a legacy/backfilled revision has no
 * structured snapshot; they must never silently grade the current template_data.
 */
export function parseRubricRevisionTemplateData(snapshot: string): unknown | null {
  return parseRubricRevisionSnapshot(snapshot)?.templateData ?? null;
}

/**
 * Map rubric plan rows while hydrating the CURRENT revision of any delegated standard
 * class. `planRowToRubric` remains a synchronous, PG-free projection for unit tests and
 * callers that already have a row; database-backed reads use this helper so an
 * acceptance rubric's criteriaHash changes when its class rubric is revised.
 */
async function mapRubricPlanRows(rows: RubricPlanRow[]): Promise<Rubric[]> {
  const mapped = rows.map((row) => planRowToRubric(row));
  const classRefs = [
    ...new Set(
      mapped
        .filter((rubric): rubric is Rubric => rubric !== null && Boolean(rubric.classRef))
        .map((rubric) => rubric.classRef as string),
    ),
  ];
  if (classRefs.length === 0) {
    return mapped.filter((rubric): rubric is Rubric => rubric !== null);
  }

  try {
    const { sql } = getOrgPg();
    const classRows = await sql<{ plan_slug: string; version: string | number | null }[]>`
      SELECT plan_slug, version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND (template_data->>'kind' IS DISTINCT FROM 'acceptance')
         AND plan_slug = ANY(${sql.array(classRefs)}::text[])`;
    const revisions = new Map<string, number | null>();
    for (const row of classRows) {
      if (row.version == null) {
        revisions.set(row.plan_slug, null);
        continue;
      }
      const revision = Number(row.version);
      revisions.set(row.plan_slug, Number.isFinite(revision) ? revision : null);
    }

    return rows
      .map((row, index) => {
        const rubric = mapped[index];
        if (!rubric?.classRef) return rubric;
        // A missing class row is still represented as null revision so the class
        // identity participates in the hash; a query failure falls through to the
        // original hash below rather than pretending the revision was observed.
        return planRowToRubric(row, revisions.get(rubric.classRef) ?? null);
      })
      .filter((rubric): rubric is Rubric => rubric !== null);
  } catch {
    return mapped.filter((rubric): rubric is Rubric => rubric !== null);
  }
}

/** active → proposed → retired, then most-recently-updated first (the v1 SQL order). */
const RUBRIC_STATUS_ORDER: Record<RubricStatus, number> = { active: 0, proposed: 1, retired: 2 };
function sortRubrics(rubrics: Rubric[]): Rubric[] {
  return rubrics.sort(
    (a, b) => RUBRIC_STATUS_ORDER[a.status] - RUBRIC_STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt),
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
             version, owner, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND ${kindCond}
       LIMIT 500`;
    return (await mapRubricPlanRows(rows)).filter((r) => kind === 'any' || r.kind === kind);
  } catch (error) {
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
function buildSeedProposeInput(r: LocalRubric, upgrading: Rubric | null): ProposeRubricInput {
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
    ...(upgrading?.stalenessWatched !== undefined ? { stalenessWatched: upgrading.stalenessWatched } : {}),
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
  const ok = await runRubricSeedPass();
  rubricSeedState = ok ? 'done' : 'pending';
}

/**
 * Re-run the seed pass AFTER a Cupboard `kind='rubric'` install dropped a new
 * self-describing dir into the writable user layer
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-004).
 *
 * WHY THIS EXISTS (and why calling ensureFirstPartyRubricsSeeded would not work):
 * that function is once-per-process by design — after the first read of the session
 * its state is 'done' and it returns IMMEDIATELY. An installer calling it would
 * therefore be a silent no-op: the dir would sit correctly in the user layer, the
 * install would report success, and the rubric would never become a live row. It
 * would appear to work and simply not.
 *
 * This runs the SAME pass (no forked seeding logic), so every guarantee the seed
 * makes is inherited unchanged: idempotent, no-clobber (any rubricId under a real
 * owner always wins, so an install can never overwrite a locally-ratified rubric),
 * the WI-3617 wedge reclaim, the EI-12932 seedContentHash upgrade gate, and the
 * WI-4287 loss-guards. `rubricSeedState` is held at 'running' across the pass to
 * keep the re-entrancy short-circuit (the pass's own writes read back through
 * loadAllRubrics), and re-armed to 'pending' on failure so a later read retries —
 * identical to the once-path's own failure handling.
 *
 * Never throws: an install that landed the dir but could not seed is reported by the
 * caller as installed-but-not-yet-live, not as a failed install.
 */
export async function reseedRubricsAfterInstall(): Promise<void> {
  rubricSeedState = 'running';
  const ok = await runRubricSeedPass();
  rubricSeedState = ok ? 'done' : 'pending';
}

/** The seed pass itself, WITHOUT the once-per-process guard — shared by the lazy
 *  boot path and the post-install re-seed. Returns whether the pass fully
 *  succeeded; never throws. */
async function runRubricSeedPass(): Promise<boolean> {
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
  return ok;
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
  /**
   * Filter to the acceptance rubric(s) whose subjectPlan equals this plan slug
   * (EI-22084090899431625 — a recurring tool-call failure: many agent sessions
   * independently guessed `subjectPlan`/`plan`/`harness`/`ref` as a way to scope
   * rubrics:list to "the acceptance rubric for the plan I'm working on", which the
   * tool had no way to express even though every Rubric row already carries
   * `subjectPlan`). Only meaningful when `kind` is 'acceptance' or 'any' — standard
   * rubrics never carry a subjectPlan, so this is a no-op filter against them.
   */
  subjectPlan?: string;
}

/** List rubrics (active first, then proposed, then retired), optionally filtered by
 *  status / characteristic / subjectPlan. Reads rubric-template plans (P-006/P-007).
 *  Standard-kind only unless `kind` opts in (see ListRubricsFilter.kind). */
export async function listRubrics(filter: ListRubricsFilter = {}): Promise<Rubric[]> {
  let rubrics = await loadAllRubrics(filter.kind ?? 'standard');
  if (filter.status) rubrics = rubrics.filter((r) => r.status === filter.status);
  if (filter.characteristic) rubrics = rubrics.filter((r) => r.characteristic === filter.characteristic);
  if (filter.subjectPlan) rubrics = rubrics.filter((r) => r.subjectPlan === filter.subjectPlan);
  return sortRubrics(rubrics).slice(0, Math.min(filter.limit ?? 100, 500));
}

/**
 * The rubric-rubric (consult-min-max-and-rubric-vetting-2026-08-17 P-003): the
 * standard-kind rubric an acceptance rubric is vetted AGAINST before the work it
 * gates is graded. The acceptance gate's vetting check (P-004) keys off this id;
 * the rubric itself is registered via rubrics:propose and owner-ratified.
 */
export const META_ACCEPTANCE_RUBRIC_ID = 'meta-acceptance-rubric';

/**
 * The outcome of reading a rubric's revision, with "could not determine" kept
 * DISTINCT from "there is no revision".
 *
 * EI-21827040531672903: the module-wide never-throw read convention is right for a
 * caller that checks the value, and a security hole for a caller that writes
 * `revision == null || <the real check>` — there, the null from a transient DB
 * error short-circuits the guard to TRUE and silently degrades it to no guard at
 * all, rendering no refusal so nothing records the skip. `ok:false` is the signal
 * such a caller needs to refuse instead of fail open; `ok:true, revision:null` is
 * the genuinely-unversioned rubric, which is not an error.
 */
export type RubricPlanRevisionRead = { ok: true; revision: number | null } | { ok: false; revision: null };

/**
 * The rubric plan row's `version` — the revision spine the vetting attestation pins
 * (consult-min-max-and-rubric-vetting-2026-08-17 P-004). Bumps on EVERY propose
 * (typo and rewrite alike — deliberately strict: any content change after vetting
 * voids the attestation, because only re-reading the rubric can say whether the
 * change was material).
 *
 * Never throws, matching every other read in this module — but unlike the plain
 * `getRubricPlanRevision` wrapper below, a FAILED read is reported as `ok:false`
 * rather than flattened into the same null a missing/unversioned row produces.
 * Prefer this whenever the null would otherwise be treated as "no constraint".
 */
export async function readRubricPlanRevision(rubricId: string): Promise<RubricPlanRevisionRead> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ plan_slug: string; version: string | number | null }[]>`
      SELECT plan_slug, version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND plan_slug = ${rubricId}
       LIMIT 1`;
    // Client-side slug guard, mirroring getRubric: identical behavior under
    // mocked-sql fixtures that return the full row set for any query.
    const row = rows.find((r) => r.plan_slug === rubricId);
    if (!row || row.version == null) return { ok: true, revision: null };
    const version = Number(row.version); // bigint arrives as a string
    return { ok: true, revision: Number.isFinite(version) ? version : null };
  } catch {
    return { ok: false, revision: null };
  }
}

/**
 * The revision as a bare value: null when the row is missing, unversioned, OR the
 * read failed. Retained unchanged for the many callers that legitimately treat all
 * three alike; a caller that must not fail open wants `readRubricPlanRevision`.
 */
export async function getRubricPlanRevision(rubricId: string): Promise<number | null> {
  return (await readRubricPlanRevision(rubricId)).revision;
}

/**
 * Resolve one rubric against an immutable historical plan revision. The current
 * plan row supplies identity/lifecycle metadata, while the selected revision's
 * enriched snapshot supplies the grading contract. Missing or malformed history
 * returns null rather than falling back to the current rubric.
 */
async function getRubricAtRevision(rubricId: string, revision: number): Promise<Rubric | null> {
  if (!Number.isInteger(revision) || revision <= 0) return null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<RubricPlanRow[]>`
      SELECT plan_slug, workspace_id, harness_slug, title, status, created, updated, updated_at,
             version, owner, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND plan_slug = ${rubricId}
       LIMIT 1`;
    const row = rows.find((candidate) => candidate.plan_slug === rubricId);
    if (!row) return null;

    const snapshot = await getPlanRevisionSnapshot(rubricId, revision, {
      workspaceId: row.workspace_id,
      harnessSlug: row.harness_slug,
    });
    if (!snapshot) return null;
    const parsedSnapshot = parseRubricRevisionSnapshot(snapshot.contentSnapshot);
    const parsed = rubricTemplateDataSchema.safeParse(parsedSnapshot?.templateData);
    if (!parsed.success) return null;

    // Preserve current plan-row metadata (title/status/ownership/lifecycle) but
    // replace both the revision and the structured grading data with the exact
    // historical snapshot. mapRubricPlanRows also preserves the existing
    // delegated-class hash semantics.
    const historical =
      (await mapRubricPlanRows([
        {
          ...row,
          version: revision,
          template_data: parsed.data,
        },
      ]))[0] ?? null;
    if (!historical) return null;
    // New snapshots pin the hash produced at write time. This prevents a later
    // hash-algorithm change or delegated-class revision from rewriting history
    // when an old attestation is re-verified. Legacy raw snapshots intentionally
    // retain the best-effort current-hash fallback above.
    return typeof parsedSnapshot?.criteriaHash === 'string' && parsedSnapshot.criteriaHash.length > 0
      ? { ...historical, criteriaHash: parsedSnapshot.criteriaHash }
      : historical;
  } catch {
    return null;
  }
}

/** Fetch one rubric in full by its slug id — ANY kind: an explicit id is an explicit
 *  opt-in, so the shared grading path resolves acceptance rubrics through the same seam
 *  standards use (plan D-010). Returns null when no rubric carries that id. */
export async function getRubric(rubricId: string, revision?: number): Promise<Rubric | null> {
  if (revision !== undefined) return getRubricAtRevision(rubricId, revision);
  const std = (await loadAllRubrics()).find((r) => r.rubricId === rubricId);
  if (std) return std;
  // Not in the standard library — a direct id-addressed lookup of any kind (acceptance
  // rubrics are hidden from the library scan, never from an explicit id).
  try {
    const { sql } = getOrgPg();
    const rows = await sql<RubricPlanRow[]>`
      SELECT plan_slug, workspace_id, harness_slug, title, status, created, updated, updated_at,
             version, owner, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND plan_slug = ${rubricId}
       LIMIT 1`;
    // Client-side slug guard: keeps behavior identical under mocked-sql test fixtures
    // that return the full row set for any query.
    const row = rows.find((r) => r.plan_slug === rubricId);
    if (!row) return null;
    return (await mapRubricPlanRows([row]))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The rubric's `criteriaHash` (WI-1393208) — a stable hash over {characteristic,
 * criteria, ratingScale, methodRef, description}, plus a delegated class identity and
 * current class revision for class-only acceptance rubrics, computed fresh on every
 * rubric read (see {@link Rubric.criteriaHash}'s doc comment: "the field to pin/compare
 * to prove the rubric's graded substance did not change under my grade"). Never
 * throws; null when the rubric is missing, the read failed, or the rare degraded
 * read could not compute a hash. Fail-open, mirroring `getRubricPlanRevision`'s
 * contract — a caller that must distinguish "not found" from "hash absent"
 * should read the full `Rubric` via `getRubric` directly.
 */
export async function getRubricCriteriaHash(rubricId: string): Promise<string | null> {
  const rubric = await getRubric(rubricId);
  return rubric?.criteriaHash ?? null;
}

/**
 * Read every LIVE acceptance rubric FOR a plan (acceptance-rubrics-on-every-plan-
 * 2026-08-11). A plan may have at most one active/ready, unarchived acceptance rubric;
 * returning all rows lets callers fail closed when old data or a concurrent write has
 * violated that invariant. The client-side mapping/filter remains intentional: mocked
 * SQL fixtures often return a wider row set than the query predicates describe.
 * By default reads degrade to an empty result, matching the other rubric reads.
 * Enforcement/preflight callers use strict:true to distinguish an unavailable
 * policy store from a successfully read empty set.
 */
export async function getAcceptanceRubricsForPlan(
  planSlug: string,
  options: { limit?: number; strict?: boolean; harnessSlug?: string } = {},
): Promise<Rubric[]> {
  try {
    const { sql } = getOrgPg();
    const limit = options.limit == null ? null : Math.min(Math.max(Math.trunc(options.limit), 1), 500);
    // Rubrics may live in the operator harness. Their storage key is NOT the
    // subject's key. Legacy metadata is usable only when the subject resolves
    // uniquely to the requested harness; never guess from the rubric's location.
    const subjectScope = options.harnessSlug == null ? sql`TRUE` : sql`(
      template_data->>'subjectHarnessSlug' = ${options.harnessSlug}
      OR (template_data->>'subjectHarnessSlug' IS NULL AND (
        SELECT count(*) = 1 AND bool_and(subject.harness_slug = ${options.harnessSlug})
          FROM harness_shared.harness_plans AS subject
         WHERE subject.workspace_id = ${rubricsScopeWorkspace()}
           AND subject.plan_slug = ${planSlug}
      ))
    )`;
    const rows = await sql<RubricPlanRow[]>`
      SELECT plan_slug, workspace_id, harness_slug, title, status, created, updated, updated_at,
             version, owner, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND archived = false
         AND status IN ('active', 'ready')
         AND template_data->>'kind' = 'acceptance'
         AND template_data->>'subjectPlan' = ${planSlug}
         AND ${subjectScope}
       ORDER BY updated_at DESC NULLS LAST, plan_slug ASC
       ${limit == null ? sql`` : sql`LIMIT ${limit}`}`;
    return (await mapRubricPlanRows(rows)).filter((r) => r.kind === 'acceptance' && r.subjectPlan === planSlug &&
      (!options.harnessSlug || !r.subjectHarnessSlug || r.subjectHarnessSlug === options.harnessSlug));
  } catch (error) {
    if (options.strict) throw error;
    return [];
  }
}

/**
 * Nullable singleton view of the subject's acceptance rubric. Preserve the resolved
 * subject harness through this convenience reader; multiple live contracts are
 * ambiguous, never permission to select whichever one happens to be newest.
 */
export async function getAcceptanceRubricForPlan(
  planSlug: string,
  options: { harnessSlug?: string } = {},
): Promise<Rubric | null> {
  const rubrics = await getAcceptanceRubricsForPlan(planSlug, options);
  return rubrics.length === 1 ? rubrics[0] : null;
}

/**
 * The RETIRED acceptance rubric(s) FOR a plan — the historical validation record
 * (EI-22078741539479611). An acceptance rubric retires WITH its shipped subject plan
 * (retireAcceptanceRubricForPlan flips it to `superseded`), so on a shipped plan the
 * live read above finds nothing and a reader that stops there concludes the plan was
 * never validated. This is the read that tells it otherwise: newest first, so `[0]` is
 * the rubric the ship was actually judged against. Never throws — degrades to `[]`.
 *
 * Deliberately NOT folded into getAcceptanceRubricsForPlan: that read backs the
 * completion gate, which must see only LIVE contracts (a retired one must never
 * satisfy a ship). This one backs the post-ship explanation.
 */
export async function getRetiredAcceptanceRubricsForPlan(
  planSlug: string,
  options: { harnessSlug?: string } = {},
): Promise<Rubric[]> {
  try {
    const { sql } = getOrgPg();
    const subjectScope = options.harnessSlug == null ? sql`TRUE` : sql`(
      template_data->>'subjectHarnessSlug' = ${options.harnessSlug}
      OR (template_data->>'subjectHarnessSlug' IS NULL AND (
        SELECT count(*) = 1 AND bool_and(subject.harness_slug = ${options.harnessSlug})
          FROM harness_shared.harness_plans AS subject
         WHERE subject.workspace_id = ${rubricsScopeWorkspace()}
           AND subject.plan_slug = ${planSlug}
      ))
    )`;
    const rows = await sql<RubricPlanRow[]>`
      SELECT plan_slug, workspace_id, harness_slug, title, status, created, updated, updated_at,
             version, owner, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND template_data->>'kind' = 'acceptance'
         AND template_data->>'subjectPlan' = ${planSlug}
         AND (archived = true OR status IN ('superseded', 'shipped'))
         AND ${subjectScope}
       ORDER BY updated_at DESC NULLS LAST, plan_slug ASC
       LIMIT 5`;
    return (await mapRubricPlanRows(rows)).filter(
      (r) => r.kind === 'acceptance' && r.subjectPlan === planSlug && r.status === 'retired' &&
        (!options.harnessSlug || !r.subjectHarnessSlug || r.subjectHarnessSlug === options.harnessSlug),
    );
  } catch {
    return [];
  }
}

/**
 * The acceptance rubric FOR a goal (consult-min-max-and-rubric-vetting-2026-08-17
 * P-009 / D-004 §2): the most recently updated valid acceptance-kind rubric whose
 * subjectGoal names `goalId`. The read behind the goal-mode 'achieved' gate — the
 * subjectGoal twin of getAcceptanceRubricForPlan above. Never throws.
 */
export async function getAcceptanceRubricForGoal(goalId: string): Promise<Rubric | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<RubricPlanRow[]>`
      SELECT plan_slug, workspace_id, harness_slug, title, status, created, updated, updated_at,
             version, owner, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
         AND template_data->>'kind' = 'acceptance'
         AND template_data->>'subjectGoal' = ${goalId}
       ORDER BY updated_at DESC
       LIMIT 5`;
    const mapped = (await mapRubricPlanRows(rows)).filter((r) => r.kind === 'acceptance' && r.subjectGoal === goalId);
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
export async function searchRubrics(query: string, limit = 50, kind: RubricKindFilter = 'standard'): Promise<Rubric[]> {
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

type AcceptanceBarHashInput = Pick<
  ProposeRubricCriterion,
  | 'key'
  | 'intent'
  | 'model'
  | 'bar'
  | 'barKey'
  | 'driftMarkers'
  | 'requiredScope'
  | 'evidencePlane'
  | 'requiredTestLayers'
  | 'role'
  | 'mandatory'
  | 'passRatings'
  | 'coversBarKeys'
>;

function normalizedBarText(value: string | undefined): string {
  return (value ?? '').replace(/\r\n?/g, '\n').trim();
}

function normalizedBarSet(values: readonly string[] | undefined, lowerCase = false): string[] {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (lowerCase ? value.toLowerCase() : value)),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

/**
 * Stable BAR fingerprint. An ordered tuple avoids object-key-order drift, while
 * set-like fields are deduplicated/sorted before hashing. Provenance is deliberately
 * excluded: it says WHEN the same promise entered the lifecycle, not WHAT it promises.
 */
export function computeAcceptanceBarHash(criterion: AcceptanceBarHashInput): string {
  const canonicalBar = normalizedBarText(criterion.model) || normalizedBarText(criterion.bar);
  if (!canonicalBar) {
    throw new Error(
      `invalid_args: acceptance criterion '${criterion.key}' cannot derive barHash without canonical model/bar text`,
    );
  }
  const key = criterion.key.trim();
  const material = [
    ['criterionKey', key],
    ...(criterion.intent
      ? [
          [
            'intent',
            {
              request: normalizedBarText(criterion.intent.request),
              constraints: normalizedBarSet(criterion.intent.constraints),
              rationale: normalizedBarText(criterion.intent.rationale),
              sourceRefs: normalizedBarSet(criterion.intent.sourceRefs),
            },
          ],
        ]
      : []),
    ['barKey', criterion.barKey?.trim() || key],
    ['bar', canonicalBar],
    ['falsifier', normalizedBarText(criterion.driftMarkers)],
    ['requiredScope', normalizedBarSet(criterion.requiredScope)],
    ...(criterion.evidencePlane ? ([['evidencePlane', criterion.evidencePlane]] as const) : []),
    ...(criterion.requiredTestLayers
      ? [['requiredTestLayers', normalizedBarSet(criterion.requiredTestLayers, true)]]
      : []),
    ['role', criterion.role ?? null],
    ['mandatory', criterion.mandatory ?? false],
    ['passRatings', normalizedBarSet(criterion.passRatings, true)],
    ['coversBarKeys', normalizedBarSet(criterion.coversBarKeys)],
  ] as const;
  return hashPlanContent(JSON.stringify(material));
}

/** Exact complete-set identity. Order-independent, duplicate-key refusing, and
 * deliberately composed only from each criterion's stable BAR identity/hash. */
export function computeAcceptanceBarSetHash(
  criteria: ReadonlyArray<Pick<ProposeRubricCriterion, 'key' | 'barKey' | 'barHash'>>,
): string {
  if (criteria.length === 0) {
    throw new Error('invalid_args: cannot derive barSetHash from an empty BAR set');
  }
  const pairs = criteria.map((criterion) => {
    const barKey = criterion.barKey?.trim() || criterion.key.trim();
    const barHash = criterion.barHash?.trim() ?? '';
    if (!barKey || !/^[a-f0-9]{64}$/.test(barHash)) {
      throw new Error(`invalid_args: BAR '${barKey || criterion.key}' lacks a valid server-derived barHash`);
    }
    return [barKey, barHash] as const;
  });
  const keys = pairs.map(([key]) => key);
  if (new Set(keys).size !== keys.length) {
    throw new Error('invalid_args: duplicate barKey values cannot form a complete barSetHash');
  }
  pairs.sort(([a], [b]) => a.localeCompare(b));
  return hashPlanContent(JSON.stringify(pairs));
}

/**
 * Canonicalize one acceptance BAR at the central writer. `bar` is only an alias:
 * it is removed before persistence, and a mismatching model+bar pair is refused.
 * Caller-supplied barHash is discarded and recomputed from normalized meaning.
 */
export function normalizeAcceptanceBarCriterion(criterion: ProposeRubricCriterion): ProposeRubricCriterion {
  criterion = normalizeRequirementSections(criterion);
  const carriesBarContract =
    criterion.intent !== undefined ||
    criterion.bar !== undefined ||
    criterion.barHash !== undefined ||
    criterion.barKey !== undefined ||
    criterion.role !== undefined ||
    criterion.mandatory !== undefined ||
    criterion.requiredScope !== undefined ||
    criterion.evidencePlane !== undefined ||
    criterion.requiredTestLayers !== undefined ||
    criterion.passRatings !== undefined ||
    criterion.coversBarKeys !== undefined ||
    criterion.barProvenance !== undefined;
  // A model-only acceptance criterion predates the BAR contract. Preserve it
  // byte-for-byte until migration explicitly marks its cohort/provenance; merely
  // re-proposing a legacy rubric must not pretend its bar was predeclared.
  if (!carriesBarContract) return criterion;

  const model = normalizedBarText(criterion.model);
  const alias = normalizedBarText(criterion.bar);
  if (model && alias && model !== alias) {
    throw new Error(
      `invalid_args: acceptance criterion '${criterion.key}' supplied conflicting model and bar text; ` +
        '`model` is canonical, so omit bar or make the alias byte-equivalent after trimming',
    );
  }

  const { bar: _wireAlias, barHash: _callerHash, ...rest } = criterion;
  const normalized: ProposeRubricCriterion = {
    ...rest,
    ...(model || alias ? { model: model || alias } : {}),
    ...(criterion.barKey?.trim() ? { barKey: criterion.barKey.trim() } : {}),
    ...(criterion.requiredScope ? { requiredScope: normalizedBarSet(criterion.requiredScope) } : {}),
    ...(criterion.requiredTestLayers
      ? { requiredTestLayers: normalizedBarSet(criterion.requiredTestLayers, true) }
      : {}),
    ...(criterion.passRatings ? { passRatings: normalizedBarSet(criterion.passRatings, true) } : {}),
    ...(criterion.coversBarKeys ? { coversBarKeys: normalizedBarSet(criterion.coversBarKeys) } : {}),
  };
  if (!normalized.model) return normalized;
  return { ...normalized, barHash: computeAcceptanceBarHash(normalized) };
}

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
  /** Optional assertion; derived from the unique subject when omitted. */
  subjectHarnessSlug?: string;
  /** acceptance-kind only: the GOAL id this rubric is the definition-of-done FOR (validated to
   *  EXIST — the goal-mode 'achieved' gate keys off it). Exactly one of subjectPlan/subjectGoal. */
  subjectGoal?: string;
  /** acceptance-kind only: the standard-kind class rubric it builds on (validated to exist). */
  classRef?: string;
  /** Unpinned standard-rubric composition refs; each rubric evolves independently. */
  composes?: string[];
  /** Internal/server-owned BAR-set pin. Agent-facing propose schemas do not expose it. */
  barSetHash?: string;
  /** Internal/server-owned cohort/subject-revision pin. */
  barContract?: AcceptanceBarContract;
  characteristic: string;
  title: string;
  description?: string;
  criteria: ProposeRubricCriterion[];
  ratingScale?: string[];
  methodRef?: string;
  /** Mark this rubric release-gating (EI-12149) — the staleness watchdog then alerts
   *  when it goes ungraded past its threshold while active. */
  releaseGating?: boolean;
  /** Mark this rubric staleness-watched WITHOUT making it a release gate (P-011) — for an
   *  ongoing HEALTH rubric that must keep being graded but must not block a ship. */
  stalenessWatched?: boolean;
  /** Contract-generation boundary (D-015) — see Rubric.historyResetAt. Normally set via
   *  setRubricHistoryReset() rather than here, because a propose demotes to 'proposed'. */
  historyResetAt?: string;
  /** Who is proposing (ownerId). Recorded as the plan owner. */
  by?: string;
  /**
   * Lifecycle status to write. Defaults to 'proposed' (the rubrics:propose tool path,
   * D-001: agents propose, an independent reviewer ratifies). Seed/test paths may pass 'active' to
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
   * P-008 loss-guard ack: allow a stored 'violatable' criterion to be resubmitted as
   * settle-once (or with the class dropped). A silent downgrade removes the criterion's
   * provisional-until-terminal protection — the exact machinery EI-20581177540737568
   * added — so it must be a conscious, explained edit. Non-empty string = ack + reason.
   */
  classDowngradeReason?: string;
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
  /**
   * P-011 (D-006): the workspace root kind:'tests' structured-check file paths resolve
   * against at propose time. The MCP tool passes its ctx-resolved root
   * (resolveAgentWorkspaceRoot) so a harness-scoped propose validates against the tree
   * the AGENT edits; omitted ⇒ the same resolver's ctx-less fallback
   * (PAPERCUSP_INTEGRATION_ROOT → cwd). Irrelevant when no criterion carries a
   * tests-check.
   */
  checkPathRoot?: string;
}

/** One explicit, deterministic upgrade made when a legacy acceptance Rubric
 * projection is copied into a new authoring write. This metadata is recorded in
 * the plan-revision rationale so a successor never looks byte-identical when it
 * actually received a schema-compatibility upgrade. */
export interface RubricCompatibilityUpgrade {
  field: string;
  action: 'omit-empty' | 'supply-falsifier' | 'append-unknown-equivalent';
  reason: string;
  value?: string;
}

export interface RubricCompatibilityAudit {
  source: 'legacy-acceptance-read-projection';
  upgrades: RubricCompatibilityUpgrade[];
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

// EI-21972673091438558: the RULE CORE now lives at the shared template_data persistence
// boundary (agent-tools/plans/rubric-loss-guard.ts) so `plans:set-template-data` — the
// generic structured-write door, which validates STRUCTURE only — cannot silently delete
// the criteria this guard exists to protect. Re-exported here because this module is the
// long-standing import site for them; there is ONE definition, not two dialects of "loss".
export {
  REPLICATION_DRILL_MARKER,
  METHOD_SHRINK_GUARD_RATIO,
  METHOD_SHRINK_GUARD_MIN_CHARS,
  criterionProcedureText,
} from './agent-tools/plans/rubric-loss-guard';

/**
 * The caller's loss acknowledgements, lifted off a propose input into the shape the
 * shared rule core and the persistence boundary both take. ONE reader of these four
 * fields, so the pre-write check and the in-lock check can never disagree about what
 * the caller acknowledged.
 */
function rubricLossAckOf(input: ProposeRubricInput): RubricLossAck {
  return {
    ...(input.dropKeys ? { dropKeys: input.dropKeys } : {}),
    ...(input.allowMethodShrink !== undefined ? { allowMethodShrink: input.allowMethodShrink } : {}),
    ...(input.shrinkReason !== undefined ? { shrinkReason: input.shrinkReason } : {}),
    ...(input.classDowngradeReason !== undefined ? { classDowngradeReason: input.classDowngradeReason } : {}),
  };
}

/**
 * PURE: the WI-4287 loss-guard. Compares a propose input against the STORED rubric and
 * THROWS a teaching error naming exactly what would be silently lost:
 *   • a stored criterion key absent from the proposal → requires a `dropKeys` ack;
 *   • a surviving criterion whose method+replication text shrinks >40% (stored ≥200
 *     chars) or loses its REPLICATION DRILL marker → requires `allowMethodShrink:true`
 *     + a non-empty `shrinkReason`.
 * `stored === null` (a brand-new rubric) and an identical re-propose both pass.
 *
 * EI-21972673091438558: the RULES now live in rubric-loss-guard.ts and are enforced
 * again inside the write lock, at the template_data persistence boundary every door
 * crosses. This function stays the propose path's EARLY, richer-worded rejection —
 * it fails before any lock is taken and names the rubric — but it is no longer the
 * only thing standing between a caller and a silently gutted rubric.
 */
export function assertNoSilentRubricLoss(stored: Rubric | null, input: ProposeRubricInput): void {
  if (!stored) return;

  const violations = collectRubricLossViolations(stored.criteria, input.criteria, rubricLossAckOf(input));

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

/** Backward-compatible instrument binding: the structured check first (P-011 / D-006 —
 *  the generalized slot), then the criterion-level field, then the legacy model token. */
export function effectiveCriterionInstrumentKey(criterion: {
  model?: string;
  instrumentKey?: string;
  check?: RubricCriterionCheck;
}): string | null {
  if (criterion.check?.kind === 'instrument' && criterion.check.instrumentKey.trim()) {
    return criterion.check.instrumentKey.trim();
  }
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
  const duplicateInstrumentKeys = [
    ...new Set(
      Object.values(bindings)
        .filter((key): key is string => Boolean(key) && key !== 'none')
        .filter((key) => (seen.has(key) ? true : (seen.add(key), false))),
    ),
  ];
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

/**
 * Acceptance criteria use a light profile where model/method/driftMarkers are optional.
 * The legacy `Rubric` projection maps omitted fields to empty strings to preserve its
 * required-string shape, so a read → re-propose round-trip can hand those empty strings
 * back here. Normalize only that projection artifact and record every upgrade. A blank
 * drift marker needs a schema-valid replacement because the current authoring profile
 * requires a concrete falsifier; the replacement is deliberately conservative and tells
 * the grader to record unknown until a native marker is authored.
 */
export function normalizeAcceptanceRubricProposal(
  criteria: ProposeRubricCriterion[],
  kind: RubricKind | undefined,
  ratingScale: readonly string[],
): {
  criteria: ProposeRubricCriterion[];
  ratingScale: string[];
  compatibility?: RubricCompatibilityAudit;
} {
  if ((kind ?? 'standard') !== 'acceptance') {
    return { criteria, ratingScale: [...ratingScale] };
  }

  const upgrades: RubricCompatibilityUpgrade[] = [];
  const normalizedCriteria = criteria.map((criterion, index) => {
    const normalized = normalizeRequirementSections(criterion);
    for (const field of ['model', 'method'] as const) {
      if (typeof normalized[field] === 'string' && normalized[field].trim() === '') {
        delete normalized[field];
        upgrades.push({
          field: `criteria[${index}].${field}`,
          action: 'omit-empty',
          reason: 'legacy Rubric projection represented an omitted optional field as an empty string',
        });
      }
    }

    // `planRowToRubric` maps a missing legacy driftMarkers field to ''. Keep an
    // actually absent direct input invalid (fail-loud for new callers), while
    // making the read → successor path deterministic and schema-valid.
    if (typeof normalized.driftMarkers === 'string' && normalized.driftMarkers.trim() === '') {
      const value =
        `Legacy acceptance criterion '${normalized.key}' has no recorded drift marker; ` +
        'treat missing evidence as unknown until a concrete falsifier is authored.';
      normalized.driftMarkers = value;
      upgrades.push({
        field: `criteria[${index}].driftMarkers`,
        action: 'supply-falsifier',
        reason: 'legacy Rubric projection represented an omitted required acceptance falsifier as an empty string',
        value,
      });
    }
    return normalizeAcceptanceBarCriterion(normalized);
  });

  const normalizedRatingScale = [...ratingScale];
  if (!normalizedRatingScale.some(isUnknownRatingEquivalent)) {
    normalizedRatingScale.push('unknown');
    upgrades.push({
      field: 'ratingScale',
      action: 'append-unknown-equivalent',
      reason: 'legacy acceptance ratingScale had no label for evidence that cannot establish a verdict',
      value: 'unknown',
    });
  }

  return {
    criteria: normalizedCriteria,
    ratingScale: normalizedRatingScale,
    ...(upgrades.length > 0 ? { compatibility: { source: 'legacy-acceptance-read-projection', upgrades } } : {}),
  };
}

interface BuiltRubricTemplateData {
  data: unknown;
  compatibility?: RubricCompatibilityAudit;
}

/** Build the validated `template_data` for a rubric-template plan from a propose input.
 *  Throws (fail-loud, D-004) if the rubric data is malformed — never persists a broken
 *  rubric. Returns the schema-coerced data. When a stored rubric is supplied, its
 *  ratingScale is the fallback for whole-document re-proposes that omit the field;
 *  a class-only acceptance rubric inherits its resolved class scale; brand-new
 *  rubrics without a class still use DEFAULT_RATING_SCALE. */
function buildRubricTemplateData(
  input: ProposeRubricInput,
  stored?: Pick<Rubric, 'ratingScale'> | null,
  delegatedClass?: Pick<Rubric, 'ratingScale'> | null,
): BuiltRubricTemplateData {
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
  const normalized = normalizeAcceptanceRubricProposal(
    input.criteria,
    input.kind,
    input.ratingScale ??
      (input.kind === 'acceptance' && input.criteria.length === 0 && input.classRef && delegatedClass
        ? delegatedClass.ratingScale
        : undefined) ??
      stored?.ratingScale ?? [...DEFAULT_RATING_SCALE],
  );
  const criteria = normalized.criteria;
  assertRubricRatingVocabulary(criteria, normalized.ratingScale, { rubricId: input.rubricId });
  const data = {
    // Kind + acceptance links (acceptance-rubrics-on-every-plan-2026-08-11) — the schema's
    // per-kind superRefine validates the combination (subjectPlan/classRef acceptance-only,
    // standard criteria fully-specified, …).
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.subjectPlan ? { subjectPlan: input.subjectPlan } : {}),
    ...(input.subjectHarnessSlug ? { subjectHarnessSlug: input.subjectHarnessSlug } : {}),
    ...(input.subjectGoal ? { subjectGoal: input.subjectGoal } : {}),
    ...(input.classRef ? { classRef: input.classRef } : {}),
    ...(input.composes !== undefined ? { composes: normalizeRubricCompositionRefs(input.composes) } : {}),
    ...(input.barSetHash ? { barSetHash: input.barSetHash } : {}),
    ...(input.barContract ? { barContract: input.barContract } : {}),
    characteristic: input.characteristic,
    criteria,
    ratingScale: normalized.ratingScale,
    ...(input.methodRef ? { methodRef: input.methodRef } : {}),
    ...(input.releaseGating !== undefined ? { releaseGating: input.releaseGating } : {}),
    ...(input.stalenessWatched !== undefined ? { stalenessWatched: input.stalenessWatched } : {}),
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
  // Reads/re-projection stay permissive for legacy acceptance rows, but every
  // direct propose/amend write uses the stricter acceptance authoring profile
  // (EI-218268): no-verdict rating + concrete falsifier per bespoke criterion.
  const schema = rubricKindOf(data) === 'acceptance' ? rubricTemplateDataAuthoringSchema : rubricTemplateDataSchema;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid_args: proposeRubric: invalid rubric data for '${input.rubricId}': ${issues}`);
  }
  return { data: parsed.data, compatibility: normalized.compatibility };
}

/**
 * Acceptance-kind link guards (acceptance-rubrics-on-every-plan-2026-08-11 P-003), run
 * BEFORE any write: the completion gate keys off subjectPlan, so a dangling link is a
 * rubric that never gates anything — refused loudly, never persisted.
 */
/** What the acceptance-link guard learned about the subject plan on its way through. */
export interface AcceptanceLinkResolution {
  /** The subject plan's stored `status` (`null` when no subjectPlan was named). */
  subjectPlanStatus: string | null;
  subjectHarnessSlug?: string;
  /** The resolved standard class, used to inherit its vocabulary for class-only
   * acceptance rubrics and to validate its current revision in read-side hashes. */
  classRubric: Pick<Rubric, 'ratingScale' | 'revision'> | null;
}

/**
 * Normalize the unpinned composition list at the canonical rubric write boundary.
 * The wire schema checks that entries are non-empty strings, but it deliberately
 * does not rewrite them; keeping this tiny pure helper here makes every writer
 * (propose, amend, and first-party seed) agree on whitespace and duplicate
 * handling before the refs are persisted.
 */
export function normalizeRubricCompositionRefs(refs: readonly string[] | undefined): string[] | undefined {
  if (refs === undefined) return undefined;
  return [...new Set(refs.map((ref) => ref.trim()))];
}

/**
 * Resolve and validate a rubric's composition edges before persisting them.
 * Composition is intentionally UNPINNED: the edge stores only a rubric id, and
 * the referenced rubric's current definition is read when grading. The target
 * still must exist and be a reusable STANDARD rubric; acceptance rubrics are
 * per-plan contracts and cannot be used as shared composition parents.
 *
 * This is kept separate from the acceptance-link guard because a standard rubric
 * may compose another standard rubric without having a subject plan/goal. The
 * helper fails closed when a read cannot resolve (getRubric returns null), so a
 * malformed/dangling edge can never be written as if it were valid.
 */
async function assertRubricCompositionLinksResolve(
  input: Pick<ProposeRubricInput, 'rubricId' | 'composes'>,
): Promise<void> {
  const refs = normalizeRubricCompositionRefs(input.composes);
  if (!refs || refs.length === 0) return;

  const rubricId = input.rubricId.trim();
  const selfRef = refs.find((ref) => ref === rubricId);
  if (selfRef) {
    throw new Error(
      `invalid_args: proposeRubric: rubric '${input.rubricId}' cannot compose itself ('${selfRef}') — ` +
        'composition edges must point to a different reusable standard rubric',
    );
  }

  const resolved = await Promise.all(refs.map(async (ref) => ({ ref, rubric: await getRubric(ref) })));
  const missing = resolved.filter(({ rubric }) => !rubric).map(({ ref }) => ref);
  if (missing.length > 0) {
    throw new Error(
      `invalid_args: proposeRubric: rubric '${input.rubricId}' composes unknown rubric(s): ${missing
        .map((ref) => `'${ref}'`)
        .join(', ')}. Each composition ref must resolve to an existing standard-kind rubric.`,
    );
  }

  const nonStandard = resolved
    .filter(({ rubric }) => rubric !== null && rubric.kind !== 'standard')
    .map(({ ref, rubric }) => `${ref} (${rubric!.kind})`);
  if (nonStandard.length > 0) {
    throw new Error(
      `invalid_args: proposeRubric: rubric '${input.rubricId}' composes non-standard rubric(s): ${nonStandard
        .map((ref) => `'${ref}'`)
        .join(', ')}. Composition refs must point to reusable standard-kind rubrics; acceptance rubrics are ` +
        'subject-bound contracts, not composition parents.',
    );
  }
}

/**
 * EI-22078741539479611 — the ONE case a NEW acceptance rubric must be refused rather
 * than activated: its subject plan is already SHIPPED. Shipping retires the plan's
 * acceptance rubric (one-shot, by design), so a later read that finds "no active rubric"
 * is looking at a CLOSED validation; authoring a fresh contract there re-opens a settled
 * gate and routes a redundant grading pass to a peer (measured live 2026-09-01: the
 * duplicate `-r2` rubric plus a BLOCKING grading request to the agent who had already
 * graded 7/7). Re-proposing an EXISTING rubricRef is deliberately left alone: stored
 * lifecycle state already outranks the authoring default (EI-21296891484659125), and a
 * content-only edit of a retired rubric stays legal (EI-21909559308315843). Pure, so the
 * rule is unit-testable without PG.
 */
export function acceptanceProposeReopensShippedPlan(args: {
  kind: string;
  storedExists: boolean;
  subjectPlanStatus: string | null;
}): boolean {
  return args.kind === 'acceptance' && !args.storedExists && args.subjectPlanStatus === 'shipped';
}

/** The refusal text for {@link acceptanceProposeReopensShippedPlan}; pure for the same reason. */
export function shippedSubjectPlanRefusal(args: {
  rubricId: string;
  subjectPlan: string;
  retiredRubricId: string | null;
}): string {
  return (
    `invalid_args: proposeRubric: subject_plan_shipped — subjectPlan '${args.subjectPlan}' is already SHIPPED, ` +
    `so a new acceptance rubric '${args.rubricId}' would RE-OPEN a settled ship gate (EI-22078741539479611). ` +
    (args.retiredRubricId
      ? `Its acceptance rubric '${args.retiredRubricId}' was retired WITH the ship (one-shot, by design) and IS ` +
        'the validation record. '
      : 'It shipped with no acceptance rubric on record (pre-gate, or under a waiver). ') +
    'A shipReadiness / lifecycle read that says "no active rubric" on a shipped plan describes a CLOSED ' +
    'validation, not a missing one — do not reconcile it by authoring. To re-validate deliberately, move the ' +
    'plan off shipped first (plans:set-plan-status), then propose.'
  );
}

/**
 * P-013 (design-to-code-coverage-seam-2026-09-02) — the STRUCTURED-CHECK FLOOR.
 *
 * An acceptance rubric is a plan's definition-of-done, and until now it could be made
 * entirely of prose: 130 of the 275 acceptance rubrics that carry criteria (47%, measured
 * 2026-09-03) name not one machine-checkable criterion, so nothing about the plan they
 * gate is ever re-verified by a machine. This floor forbids that SILENCE. It deliberately
 * does NOT judge which check is right — only that the rubric must say how it is checked.
 *
 * ⚠ Deliberately NOT a coverage mandate. P-013's own text asks for a kind:'coverage'
 * criterion scoped to planTouched in EVERY acceptance rubric; D-034 records why that half
 * is sequenced behind the evidence path instead of shipped here. All 2,019 censused
 * surfaces sit at meets_l1..l4 = 0 because `coverage_evidence` holds 0 rows, and the
 * grading rule is `belowUnwaived === 0 ? 'pass' : 'fail'` — so a mandatory coverage check
 * would refuse EVERY acceptance emit fleet-wide (coverage_scope_empty over a scope that
 * matches no censused surface, coverage_contradicted over one that does). Mandating an
 * instrument whose evidence table is empty does not measure coverage; it stops shipping.
 *
 * Scope is acceptance-kind ONLY, and that is what keeps the cold-start seeder safe: all 13
 * first-party rubric seeds carry kind = null and none of them carries a check, so a blanket
 * floor would refuse `reseedRubricsAfterInstall` on every boot.
 *
 * Pure, so the rule is unit-testable without PG — the same posture as
 * {@link acceptanceProposeReopensShippedPlan}.
 */
export function acceptanceRubricLacksStructuredCheck(args: {
  kind: string;
  criteria: readonly Pick<RubricCriterion, 'check'>[];
}): boolean {
  // An empty criteria array is the classRef / pure-investigation case (plan D-009): there
  // is no criterion to attach a check to, so there is nothing to be silent ABOUT.
  if (args.kind !== 'acceptance' || args.criteria.length === 0) return false;
  return !args.criteria.some((c) => c.check != null);
}

/** The refusal text for {@link acceptanceRubricLacksStructuredCheck}; pure for the same reason. */
export function structuredCheckFloorRefusal(args: { rubricId: string; criteriaCount: number }): string {
  return (
    'invalid_args: proposeRubric: acceptance_rubric_needs_structured_check — acceptance rubric ' +
    `'${args.rubricId}' carries ${args.criteriaCount} criteria and not one of them has a structured ` +
    '`check`, so nothing it asserts can ever be re-verified by a machine. Give at least ONE criterion ' +
    'a check:\n' +
    "  · check: { kind:'tests', files:['path/to/x.test.ts'] } — the majority idiom (628 criteria use it); " +
    'the paths are validated HERE and actually RUN by scorecards:emit at grading time.\n' +
    "  · check: { kind:'cargo', manifestPath, sourceFiles } — for a native crate.\n" +
    "  · check: { kind:'instrument', instrumentKey:'none' } — the EXPLICIT MANUAL declaration. This is a " +
    'legitimate answer for a docs/process plan: the floor forbids silence, not manual verification.\n' +
    "⚠ Do NOT reach for check:{ kind:'coverage' } to satisfy this today. The surface census has 0 proven " +
    'surfaces (coverage_evidence is empty), so every coverage check currently fails or refuses at GRADING ' +
    'time and would block the emit you are authoring this rubric for.\n' +
    'A pure-investigation rubric may still omit criteria entirely (classRef with an empty criteria array).'
  );
}

async function assertAcceptanceLinksResolve(input: ProposeRubricInput): Promise<AcceptanceLinkResolution> {
  const subjectPlan = input.subjectPlan;
  const subjectGoal = input.subjectGoal;
  let subjectPlanStatus: string | null = null;
  let subjectHarnessSlug: string | undefined;
  let classRubric: Pick<Rubric, 'ratingScale' | 'revision'> | null = null;
  if (subjectPlan) {
    const { sql } = getOrgPg();
    const subj = await sql<{ plan_slug: string; harness_slug: string; template: string | null; status: string | null }[]>`
      SELECT plan_slug, harness_slug, template, status
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND plan_slug = ${subjectPlan}
         AND ${input.subjectHarnessSlug ? sql`harness_slug = ${input.subjectHarnessSlug}` : sql`TRUE`}
       LIMIT 2`;
    if (subj.length > 1) {
      throw new Error(`invalid_args: proposeRubric: subjectPlan '${subjectPlan}' is ambiguous across harnesses; supply subjectHarnessSlug`);
    }
    const subjRow = subj.find((r) => r.plan_slug === subjectPlan);
    subjectHarnessSlug = subjRow?.harness_slug;
    subjectPlanStatus = subjRow?.status ?? null;
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
  }
  // The goal-subject twin (consult-min-max-…-2026-08-17 P-009): the 'achieved' gate
  // keys off subjectGoal exactly as the completion gate keys off subjectPlan, so a
  // dangling goal id is refused just as loudly.
  if (subjectGoal) {
    const { sql } = getOrgPg();
    const subj = await sql<{ id: string }[]>`
      SELECT id
        FROM harness_shared.goals
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND id = ${subjectGoal}
       LIMIT 1`;
    if (!subj.some((r) => r.id === subjectGoal)) {
      throw new Error(
        `invalid_args: proposeRubric: acceptance rubric '${input.rubricId}' names subjectGoal '${subjectGoal}', ` +
          "but no such goal exists in this workspace — the goal-mode 'achieved' gate keys off this link, so a " +
          'dangling subjectGoal would never gate anything. Fix the id (goals:list to find it).',
      );
    }
  }
  if (!subjectPlan && !subjectGoal) {
    return { subjectPlanStatus, classRubric }; // schema already refuses acceptance without a subject
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
    classRubric = cls;
  }
  return { subjectPlanStatus, subjectHarnessSlug, classRubric };
}

/** Keep one live acceptance contract per subject plan; migration 1004 is the
 * database-level concurrency backstop for proposals racing on different rubric ids. */
async function assertAcceptanceSubjectPlanAvailable(
  input: ProposeRubricInput,
  rubricStatus: RubricStatus,
): Promise<void> {
  if (input.kind !== 'acceptance' || !input.subjectPlan || rubricStatus !== 'active') return;
  const conflicts = (await getAcceptanceRubricsForPlan(input.subjectPlan, {
    harnessSlug: input.subjectHarnessSlug, strict: true,
  })).filter(
    (rubric) => rubric.rubricId !== input.rubricId,
  );
  if (conflicts.length === 0) return;
  throw new Error(
    `invalid_args: proposeRubric: subjectPlan '${input.subjectPlan}' already has an active acceptance rubric ` +
      `${conflicts.map((rubric) => `'${rubric.rubricId}'`).join(', ')}. ` +
      'Retire the existing contract before proposing a replacement; one active acceptance rubric per subject plan is enforced.',
  );
}

/** The `template: rubric` plan body (frontmatter + Now + Background + Decisions). The
 *  structured fields live in `template_data` (written separately); the body is narrative
 *  context. Mirrors the Scout rubric-rail draft shape so the plan parses + derives the
 *  `template` column. */
export function buildRubricPlanBody(args: {
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

**Next:** An independent reviewer (or the owner/su) ratifies a proposed rubric by promoting
this plan to \`active\` (rubrics:ratify / plans:set-plan-status); the proposer cannot
self-ratify. Revise the criteria via plans:set-template-data.

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
async function resolveRubricWriteScope(rubricId: string): Promise<{ workspaceId: string; harnessSlug: string }> {
  const workspaceId = rubricsScopeWorkspace();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ harness_slug: string; template: string | null }[]>`
      SELECT harness_slug, template
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND plan_slug = ${rubricId}
       LIMIT 1`;
    const existing = rows[0];
    if (existing && existing.template !== RUBRIC_TEMPLATE_NAME) {
      throw new Error(
        `invalid_args: proposeRubric: rubricId '${rubricId}' collides with an existing ` +
          `non-rubric plan (template=${existing.template ?? 'none'}, harness=${existing.harness_slug}); ` +
          `choose a distinct rubricRef (for acceptance rubrics, use 'acceptance-${rubricId}')`,
      );
    }
    if (existing?.harness_slug) return { workspaceId, harnessSlug: existing.harness_slug };
  } catch (error) {
    // Database availability failures retain the historical default-home fallback, but a
    // namespace collision is caller input and must remain fail-closed.
    if (error instanceof Error && error.message.startsWith('invalid_args: proposeRubric: rubricId')) throw error;
  }
  return { workspaceId, harnessSlug: defaultRubricWriteHarness() };
}

/**
 * Reconstruct the rubric visible to a locked amendment from the body and
 * template_data that withPlanLock read inside the advisory-locked transaction.
 *
 * amendRubric used to call getRubric before entering withPlanLock, then pass that
 * stale snapshot to proposeRubric. Concurrent amendments therefore each wrote a
 * whole-document snapshot and erased fields committed by earlier writers. Keep
 * this conversion local to the lock callback: the body and structured data are
 * the same snapshot, so applyRubricAmendment always patches the version that
 * this writer is about to replace.
 */
function rubricFromLockedPlan(
  rubricId: string,
  current: string | null,
  templateData: unknown,
  scope: { workspaceId: string; harnessSlug: string },
): Rubric | null {
  if (!current) return null;
  const index = deriveIndexFromContent(current);
  if (index.template !== RUBRIC_TEMPLATE_NAME) return null;
  return planRowToRubric({
    plan_slug: rubricId,
    workspace_id: scope.workspaceId,
    harness_slug: scope.harnessSlug,
    title: index.title,
    status: index.status,
    created: index.created,
    updated: index.updated,
    // The amendment only needs the projected fields above; planRowToRubric still
    // expects the DB timestamp, so use the body date when locked metadata does
    // not expose the timestamptz column.
    updated_at: index.updated ?? new Date().toISOString(),
    owner: index.owner,
    archived: false,
    template_data: templateData,
  });
}

/**
 * Patch the generated frontmatter fields for an existing rubric plan while
 * preserving its narrative body verbatim.
 *
 * Rubric plans are allowed to carry project-specific requirements, evidence
 * matrices, plan items, and decisions in addition to the generated scaffold.
 * Rebuilding the body with buildRubricPlanBody during a small criterion amend
 * silently discarded those sections (the v8 → v9 acceptance-plan loss). Keep
 * amendRubric a read-modify-write of the frontmatter instead; only the fields
 * owned by the rubric amendment are changed and every other section survives.
 */
export function preserveRubricPlanBody(
  current: string,
  opts: { title: string; planStatus: string; owner: string | null; today?: Date },
): string {
  let body = current;
  body = setFrontmatterScalar(body, 'title', opts.title);
  body = setFrontmatterScalar(body, 'status', opts.planStatus);
  body = setFrontmatterScalar(body, 'owner', opts.owner);
  return bumpUpdatedDate(body, opts.today ?? new Date());
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
function rubricRevisionSnapshot(writtenBody: string, templateData: unknown, criteriaHash: string | null): string {
  if (templateData === null || templateData === undefined) return writtenBody;
  const serialized = JSON.stringify(
    {
      schemaVersion: RUBRIC_REVISION_SNAPSHOT_SCHEMA_VERSION,
      templateData,
      criteriaHash,
    },
    null,
    2,
  );
  if (serialized === undefined) return writtenBody;
  const separator = writtenBody.endsWith('\n') ? '\n' : '\n\n';
  return (
    writtenBody + separator + '## Structured rubric data (`template_data`)\n\n' + '~~~json\n' + serialized + '\n~~~\n'
  );
}

/** Compute the same current-read hash without triggering first-party seeding. */
async function rubricRevisionCriteriaHash(
  templateData: unknown,
  scope: { workspaceId: string; harnessSlug: string },
): Promise<string | null> {
  const [rubric] = await mapRubricPlanRows([
    {
      plan_slug: '__rubric_revision_snapshot__',
      workspace_id: scope.workspaceId,
      harness_slug: scope.harnessSlug,
      title: null,
      status: 'active',
      created: null,
      updated: null,
      updated_at: new Date(0).toISOString(),
      version: 1,
      owner: null,
      archived: false,
      template_data: templateData,
    },
  ]);
  return rubric?.criteriaHash ?? null;
}

function rubricRevisionAfterWrite(
  rubricId: string,
  by: string | undefined,
  rationale: string,
  fallbackTemplateData?: unknown,
  compatibilityAudit?: () => RubricCompatibilityAudit | undefined,
): (
  writtenBody: string,
  scope: { workspaceId: string; harnessSlug: string },
  committedTemplateData: unknown,
) => Promise<void> {
  const identity: AgentIdentity = {
    ownerId: by ?? 'rubrics:system',
    ownerLabel: by ?? 'rubrics:system',
    // Not a `principal` (in-process human) — a rubric write is an agent/Queen action, so
    // classifyAuthor records author_kind='agent'.
    source: 'static-client',
    workspaceId: null,
    userId: null,
  };
  return async (writtenBody, scope, committedTemplateData) => {
    const snapshotTemplateData =
      committedTemplateData !== undefined ? committedTemplateData : fallbackTemplateData;
    const criteriaHash = await rubricRevisionCriteriaHash(snapshotTemplateData, scope);
    // Thread the (workspaceId, harnessSlug) withPlanLock resolved for THIS write so the
    // revision lands on the rubric plan's own PK (recordPlanRevision re-resolves through
    // the same resolvePlanScope — the operator-home short-circuit for the rubric harness).
    await recordPlanRevision({
      planSlug: rubricId,
      ...(scope?.harnessSlug ? { harnessSlug: scope.harnessSlug } : {}),
      ...(scope?.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      // withPlanLock supplies the value committed by this exact transaction.
      // The fallback keeps auditability best-effort for older callers/tests that
      // invoke this helper without the third hook argument.
      content: rubricRevisionSnapshot(
        writtenBody,
        snapshotTemplateData,
        criteriaHash,
      ),
      // The revision hash remains the canonical plan-body fingerprint used by
      // activation/current-revision comparisons. Only content_snapshot is
      // enriched with structured rubric data.
      contentHash: hashPlanContent(writtenBody),
      rationale: (() => {
        const compatibility = compatibilityAudit?.();
        return compatibility && compatibility.upgrades.length > 0
          ? `${rationale}; compatibility=${JSON.stringify(compatibility)}`
          : rationale;
      })(),
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
  // Every preflight and writer must inspect the same canonical fields. In
  // particular, a nested verification.check must participate in the check floor.
  input = { ...input, criteria: input.criteria.map(normalizeRequirementSections) };
  const kind = input.kind ?? 'standard';
  // Validate FIRST (fail-loud) before any write, so a malformed rubric never persists a
  // half-state (a body with no/invalid template_data).
  let builtTemplateData = buildRubricTemplateData(input);
  let templateData = builtTemplateData.data;
  let compatibilityAudit = builtTemplateData.compatibility;
  // EI-21818117666341180: acceptance-rubric method/replication prose is itself a
  // citation map. Refuse a path that exists but does not contain the explicit
  // symbol-level subject or named test case the criterion tells the grader to
  // inspect. This is pure and runs before any acceptance-link/store write.
  if (kind === 'acceptance') {
    assertAcceptanceRubricCitationPathsResolve(input.criteria, { root: input.checkPathRoot });
  }
  // P-013: the structured-check floor. Pure and cheap, so it refuses BEFORE any link
  // resolution or store read — an acceptance rubric made entirely of prose gates nothing.
  if (acceptanceRubricLacksStructuredCheck({ kind, criteria: input.criteria })) {
    throw new Error(structuredCheckFloorRefusal({ rubricId: input.rubricId, criteriaCount: input.criteria.length }));
  }
  // Acceptance links must RESOLVE before anything persists (plan P-003): a dangling
  // subjectPlan would never gate anything, silently.
  const stored = await getRubric(input.rubricId);
  if (stored?.subjectHarnessSlug) {
    if ((input.subjectHarnessSlug && input.subjectHarnessSlug !== stored.subjectHarnessSlug) ||
        input.subjectPlan !== stored.subjectPlan) {
      throw new Error('invalid_args: proposeRubric: an existing acceptance rubric cannot change its subject identity');
    }
    input = { ...input, subjectHarnessSlug: stored.subjectHarnessSlug };
  }
  const links = kind === 'acceptance' ? await assertAcceptanceLinksResolve(input) : null;
  if (links?.subjectHarnessSlug) input = { ...input, subjectHarnessSlug: links.subjectHarnessSlug };
  // Composition edges are unpinned, but they are not unchecked strings: every
  // target must resolve to a reusable standard rubric before this document can
  // be written. Keep this beside the acceptance-link guard so both identity
  // edges fail before any plan lock/write side effect.
  await assertRubricCompositionLinksResolve(input);
  // P-003: once a subject plan has adopted the BAR contract, the canonical
  // rubric writer also consults the shared snapshot before replacing it. The
  // pre-start phase intentionally permits METHOD-empty bars; it still refuses
  // a stored contract whose identity, provenance, mapping, or bounded source
  // state is already divergent. New activation seeds have no existing rubric
  // yet and are validated by seedAcceptanceBarsInTransaction instead.
  if (kind === 'acceptance' && stored?.barContract?.adoptionEpoch != null && input.subjectPlan) {
    const { readAndEvaluateAcceptanceBarLifecycle } = await import('./acceptance-bar-lifecycle-evaluator');
    const lifecycle = await readAndEvaluateAcceptanceBarLifecycle(input.subjectPlan, 'pre-start', {
      harnessSlug: input.subjectHarnessSlug,
    });
    if (!lifecycle.satisfied) {
      throw new Error(
        `invalid_args: proposeRubric: acceptance_bar_contract_not_ready — ${
          lifecycle.message ?? lifecycle.codes.join(', ')
        }`,
      );
    }
  }
  // EI-22078741539479611: a NEW acceptance contract for an already-shipped plan re-opens a
  // settled gate. Decided by the pure predicate so the rule is testable without PG; the
  // retired-rubric lookup runs only on the refusal path, to name the record it protects.
  if (
    acceptanceProposeReopensShippedPlan({
      kind,
      storedExists: stored != null,
      subjectPlanStatus: links?.subjectPlanStatus ?? null,
    })
  ) {
    const subjectPlan = input.subjectPlan ?? '';
    const retired = subjectPlan ? await getRetiredAcceptanceRubricsForPlan(subjectPlan, {
      harnessSlug: input.subjectHarnessSlug,
    }) : [];
    throw new Error(
      shippedSubjectPlanRefusal({
        rubricId: input.rubricId,
        subjectPlan,
        retiredRubricId: retired[0]?.rubricId ?? null,
      }),
    );
  }
  // `getRubric` intentionally runs after the initial validation because reads can
  // trigger first-party seeding. Rebuild when the caller omitted the whole-document
  // ratingScale so a class-only acceptance rubric inherits the RESOLVED class
  // vocabulary, while ordinary re-proposes preserve the existing rubric's scale
  // instead of silently reverting it to DEFAULT_RATING_SCALE.
  if (links?.subjectHarnessSlug || (input.ratingScale === undefined && (stored?.ratingScale || links?.classRubric))) {
    builtTemplateData = buildRubricTemplateData(input, stored, links?.classRubric);
    templateData = builtTemplateData.data;
    compatibilityAudit = builtTemplateData.compatibility;
  }
  // EI-21296891484659125: acceptance rubrics activate on their FIRST propose (D-008),
  // but a whole-document revision must never resurrect one already retired with its
  // shipped subject plan. Mirror the EI-12932 seed-upgrade guard: stored lifecycle state
  // outranks the path's authoring default. This is deliberately stricter than accepting
  // an explicit active status — reopening a closed acceptance contract needs a successor,
  // not a content upsert that silently flips its rubric-template plan back to active.
  const rubricStatus: RubricStatus =
    kind === 'acceptance' && stored?.status === 'retired'
      ? stored.status
      : (input.status ?? (kind === 'acceptance' ? 'active' : 'proposed'));
  await assertAcceptanceSubjectPlanAvailable(input, rubricStatus);
  const planStatus = rubricStatusToPlanStatus(rubricStatus);
  // WI-4287 loss-guard: propose is a whole-document replace — refuse to silently drop
  // stored criteria or gut their testing procedures (see assertNoSilentRubricLoss).
  assertNoSilentRubricLoss(stored, input);
  // P-011 (owner-ratified D-006): every kind:'tests' structured check must name files
  // that RESOLVE against the live tree, or the propose is REFUSED — a check that can
  // never run is a booby trap, not advice (unlike the advisory replicationSqlCheck,
  // whose subject is external moving-target DB state). Enforced HERE in the lib write
  // path, like the loss-guards, so every caller (MCP tool, amend's re-propose, seeds)
  // inherits it. Criteria without a tests-check are untouched.
  assertCriterionCheckPathsResolve(input.criteria, { root: input.checkPathRoot });
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
      ...(input.by ? { actorId: input.by } : {}),
      ...scope,
      // EI-10443: record a plan_revisions audit row for the propose write.
      afterWrite: rubricRevisionAfterWrite(
        input.rubricId,
        input.by,
        `rubrics:propose (${rubricStatus})`,
        templateData,
        () => compatibilityAudit,
      ),
    },
    async (current) => {
      // The slug namespace is shared with ordinary work plans. Re-check under the
      // plan's advisory lock so a plan created after resolveRubricWriteScope cannot
      // be silently converted into a rubric by this whole-document upsert.
      if (current) {
        const existingTemplate = deriveIndexFromContent(current).template;
        if (existingTemplate !== RUBRIC_TEMPLATE_NAME) {
          throw new Error(
            `invalid_args: proposeRubric: rubricId '${input.rubricId}' collides with an existing ` +
              `non-rubric plan (template=${existingTemplate ?? 'none'}, harness=${scope.harnessSlug}); ` +
              `choose a distinct rubricRef (for acceptance rubrics, use 'acceptance-${input.rubricId}')`,
          );
        }
      }
      // The boundary guard re-checks this write against the row it is replacing, INSIDE
      // the lock (EI-21972673091438558). Pass the caller's acknowledgements through so an
      // intentional, acked removal still lands — an unacked one is refused at both ends.
      return {
        newBody: body,
        templateData: { data: templateData, rubricLossAck: rubricLossAckOf(input) },
        value: true,
      };
    },
  );
  if (result.kind === 'busy') {
    throw new Error(`proposeRubric: plan '${input.rubricId}' is being written by another caller`);
  }

  // withPlanLock returns activation-gate refusals as typed domain values so plan
  // tools can render them without throwing. This library API cannot return a partial
  // Rubric, so preserve the exact refusal rather than misreporting it as a failed
  // post-write lookup.
  if (isConversationAuditRequiredValue(result.value)) {
    throw new Error(`${result.value.code}: ${result.value.message}`);
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
  /** Target one requirement while preserving every other criterion and its history. */
  requirement?: {
    key: string;
    intent?: RequirementIntent;
    acceptance?: Partial<RequirementAcceptance>;
    verification?: Partial<RequirementVerification>;
  };
  /**
   * Acceptance-kind only: replace the COMPLETE criterion set through the
   * cross-plan BAR amendment transaction. This is the post-seed escape hatch
   * for adding a declared R-N BAR or binding structured checks without routing
   * through rubrics:propose's pre-start readiness gate.
   */
  criteria?: ProposeRubricCriterion[];
  /** Patch ONE criterion's prose field. `append` adds a paragraph (never guarded — it
   *  can only grow the procedure); `replace` swaps the field and inherits the WI-4287
   *  shrink guard via proposeRubric. */
  criterion?: {
    key: string;
    field: AmendableCriterionField;
    mode: 'append' | 'replace';
    text: string;
  };
  /**
   * P-008: set ONE criterion's grading class. UPGRADE-ONLY through this path — setting
   * 'violatable' (or classifying an unclassed criterion) only tightens grading, so it
   * keeps the stored status + ratifier like any amendment. DOWNGRADING a stored
   * 'violatable' criterion removes its provisional-until-terminal protection and is
   * REFUSED here: that edit is rubrics:propose territory (classDowngradeReason + a
   * fresh ratification).
   */
  criterionClass?: {
    key: string;
    class: CriterionClass;
  };
  /** Change the structural evidence plane through the same BAR amendment seam. */
  criterionEvidencePlane?: { key: string; evidencePlane: 'tree' | 'deployed' | 'live' };
  /** Set/replace the rubric-level runbook slug (agent-insights). */
  methodRef?: string;
  /** Bind a missing acceptance class without replacing the BAR contract. Existing classes cannot change here. */
  classRef?: string;
  /**
   * Replace the rubric's unpinned composition references. Omit to preserve the
   * stored composition. The refs are normalized (trimmed + de-duplicated) and
   * validated against live standard-kind rubrics before the write.
   */
  composes?: string[];
  allowMethodShrink?: boolean;
  shrinkReason?: string;
  /** Authenticated actor for a BAR amendment; distinct from rubric authorship (`by`). */
  actorId?: string;
  /** Human-readable reason recorded in the subject-plan Decision. */
  reason?: string;
  /** Optimistic CAS against the two rows touched by a cross-plan amendment. */
  expectedRubricRevision?: number;
  expectedSubjectPlanRevision?: number;
  /** Stable replay token. Omitted ⇒ a deterministic hash of the amendment inputs. */
  idempotencyKey?: string;
  /** Outside-lineage approval receipt required for a started BAR meaning change. */
  approvalRef?: string;
  approvedBy?: string;
  approvedAt?: string;
  /** Test-only rollback probe; production callers should omit it. */
  faultInjection?: 'after-decision' | 'after-rubric' | 'after-projection' | 'after-rebind';
  /** Workspace root used to validate structured test checks and cited paths. */
  checkPathRoot?: string;
  by?: string;
}

/**
 * Pure core of amendRubric: patch the stored rubric per the amendment and shape the
 * whole-document ProposeRubricInput that persists it — STORED status preserved
 * (amending an active rubric never demotes it to proposed). Exported for unit tests;
 * throws teaching errors on an unknown criterion key / an empty amendment.
 */
export function applyRubricAmendment(stored: Rubric, input: AmendRubricInput): ProposeRubricInput {
  if (
    !input.criteria &&
    !input.requirement &&
    !input.criterion &&
    !input.criterionClass &&
    !input.criterionEvidencePlane &&
    input.methodRef === undefined &&
    input.classRef === undefined &&
    input.composes === undefined
  ) {
    throw new Error(
      'amendRubric: nothing to amend — pass criteria, criterion, criterionClass, criterionEvidencePlane, methodRef, classRef, and/or composes',
    );
  }
  if (
    input.requirement &&
    (input.criteria || input.criterion || input.criterionClass || input.criterionEvidencePlane)
  ) {
    throw new Error('invalid_args: requirement amendment cannot be combined with other criterion patches');
  }
  if (input.criteria && (input.criterion || input.criterionClass || input.criterionEvidencePlane)) {
    throw new Error(
      'invalid_args: amendRubric: criteria is the complete replacement set and cannot be combined with criterion, criterionClass, or criterionEvidencePlane patches',
    );
  }
  if (input.criteria && stored.kind !== 'acceptance') {
    throw new Error(
      'invalid_args: amendRubric: complete criteria replacement is acceptance-kind only; use rubrics:propose for a standard rubric revision',
    );
  }

  const classRef = input.classRef?.trim();
  if (input.classRef !== undefined) {
    if (stored.kind !== 'acceptance' || !classRef) {
      throw new Error('invalid_args: amendRubric: classRef requires an acceptance rubric and a non-empty class reference');
    }
    if (stored.classRef && stored.classRef !== classRef) {
      throw new Error('invalid_args: amendRubric: an existing acceptance class cannot be replaced through this amendment');
    }
  }

  let criteria: ProposeRubricCriterion[] = input.criteria
    ? input.criteria.map(normalizeRequirementSections)
    : stored.criteria;
  if (input.requirement) {
    const patch = input.requirement;
    const target = criteria.find((criterion) => criterion.key === patch.key);
    if (stored.kind !== 'acceptance' || !target) {
      throw new Error('invalid_args: requirement amendment requires an existing acceptance criterion');
    }
    if (
      ![patch.intent, patch.acceptance, patch.verification].some((section) => section && Object.keys(section).length)
    ) {
      throw new Error('invalid_args: requirement amendment is empty');
    }
    // Remove read aliases before replacing canonical fields; an old projected BAR
    // must not masquerade as conflicting new input. Unspecified fields survive.
    const { bar: _bar, acceptance: _acceptance, verification: _verification, ...canonical } = target;
    const acceptance = patch.acceptance;
    const verification = patch.verification;
    const next: ProposeRubricCriterion = {
      ...canonical,
      ...(patch.intent ? { intent: patch.intent } : {}),
      ...(acceptance
        ? {
            ...Object.fromEntries(
              Object.entries(acceptance).filter(([key]) => !['condition', 'falsifier'].includes(key)),
            ),
            ...(acceptance.condition !== undefined ? { model: acceptance.condition } : {}),
            ...(acceptance.falsifier !== undefined ? { driftMarkers: acceptance.falsifier } : {}),
          }
        : {}),
      ...(verification ?? {}),
    };
    criteria = criteria.map((criterion) => (criterion.key === patch.key ? next : criterion));
  }
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
    criteria = stored.criteria.map((c) => {
      if (c.key !== key) return c;
      if (stored.kind === 'acceptance' && field === 'model') {
        // `bar` and `barHash` are read/projection aliases, not independent
        // authoring fields. A stored acceptance criterion carries both aliases,
        // so retaining them while replacing the canonical model makes the
        // normalizer compare the new model with the stale old bar and reject a
        // valid model-only amendment. Drop both aliases here; the central
        // acceptance writer re-derives the hash from the new canonical model.
        const { bar: _bar, barHash: _barHash, ...canonical } = c;
        return { ...canonical, model: next };
      }
      return { ...c, [field]: next };
    });
  }
  if (input.criterionClass) {
    const { key, class: cls } = input.criterionClass;
    const target = criteria.find((c) => c.key === key);
    if (!target) {
      throw new Error(
        `amendRubric: rubric '${input.rubricId}' has no criterion '${key}' — keys: ${criteria
          .map((c) => c.key)
          .join(', ')}`,
      );
    }
    // Upgrade-only (P-008): removing 'violatable' strips the provisional-until-terminal
    // protection, which must not ride the no-demotion amend path.
    if (target.criterionClass === 'violatable' && cls !== 'violatable') {
      throw new Error(
        `invalid_args: amendRubric: criterion '${key}' is 'violatable' — downgrading to '${cls}' removes its ` +
          'provisional-until-terminal protection. Use rubrics:propose (whole-document) with classDowngradeReason ' +
          'so the edit gets a fresh ratification',
      );
    }
    criteria = criteria.map((c) => (c.key === key ? { ...c, criterionClass: cls } : c));
  }

  if (input.criterionEvidencePlane) {
    const { key, evidencePlane } = input.criterionEvidencePlane;
    if (
      stored.kind !== 'acceptance' ||
      !criteria.some((criterion) => criterion.key === key) ||
      !['tree', 'deployed', 'live'].includes(evidencePlane)
    ) {
      throw new Error(
        'invalid_args: criterionEvidencePlane requires an existing acceptance criterion and a structural tree/deployed/live token',
      );
    }
    criteria = criteria.map((criterion) => {
      if (criterion.key !== key) return criterion;
      const requiredScope = criterion.requiredScope?.map((scope) =>
        isAcceptanceEvidencePlane(scope) ? evidencePlane : scope,
      );
      return {
        ...criterion,
        ...(requiredScope ? { requiredScope } : {}),
        evidencePlane,
      };
    });
  }

  return {
    rubricId: stored.rubricId,
    // Kind + acceptance links round-trip (acceptance-rubrics-on-every-plan-2026-08-11):
    // dropping them from an amendment would flip an acceptance rubric to standard and
    // orphan its subjectPlan link — the WI-4287 loss class, on identity fields.
    ...(stored.kind !== 'standard' ? { kind: stored.kind } : {}),
    ...(stored.subjectPlan ? { subjectPlan: stored.subjectPlan } : {}),
    ...(stored.subjectHarnessSlug ? { subjectHarnessSlug: stored.subjectHarnessSlug } : {}),
    ...(stored.subjectGoal ? { subjectGoal: stored.subjectGoal } : {}),
    ...(classRef || stored.classRef ? { classRef: classRef ?? stored.classRef! } : {}),
    ...(input.composes !== undefined
      ? { composes: normalizeRubricCompositionRefs(input.composes) }
      : stored.composes
        ? { composes: [...stored.composes] }
        : {}),
    ...(stored.barSetHash ? { barSetHash: stored.barSetHash } : {}),
    ...(stored.barContract ? { barContract: stored.barContract } : {}),
    characteristic: stored.characteristic,
    title: stored.title,
    description: stored.description,
    criteria,
    ratingScale: stored.ratingScale,
    // EI-12149: an amendment must carry the stored release-gating mark — dropping it
    // would silently un-gate the rubric (the WI-4287 loss class, on a boolean).
    ...(stored.releaseGating !== undefined ? { releaseGating: stored.releaseGating } : {}),
    // Same loss class as releaseGating above (WI-4287): dropping this on an amendment
    // would silently un-watch the rubric, and an un-watched health rubric fails EXACTLY
    // as quietly as the gap this flag was added to close.
    ...(stored.stalenessWatched !== undefined ? { stalenessWatched: stored.stalenessWatched } : {}),
    ...((input.methodRef ?? stored.methodRef) ? { methodRef: (input.methodRef ?? stored.methodRef)! } : {}),
    ...((input.by ?? stored.createdBy) ? { by: (input.by ?? stored.createdBy)! } : {}),
    status: stored.status,
    // EI-10751: an amendment preserves the rubric's status, so it must also preserve the
    // ratifier of record — otherwise amending an active rubric leaves it active with the
    // stored ratifiedBy dropped, and the projection falls back to the plan owner (the
    // exact false-provenance record this fix removes).
    ...(stored.status === 'active' && stored.ratifiedBy ? { ratifiedBy: stored.ratifiedBy } : {}),
    ...(input.allowMethodShrink !== undefined ? { allowMethodShrink: input.allowMethodShrink } : {}),
    ...(input.shrinkReason !== undefined ? { shrinkReason: input.shrinkReason } : {}),
    ...(input.checkPathRoot !== undefined ? { checkPathRoot: input.checkPathRoot } : {}),
  };
}

interface AcceptanceAmendmentPlanRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  content: string;
  content_hash: string;
  version: number | string;
  title: string | null;
  status: string | null;
  created: string | null;
  updated: string | null;
  owner: string | null;
  archived: boolean;
  template_data: unknown;
}

interface AcceptanceAmendmentClauseRow {
  spec_id: string;
  source_val_id: string | null;
  current_revision: number | string;
  source_bar_key: string | null;
  plan_item_id: string;
  behavior: string;
  behavior_class: SpecClauseRevision['behaviorClass'];
  required_evidence: string[];
  required_test_layers: string[];
  mutation_required: boolean;
  lifecycle_status: SpecClauseRevision['lifecycleStatus'];
  supersedes_spec_id: string | null;
  supersedes_revision: number | string | null;
  exemption: Record<string, unknown> | null;
}

interface AcceptanceAmendmentResult {
  rubric: Rubric;
  decisionId: string;
  rubricRevision: number;
  subjectPlanRevision: number;
  barSetHash: string;
  changedBars: string[];
  reboundContracts: number;
  invalidated: {
    evidence: number;
    scorecards: number;
    vetting: number;
  };
  idempotencyKey: string;
  replayed?: boolean;
  /** No promise changed; continue through the guarded method/pin-refresh writer. */
  methodOnly?: boolean;
  /** Committed snapshots used by the existing plan-revision audit spine. */
  rubricBody?: string;
  subjectBody?: string;
  templateData?: unknown;
  preview?: AcceptanceBarAmendmentPreview;
}

export interface AcceptanceBarAmendmentPreview {
  rubricRevision: number;
  subjectPlanRevision: number;
  priorBarSetHash: string;
  nextBarSetHash: string;
  changedBars: string[];
  projectionCount: number;
  approval: AcceptanceBarApproval;
  approvalRequired: boolean;
  sourceSnapshotHash: string;
  changes: import('./acceptance-bar-contract-snapshot').AcceptanceBarContractDiff['changes'];
  revisionMovement: { rubric: { from: number; to: number }; subject: { from: number; to: number } };
  invalidatedProofRefs: string[];
  invalidatedScorecardIds: string[];
  authorVerdictBecomesStale: boolean;
  reboundWorkItemIds: string[];
  cohortDisposition: { cohort: string | null; adoptionEpoch: number | null; action: 'preserve' };
  nextRepair: { code: string; action: string };
}

function amendmentFaultStage(input: AmendRubricInput): AmendRubricInput['faultInjection'] | undefined {
  return (
    input.faultInjection ?? (process.env.PAPERCUSP_ACCEPTANCE_BAR_AMENDMENT_FAULT as AmendRubricInput['faultInjection'])
  );
}

function injectAmendmentFault(input: AmendRubricInput, stage: NonNullable<AmendRubricInput['faultInjection']>): void {
  if (amendmentFaultStage(input) === stage) {
    throw new Error(`acceptance_bar_amendment_fault_injected:${stage}`);
  }
}

function decisionHasAmendmentKey(body: string, key: string): boolean {
  return parsePlan(body).decisions.some((decision) => decision.body.split('\n').includes(`Amendment-Id: ${key}`));
}

function amendmentRequestHash(input: AmendRubricInput): string {
  return hashPlanContent(
    JSON.stringify([
      input.rubricId,
      input.actorId ?? input.by ?? null,
      input.reason ?? null,
      input.criteria ?? null,
      input.requirement ?? null,
      input.criterion ? [input.criterion.key, input.criterion.field, input.criterion.mode, input.criterion.text] : null,
      input.criterionClass ? [input.criterionClass.key, input.criterionClass.class] : null,
      input.criterionEvidencePlane
        ? [input.criterionEvidencePlane.key, input.criterionEvidencePlane.evidencePlane]
        : null,
      input.methodRef ?? null,
      input.composes ?? null,
      input.approvalRef ?? null,
    ]),
  );
}

function amendmentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function resolveAcceptanceSubjectScope(
  workspaceId: string,
  subjectPlan: string,
  subjectHarnessSlug?: string,
): Promise<{ workspaceId: string; harnessSlug: string }> {
  const { sql } = getOrgPg();
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT harness_slug
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND plan_slug = ${subjectPlan}
       AND ${subjectHarnessSlug ? sql`harness_slug = ${subjectHarnessSlug}` : sql`TRUE`}
     ORDER BY harness_slug
     LIMIT 2`;
  if (rows.length === 0) {
    throw new Error(`invalid_args: acceptance BAR amendment subject plan '${subjectPlan}' was not found`);
  }
  if (rows.length > 1 && rows[0]!.harness_slug !== rows[1]!.harness_slug) {
    throw new Error(
      `invalid_args: acceptance BAR amendment subject plan '${subjectPlan}' is ambiguous across harnesses`,
    );
  }
  return { workspaceId, harnessSlug: rows[0]!.harness_slug };
}

type AcceptanceBarAmendmentMapping = { planItemIds: string[] };

/**
 * Build the post-amendment BAR view used by both dry-run and apply preflights.
 *
 * The live snapshot describes the currently persisted contract, while the
 * criteria/mappings here describe the candidate that the amendment is about to
 * write. Keep structured verification fields from the candidate explicitly:
 * scorecards:emit evaluates these fields at pre-vetting, so falling back to the
 * prior trace would let an amendment preview/apply a BAR that vetting must reject.
 */
export function buildAcceptanceBarAmendmentCandidate(
  snapshot: AcceptanceBarContractSnapshot,
  nextCriteria: RubricCriterion[],
  desiredMappingByBar: ReadonlyMap<string, AcceptanceBarAmendmentMapping>,
  itemStatusById: ReadonlyMap<string, string>,
): AcceptanceBarContractSnapshot {
  const priorByKey = new Map(snapshot.bars.map((bar) => [bar.barKey, bar]));
  const bars: AcceptanceBarTrace[] = nextCriteria
    .filter((criterion) => criterion.role !== 'disclosure')
    .map((criterion) => {
      const barKey = criterion.barKey ?? criterion.key;
      const prior = priorByKey.get(barKey);
      const mapping = desiredMappingByBar.get(barKey);
      const planItemIds = mapping?.planItemIds ?? [];
      const statuses = planItemIds.map((planItemId) => itemStatusById.get(planItemId) ?? null);
      const mappingState: AcceptanceBarTrace['readiness']['mapping'] =
        planItemIds.length === 0
          ? 'missing'
          : statuses.every((status) => status === 'dropped')
            ? 'dropped-only'
            : 'live';
      const readinessCodes: AcceptanceBarTrace['readiness']['codes'] =
        mappingState === 'missing'
          ? ['bar_snapshot_mapping_missing']
          : mappingState === 'dropped-only'
            ? ['bar_snapshot_mapping_dropped_only']
            : [];
      const priorMappingByItem = new Map((prior?.mappings ?? []).map((candidate) => [candidate.planItemId, candidate]));
      const mappings = planItemIds.map((planItemId) => {
        const priorMapping = priorMappingByItem.get(planItemId);
        return {
          ...(priorMapping ?? {}),
          planItemId,
          planItemStatus: itemStatusById.get(planItemId) ?? priorMapping?.planItemStatus ?? null,
          specId: priorMapping?.specId ?? `AUTO-BAR-${barKey}-${planItemId}`,
          specRevision: priorMapping?.specRevision ?? 0,
          specContentHash: priorMapping?.specContentHash ?? '',
          sourceValId: priorMapping?.sourceValId ?? null,
          sourceBarHash: criterion.barHash ?? priorMapping?.sourceBarHash ?? null,
          sourceBarSetHash: priorMapping?.sourceBarSetHash ?? snapshot.plan?.barSetHash ?? null,
          sourceRubricRevision: priorMapping?.sourceRubricRevision ?? snapshot.rubric?.revision ?? null,
          evidencePlane: criterion.evidencePlane ?? priorMapping?.evidencePlane ?? null,
        };
      });
      return {
        ...(prior ?? {}),
        barKey,
        criterionKey: criterion.key,
        title: criterion.title,
        barHash: criterion.barHash ?? null,
        model: criterion.model ?? '',
        method: criterion.method ?? '',
        check: criterion.check ?? null,
        replication: criterion.replication ?? null,
        falsifier: criterion.driftMarkers ?? '',
        role: criterion.role ?? null,
        mandatory: criterion.mandatory ?? null,
        requiredScope: criterion.requiredScope ?? [],
        evidencePlane: criterion.evidencePlane ?? null,
        requiredTestLayers: criterion.requiredTestLayers ?? [],
        passRatings: criterion.passRatings ?? [],
        coversBarKeys: criterion.coversBarKeys ?? [],
        provenance: criterion.barProvenance ?? null,
        mappings,
        workContracts: prior?.workContracts ?? [],
        proof: prior?.proof ?? {
          state: 'missing',
          history: [],
          currentEvidence: 0,
          staleEvidence: 0,
          kinds: [],
          evidenceRefs: [],
          uncertainEvidence: 0,
          evidencePlanes: [],
          adequacy: { state: 'unknown', checks: [] },
        },
        grading: prior?.grading ?? {
          state: 'missing',
          history: [],
          scorecardId: null,
          rubricRevision: null,
          gradedBy: null,
          selectedVia: null,
          rating: null,
          evidence: null,
        },
        // Recompute candidate structural readiness rather than carrying stale
        // method/projection codes from the pre-amendment snapshot. Execution
        // fields are evaluated by the lifecycle evaluator below.
        readiness: {
          state: readinessCodes.length === 0 ? 'ready' : 'blocked',
          codes: readinessCodes,
          mapping: mappingState,
          method: criterion.method?.trim() ? 'declared' : 'missing',
          workContract: prior?.readiness.workContract ?? 'missing',
        },
      };
    });
  return { ...snapshot, bars };
}

async function amendAcceptanceBarRubric(
  input: AmendRubricInput,
  rubricScope: { workspaceId: string; harnessSlug: string },
  preview = false,
): Promise<AcceptanceAmendmentResult | null> {
  const rubricHint = await getRubric(input.rubricId);
  const subjectPlanHint = rubricHint?.subjectPlan;
  if (!subjectPlanHint) return null;
  const subjectScope = await resolveAcceptanceSubjectScope(
    rubricScope.workspaceId,
    subjectPlanHint,
    rubricHint?.subjectHarnessSlug,
  );
  const txResult = await withAcceptanceBarAmendmentTransaction(
    {
      plans: [
        { ...rubricScope, planSlug: input.rubricId },
        { ...subjectScope, planSlug: subjectPlanHint },
      ],
    },
    async (tx) => {
      const rubricRows = await tx<AcceptanceAmendmentPlanRow[]>`
        SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
               title, status, created, updated, owner, archived, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${rubricScope.workspaceId}
           AND harness_slug = ${rubricScope.harnessSlug}
           AND plan_slug = ${input.rubricId}
         FOR UPDATE`;
      const subjectRows = await tx<AcceptanceAmendmentPlanRow[]>`
        SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version,
               title, status, created, updated, owner, archived, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${subjectScope.workspaceId}
           AND harness_slug = ${subjectScope.harnessSlug}
           AND plan_slug = ${subjectPlanHint}
         FOR UPDATE`;
      const rubricRow = rubricRows[0];
      const subjectRow = subjectRows[0];
      if (!rubricRow || !subjectRow) return null;
      const stored = rubricFromLockedPlan(input.rubricId, rubricRow.content, rubricRow.template_data, rubricScope);
      if (!stored || stored.kind !== 'acceptance' || stored.subjectPlan !== subjectPlanHint ||
          (stored.subjectHarnessSlug && stored.subjectHarnessSlug !== subjectScope.harnessSlug)) return null;

      // An explicit replay token identifies the original request, including its
      // approval receipt. Handle retries before CAS and re-applying append text.
      const replay =
        input.idempotencyKey &&
        parsePlan(subjectRow.content).decisions.find((decision) =>
          decision.body.split('\n').includes(`Amendment-Id: ${input.idempotencyKey!.trim()}`),
        );
      if (replay && !preview) {
        if (!replay.body.split('\n').includes(`Request-Hash: ${amendmentRequestHash(input)}`)) {
          throw new Error('acceptance_bar_amendment_replay_conflict');
        }
        return {
          rubric: stored,
          decisionId: replay.id,
          rubricRevision: Number(rubricRow.version),
          subjectPlanRevision: Number(subjectRow.version),
          barSetHash: stored.barSetHash!,
          changedBars: [],
          reboundContracts: 0,
          invalidated: { evidence: 0, scorecards: 0, vetting: 0 },
          idempotencyKey: input.idempotencyKey!.trim(),
          replayed: true,
        };
      }

      const amended = applyRubricAmendment(stored, input);
      const built = buildRubricTemplateData(amended);
      await assertRubricCompositionLinksResolve(amended);
      assertAcceptanceRubricCitationPathsResolve(amended.criteria, { root: amended.checkPathRoot });
      assertCriterionCheckPathsResolve(amended.criteria, { root: amended.checkPathRoot });
      const actorId = (input.actorId ?? input.by ?? stored.createdBy ?? '').trim();
      const reason = (input.reason ?? `rubrics:amend ${input.rubricId}`).trim();
      const oldRubricRevision = Number(rubricRow.version);
      const oldSubjectRevision = Number(subjectRow.version);
      if (input.expectedRubricRevision !== undefined && input.expectedRubricRevision !== oldRubricRevision) {
        throw new Error(
          `acceptance_bar_amendment_revision_conflict: rubric '${input.rubricId}' expected ${input.expectedRubricRevision}, live ${oldRubricRevision}`,
        );
      }
      if (input.expectedSubjectPlanRevision !== undefined && input.expectedSubjectPlanRevision !== oldSubjectRevision) {
        throw new Error(
          `acceptance_bar_amendment_revision_conflict: subject plan '${subjectPlanHint}' expected ${input.expectedSubjectPlanRevision}, live ${oldSubjectRevision}`,
        );
      }

      const nextRubricRevision = oldRubricRevision + 1;
      const nextSubjectRevision = oldSubjectRevision + 1;
      const guard = guardAcceptanceBarTemplateDataWrite({
        slug: input.rubricId,
        storedTemplateData: rubricRow.template_data,
        nextTemplateData: built.data,
        subjectPlan: {
          status: subjectRow.status,
          revision: nextSubjectRevision,
          adoptionEpoch: undefined,
          cohort: undefined,
        },
        actorId,
        amendment: {
          actorId,
          reason,
        },
      });
      const changedBars = guard.changes
        .filter((change) => ['added', 'removed', 'meaning'].includes(change.kind))
        .map((change) => change.barKey);

      if (!actorId) throw new Error(`invalid_args: acceptance BAR amendment requires an authenticated actor`);
      if (!reason) throw new Error(`invalid_args: acceptance BAR amendment requires a non-empty reason`);
      const approvalRequest: AcceptanceBarApproval = {
        schemaVersion: 1,
        kind: 'acceptance-bar-amendment-approval',
        rubricRef: input.rubricId,
        subjectPlan: subjectPlanHint,
        bars: changedBars.map((barKey) => ({
          barKey,
          priorBarHash:
            stored.criteria.find((criterion) => (criterion.barKey ?? criterion.key) === barKey)?.barHash ?? null,
          nextBarHash:
            ((guard.data.criteria as Array<Record<string, unknown>>).find(
              (criterion) => (criterion.barKey ?? criterion.key) === barKey,
            )?.barHash as string | undefined) ?? null,
        })),
      };
      const approval =
        preview || changedBars.length === 0
          ? null
          : await resolveAcceptanceBarApproval(tx as never, {
              workspaceId: subjectScope.workspaceId,
              approvalRef: input.approvalRef,
              approvedBy: input.approvedBy,
              expected: approvalRequest,
            });
      if (approval) {
        const implementers = await resolvePlanImplementerIdentities(subjectPlanHint, {
          sql: tx as never,
          workspaceId: subjectScope.workspaceId,
        });
        for (const implementer of new Set([actorId, stored.createdBy, subjectRow.owner, ...implementers])) {
          if (
            implementer &&
            (await areAcceptanceLineageRelated(approval.approvedBy, implementer, {
              sql: tx as never,
              workspaceId: subjectScope.workspaceId,
            }))
          ) {
            throw new Error(
              `acceptance_bar_approval_in_implementer_lineage: '${approval.approvedBy}' is related to '${implementer}'`,
            );
          }
        }
      }

      const nextBarHashes = (guard.data.criteria as Array<Record<string, unknown>>)
        .map((criterion) => String(criterion.barHash ?? ''))
        .filter(Boolean);
      const idempotencyKey =
        input.idempotencyKey?.trim() ||
        acceptanceBarAmendmentKey({
          rubricId: input.rubricId,
          subjectPlan: subjectPlanHint,
          actorId,
          reason,
          priorRubricRevision: oldRubricRevision,
          nextBarHashes,
        });
      if (decisionHasAmendmentKey(subjectRow.content, idempotencyKey)) {
        return {
          rubric: stored,
          decisionId: parsePlan(subjectRow.content).decisions.find((d) =>
            d.body.includes(`Amendment-Id: ${idempotencyKey}`),
          )!.id,
          rubricRevision: oldRubricRevision,
          subjectPlanRevision: oldSubjectRevision,
          barSetHash: stored.barSetHash ?? String(guard.data.barSetHash ?? ''),
          changedBars,
          reboundContracts: 0,
          invalidated: { evidence: 0, scorecards: 0, vetting: 0 },
          idempotencyKey,
          replayed: true,
        };
      }

      const clauses = await tx<AcceptanceAmendmentClauseRow[]>`
        SELECT c.spec_id, c.source_val_id, c.current_revision, r.source_bar_key,
               r.plan_item_id, r.behavior, r.behavior_class, r.required_evidence,
               r.required_test_layers, r.mutation_required, r.lifecycle_status,
               r.supersedes_spec_id, r.supersedes_revision, r.exemption
          FROM harness_shared.plan_spec_clauses c
          JOIN harness_shared.plan_spec_clause_revisions r
            ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
           AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
           AND r.revision = c.current_revision
         WHERE c.workspace_id = ${subjectScope.workspaceId}
           AND c.harness_slug = ${subjectScope.harnessSlug}
           AND c.plan_slug = ${subjectPlanHint}
           AND r.source_bar_key IS NOT NULL
         ORDER BY c.spec_id LIMIT 1001`;
      if (clauses.length > 1000) throw new Error('acceptance_bar_revision_projection_truncated');
      const { parseRequirementBars, parseBarMappings } = await import('./acceptance-bar-seed');
      const requirements = parseRequirementBars(subjectRow.content);
      if (!requirements.ok) {
        throw new Error(
          `acceptance_bar_amendment_requirements_invalid:${requirements.problems.map((problem) => problem.code).join(',')}`,
        );
      }
      const desiredMappings = parseBarMappings(subjectRow.content, new Set(requirements.bars.map((bar) => bar.barKey)));
      if (!desiredMappings.ok) {
        throw new Error(
          `acceptance_bar_amendment_mapping_invalid:${desiredMappings.problems.map((problem) => problem.code).join(',')}`,
        );
      }
      const desiredMappingByBar = new Map(desiredMappings.mappings.map((mapping) => [mapping.barKey, mapping]));
      const itemIds = [
        ...new Set([
          ...clauses.map((clause) => clause.plan_item_id),
          ...desiredMappings.mappings.flatMap((mapping) => mapping.planItemIds),
        ]),
      ];
      const itemRows = itemIds.length
        ? await tx<{ item_id: string; status: string }[]>`
            SELECT item_id, status FROM harness_shared.plan_items
             WHERE workspace_id = ${subjectScope.workspaceId}
               AND harness_slug = ${subjectScope.harnessSlug}
               AND plan_slug = ${subjectPlanHint}
               AND item_id = ANY(${itemIds}::text[])`
        : [];
      const liveItems = new Set(itemRows.filter((row) => row.status !== 'dropped').map((row) => row.item_id));
      for (const barKey of changedBars) {
        const mappedItemIds = new Set([
          ...clauses.filter((clause) => clause.source_bar_key === barKey).map((clause) => clause.plan_item_id),
          ...(desiredMappingByBar.get(barKey)?.planItemIds ?? []),
        ]);
        if (![...mappedItemIds].some((planItemId) => liveItems.has(planItemId))) {
          throw new Error(
            `acceptance_bar_amendment_no_live_discharge_mapping: BAR '${barKey}' has no live mapped plan item`,
          );
        }
      }

      const {
        readAcceptanceBarContractSnapshot,
        diffAcceptanceBarContractSnapshots,
      } = await import('./acceptance-bar-contract-snapshot');
      const { evaluateAcceptanceBarLifecycle } = await import('./acceptance-bar-lifecycle-evaluator');
      const snapshot = await readAcceptanceBarContractSnapshot(subjectPlanHint, {}, {
        harnessSlug: subjectScope.harnessSlug,
      });
      if (
        preview &&
        (snapshot.completeness.truncated ||
          snapshot.completeness.problems.some((problem) => problem.code === 'bar_snapshot_source_unavailable'))
      ) {
        throw new Error('acceptance_bar_amendment_preview_source_incomplete');
      }
      const nextCriteria = guard.data.criteria as unknown as RubricCriterion[];
      const itemStatusById = new Map(itemRows.map((row) => [row.item_id, row.status]));
      const candidate = buildAcceptanceBarAmendmentCandidate(
        snapshot,
        nextCriteria,
        desiredMappingByBar,
        itemStatusById,
      );
      const nextTemplateData = guard.data as { barContract?: { adoptionEpoch?: number | null } };
      const startedBar =
        stored.barContract?.adoptionEpoch != null || nextTemplateData.barContract?.adoptionEpoch != null;
      // A classRef bind is metadata-only: it changes neither the BAR set nor any
      // criterion meaning. Do not make this repair depend on the started contract
      // being ready for vetting; draft plans intentionally reach this path before
      // METHOD/check fields are authored. Meaning-changing amendments still take
      // the full pre-vetting lifecycle gate below.
      if (startedBar && changedBars.length > 0) {
        const lifecycle = evaluateAcceptanceBarLifecycle(
          candidate.applicable ? candidate : { ...candidate, applicable: true },
          'pre-vetting',
        );
        if (!lifecycle.satisfied) {
          throw new Error(
            lifecycle.message ?? 'acceptance_bar_amendment_candidate_not_ready_for_vetting',
          );
        }
      }

      if (changedBars.length === 0 && !preview) return {
        rubric: stored, decisionId: '', rubricRevision: oldRubricRevision,
        subjectPlanRevision: oldSubjectRevision, barSetHash: stored.barSetHash!,
        changedBars, reboundContracts: 0, invalidated: { evidence: 0, scorecards: 0, vetting: 0 },
        idempotencyKey: '', methodOnly: true,
      };

      if (preview) {
        const changes = diffAcceptanceBarContractSnapshots(snapshot, candidate, 'amend').changes;
        const open = changedBars.length
          ? await tx<Array<{ work_item_id: string }>>`
          SELECT DISTINCT e.work_item_id FROM harness_shared.work_item_spec_revision_edges e
            JOIN harness_shared.work_items w ON w.workspace_id=e.workspace_id
             AND w.harness_slug=e.harness_slug AND w.feature_id=e.work_item_id
            JOIN harness_shared.plan_spec_clauses c ON c.workspace_id=e.workspace_id
             AND c.harness_slug=e.harness_slug AND c.plan_slug=e.plan_slug AND c.spec_id=e.spec_id
           WHERE e.workspace_id=${subjectScope.workspaceId} AND e.harness_slug=${subjectScope.harnessSlug}
             AND e.plan_slug=${subjectPlanHint} AND e.spec_id=ANY(${clauses.map((clause) => clause.spec_id)}::text[])
             AND e.spec_revision=c.current_revision
             AND w.status NOT IN ('done','dropped','resolved','closed','passed','deprecated')
           ORDER BY e.work_item_id LIMIT 1001`
          : [];
        if (open.length > 1000) throw new Error('acceptance_bar_amendment_preview_work_truncated');
        const missingMethod = nextCriteria.some((criterion) => criterion.mandatory && !criterion.method?.trim());
        return {
          rubric: stored,
          decisionId: '',
          rubricRevision: oldRubricRevision,
          subjectPlanRevision: oldSubjectRevision,
          barSetHash: stored.barSetHash!,
          changedBars,
          reboundContracts: 0,
          invalidated: { evidence: 0, scorecards: 0, vetting: 0 },
          idempotencyKey,
          preview: {
            rubricRevision: oldRubricRevision,
            subjectPlanRevision: oldSubjectRevision,
            priorBarSetHash: stored.barSetHash!,
            nextBarSetHash: String(guard.data.barSetHash),
            changedBars,
            projectionCount: candidate.bars.reduce((count, bar) => count + bar.mappings.length, 0),
            approval: approvalRequest,
            approvalRequired: changedBars.length > 0,
            sourceSnapshotHash: snapshot.contentHash,
            changes,
            revisionMovement: {
              rubric: { from: oldRubricRevision, to: nextRubricRevision },
              subject: { from: oldSubjectRevision, to: changedBars.length ? nextSubjectRevision : oldSubjectRevision },
            },
            invalidatedProofRefs: [...new Set(snapshot.bars.flatMap((bar) => bar.proof.evidenceRefs))].sort(),
            invalidatedScorecardIds: [...snapshot.sourceRevisions.scorecardIds].sort(),
            authorVerdictBecomesStale: ['accepted', 'rejected'].includes(snapshot.grading.authorVerdict.state),
            reboundWorkItemIds: open.map((row) => row.work_item_id),
            cohortDisposition: {
              cohort: snapshot.plan?.cohort ?? null,
              adoptionEpoch: snapshot.plan?.adoptionEpoch ?? null,
              action: 'preserve' as const,
            },
            nextRepair: missingMethod
              ? {
                  code: 'bar_snapshot_method_missing',
                  action: 'Fill every mandatory METHOD before vetting or grading.',
                }
              : {
                  code: 'bar_snapshot_proof_stale',
                  action:
                    'Bind proof to the new spec revisions, then refresh vetting and independent grading; historical ship verdicts remain recorded but cannot authorize this revision.',
                },
          },
        };
      }
      const decisionId = allocateNextDecisionId(subjectRow.content);
      const decisionBody = [
        `Amendment-Id: ${idempotencyKey}`,
        `Request-Hash: ${amendmentRequestHash(input)}`,
        `Actor: ${actorId}`,
        `Reason: ${reason}`,
        ...(approval
          ? [
              `Approved-By: ${approval.approvedBy}`,
              `Approval-Ref: ${approval.approvalRef}`,
              `Approved-At: ${approval.approvedAt}`,
            ]
          : []),
        `Rubric revision: ${oldRubricRevision} → ${nextRubricRevision}`,
        `Subject plan revision: ${oldSubjectRevision} → ${nextSubjectRevision}`,
        `Changed BARs: ${changedBars.join(', ')}`,
        'Prior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.',
      ].join('\n');
      const subjectBody = bumpUpdatedDate(
        appendDecisionToBody(
          subjectRow.content,
          decisionId,
          'Acceptance BAR amendment',
          decisionBody,
          amendmentDate(),
          [],
        ),
      );
      injectAmendmentFault(input, 'after-decision');

      const rubricBody = preserveRubricPlanBody(rubricRow.content, {
        title: amended.title,
        planStatus: rubricStatusToPlanStatus(stored.status),
        owner: amended.by ?? null,
      });
      const rubricIdx = deriveIndexFromContent(rubricBody);
      const rubricForcedPast = summarizeForcedPast(rubricBody);
      const rubricTemplateJson = JSON.stringify(guard.data);
      const rubricHash = hashPlanContent(rubricBody);
      await tx`
        UPDATE harness_shared.harness_plans
           SET content = ${rubricBody}, content_hash = ${rubricHash}, version = ${nextRubricRevision},
               title = ${rubricIdx.title}, status = ${rubricIdx.status}, created = ${rubricIdx.created},
               updated = ${rubricIdx.updated}, owner = ${rubricIdx.owner}, initiative = ${rubricIdx.initiative},
               template = ${rubricIdx.template}, supersedes = ${rubricIdx.supersedes},
               superseded_by = ${rubricIdx.supersededBy}, is_legacy = ${rubricIdx.isLegacy},
               items = ${JSON.stringify(rubricIdx.items)}::text::jsonb,
               decisions = ${JSON.stringify(rubricIdx.decisions)}::text::jsonb,
               now_state = ${rubricIdx.nowState}, now_next = ${rubricIdx.nowNext},
               promote_policy = ${JSON.stringify(rubricIdx.promotePolicy)}::text::jsonb,
               forced_past = ${rubricForcedPast ? JSON.stringify(rubricForcedPast) : null}::text::jsonb,
               template_data = ${rubricTemplateJson}::text::jsonb, updated_at = now(), origin = 'local'
         WHERE workspace_id = ${rubricScope.workspaceId}
           AND harness_slug = ${rubricScope.harnessSlug}
           AND plan_slug = ${input.rubricId}`;
      await writePlanIndexRows(
        tx as never,
        { workspaceId: rubricScope.workspaceId, harnessSlug: rubricScope.harnessSlug, planSlug: input.rubricId },
        rubricIdx,
      );
      injectAmendmentFault(input, 'after-rubric');

      const subjectIdx = deriveIndexFromContent(subjectBody);
      const subjectForcedPast = summarizeForcedPast(subjectBody);
      const subjectHash = hashPlanContent(subjectBody);
      await tx`
        UPDATE harness_shared.harness_plans
           SET content = ${subjectBody}, content_hash = ${subjectHash}, version = ${nextSubjectRevision},
               title = ${subjectIdx.title}, status = ${subjectIdx.status}, created = ${subjectIdx.created},
               updated = ${subjectIdx.updated}, owner = ${subjectIdx.owner}, initiative = ${subjectIdx.initiative},
               template = ${subjectIdx.template}, supersedes = ${subjectIdx.supersedes},
               superseded_by = ${subjectIdx.supersededBy}, is_legacy = ${subjectIdx.isLegacy},
               items = ${JSON.stringify(subjectIdx.items)}::text::jsonb,
               decisions = ${JSON.stringify(subjectIdx.decisions)}::text::jsonb,
               now_state = ${subjectIdx.nowState}, now_next = ${subjectIdx.nowNext},
               promote_policy = ${JSON.stringify(subjectIdx.promotePolicy)}::text::jsonb,
               forced_past = ${subjectForcedPast ? JSON.stringify(subjectForcedPast) : null}::text::jsonb,
               acceptance_bar_set_hash = ${String(guard.data.barSetHash ?? '')},
               acceptance_bar_rubric_slug = ${input.rubricId},
               acceptance_bar_rubric_revision = ${nextRubricRevision},
               acceptance_bar_seeded_at = now(), acceptance_bar_seeded_by = ${actorId},
               updated_at = now(), origin = 'local'
         WHERE workspace_id = ${subjectScope.workspaceId}
           AND harness_slug = ${subjectScope.harnessSlug}
           AND plan_slug = ${subjectPlanHint}`;
      await writePlanIndexRows(
        tx as never,
        { workspaceId: subjectScope.workspaceId, harnessSlug: subjectScope.harnessSlug, planSlug: subjectPlanHint },
        subjectIdx,
      );

      // Every projection pins the GLOBAL rubric revision and BAR-set hash,
      // including BARs whose individual meaning did not change.
      const newClauseRevisions = await synchronizeAcceptanceBarRevision(tx as never, {
        ...subjectScope,
        rubricSlug: input.rubricId,
        rubricRevision: nextRubricRevision,
        templateData: guard.data,
        actorId,
      });
      injectAmendmentFault(input, 'after-projection');

      const currentClauses = await tx<
        Array<{
          spec_id: string;
          current_revision: number | string;
          plan_item_id: string;
        }>
      >`
        SELECT c.spec_id, c.current_revision, r.plan_item_id
          FROM harness_shared.plan_spec_clauses c
          JOIN harness_shared.plan_spec_clause_revisions r
            ON r.workspace_id=c.workspace_id AND r.harness_slug=c.harness_slug
           AND r.plan_slug=c.plan_slug AND r.spec_id=c.spec_id AND r.revision=c.current_revision
         WHERE c.workspace_id=${subjectScope.workspaceId} AND c.harness_slug=${subjectScope.harnessSlug}
           AND c.plan_slug=${subjectPlanHint} AND r.source_bar_key IS NOT NULL
         ORDER BY c.spec_id LIMIT 1001`;
      if (currentClauses.length > 1000) throw new Error('acceptance_bar_revision_projection_truncated');
      const priorRevisionBySpec = new Map(clauses.map((clause) => [clause.spec_id, Number(clause.current_revision)]));
      let reboundContracts = 0;
      for (const clause of currentClauses) {
        const revision = newClauseRevisions.get(clause.spec_id) ?? Number(clause.current_revision);
        const priorRevision = priorRevisionBySpec.get(clause.spec_id);
        if (priorRevision !== undefined && revision === priorRevision) continue;
        const explicit =
          priorRevision === undefined
            ? []
            : await tx<{ work_item_id: string }[]>`
          SELECT e.work_item_id
            FROM harness_shared.work_item_spec_revision_edges e
            JOIN harness_shared.work_items w
              ON w.workspace_id = e.workspace_id AND w.harness_slug = e.harness_slug
             AND w.feature_id = e.work_item_id
           WHERE e.workspace_id = ${subjectScope.workspaceId}
             AND e.harness_slug = ${subjectScope.harnessSlug}
             AND e.plan_slug = ${subjectPlanHint}
             AND e.spec_id = ${clause.spec_id}
             AND e.spec_revision = ${priorRevision}`;
        const covered = await tx<{ work_item_id: string }[]>`
          SELECT w.feature_id AS work_item_id
            FROM harness_shared.work_items w
           WHERE w.workspace_id=${subjectScope.workspaceId} AND w.harness_slug=${subjectScope.harnessSlug}
             AND (
               (w.source_plan_slug=${subjectPlanHint} AND ${clause.plan_item_id}=ANY(COALESCE(w.source_plan_item_ids,ARRAY[]::text[])))
               OR (w.payload->'plan_item'->>'slug'=${subjectPlanHint} AND w.payload->'plan_item'->>'item'=${clause.plan_item_id})
             )`;
        const open = [...new Set([...explicit, ...covered].map((row) => row.work_item_id))];
        const current = await tx<{ content_hash: string }[]>`
          SELECT content_hash FROM harness_shared.plan_spec_clause_revisions
           WHERE workspace_id = ${subjectScope.workspaceId} AND harness_slug = ${subjectScope.harnessSlug}
             AND plan_slug = ${subjectPlanHint} AND spec_id = ${clause.spec_id} AND revision = ${revision}`;
        const fingerprint = current[0]?.content_hash;
        if (!fingerprint) continue;
        for (const workItemId of open) {
          await tx`
            INSERT INTO harness_shared.work_item_spec_revision_edges (
              workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
              spec_revision, spec_fingerprint, created_by
            ) VALUES (
              ${subjectScope.workspaceId}, ${subjectScope.harnessSlug}, ${workItemId}, ${subjectPlanHint},
              ${clause.spec_id}, ${revision}, ${fingerprint}, ${actorId}
            ) ON CONFLICT DO NOTHING`;
          reboundContracts += 1;
        }
      }
      injectAmendmentFault(input, 'after-rebind');

      const evidence = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM harness_shared.spec_evidence_bindings e
          JOIN harness_shared.plan_spec_clauses c
            ON c.workspace_id = e.workspace_id AND c.harness_slug = e.harness_slug
           AND c.plan_slug = e.plan_slug AND c.spec_id = e.spec_id
         WHERE e.workspace_id = ${subjectScope.workspaceId} AND e.harness_slug = ${subjectScope.harnessSlug}
           AND e.plan_slug = ${subjectPlanHint} AND e.spec_id = ANY(${currentClauses.map((c) => c.spec_id)}::text[])
           AND e.spec_revision < c.current_revision`;
      const scorecards = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM harness_shared.work_items
         WHERE workspace_id = ${subjectScope.workspaceId}
           AND payload -> 'observation' ->> 'rubricRef' = ${input.rubricId}
           AND (payload -> 'observation' ->> 'rubricRevision')::int = ${oldRubricRevision}`;
      const vetting = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM harness_shared.work_items
         WHERE workspace_id = ${subjectScope.workspaceId}
           AND payload -> 'observation' ->> 'rubricRef' = ${META_ACCEPTANCE_RUBRIC_ID}
           AND payload -> 'observation' -> 'subject' ->> 'ref' = ${input.rubricId}
           AND (payload -> 'observation' ->> 'rubricRevision')::int = ${oldRubricRevision}`;

      const projected = planRowToRubric({
        plan_slug: input.rubricId,
        version: nextRubricRevision,
        workspace_id: rubricScope.workspaceId,
        harness_slug: rubricScope.harnessSlug,
        title: rubricIdx.title,
        status: rubricIdx.status,
        created: rubricIdx.created,
        updated: rubricIdx.updated,
        updated_at: new Date().toISOString(),
        owner: rubricIdx.owner,
        archived: false,
        template_data: guard.data,
      });
      if (!projected) throw new Error(`acceptance_bar_amendment: amended rubric failed projection`);
      return {
        rubric: projected,
        decisionId,
        rubricRevision: nextRubricRevision,
        subjectPlanRevision: nextSubjectRevision,
        barSetHash: String(guard.data.barSetHash),
        changedBars,
        reboundContracts,
        invalidated: {
          evidence: Number(evidence[0]?.count ?? 0),
          scorecards: Number(scorecards[0]?.count ?? 0),
          vetting: Number(vetting[0]?.count ?? 0),
        },
        idempotencyKey,
        rubricBody,
        subjectBody,
        templateData: guard.data,
      } satisfies AcceptanceAmendmentResult;
    },
  );
  if (!txResult) return null;
  if (txResult.replayed || txResult.preview || txResult.methodOnly) return txResult;
  // Revision rows are audit history.  The data transaction above remains the
  // atomic source of truth; these best-effort records make both plans visible
  // through the existing plan-revisions reader.
  const identity: AgentIdentity = {
    ownerId: input.actorId ?? input.by ?? 'rubrics:system',
    ownerLabel: input.actorId ?? input.by ?? 'rubrics:system',
    source: 'static-client',
    workspaceId: null,
    userId: null,
  };
  const criteriaHash =
    txResult.rubricBody && txResult.templateData
      ? await rubricRevisionCriteriaHash(txResult.templateData, rubricScope)
      : null;
  await Promise.all([
    txResult.rubricBody && txResult.templateData
      ? recordPlanRevision({
          planSlug: input.rubricId,
          harnessSlug: rubricScope.harnessSlug,
          workspaceId: rubricScope.workspaceId,
          content: rubricRevisionSnapshot(txResult.rubricBody, txResult.templateData, criteriaHash),
          rationale: `acceptance BAR amendment ${txResult.idempotencyKey}`,
          identity,
        })
      : Promise.resolve(null),
    txResult.subjectBody
      ? recordPlanRevision({
          planSlug: subjectPlanHint,
          harnessSlug: subjectScope.harnessSlug,
          workspaceId: subjectScope.workspaceId,
          content: txResult.subjectBody,
          rationale: `acceptance BAR amendment ${txResult.idempotencyKey}`,
          identity,
        })
      : Promise.resolve(null),
  ]);
  return txResult;
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
export async function previewAcceptanceBarAmendment(
  input: AmendRubricInput,
): Promise<AcceptanceBarAmendmentPreview | null> {
  const scope = await resolveRubricWriteScope(input.rubricId);
  return (await amendAcceptanceBarRubric(input, scope, true))?.preview ?? null;
}

export async function amendRubric(input: AmendRubricInput): Promise<Rubric | null> {
  const scope = await resolveRubricWriteScope(input.rubricId);
  let methodOnlyRevision: number | undefined;
  // A started acceptance BAR is a cross-plan contract: changing its MODEL or
  // falsifier must update the subject plan, projection revisions, and open
  // work-item contracts in the same transaction.  METHOD/title/criterion-class
  // edits remain on the ordinary single-plan path.
  const currentForRouting = await getRubric(input.rubricId);
  if (
    currentForRouting?.kind === 'acceptance' &&
    currentForRouting.barContract &&
    (input.criteria ||
      input.requirement ||
      input.criterionEvidencePlane ||
      (input.criterion && (input.criterion.field === 'model' || input.criterion.field === 'driftMarkers')))
  ) {
    const amended = await amendAcceptanceBarRubric(input, scope);
    // A null reread still refuses. Only an explicit, locked method-only result
    // may use the ordinary writer, which refreshes the dependent revision pins.
    if (!amended?.methodOnly) return amended?.rubric ?? null;
    methodOnlyRevision = amended.rubricRevision;
  }
  const compatibilityAudit: { current?: RubricCompatibilityAudit } = {};
  const result = await withPlanLock<true | null>(
    null,
    {
      slug: input.rubricId,
      intent: `rubrics:amend ${input.rubricId}`,
      ...(input.by ? { actorId: input.by } : {}),
      ...scope,
      afterWrite: rubricRevisionAfterWrite(
        input.rubricId,
        input.by,
        'rubrics:amend',
        undefined,
        () => compatibilityAudit.current,
      ),
    },
    async (current, meta) => {
      const stored = rubricFromLockedPlan(input.rubricId, current, meta?.templateData ?? null, scope);
      if (!current || !stored) return { newBody: null, value: null };
      if (methodOnlyRevision !== undefined && meta?.version !== methodOnlyRevision) {
        throw new Error('acceptance_bar_amendment_revision_conflict: rubric changed before method update');
      }

      // Build and validate the replacement from the locked snapshot. This keeps
      // the loss guards and template schema on the same side of the advisory lock
      // as the read-modify-write itself.
      const amended = applyRubricAmendment(stored, input);
      const builtTemplateData = buildRubricTemplateData(amended);
      await assertRubricCompositionLinksResolve(amended);
      const templateData = builtTemplateData.data;
      compatibilityAudit.current = builtTemplateData.compatibility;
      // Record the acceptance-BAR MEANING EPOCH alongside the revision bump.
      // THIS is the writer that advances the revision for a method-only edit:
      // `amendRubric` routes only model/driftMarkers/requirement/evidence-plane
      // edits to the cross-plan amender, and that amender RETURNS EARLY with
      // methodOnly when no BAR meaning changed — so every meaning-preserving
      // edit (a method rewrite, a title fix, a criterion-class change) lands
      // here and bumps `version` with the BAR contract untouched. Without an
      // epoch, that bump alone reads downstream as "re-grade and re-vet".
      if (stored.kind === 'acceptance' && stored.barContract) {
        const priorRevision = Number(meta?.version ?? 0);
        const contract = (templateData as { barContract?: Record<string, unknown> }).barContract;
        if (contract && Number.isFinite(priorRevision) && priorRevision > 0) {
          const meaningRevision = nextAcceptanceBarMeaningRevision({
            priorCriteria: stored.criteria,
            nextCriteria: amended.criteria,
            priorMeaningRevision: stored.barContract.meaningRevision ?? null,
            priorRevision,
            nextRevision: priorRevision + 1,
          });
          if (meaningRevision !== undefined) contract.meaningRevision = meaningRevision;
        }
      }
      if (amended.kind === 'acceptance') {
        assertAcceptanceRubricCitationPathsResolve(amended.criteria, { root: amended.checkPathRoot });
      }
      if (amended.kind === 'acceptance') await assertAcceptanceLinksResolve(amended);
      assertNoSilentRubricLoss(stored, amended);
      assertCriterionCheckPathsResolve(amended.criteria, { root: amended.checkPathRoot });

      // Keep the current narrative body (requirements, plan items, decisions,
      // and any hand-authored evidence context) intact. A criterion amendment
      // owns only the rubric frontmatter fields and template_data; regenerating
      // the generic scaffold here would erase those durable sections.
      const body = preserveRubricPlanBody(current, {
        title: amended.title,
        planStatus: rubricStatusToPlanStatus(amended.status ?? stored.status),
        owner: amended.by ?? null,
      });

      return {
        newBody: body,
        // Same as propose: the in-lock boundary guard needs the amendment's own
        // acknowledgements (EI-21972673091438558) — `amended` is the re-proposal that
        // assertNoSilentRubricLoss just checked, so its acks are the authoritative ones.
        templateData: {
          data: templateData,
          rubricLossAck: rubricLossAckOf(amended),
          // Promise changes belong to the approved cross-plan transaction.
          // Re-check that invariant against this writer's locked current row.
        },
        value: true,
      };
    },
  );
  if (result.kind === 'busy') {
    throw new Error(`amendRubric: plan '${input.rubricId}' is being written by another caller`);
  }
  if (!result.value) return null;
  return getRubric(input.rubricId);
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
 * Ratify a proposed rubric → active (D-001: independent reviewer/owner gate) by promoting its plan
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
      `invalid_args: ratifyRubric: '${rubricId}' is an acceptance-kind rubric (the definition-of-done for ` +
        `${existing.subjectGoal ? `goal '${existing.subjectGoal}'` : `plan '${existing.subjectPlan ?? '?'}'`}) — acceptance rubrics are never ratified (acceptance-rubrics-on-every-plan ` +
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
  const persistedProposer = rawData && typeof rawData.proposedBy === 'string' ? rawData.proposedBy : null;
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
      afterWrite: rubricRevisionAfterWrite(
        rubricId,
        by,
        'rubrics:ratify → active',
        rawData && by ? { ...rawData, ratifiedBy: by } : rawData,
      ),
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
export async function retireAcceptanceRubricForPlan(
  planSlug: string,
  by?: string,
  options: { harnessSlug?: string } = {},
): Promise<string | null> {
  try {
    const rubric = await getAcceptanceRubricForPlan(planSlug, options);
    if (!rubric || rubric.status === 'retired') return null;
    const scope = await resolveRubricWriteScope(rubric.rubricId);
    const result = await withPlanLock<boolean>(
      null,
      {
        slug: rubric.rubricId,
        intent: `acceptance-rubric retire (subject plan '${planSlug}' shipped)`,
        ...scope,
        afterWrite: rubricRevisionAfterWrite(
          rubric.rubricId,
          by,
          'acceptance rubric retired with its shipped subject plan',
        ),
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
 * Retire a STANDARD rubric — the missing inverse of `ratifyRubric` (EI-20276435149948191).
 *
 * WHY THIS EXISTS WHEN THE STATE WAS ALREADY REACHABLE. A rubric IS a plan row, and
 * `planStatusToRubricStatus` maps a `superseded` plan → a `retired` rubric, so
 * `plans:set-plan-status { slug: <rubricId>, status:'superseded' }` already flipped one.
 * That route is not wrong, it is UNDISCOVERABLE and UNGUARDED: an agent looking to retire
 * a rubric reads the `rubrics:*` surface, finds propose (whole-document replace, resets to
 * `proposed`), ratify (`proposed`→`active`), amend (criterion prose only) and
 * set-history-reset (explicitly PRESERVES status) — and correctly concludes there is no
 * way out of `active`. That is exactly what EI-20276435149948191 filed, after the
 * 2026-08-09 Mug/Cup/Kettle retirement left `cup-lifecycle-durability`,
 * `kettle-supervision-health` and `mug-pot-coordination-health` stuck `active`, so the
 * staleness watchdog (which selects `listRubrics({ status:'active' })`) nagged forever for
 * scorecards whose instruments had been deleted.
 *
 * THE GUARD IS THE OTHER HALF, and it is why this is not just sugar over the plan verb.
 * An ACCEPTANCE rubric is a per-plan contract that archives WITH its subject plan
 * (acceptance-rubrics-on-every-plan-2026-08-11 P-005, `retireAcceptanceRubricForPlan`).
 * Hand-retiring one through the generic plan verb desyncs it from the plan whose
 * definition-of-done it IS — silently, because the plan verb has no idea it is looking at
 * a rubric. Refusing that here is the invariant the raw route cannot express.
 *
 * Unlike `ratifyRubric` there is deliberately NO author≠actor gate: retiring is a
 * custodial act (the subsystem is gone), not a governance promotion, and requiring an
 * independent second party to retire a rubric nobody can grade would strand it forever —
 * the very failure this fixes. Reversible by re-ratifying.
 */
export async function retireRubric(rubricId: string, by?: string, reason?: string): Promise<Rubric | null> {
  const existing = await getRubric(rubricId);
  if (!existing) return null;
  if (existing.kind === 'acceptance') {
    throw new Error(
      `invalid_args: retireRubric: '${rubricId}' is an acceptance-kind rubric (the definition-of-done for ` +
        `${existing.subjectGoal ? `goal '${existing.subjectGoal}'` : `plan '${existing.subjectPlan ?? '?'}'`}) — ` +
        'acceptance rubrics are never retired by hand: they archive WITH their subject plan ' +
        '(acceptance-rubrics-on-every-plan-2026-08-11 P-005). Ship or supersede that plan instead.',
    );
  }
  // Idempotent: already-retired is the goal state, not an error. Returning the rubric
  // (rather than null, which means not-found) keeps those two cases distinguishable.
  if (existing.status === 'retired') return existing;
  const scope = await resolveRubricWriteScope(rubricId);
  const result = await withPlanLock<boolean>(
    null,
    {
      slug: rubricId,
      intent: `rubrics:retire ${rubricId}`,
      ...scope,
      afterWrite: rubricRevisionAfterWrite(rubricId, by, `rubrics:retire → retired${reason ? ` (${reason})` : ''}`),
    },
    async (current) => {
      if (current === null) return { newBody: null, value: false };
      const flipped = setPlanFrontmatterStatus(current, rubricStatusToPlanStatus('retired'));
      if (flipped === null) return { newBody: null, value: false };
      return { newBody: bumpUpdatedDate(flipped), value: true };
    },
  );
  if (result.kind === 'busy') {
    throw new Error(`retireRubric: plan '${rubricId}' is being written by another caller`);
  }
  return getRubric(rubricId);
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
export async function setRubricHistoryReset(rubricId: string, at: string, by?: string): Promise<Rubric | null> {
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
      afterWrite: rubricRevisionAfterWrite(rubricId, by, `rubrics:set-history-reset → ${iso}`, {
        ...rawData,
        historyResetAt: iso,
      }),
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
export async function autoRatifyRubricOnFirstScorecard(rubricId: string, graderId: string): Promise<Rubric | null> {
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
