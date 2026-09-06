/**
 * Transactional Requirements → acceptance BAR seeding.
 *
 * `## Requirements` is the early human projection; after this write the active
 * acceptance-rubric criteria are canonical. The subject plan's existing
 * `### Bar-to-work map for this plan` table supplies the explicit many-to-many
 * R-N → P-NNN relation. No semantic inference and no second requirements store.
 */
import { createHash } from 'node:crypto';
import { parsePlan } from '@papercusp/plan-parser';
import {
  acceptanceRubricCriterionSchema,
  rubricTemplateDataAuthoringSchema,
  requirementSectionsSchema,
  type AcceptanceEvidencePlane,
} from './agent-tools/plans/rubric-template';
import { splitPlanSections } from './agent-tools/plans/plan-sections';
import {
  PLAN_ADVISORY_LOCK_NAMESPACE,
  planAdvisoryLockKey,
} from './agent-tools/plans/plan-lock-key';
import {
  setSpecClause,
  type SpecClauseSql,
  type SpecClauseWrite,
} from './agent-tools/plans/spec-clauses-store';
import { hashPlanContent } from './agent-tools/plans/content-hash';
import {
  buildRubricPlanBody,
  computeAcceptanceBarSetHash,
  DEFAULT_RATING_SCALE,
  normalizeAcceptanceBarCriterion,
  type ProposeRubricCriterion,
} from './rubrics';
import { guardAcceptanceBarTemplateDataWrite } from './agent-tools/plans/rubric-loss-guard';

export const ACCEPTANCE_BAR_CONTRACT_EPOCH = 1;
export const MAX_REQUIREMENT_BARS = 200;
export const MAX_BAR_PROJECTION_EDGES = 1_000;

export type AcceptanceBarCohort = 'post-epoch' | 'legacy-backfilled';

export type AcceptanceBarSeedCode =
  | 'bar_requirements_missing'
  | 'bar_requirement_parse_failed'
  | 'bar_key_duplicate'
  | 'bar_set_too_large'
  | 'bar_mapping_missing'
  | 'bar_mapping_duplicate'
  | 'bar_mapping_unknown'
  | 'bar_mapping_invalid'
  | 'bar_mapping_dropped_only'
  | 'bar_evidence_plane_invalid'
  | 'bar_projection_set_too_large'
  | 'bar_rubric_conflict'
  | 'bar_rubric_busy'
  | 'bar_amendment_required'
  | 'bar_projection_conflict'
  | 'bar_seed_persistence_failed';

export interface AcceptanceBarSeedProblem {
  code: AcceptanceBarSeedCode;
  detail: string;
  barKey?: string;
  planItemId?: string;
}

export interface ParsedRequirementBar {
  barKey: string;
  title: string;
  model: string;
  /** Present only for explicit three-section authoring; legacy prose stays legacy. */
  criterion?: ProposeRubricCriterion;
}

export interface ParsedBarMapping {
  barKey: string;
  planItemIds: string[];
  evidencePlane: AcceptanceEvidencePlane;
  evidencePlaneExplicit?: boolean;
}

export interface AcceptanceBarSeedBuildInput {
  planSlug: string;
  planContent: string;
  actorId: string;
  declaredAt: string;
  cohort: AcceptanceBarCohort;
  /** Server-owned late-authoring provenance; independent of enforcement cohort. */
  backfilled?: boolean;
  /** Explicit R-N → existing criterion identity adoption, only before a BAR contract exists. */
  legacyCriterionMap?: Record<string, string>;
  adoptionEpoch: number;
  subjectPlanRevision: number;
  /** Locked subject state; only the already-pinned started revision may reuse canonical BARs. */
  planStatus?: string | null;
  rubricSlug: string;
  rubricRevision: number;
  existingTemplateData?: unknown;
}

export type AcceptanceBarSeedBuildResult =
  | {
      ok: true;
      rubricSlug: string;
      barSetHash: string;
      templateData: Record<string, unknown>;
      criteria: ProposeRubricCriterion[];
      projections: SpecClauseWrite[];
      mappings: ParsedBarMapping[];
    }
  | {
      ok: false;
      error: AcceptanceBarSeedCode;
      message: string;
      problems: AcceptanceBarSeedProblem[];
    };

function refusal(problems: AcceptanceBarSeedProblem[]): AcceptanceBarSeedBuildResult {
  const first = problems[0] ?? {
    code: 'bar_seed_persistence_failed' as const,
    detail: 'BAR seeding failed without a diagnostic',
  };
  return {
    ok: false,
    error: first.code,
    message: `${problems.length} BAR seed problem(s): ${problems.map((p) => p.detail).join('; ')}`,
    problems,
  };
}

function sectionBody(planContent: string, heading: string): string | null {
  return splitPlanSections(planContent).find(
    (section) => section.heading.trim().toLowerCase() === heading.toLowerCase(),
  )?.body ?? null;
}

/** Parse the explicit `**R-N — Title.** body` records. Any malformed R-looking
 * record is a refusal; a partial parse must never shrink the BAR denominator. */
export function parseRequirementBars(planContent: string):
  | { ok: true; bars: ParsedRequirementBar[] }
  | { ok: false; problems: AcceptanceBarSeedProblem[] } {
  const body = sectionBody(planContent, 'Requirements');
  if (body === null) {
    return { ok: false, problems: [{ code: 'bar_requirements_missing', detail: 'plan has no ## Requirements section' }] };
  }
  const lines = body.split('\n');
  const bars: ParsedRequirementBar[] = [];
  const problems: AcceptanceBarSeedProblem[] = [];
  let current: { barKey: string; title: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const outcome = current.lines.join('\n').trim();
    if (outcome.includes('```requirement')) {
      const fenced = /^```requirement\s*\n([\s\S]*?)\n```$/.exec(outcome);
      try {
        if (!fenced) throw new Error('use one requirement JSON block with no competing prose');
        const sections = requirementSectionsSchema.parse(JSON.parse(fenced[1]!));
        const criterion = normalizeAcceptanceBarCriterion({
          key: current.barKey.toLowerCase(), title: current.title, barKey: current.barKey, ...sections,
        });
        bars.push({ barKey: current.barKey, title: current.title, model: criterion.model!, criterion });
      } catch (error) {
        problems.push({ code: 'bar_requirement_parse_failed', barKey: current.barKey,
          detail: `${current.barKey}: ${error instanceof Error ? error.message : String(error)}` });
      }
      return;
    }
    if (!outcome) {
      problems.push({
        code: 'bar_requirement_parse_failed',
        barKey: current.barKey,
        detail: `${current.barKey} has a title but no outcome statement`,
      });
    } else {
      bars.push({
        barKey: current.barKey,
        title: current.title,
        model: `${current.title.replace(/[.\s]+$/g, '')}. ${outcome}`,
      });
    }
  };

  for (const line of lines) {
    const start = /^\*\*(R-\d+)\s+[—–-]\s+(.+?)\.\*\*\s*(.*)$/.exec(line);
    if (start) {
      flush();
      current = {
        barKey: start[1]!,
        title: start[2]!.trim(),
        lines: start[3]?.trim() ? [start[3].trim()] : [],
      };
      continue;
    }
    if (/^\*\*R-\d+\b/.test(line)) {
      flush();
      current = null;
      problems.push({
        code: 'bar_requirement_parse_failed',
        detail: `malformed requirement record: ${line.slice(0, 160)}`,
      });
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();

  if (bars.length === 0 && problems.length === 0) {
    problems.push({
      code: 'bar_requirement_parse_failed',
      detail: '## Requirements contains no `**R-N — Title.** outcome` records',
    });
  }
  if (bars.length > MAX_REQUIREMENT_BARS) {
    problems.push({
      code: 'bar_set_too_large',
      detail: `Requirements contains ${bars.length} bars; maximum is ${MAX_REQUIREMENT_BARS}`,
    });
  }
  const seen = new Set<string>();
  for (const bar of bars) {
    if (seen.has(bar.barKey)) {
      problems.push({ code: 'bar_key_duplicate', barKey: bar.barKey, detail: `duplicate requirement key ${bar.barKey}` });
    }
    seen.add(bar.barKey);
  }
  return problems.length ? { ok: false, problems } : { ok: true, bars };
}

function evidencePlaneOf(raw: string | undefined): AcceptanceEvidencePlane | null {
  const normalized = (raw ?? '').replace(/`/g, '').trim().toLowerCase();
  if (!normalized) return 'tree';
  return normalized === 'tree' || normalized === 'deployed' || normalized === 'live'
    ? normalized
    : null;
}

/** Parse the plan's existing design table. A third `evidence plane` column is
 * optional; omission is the conservative authoring default `tree`. */
export function parseBarMappings(planContent: string, requirementKeys: ReadonlySet<string>):
  | { ok: true; mappings: ParsedBarMapping[] }
  | { ok: false; problems: AcceptanceBarSeedProblem[] } {
  const design = sectionBody(planContent, 'Design');
  const problems: AcceptanceBarSeedProblem[] = [];
  if (design === null) {
    return { ok: false, problems: [{ code: 'bar_mapping_missing', detail: 'plan has no ## Design section containing a Bar-to-work map' }] };
  }
  const lines = design.split('\n');
  const start = lines.findIndex((line) => /^###\s+Bar-to-work map for this plan\s*$/i.test(line.trim()));
  if (start < 0) {
    return { ok: false, problems: [{ code: 'bar_mapping_missing', detail: '## Design has no `### Bar-to-work map for this plan` table' }] };
  }

  const parsedPlan = parsePlan(planContent);
  const statusByItem = new Map(parsedPlan.items.map((item) => [item.id, item.storedStatus]));
  const mappings: ParsedBarMapping[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^###\s+/.test(line)) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || /^bar$/i.test(cells[0] ?? '') || /^[-:]+$/.test((cells[0] ?? '').replace(/\s/g, ''))) continue;
    const barKey = (cells[0] ?? '').replace(/`/g, '').trim();
    if (!/^R-\d+$/.test(barKey)) continue;
    if (seen.has(barKey)) {
      problems.push({ code: 'bar_mapping_duplicate', barKey, detail: `Bar-to-work map has duplicate row ${barKey}` });
      continue;
    }
    seen.add(barKey);
    const itemCell = cells[1] ?? '';
    const itemIds = [...new Set(itemCell.match(/P-\d{3,}/g) ?? [])];
    const leftover = itemCell.replace(/`?P-\d{3,}`?/g, '').replace(/[\s,]+/g, '');
    if (itemIds.length === 0 || leftover) {
      problems.push({
        code: 'bar_mapping_invalid',
        barKey,
        detail: `${barKey} mapping must contain only one or more P-NNN ids (received ${JSON.stringify(itemCell)})`,
      });
      continue;
    }
    const evidencePlane = evidencePlaneOf(cells[2]);
    if (!evidencePlane) {
      problems.push({
        code: 'bar_evidence_plane_invalid',
        barKey,
        detail: `${barKey} evidence plane must be tree, deployed, or live (received ${JSON.stringify(cells[2])})`,
      });
      continue;
    }
    for (const planItemId of itemIds) {
      if (!statusByItem.has(planItemId)) {
        problems.push({
          code: 'bar_mapping_unknown',
          barKey,
          planItemId,
          detail: `${barKey} maps to absent plan item ${planItemId}`,
        });
      }
    }
    const live = itemIds.filter((itemId) => statusByItem.get(itemId) !== 'dropped');
    if (live.length === 0) {
      problems.push({
        code: 'bar_mapping_dropped_only',
        barKey,
        detail: `${barKey} maps only to dropped plan items`,
      });
    }
    mappings.push({ barKey, planItemIds: itemIds, evidencePlane,
      ...(cells[2]?.replace(/`/g, '').trim() ? { evidencePlaneExplicit: true } : {}) });
  }

  for (const barKey of requirementKeys) {
    if (!seen.has(barKey)) {
      problems.push({ code: 'bar_mapping_missing', barKey, detail: `${barKey} has no Bar-to-work map row` });
    }
  }
  for (const mapping of mappings) {
    if (!requirementKeys.has(mapping.barKey)) {
      problems.push({
        code: 'bar_mapping_unknown',
        barKey: mapping.barKey,
        detail: `Bar-to-work map contains ${mapping.barKey}, which has no Requirements record`,
      });
    }
  }
  const edgeCount = mappings.reduce((count, mapping) => count + mapping.planItemIds.length, 0);
  if (edgeCount > MAX_BAR_PROJECTION_EDGES) {
    problems.push({
      code: 'bar_projection_set_too_large',
      detail: `Bar-to-work map contains ${edgeCount} edges; maximum is ${MAX_BAR_PROJECTION_EDGES}`,
    });
  }
  return problems.length ? { ok: false, problems } : { ok: true, mappings };
}

function seededCriterion(
  bar: ParsedRequirementBar,
  mapping: ParsedBarMapping,
  input: Pick<AcceptanceBarSeedBuildInput, 'actorId' | 'declaredAt' | 'cohort' | 'backfilled'>,
): ProposeRubricCriterion {
  const criterion = normalizeAcceptanceBarCriterion({
    key: bar.barKey.toLowerCase(),
    title: bar.title,
    model: bar.model,
    driftMarkers:
      `${bar.barKey} is falsified when the required outcome is absent, contradicted, or cannot be ` +
      `evidenced on the ${mapping.evidencePlane} plane.`,
    barKey: bar.barKey,
    role: 'outcome',
    mandatory: true,
    requiredScope: [mapping.evidencePlane],
    evidencePlane: mapping.evidencePlane,
    passRatings: ['healthy'],
    // Unified input already names the exact promise, falsifier and method.
    // Never concatenate its title or manufacture an alternative promise.
    ...(bar.criterion ?? {}),
    barProvenance: {
      lifecycle: input.cohort === 'post-epoch' && !input.backfilled ? 'pre-implementation' : 'legacy-backfilled',
      declaredAt: input.declaredAt,
      declaredBy: input.actorId,
    },
  });
  return criterion;
}

function methodProjection(existing: Record<string, unknown>): Record<string, unknown> {
  const fields = [
    'method', 'replication', 'instrumentKey', 'window', 'criterionClass', 'check', 'ratingScale',
  ];
  return Object.fromEntries(fields.filter((field) => existing[field] !== undefined).map((field) => [field, existing[field]]));
}

/** Pure complete-set builder. Existing METHOD fields survive only when the BAR
 * hash is unchanged; a post-start meaning change is routed to amendment. */
export function buildAcceptanceBarSeed(input: AcceptanceBarSeedBuildInput): AcceptanceBarSeedBuildResult {
  const requirements = parseRequirementBars(input.planContent);
  if (!requirements.ok) return refusal(requirements.problems);
  const mappings = parseBarMappings(
    input.planContent,
    new Set(requirements.bars.map((bar) => bar.barKey)),
  );
  if (!mappings.ok) return refusal(mappings.problems);
  const mappingByKey = new Map(mappings.mappings.map((mapping) => [mapping.barKey, mapping]));
  const conflicts = requirements.bars.filter((bar) => {
    const mapping = mappingByKey.get(bar.barKey)!;
    return mapping.evidencePlaneExplicit && bar.criterion?.evidencePlane &&
      mapping.evidencePlane !== bar.criterion.evidencePlane;
  });
  if (conflicts.length) return refusal(conflicts.map((bar) => ({ code: 'bar_evidence_plane_invalid',
    barKey: bar.barKey, detail: `${bar.barKey} has conflicting Acceptance and map evidence planes` })));

  const existingParsed = input.existingTemplateData === undefined
    ? null
    : rubricTemplateDataAuthoringSchema.safeParse(input.existingTemplateData);
  if (existingParsed && !existingParsed.success) {
    return refusal([{ code: 'bar_rubric_conflict', detail: 'the active acceptance rubric has invalid template_data' }]);
  }
  const existing = existingParsed?.success ? existingParsed.data : null;
  const preserveCanonicalBars = input.planStatus != null && input.planStatus !== 'draft' &&
    existing?.barContract?.subjectPlanRevision === input.subjectPlanRevision &&
    existing.barContract.adoptionEpoch === input.adoptionEpoch &&
    existing.barContract.cohort === input.cohort;
  if (existing && (existing.kind !== 'acceptance' || existing.subjectPlan !== input.planSlug)) {
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: `rubric '${input.rubricSlug}' is not the acceptance rubric for '${input.planSlug}'`,
    }]);
  }
  const legacyMap = input.legacyCriterionMap;
  if (legacyMap && (!input.backfilled || !existing || existing.barContract ||
      Object.keys(legacyMap).length !== requirements.bars.length ||
      new Set(Object.values(legacyMap)).size !== existing.criteria.length ||
      existing.criteria.length !== requirements.bars.length ||
      requirements.bars.some((bar) => !existing.criteria.some((criterion) =>
        criterion.key === legacyMap[bar.barKey] && criterion.role !== 'disclosure' && criterion.model?.trim())))) {
    return refusal([{ code: 'bar_rubric_conflict',
      detail: 'legacyCriterionMap must bijectively map every Requirements BAR to every existing outcome criterion, only during first backfill' }]);
  }
  const existingByBar = new Map(
    (existing?.criteria ?? [])
      .filter((criterion) => criterion.barKey)
      .map((criterion) => [criterion.barKey!, criterion] as const),
  );
  const extras = (existing?.criteria ?? []).filter(
    (criterion) => (!criterion.barKey || !mappingByKey.has(criterion.barKey)) &&
      !Object.values(legacyMap ?? {}).includes(criterion.key),
  );
  if (extras.length > 0) {
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: `active rubric contains criterion(s) outside the current Requirements set: ${extras.map((c) => c.key).join(', ')}`,
    }]);
  }

  const criteria = requirements.bars.map((bar) => {
    const seeded = seededCriterion(bar, mappingByKey.get(bar.barKey)!, input);
    const legacy = legacyMap && existing?.criteria.find((criterion) => criterion.key === legacyMap[bar.barKey]);
    if (legacy) {
      // Keep the graded identity, full outcome, falsifier and METHOD intact.
      // Adoption adds structural BAR pins; it must not weaken an older rubric
      // whose outcome text is more precise than the original Requirements seed.
      return normalizeAcceptanceBarCriterion({ ...legacy,
        barKey: bar.barKey, role: 'outcome', mandatory: true,
        requiredScope: seeded.requiredScope, evidencePlane: seeded.evidencePlane,
        passRatings: legacy.passRatings ?? (legacy.ratingScale ?? existing!.ratingScale ?? DEFAULT_RATING_SCALE)
          .filter((rating) => ['healthy', 'pass'].includes(rating.trim().toLowerCase())),
        barProvenance: seeded.barProvenance,
      });
    }
    const prior = existingByBar.get(bar.barKey);
    // Once an amendment pins this exact started plan revision, the criterion is
    // authoritative. Re-auditing must not replace its approved falsifier/plane
    // with the original human seed. A changed plan revision still takes the
    // normal meaning-change guard below the builder.
    if (preserveCanonicalBars && prior) return { ...prior } as ProposeRubricCriterion;
    if (!prior || prior.barHash !== seeded.barHash) return seeded;
    return {
      ...seeded,
      ...methodProjection(prior as unknown as Record<string, unknown>),
      ...methodProjection((bar.criterion ?? {}) as Record<string, unknown>),
      barProvenance: prior.barProvenance ?? seeded.barProvenance,
    } as ProposeRubricCriterion;
  });
  const barSetHash = computeAcceptanceBarSetHash(criteria);
  const parsedPlan = parsePlan(input.planContent);
  const templateCandidate = {
    ...(existing ?? {}),
    kind: 'acceptance' as const,
    subjectPlan: input.planSlug,
    characteristic: existing?.characteristic ?? 'plan-acceptance',
    criteria,
    ratingScale: existing?.ratingScale ?? [...DEFAULT_RATING_SCALE],
    description: existing?.description ?? `Predeclared acceptance BARs for ${input.planSlug}.`,
    proposedBy: existing?.proposedBy ?? input.actorId,
    barSetHash,
    barContract: preserveCanonicalBars ? existing!.barContract : {
      schemaVersion: 1 as const,
      adoptionEpoch: input.adoptionEpoch,
      cohort: input.cohort,
      subjectPlanRevision: input.subjectPlanRevision,
      seededAt: input.declaredAt,
      seededBy: input.actorId,
    },
  };
  const templateData = rubricTemplateDataAuthoringSchema.safeParse(templateCandidate);
  if (!templateData.success) {
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: `seeded rubric is invalid: ${templateData.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    }]);
  }

  const projections: SpecClauseWrite[] = [];
  for (const criterion of criteria) {
    const mapping = mappingByKey.get(criterion.barKey!)!;
    const evidencePlane = criterion.evidencePlane ?? mapping.evidencePlane;
    for (const planItemId of mapping.planItemIds) {
      projections.push({
        planSlug: input.planSlug,
        specId: `AUTO-BAR-${criterion.barKey}-${planItemId}`,
        expectedRevision: 0,
        planItemId,
        behavior: criterion.model ?? '',
        behaviorClass: 'happy-path',
        requiredEvidence: [evidencePlane],
        ...(criterion.requiredTestLayers ? { requiredTestLayers: criterion.requiredTestLayers } : {}),
        lifecycleStatus: 'draft',
        falsifier: { observation: criterion.driftMarkers ?? '' },
        acceptanceRef: `${input.rubricSlug}@${input.rubricRevision}:${criterion.barKey}`,
        sourceBar: {
          barKey: criterion.barKey!,
          barHash: criterion.barHash!,
          barSetHash,
          rubricSlug: input.rubricSlug,
          rubricRevision: input.rubricRevision,
          evidencePlane,
        },
        actorId: input.actorId,
      });
    }
  }
  // Compile-time/runtime backstop: every generated criterion is valid independently,
  // not only because the containing document happened to parse.
  for (const criterion of criteria) acceptanceRubricCriterionSchema.parse(criterion);

  return {
    ok: true,
    rubricSlug: input.rubricSlug,
    barSetHash,
    templateData: templateData.data as Record<string, unknown>,
    criteria,
    projections,
    mappings: mappings.mappings,
  };
}

export function acceptanceBarRubricSlug(planSlug: string): string {
  return `acceptance-${planSlug}`;
}

interface RubricRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  content: string;
  content_hash: string;
  version: number | string;
  title: string | null;
  template_data: unknown;
}

export interface TransactionalAcceptanceBarSeedInput {
  executor: SpecClauseSql;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  planContent: string;
  planTitle: string | null;
  planStatus: string | null;
  planVersion: number;
  adoptionEpoch: number;
  cohort: AcceptanceBarCohort;
  /** Only the canonical migration adapter sets this from its classified action. */
  backfilled?: boolean;
  legacyCriterionMap?: Record<string, string>;
  actorId: string;
  now: Date;
  /** Validate and describe the same canonical write without mutating any rows. */
  dryRun?: boolean;
}

export interface TransactionalAcceptanceBarSeedSuccess {
  ok: true;
  rubricSlug: string;
  rubricRevision: number;
  barSetHash: string;
  bars: number;
  projectionEdges: number;
  rubricChanged: boolean;
  preview?: { priorRubricRevision: number; nextRubricRevision: number; priorBarSetHash: string | null;
    nextBarSetHash: string; mappings: ParsedBarMapping[]; changes: import('./acceptance-bar-contract-snapshot').AcceptanceBarContractDiff['changes'];
    cohort: AcceptanceBarCohort; provenance: 'pre-implementation' | 'legacy-backfilled'; invalidatesPriorProof: boolean };
}

export type TransactionalAcceptanceBarSeedResult =
  | TransactionalAcceptanceBarSeedSuccess
  | Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;

export class AcceptanceBarSeedAbort extends Error {
  constructor(readonly result: Exclude<TransactionalAcceptanceBarSeedResult, { ok: true }>) {
    super(result.message);
    this.name = 'AcceptanceBarSeedAbort';
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Run inside the subject activation-audit transaction. Any late projection
 * refusal throws AcceptanceBarSeedAbort so earlier rubric/clause writes roll back. */
export async function seedAcceptanceBarsInTransaction(
  input: TransactionalAcceptanceBarSeedInput,
): Promise<TransactionalAcceptanceBarSeedResult> {
  const sql = input.executor;
  const rubrics = await sql<RubricRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version, title, template_data
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${input.workspaceId}
       AND template = 'rubric'
       AND template_slug IS NULL
       AND archived = false
       AND status IN ('active', 'ready')
       AND template_data->>'kind' = 'acceptance'
       AND template_data->>'subjectPlan' = ${input.planSlug}
     ORDER BY updated_at DESC NULLS LAST, plan_slug ASC
     LIMIT 2`;
  if (rubrics.length > 1) {
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: `subject plan has ${rubrics.length} active acceptance rubrics; exactly one is required`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;
  }
  const discovered = rubrics[0];
  const rubricSlug = discovered?.plan_slug ?? acceptanceBarRubricSlug(input.planSlug);
  const rubricHarness = discovered?.harness_slug ?? input.harnessSlug;
  const rubricLockKey = planAdvisoryLockKey(input.workspaceId, rubricHarness, rubricSlug);
  const lock = await sql<Array<{ ok: boolean }>>`
    SELECT pg_try_advisory_xact_lock(
      hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}), hashtext(${rubricLockKey})
    ) AS ok`;
  if (!lock[0]?.ok) {
    return refusal([{
      code: 'bar_rubric_busy',
      detail: `acceptance rubric '${rubricSlug}' is being edited; activation seed refused without writing`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;
  }

  const lockedRows = await sql<RubricRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, content, content_hash, version, title, template_data
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${rubricHarness}
       AND plan_slug = ${rubricSlug}
     FOR UPDATE`;
  const existing = lockedRows[0] ?? null;
  if (existing && (!discovered || existing.plan_slug !== discovered.plan_slug)) {
    return refusal([{
      code: 'bar_rubric_conflict',
      detail: `deterministic rubric slug '${rubricSlug}' collides with an existing non-acceptance plan`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;
  }

  const existingRevision = existing ? Number(existing.version) : 0;
  const provisionalRevision = existingRevision + 1;
  const existingTemplate = existing
    ? rubricTemplateDataAuthoringSchema.safeParse(existing.template_data)
    : null;
  const seedInstant =
    existingTemplate?.success &&
    existingTemplate.data.barContract?.subjectPlanRevision === input.planVersion &&
    existingTemplate.data.barContract.cohort === input.cohort
      ? existingTemplate.data.barContract.seededAt
      : input.now.toISOString();
  let built = buildAcceptanceBarSeed({
    planSlug: input.planSlug,
    planContent: input.planContent,
    actorId: input.actorId,
    declaredAt: seedInstant,
    cohort: input.cohort,
    backfilled: input.backfilled,
    legacyCriterionMap: input.legacyCriterionMap,
    adoptionEpoch: input.adoptionEpoch,
    subjectPlanRevision: input.planVersion,
    planStatus: input.planStatus,
    rubricSlug,
    rubricRevision: provisionalRevision,
    ...(existing ? { existingTemplateData: existing.template_data } : {}),
  });
  if (!built.ok) return built;

  // P-004/D-009: this activation seeder is a direct SQL writer, so it must
  // cross the same started-BAR guard as withPlanLock. A post-start meaning
  // change is an amendment, never a migration/seed overwrite; provenance is
  // canonicalized from the locked subject-plan state before any SQL write.
  if (existingTemplate?.success && existingTemplate.data.barContract) {
    const guarded = guardAcceptanceBarTemplateDataWrite({
      slug: rubricSlug,
      storedTemplateData: existing.template_data,
      nextTemplateData: built.templateData,
      subjectPlan: {
        status: input.planStatus,
        revision: input.planVersion,
        adoptionEpoch: input.adoptionEpoch,
        cohort: input.cohort,
      },
      actorId: input.actorId,
    });
    built = {
      ...built,
      templateData: guarded.data,
      criteria: (guarded.data.criteria as ProposeRubricCriterion[]),
      barSetHash: String(guarded.data.barSetHash ?? built.barSetHash),
    };
  }

  const sameBarMeaning = existingTemplate?.success
    ? existingTemplate.data.criteria.every((criterion) => {
        const next = built.ok ? built.criteria.find((item) => item.barKey === criterion.barKey) : null;
        return Boolean(next && next.barHash === criterion.barHash);
      })
    : false;
  const adoptingLegacy = input.backfilled && input.legacyCriterionMap &&
    existingTemplate?.success && !existingTemplate.data.barContract;
  if (existing && input.planStatus !== 'draft' && !sameBarMeaning && !adoptingLegacy) {
    return refusal([{
      code: 'bar_amendment_required',
      detail: `Requirements changed BAR meaning after plan status '${input.planStatus ?? 'unknown'}'; use the amendment transaction`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>;
  }

  const rubricChanged = !existing || stableJson(existing.template_data) !== stableJson(built.templateData);
  const rubricRevision = rubricChanged ? provisionalRevision : existingRevision;
  if (!rubricChanged && rubricRevision !== provisionalRevision) {
    built = buildAcceptanceBarSeed({
      planSlug: input.planSlug,
      planContent: input.planContent,
      actorId: input.actorId,
      declaredAt:
        existingTemplate?.success && existingTemplate.data.barContract
          ? existingTemplate.data.barContract.seededAt
          : input.now.toISOString(),
      cohort: input.cohort,
      adoptionEpoch: input.adoptionEpoch,
      subjectPlanRevision: input.planVersion,
      planStatus: input.planStatus,
      rubricSlug,
      rubricRevision,
      existingTemplateData: existing!.template_data,
    });
    if (!built.ok) return built;
  }

  const date = input.now.toISOString().slice(0, 10);
  const title = existing?.title ?? `Acceptance BAR — ${input.planTitle ?? input.planSlug}`;
  const body = existing?.content ?? buildRubricPlanBody({
    slug: rubricSlug,
    title,
    planStatus: 'active',
    owner: input.actorId,
    date,
    description: `Predeclared acceptance BARs seeded from ${input.planSlug}.`,
  });
  if (rubricChanged && !input.dryRun) {
    const templateJson = JSON.stringify(built.templateData);
    const bodyHash = hashPlanContent(body);
    await sql`
      INSERT INTO harness_shared.harness_plans (
        workspace_id, harness_slug, plan_slug, content, content_hash, version,
        title, status, created, updated, owner, template, template_data,
        items, decisions, now_state, now_next, origin
      ) VALUES (
        ${input.workspaceId}, ${rubricHarness}, ${rubricSlug}, ${body}, ${bodyHash}, ${rubricRevision},
        ${title}, 'active', ${date}, ${date}, ${input.actorId}, 'rubric', ${templateJson}::text::jsonb,
        '[]'::jsonb, '[]'::jsonb, 'Acceptance BAR rubric', 'Fill METHOD/checks against as-built work before grading', 'local'
      )
      ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
        template_data = EXCLUDED.template_data,
        version = EXCLUDED.version,
        updated_at = now(),
        origin = 'local'`;

    const snapshot = `${body}${body.endsWith('\n') ? '\n' : '\n\n'}## Structured rubric data (\`template_data\`)\n\n~~~json\n${JSON.stringify(built.templateData, null, 2)}\n~~~\n`;
    await sql`
      INSERT INTO harness_shared.plan_revisions (
        workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot, rationale,
        author_kind, author_id, session_id, session_kind, created_at
      )
      SELECT ${input.workspaceId}, ${rubricHarness}, ${rubricSlug}, COALESCE(MAX(seq), 0) + 1,
             ${bodyHash}, ${snapshot}, 'activation BAR seed',
             'agent', ${input.actorId}, null, null, ${input.now.getTime()}
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${input.workspaceId}
         AND harness_slug = ${rubricHarness}
         AND plan_slug = ${rubricSlug}`;
  }

  const identities = await sql<Array<{
    spec_id: string;
    current_revision: number | string;
    source_bar_key: string | null;
    plan_item_id: string;
    lifecycle_status: SpecClauseWrite['lifecycleStatus'];
  }>>`
    SELECT c.spec_id, c.current_revision, r.source_bar_key, r.plan_item_id, r.lifecycle_status
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
       AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
       AND r.revision = c.current_revision
     WHERE c.workspace_id = ${input.workspaceId}
       AND c.harness_slug = ${input.harnessSlug}
       AND c.plan_slug = ${input.planSlug}
     ORDER BY c.spec_id
     LIMIT ${MAX_BAR_PROJECTION_EDGES + 1}`;
  if (identities.length > MAX_BAR_PROJECTION_EDGES) {
    throw new AcceptanceBarSeedAbort(refusal([{
      code: 'bar_projection_set_too_large',
      detail: `existing projection identity read exceeded ${MAX_BAR_PROJECTION_EDGES}; refusing a truncated comparison`,
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>);
  }
  const expectedProjectionIds = new Set(built.projections.map((projection) => projection.specId));
  const unexpected = identities.filter(
    (row) => (row.source_bar_key !== null || row.spec_id.startsWith('AUTO-BAR-')) &&
      !expectedProjectionIds.has(row.spec_id),
  );
  if (unexpected.length > 0) {
    throw new AcceptanceBarSeedAbort(refusal([{
      code: 'bar_projection_conflict',
      detail:
        `stored BAR projection(s) are outside the exact current map: ` +
        unexpected.map((row) => row.spec_id).join(', '),
    }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>);
  }
  const identityBySpec = new Map(identities.map((row) => [row.spec_id, row]));
  if (input.dryRun) {
    const { diffAcceptanceBarContractSnapshots } = await import('./acceptance-bar-contract-snapshot');
    const view = (criteria: ProposeRubricCriterion[], prior = false) => ({
      contentHash: hashPlanContent(stableJson(criteria)),
      plan: { cohort: input.cohort, adoptionEpoch: input.adoptionEpoch },
      bars: criteria.map((criterion) => ({
        barKey: criterion.barKey ?? criterion.key, barHash: criterion.barHash ?? null,
        model: criterion.model ?? '', method: criterion.method ?? '', falsifier: criterion.driftMarkers ?? '',
        role: criterion.role ?? null, mandatory: criterion.mandatory ?? null,
        requiredScope: criterion.requiredScope ?? [], evidencePlane: criterion.evidencePlane ?? null,
        passRatings: criterion.passRatings ?? [], coversBarKeys: criterion.coversBarKeys ?? [],
        provenance: criterion.barProvenance ?? null,
        mappings: prior ? identities.filter((row) => row.source_bar_key === criterion.barKey)
          .map((row) => ({ specId: row.spec_id, planItemId: row.plan_item_id }))
          : built.ok ? built.projections.filter((projection) => projection.sourceBar?.barKey === criterion.barKey)
            .map((projection) => ({ specId: projection.specId, planItemId: projection.planItemId })) : [],
      })),
    });
    return { ok: true, rubricSlug, rubricRevision, barSetHash: built.barSetHash,
      bars: built.criteria.length, projectionEdges: built.projections.length, rubricChanged,
      preview: { priorRubricRevision: existingRevision, nextRubricRevision: rubricRevision,
        priorBarSetHash: existingTemplate?.success ? existingTemplate.data.barSetHash ?? null : null,
        nextBarSetHash: built.barSetHash, mappings: built.mappings,
        changes: diffAcceptanceBarContractSnapshots(
          existingTemplate?.success ? view(existingTemplate.data.criteria, true) : null, view(built.criteria), 'seed').changes,
        cohort: input.cohort, provenance: input.backfilled || input.cohort === 'legacy-backfilled' ? 'legacy-backfilled' : 'pre-implementation',
        invalidatesPriorProof: Boolean(existing && rubricChanged) },
    };
  }
  for (const projection of built.projections) {
    const prior = identityBySpec.get(projection.specId);
    const result = await setSpecClause(
      {
        ...projection,
        expectedRevision: prior ? Number(prior.current_revision) : 0,
        // Activation re-audits refresh the projection, not its review lifecycle.
        // Preserving the state makes unchanged writes no-ops, retaining exact
        // evidence pins and acceptance provenance. New clauses still start draft;
        // changed contract fields still append a revision through setSpecClause.
        lifecycleStatus: prior?.lifecycle_status ?? projection.lifecycleStatus,
      },
      { executor: sql, workspaceId: input.workspaceId, harnessSlug: input.harnessSlug },
    );
    if (!['created', 'revised', 'unchanged'].includes(result.status)) {
      throw new AcceptanceBarSeedAbort(refusal([{
        code: 'bar_projection_conflict',
        detail: `projection '${projection.specId}' refused with ${result.status}`,
      }]) as Exclude<AcceptanceBarSeedBuildResult, { ok: true }>);
    }
  }

  await sql`
    UPDATE harness_shared.harness_plans
       SET acceptance_bar_set_hash = ${built.barSetHash},
           acceptance_bar_rubric_slug = ${rubricSlug},
           acceptance_bar_rubric_revision = ${rubricRevision},
           acceptance_bar_seeded_at = ${input.now},
           acceptance_bar_seeded_by = ${input.actorId}
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND plan_slug = ${input.planSlug}`;

  return {
    ok: true,
    rubricSlug,
    rubricRevision,
    barSetHash: built.barSetHash,
    bars: built.criteria.length,
    projectionEdges: built.projections.length,
    rubricChanged,
  };
}

/** Stable helper used by tests/readiness code when only a projection fingerprint
 * is needed without importing the rubric writer. */
export function acceptanceBarSeedFingerprint(result: TransactionalAcceptanceBarSeedSuccess): string {
  return createHash('sha256')
    .update(`${result.rubricSlug}\0${result.rubricRevision}\0${result.barSetHash}\0${result.projectionEdges}`)
    .digest('hex');
}
