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
 * hive-coordination-health rubric is served from its migrated rubric-template plan
 * (mig 338, ws='default', harness='papercusp'), and the table is dropped by a follow-on
 * migration. Versioning falls out of the plan revision spine (no separate machinery).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import {
  rubricTemplateDataSchema,
  RUBRIC_TEMPLATE_NAME,
} from './agent-tools/plans/rubric-template';
import { withPlanLock, bumpUpdatedDate } from './agent-tools/plans/with-plan-lock';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';
import { listLocalRubrics, rubricsNeedingSeed } from './cupboard/rubric-store';

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
 * read looked in a near-dead workspace and missed the active `hive-coordination-health`
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

function tsIso(v: string | Date): string {
  return typeof v === 'string' ? v : v.toISOString();
}

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
 * Identity: a plan has ONE `owner`, so createdBy / proposedBy / ratifiedBy all derive
 * from it (ratifiedBy only once active). The proposer↔ratifier distinction the v1 table
 * tracked separately is intentionally collapsed (D-002: the plan is the substrate; no
 * consumer reads the distinction — its history lives in the plan's revision spine).
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
    status,
    createdBy: row.owner ?? null,
    proposedBy: row.owner ?? null,
    ratifiedBy: status === 'active' ? (row.owner ?? null) : null,
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

/** Every rubric-template plan in the rubric workspace, mapped to Rubric. The single read
 *  path the three public reads filter/search over — which makes it the ONE choke point
 *  where the first-party seed hooks (any rubrics:list/get/search or Overwatch getRubric
 *  triggers it). Degrades to [] if the plans store is unavailable (e.g. a test DB with
 *  no harness_plans) — reads never throw. */
async function loadAllRubrics(): Promise<Rubric[]> {
  // Auto-seed on read in REAL processes only. Under vitest the established fixture
  // pattern mocks getOrgPg but often not withWorkspace — the seed's proposeRubric
  // writes would escape the testcontainer onto the real org PG (observed while
  // building rubrics-first-party-seed.integration.test.ts, which now mocks both and
  // exercises the seed EXPLICITLY via ensureFirstPartyRubricsSeeded()).
  if (!process.env.VITEST) await ensureFirstPartyRubricsSeeded();
  return queryRubricPlans();
}

/** The raw plan-row read behind loadAllRubrics, seed-free (the seed itself reads/writes
 *  through paths that land back here — the seed gate above breaks the recursion). */
async function queryRubricPlans(): Promise<Rubric[]> {
  try {
    const { sql } = getOrgPg();
    // Exclude per-run instance plans (template_slug IS NOT NULL) — a rubric is a
    // top-level plan, not a scheduled instance (D-003).
    const rows = await sql<RubricPlanRow[]>`
      SELECT plan_slug, workspace_id, harness_slug, title, status, created, updated, updated_at,
             owner, archived, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${rubricsScopeWorkspace()}
         AND template = ${RUBRIC_TEMPLATE_NAME}
         AND template_slug IS NULL
       LIMIT 500`;
    return rows.map(planRowToRubric).filter((r): r is Rubric => r !== null);
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
 *  reads). The content VERSION lives in the bundle (rubric.json/listing.json), not in
 *  template_data — rubricTemplateDataSchema is .strict() and a version field there
 *  would fail loud; v1 has no upgrade semantics anyway (existing rows always win). */
export const FIRST_PARTY_RUBRIC_SEED_OWNER = 'first-party-bundle';

type RubricSeedState = 'pending' | 'running' | 'done';
let rubricSeedState: RubricSeedState = 'pending';

/** Test-only: re-arm the once-per-process seed gate. */
export function __resetRubricSeedStateForTests(): void {
  rubricSeedState = 'pending';
}

/** Raw slug existence set for the no-clobber check. Deliberately NOT planRowToRubric
 *  (which nulls out rows with invalid template_data): even a half-authored rubric plan
 *  row must block the seed rather than be silently overwritten. THROWS on a DB error so
 *  the caller can defer the seed instead of mistaking "unreachable" for "empty". */
async function existingRubricPlanSlugs(): Promise<Set<string>> {
  const { sql } = getOrgPg();
  const rows = await sql<{ plan_slug: string }[]>`
    SELECT plan_slug
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${rubricsScopeWorkspace()}
       AND template = ${RUBRIC_TEMPLATE_NAME}`;
  return new Set(rows.map((r) => r.plan_slug));
}

/**
 * Seed the bundled first-party rubrics into the workspace store, once per process —
 * wired into loadAllRubrics, so any rubrics:list/get/search (or the Overwatch scorecard
 * getRubric) triggers it lazily. Seeded rubrics are authored ACTIVE (they shipped
 * ratified) with owner FIRST_PARTY_RUBRIC_SEED_OWNER, via the canonical proposeRubric
 * path (fail-loud schema validation, plan-lock writes).
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
      const missing = rubricsNeedingSeed(bundled, await existingRubricPlanSlugs());
      for (const r of missing) {
        try {
          await proposeRubric({
            rubricId: r.rubricId,
            characteristic: r.characteristic,
            title: r.title,
            ...(r.description ? { description: r.description } : {}),
            criteria: r.criteria,
            ratingScale: r.ratingScale,
            ...(r.methodRef ? { methodRef: r.methodRef } : {}),
            by: FIRST_PARTY_RUBRIC_SEED_OWNER,
            status: 'active',
          });
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
}

/** List rubrics (active first, then proposed, then retired), optionally filtered by
 *  status / characteristic. Reads rubric-template plans (P-006/P-007). */
export async function listRubrics(filter: ListRubricsFilter = {}): Promise<Rubric[]> {
  let rubrics = await loadAllRubrics();
  if (filter.status) rubrics = rubrics.filter((r) => r.status === filter.status);
  if (filter.characteristic) rubrics = rubrics.filter((r) => r.characteristic === filter.characteristic);
  return sortRubrics(rubrics).slice(0, Math.min(filter.limit ?? 100, 500));
}

/** Fetch one rubric in full by its slug id. Returns null when no rubric carries that id. */
export async function getRubric(rubricId: string): Promise<Rubric | null> {
  return (await loadAllRubrics()).find((r) => r.rubricId === rubricId) ?? null;
}

/**
 * Search rubrics by id / characteristic / title / description. Case-insensitive,
 * all-tokens-must-match (websearch's AND semantics). At this scale (tens of rubrics) an
 * in-process scan over the rubric-template plans is as fast as a table FTS.
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

// ─── writes: author / ratify a rubric-template plan (P-007 Stage 2) ──────────────────

export interface ProposeRubricInput {
  rubricId: string;
  characteristic: string;
  title: string;
  description?: string;
  criteria: RubricCriterion[];
  ratingScale?: string[];
  methodRef?: string;
  /** Who is proposing (ownerId). Recorded as the plan owner. */
  by?: string;
  /**
   * Lifecycle status to write. Defaults to 'proposed' (the rubrics:propose tool path,
   * D-001: agents propose, the Queen ratifies). Seed/test paths may pass 'active' to
   * author a ratified rubric directly. Idempotent on rubricId: re-propose updates the
   * plan content + template_data and sets the status.
   */
  status?: RubricStatus;
}

/** Build the validated `template_data` for a rubric-template plan from a propose input.
 *  Throws (fail-loud, D-004) if the rubric data is malformed — never persists a broken
 *  rubric. Returns the schema-coerced data. */
function buildRubricTemplateData(input: ProposeRubricInput): unknown {
  const data = {
    characteristic: input.characteristic,
    criteria: input.criteria,
    ratingScale: input.ratingScale ?? [...DEFAULT_RATING_SCALE],
    ...(input.methodRef ? { methodRef: input.methodRef } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  const parsed = rubricTemplateDataSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`proposeRubric: invalid rubric data for '${input.rubricId}': ${issues}`);
  }
  return parsed.data;
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

**Next:** The Queen ratifies a proposed rubric by promoting this plan to \`active\`
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
 * Propose (idempotent upsert) a rubric → a `template: rubric` plan. status defaults to
 * 'proposed' (draft plan); 'active' authors a ratified rubric directly. Re-proposing the
 * same rubricId updates the plan content + template_data. Two canonical plan writes (the
 * content path and the structured template_data path cannot be combined): (1) upsert the
 * plan body (frontmatter → title/status/template columns); (2) write the validated
 * template_data jsonb.
 */
export async function proposeRubric(input: ProposeRubricInput): Promise<Rubric> {
  const rubricStatus: RubricStatus = input.status ?? 'proposed';
  const planStatus = rubricStatusToPlanStatus(rubricStatus);
  // Validate FIRST (fail-loud) before any write, so a malformed rubric never persists a
  // half-state (a body with no/invalid template_data).
  const templateData = buildRubricTemplateData(input);
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

  // Write 1 — upsert the plan body (derives title/status/template columns from frontmatter).
  const bodyResult = await withPlanLock<true>(
    null,
    { slug: input.rubricId, intent: `rubrics:propose ${input.rubricId}`, ...scope },
    async () => ({ newBody: body, value: true }),
  );
  if (bodyResult.kind === 'busy') {
    throw new Error(`proposeRubric: plan '${input.rubricId}' is being written by another caller`);
  }

  // Write 2 — the validated template_data jsonb (structured-only path: newBody:null).
  const dataResult = await withPlanLock<boolean>(
    null,
    { slug: input.rubricId, intent: `rubrics:propose:data ${input.rubricId}`, ...scope },
    async (current) =>
      current === null
        ? { newBody: null, value: false }
        : { newBody: null, templateData: { data: templateData }, value: true },
  );
  if (dataResult.kind === 'busy') {
    throw new Error(`proposeRubric: template_data write for '${input.rubricId}' is busy`);
  }

  const rubric = await getRubric(input.rubricId);
  if (!rubric) {
    throw new Error(`proposeRubric: rubric '${input.rubricId}' did not resolve after write`);
  }
  return rubric;
}

/**
 * Ratify a proposed rubric → active (D-001: the Queen/owner gate) by promoting its plan
 * (status → active). Returns the activated rubric, or null if no rubric-template plan
 * with that id exists. `by` is informational (the plan owner is the recorded identity;
 * the ratifying authority lands in the plan's revision history).
 */
export async function ratifyRubric(rubricId: string, _by?: string): Promise<Rubric | null> {
  const existing = await getRubric(rubricId);
  if (!existing) return null;
  const scope = await resolveRubricWriteScope(rubricId);
  const result = await withPlanLock<boolean>(
    null,
    { slug: rubricId, intent: `rubrics:ratify ${rubricId}`, ...scope },
    async (current) => {
      if (current === null) return { newBody: null, value: false };
      const flipped = setPlanFrontmatterStatus(current, 'active');
      return flipped === null
        ? { newBody: null, value: false }
        : { newBody: bumpUpdatedDate(flipped), value: true };
    },
  );
  if (result.kind === 'busy') {
    throw new Error(`ratifyRubric: plan '${rubricId}' is being written by another caller`);
  }
  return getRubric(rubricId);
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
