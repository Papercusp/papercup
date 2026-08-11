/**
 * plan-item → work_item conversion — convert-at-pickup.
 *
 * Plans: project-centric-harness-rethink-2026-06-04 D-015 ("working a plan item =
 * convert it to a work_item first — no untracked self-item") +
 * unify-work-items-2026-06-04 + plan-item-assignment-claim-liveness-2026-06-04.
 *
 * When an agent picks up a PLAN ITEM to work it, the first step is to convert it
 * to a WORK_ITEM (the execution unit: kind + assignee + claim/lease + lifecycle).
 * Strategy (self/inline vs a blueprint) is orthogonal — it is *how* the work_item
 * executes, not *whether* one exists. This module is that conversion:
 *
 *   1. POLICY + LEASE first — `claimPlanItem` (liveness.ts) enforces the
 *      assignment/work-group policy and takes the authority-mediated lease.
 *      A refused/conflicted pickup creates NOTHING.
 *   2. IDEMPOTENT — re-picking an already-converted item RESUMES its existing
 *      work_item (found via the `implements` link edge) instead of minting a
 *      duplicate. A lapsed peer's stale work-item assignee is taken over: the
 *      plan-item lease (step 1) is the mutual-exclusion authority, so whoever
 *      holds it owns the execution record too.
 *   3. LINKED BACK — the work_item carries an `implements` coord_links edge to
 *      the plan item (`plan_item` / '<plan>#<item>', the same ObjectRef
 *      vocabulary issue-blocks-merge + work_items:link use) AND stamps
 *      `payload.plan_item = { plan_slug, item_id, harness_slug }`. The edge is
 *      the queryable substrate truth (idempotency, detail views); the payload
 *      stamp is what lets the PURE reflect rules (reflect-rules.ts) read the
 *      linkage straight off a work_items:* tool event without I/O.
 *
 * The plan-item STATUS flip (todo→wip on pickup, →done on completion) is NOT
 * done here — it rides the event-reaction system: `plan_items:convert` declares
 * an `emits:` firing plans:set-status, and reflect-rules.ts maps the work_item
 * lifecycle back onto the plan item. One mechanism, inspectable in events:graph.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
// The OTHER half of the split implements-link plane (see listConvertedPlanItemRefs): the
// dynamic coord scope issues-engineer.ts writes issue-family links under.
import { coordScopeWorkspace } from '../agent-tools/coordination/log';
import { readPlanBySlug } from '../agent-tools/plans/source';
import { PLAN_ITEM_KIND, planItemRef } from '../issue-blocks-merge';
import {
  createWorkItem,
  claimWorkItem,
  releaseWorkItem,
  getWorkItem,
  linkWorkItem,
  isWorkItemKind,
  ISSUE_FAMILY_KINDS,
  type WorkItem,
  type WorkItemKind,
} from '../work-items';
import { claimPlanItem, type PriorHolderWarning } from './liveness';
import type { LivenessMode, PlanItemClaim } from './claims';
import { compilePlanItemBrief, decisionsForItem } from './compile-brief';

/** The link rel from a work_item to the plan item it executes. */
export const IMPLEMENTS_REL = 'implements';

/** The payload stamp the reflect rules read off work_items:* tool events. */
export interface PlanItemStamp {
  plan_slug: string;
  item_id: string;
  harness_slug: string;
}

/** Work-item states that mean "this execution record is finished" — a re-pickup
 *  of the plan item mints a FRESH work_item rather than resuming a closed one
 *  (and a release of one falls back to the bare plan-item lease — there is no
 *  live execution record to release). Exported for the TUI release route. */
export const TERMINAL_WORK_ITEM_STATES = new Set(['passed', 'resolved', 'closed', 'done', 'deprecated', 'dropped']);

export interface ConvertPlanItemOpts {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  /** Work-item kind to mint (D-002 vocabulary). Default 'task' — the generic
   *  "an agent is executing this" record; pass feature/research-task/bug/… when
   *  the item warrants a pipeline-shaped unit. */
  kind?: WorkItemKind;
  /** Override the work-item title (default: the plan item's text, truncated). */
  title?: string;
  /** Per-lane situational brief (queen-wave-dispatch P-021) — the Queen's
   *  situational overlay, persisted on the minted work-item's
   *  `payload.brief` so the placement read (and the placed bee) sees the
   *  context it is MISSING. Carried from a `## Promote` lane's `brief:` field
   *  (promote-policy `BuiltFeature.brief`). Stamped at MINT only; a resume of
   *  an existing work-item keeps its as-placed brief. */
  brief?: string;
  /** P-003 compiled-briefs (flag `papercusp-compiled-briefs`): when true and no
   *  explicit `brief` is supplied, compile one at mint from the plan focus + the
   *  decisions bearing on this item. The flag read lives at the caller (the tool
   *  layer) so this core stays unit-testable without flag mocking. */
  compileBriefIfMissing?: boolean;
  /** Scheduled-plan run scope (scheduled-recurring-plans D-016). When set, this
   *  conversion is one fire of a recurring plan: the work item groups under the
   *  TEMPLATE slug (source_plan_slug) and carries the run in payload.plan_run, so
   *  runs stay distinct (the `implements` edge already keys on the instance plan
   *  slug) while the Queen frontier filter + template grouping work unchanged. */
  planRun?: {
    runId: number;
    runSeq?: number;
    instancePlanSlug?: string;
    templateSlug: string;
  };
  owner: string;
  ownerLabel?: string | null;
  ownerName?: string | null;
  ownerUser: string;
  intent?: string;
  livenessMode?: LivenessMode;
  ttlSec?: number;
}

export type ConvertPlanItemResult =
  | {
      /** converted = a new work_item was minted; resumed = an existing one re-claimed. */
      status: 'converted' | 'resumed';
      workItem: WorkItem;
      claim: PlanItemClaim;
      mode: LivenessMode;
      viaAssignment: boolean;
      planItem: { plan: string; item: string; status: string | null; text: string | null };
      /** EI-7189: set when the item's prior (just-lapsed) claim holder still looks
       *  alive — a heads-up to coordinate before continuing, NOT a refusal. */
      priorHolderWarning?: PriorHolderWarning;
    }
  | { status: 'refused'; reason: string; assignee?: string }
  | { status: 'conflict'; conflict: PlanItemClaim };

/**
 * Shared workspace-scope resolver for the implements/relates link plane — see
 * listConvertedPlanItemRefs below for the full explanation of why every reader here
 * must UNION both tenants rather than pin one: the plane is split by FAMILY
 * (feature-family under DEFAULT_COORD_WORKSPACE, issue-family under
 * coordScopeWorkspace()), so a single-tenant read is blind to a whole family.
 * `workspaceIds` exists only to pin the set in tests.
 */
function implementsLinkScopes(workspaceIds?: readonly string[]): string[] {
  return workspaceIds?.length
    ? [...new Set(workspaceIds)]
    : [...new Set([DEFAULT_COORD_WORKSPACE, coordScopeWorkspace()])];
}

/** Resolve the work_item that `implements` a plan item (or null). Reads the
 *  coord_links edge written at conversion; src is an issue-family id or a
 *  harness-qualified feature ref ('<harness>#<id>'). Unions both workspaces the
 *  implements-link plane is split across (see implementsLinkScopes) — a single-tenant
 *  read here would be blind to whichever family lives in the other workspace. */
export async function findImplementingWorkItem(
  planSlug: string,
  itemId: string,
  workspaceIds?: readonly string[],
): Promise<WorkItem | null> {
  const { sql } = getOrgPg();
  const scopes = implementsLinkScopes(workspaceIds);
  const rows = await sql<{ src_kind: string; src_ref: string }[]>`
    SELECT src_kind, src_ref
      FROM harness_shared.coord_links
     WHERE workspace_id = ANY(${scopes})
       AND rel = ${IMPLEMENTS_REL}
       AND dst_kind = ${PLAN_ITEM_KIND}
       AND dst_ref = ${planItemRef(planSlug, itemId)}
     ORDER BY created_at DESC`;
  for (const r of rows) {
    if (r.src_kind === 'issue') {
      const wi = await getWorkItem(r.src_ref);
      if (wi) return wi;
    } else if (r.src_kind === 'feature') {
      // featureRef '<harness>#<id>' (issue-blocks-merge).
      const i = r.src_ref.indexOf('#');
      if (i > 0) {
        const wi = await getWorkItem(r.src_ref.slice(i + 1), r.src_ref.slice(0, i));
        if (wi) return wi;
      }
    }
  }
  return null;
}

/**
 * Backstop resolver for the conversion idempotency check — finds a work_item
 * minted for this plan item via the `payload.plan_item` STAMP rather than the
 * `implements` edge.
 *
 * The edge (findImplementingWorkItem) is the primary idempotency key, but it is a
 * separate coord_links row that can be deleted out-of-band (a link prune, a manual
 * substrate edit) while the work_item itself survives. Without this fallback a
 * re-pickup would then sail past step 2 and mint a SECOND work_item for the same
 * plan item — two execution records, the orphaned first one invisible to the
 * resume path (it violates the re-pick-resumes contract; convert.ts module header
 * §2). Every convert stamps `payload.plan_item = { plan_slug, item_id, harness_slug }`
 * on BOTH families (feature: harness_features_consolidated.payload; issue:
 * engineer_issues.payload), so the stamp is the durable second source of truth.
 * Newest-first so a resume picks the most recent record.
 */
export async function findConvertedWorkItemByStamp(
  planSlug: string,
  itemId: string,
  harnessSlug: string,
): Promise<WorkItem | null> {
  const { sql } = getOrgPg();
  // The stamp is identical across families — match plan_slug + item_id (harness is in
  // scope). The leading `payload->'plan_item' IS NOT NULL` matches the PARTIAL predicate
  // of work_items_plan_item_stamp_idx (migration 725) exactly, which is what lets the
  // planner index-scan instead of seq-scanning. harness_features_consolidated is a plain
  // (non-aggregating) view over work_items, so a query against it inlines onto the same
  // base-table index — there is no separate hfc-side index (WI-7049: migration 725
  // originally tried to add one directly on the view, which is illegal on Postgres and
  // was removed).
  //
  // ⚠ Do NOT reintroduce a `CASE WHEN jsonb_typeof(payload) = 'string'` unwrap here. That
  // mitigation for the postgres-js `::jsonb` binding quirk
  // (agent-insights/postgres-js-jsonb-binding) is what defeated the index and made THIS
  // function the single largest live consumer of DB time in the system: 142 calls/min x
  // 134ms to return one row, ~7.6 hours of DB time per day (WI-6993). The quirk is fixed
  // at the source — restoreRawJsonbSerializer (EI-18698602043482898) installs a sticky
  // hybrid serializer correct for both `sql.json(v)` and `${JSON.stringify(v)}::jsonb` —
  // and migration 725's CHECK constraint makes a non-object payload unstorable.
  const stampMatch = () =>
    sql`payload->'plan_item' IS NOT NULL
    AND payload->'plan_item'->>'plan_slug' = ${planSlug}
    AND payload->'plan_item'->>'item_id' = ${itemId}`;
  const featureRows = await sql<{ feature_id: string; harness_slug: string }[]>`
    SELECT feature_id, harness_slug
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${harnessSlug} AND ${stampMatch()}
     ORDER BY updated_ts DESC NULLS LAST`;
  for (const r of featureRows) {
    const wi = await getWorkItem(r.feature_id, r.harness_slug);
    if (wi) return wi;
  }
  // Read the UNIFIED base table rather than the engineer_issues view: the view projects
  // `payload - '_ei'`, an expression no base-table index can serve, so every call through
  // it seq-scanned. `engineer_issues` is exactly `work_items` filtered to the issue family
  // with feature_id aliased to issue_id, so this is the same row set, and `updated_at` is
  // the view's `to_timestamp(updated_ts / 1000)` — ordering on updated_ts is equivalent.
  const issueRows = await sql<{ issue_id: string }[]>`
    SELECT feature_id AS issue_id
      FROM harness_shared.work_items
     WHERE item_kind = ANY(${[...ISSUE_FAMILY_KINDS]}::text[])
       AND ${stampMatch()}
     ORDER BY updated_ts DESC NULLS LAST`;
  for (const r of issueRows) {
    const wi = await getWorkItem(r.issue_id);
    if (wi) return wi;
  }
  return null;
}

/**
 * Find every work-item that COVERS this plan item via the `relates` coverage edge
 * (written by work_items:create's `plan_item`/`targetPlanItem` — see
 * _create-core.ts §"Forward edge") — i.e. any work-item that ADDRESSES this plan
 * item, whether or not it is the primary conversion (`implements`) record. A plan
 * item can accumulate several coverage edges over its life (the original
 * conversion, plus any residual/follow-up split off later).
 *
 * Used by the residual-coverage guard (EI-18655063958515097 — "a residual split
 * off a closing plan item silently leaves the lane"): before a plan item is
 * allowed to read as `done`, check whether any linked coverage work-item is still
 * non-terminal — if the parent closes anyway, the plan silently reads as fully
 * satisfied while real, tracked work remains open. Order is newest-linked-first;
 * callers typically only care whether ANY non-terminal item exists.
 *
 * Unions both workspaces the implements/relates link plane is split across (see
 * implementsLinkScopes) — EI-19346291419606670: this reader used to hardcode
 * DEFAULT_COORD_WORKSPACE alone, so on `rel='relates'` it saw only ~18% of coverage
 * links (293 in the real per-workspace tenant vs 64 in 'default') and the guard
 * FAILED OPEN: a plan item could close as fully satisfied while real tracked work
 * remained open in the tenant this reader never looked at.
 */
export async function findCoverageWorkItems(
  planSlug: string,
  itemId: string,
  workspaceIds?: readonly string[],
): Promise<WorkItem[]> {
  const { sql } = getOrgPg();
  const scopes = implementsLinkScopes(workspaceIds);
  const rows = await sql<{ src_kind: string; src_ref: string }[]>`
    SELECT src_kind, src_ref
      FROM harness_shared.coord_links
     WHERE workspace_id = ANY(${scopes})
       AND rel = 'relates'
       AND dst_kind = ${PLAN_ITEM_KIND}
       AND dst_ref = ${planItemRef(planSlug, itemId)}
     ORDER BY created_at DESC`;
  const out: WorkItem[] = [];
  for (const r of rows) {
    if (r.src_kind === 'issue') {
      const wi = await getWorkItem(r.src_ref);
      if (wi) out.push(wi);
    } else if (r.src_kind === 'feature') {
      const i = r.src_ref.indexOf('#');
      if (i > 0) {
        const wi = await getWorkItem(r.src_ref.slice(i + 1), r.src_ref.slice(0, i));
        if (wi) out.push(wi);
      }
    }
  }
  return out;
}

/**
 * Heuristic (EI-18655063958515097): does this closing note/rationale text read like
 * an unmet acceptance criterion was split off into a follow-up, rather than the item
 * being genuinely fully done? A completed investigation can mention a "residual
 * defect" while recording that the defect was discovered and filed; that is a finding,
 * not unfinished scope, so keep that explicit verdict out of the residual path. Pure so
 * it's unit-testable without the lock/PG path.
 */
export function looksLikeResidualClosure(text: string): boolean {
  const discoveryVerdict =
    /\b(?:verdict|investigat\w*|diagnos\w*|discover(?:ed|y)?|found|confirmed|predates?)\b/i.test(text) &&
    /\b(?:defect|bug|issue)\b/i.test(text) &&
    /\b(?:filed|created|opened|tracked)\b/i.test(text);
  const explicitUnmetAcceptance =
    /\b(?:acceptance|criteri\w*|ask|scope|work)\b[^.\n]{0,120}\b(?:not met|unmet|deferred|split(?:[- ]?off)?|left (?:open|unresolved|unmet))\b/i.test(
      text,
    );
  if (discoveryVerdict && !explicitUnmetAcceptance) return false;

  return /\b(split[- ]?off|carved[- ]?off|residual|deferred|not (?:fully |entirely )?met|partial(?:ly)? (?:done|complete|addressed)|left (?:open|unresolved|unmet)|unmet acceptance|acceptance (?:criteri\w*|ask)\b[^.]*(?:not met|unmet))\b/i.test(
    text,
  );
}

/**
 * Every plan-item ref ('<plan>#<item>') that has a work_item `implements` edge —
 * i.e. has been CONVERTED (picked up for execution). The decision↔execution
 * boundary's queryable truth (queen-autonomy-policy B-14 / P-104 · D-013): the
 * Queue (plans:attention) drops these so a converted item shows ONLY in Working
 * (post-convert), never in both. ONE indexed read (coord_links_dst_idx on
 * workspace_id, dst_kind, dst_ref). The edge persists past a work-item's
 * completion, but reflect-rules flips a completed plan-item to `done` (which the
 * Queue already excludes), so a still-open plan-item carrying an edge is one that
 * is actively executing.
 *
 * ⚠ TENANT-COMPLETE BY DEFAULT, and it must stay that way: the implements-link plane is SPLIT
 * BY FAMILY across two workspaces, so NO single `workspace_id` can see every conversion.
 *
 * The split is a half-finished rollout of the per-workspace coord flag, not a migration
 * remnant. Two sibling modules construct the SAME `PgLinkStore` with different tenants:
 *
 *   issues-engineer.ts  →  getWorkspaceId: () => coordScopeWorkspace()   (dynamic)
 *   work-items.ts       →  workspaceId: DEFAULT_COORD_WORKSPACE          (static literal)
 *
 * `coordScopeWorkspace()` returns `activeWorkspaceId()` once the coord-per-workspace flag is
 * on, so ISSUE-family links moved to the real tenant while FEATURE-family links stayed on
 * 'default'. work-items.ts's own comment says it "mirrors issues-engineer" — an invariant the
 * code violates. Measured 2026-08-02 on `rel='implements' AND dst_kind='plan_item'`:
 *
 *   default             feature   1216   still being written (through 2026-08-02)
 *   default             issue      155   stops 2026-06-23 — the changeover
 *   papercusp-workspace issue     1468   still being written (through 2026-08-02)
 *
 * So each single-tenant read is blind to a whole family, and — because the half it DOES see is
 * large and plausible — the blindness never announces itself. P-009's backfill discovered 18 of
 * 24 edges and missed 4 plans entirely while every counter reported healthy (0 failures, 0
 * dangling, 0 unresolved). Reading only the real tenant is not the fix but the same bug
 * mirrored: it would hide all 1216 feature conversions and make promotion re-mint them.
 *
 * Callers therefore pass NOTHING and get the union. Idempotency reads must over-include: a ref
 * seen that shouldn't be costs one skipped promotion, a ref MISSED mints a duplicate work-item.
 * `workspaceIds` exists only to pin the set in tests.
 *
 * ⚠ A test fixture on `workspaceId: 'default'` CANNOT observe this class of bug — the fixture
 * value silently satisfies whichever tenant the reader picked, which is exactly why P-009's
 * 26/26 green, mutation-verified suite never saw it. Pin this with a fixture that writes the
 * two families to DIFFERENT workspaces.
 *
 * The durable repair is to converge the two stores onto one resolver and migrate the stranded
 * rows; until then this union is what keeps every reader honest.
 */
export async function listConvertedPlanItemRefs(workspaceIds?: readonly string[]): Promise<Set<string>> {
  const { sql } = getOrgPg();
  const scopes = implementsLinkScopes(workspaceIds);
  const rows = await sql<{ dst_ref: string }[]>`
    SELECT DISTINCT dst_ref
      FROM harness_shared.coord_links
     WHERE workspace_id = ANY(${scopes})
       AND rel = ${IMPLEMENTS_REL}
       AND dst_kind = ${PLAN_ITEM_KIND}`;
  return new Set(rows.map((r) => r.dst_ref));
}

/**
 * Every plan-item ref ('<plan>#<item>', among the given `itemIds` of `planSlug`)
 * that already has WORK-ITEM COVERAGE of ANY kind: an `implements` edge (the
 * canonical convert-at-pickup / promotion mint), a `relates` edge (the ad-hoc
 * `work_items:create{targetPlanItem}` coverage write — see _create-core.ts
 * §"Forward edge"), OR a `payload.plan_item` STAMP with no edge at all
 * (defensive — mirrors findConvertedWorkItemByStamp's fallback for an edge
 * deleted/never-written out-of-band).
 *
 * This answers a DELIBERATELY WIDER question than listConvertedPlanItemRefs
 * ("has this item been converted via the canonical `implements` path" — the
 * Queue/Working split those callers rely on). Use THIS one only for "should a
 * NEW execution record be minted for this item" gates (promotion's idempotency
 * check) — swapping it into a Queue/Working-style caller would make an ad-hoc
 * `relates`-only coverage item (which never executes via convert-at-pickup)
 * silently disappear from the Queue despite nothing actually converting it.
 *
 * EI-19946482711398073 / WI-37359: plan-workitem-promotion-run.ts's mint gate
 * used to call listConvertedPlanItemRefs() (implements-only), so a plan item
 * manually covered via `work_items:create{targetPlanItem}` (relates + stamp,
 * no implements edge) read as un-promoted — a later `plans:start` re-run (or
 * any promotion re-invocation) would mint a DUPLICATE work-item for it.
 *
 * Scoped to ONE plan's given items (unlike listConvertedPlanItemRefs, which is
 * intentionally tenant-complete across every plan) — promotion only ever needs
 * the coverage state of the specific items it is about to consider minting, so
 * this stays cheap regardless of how many other plans/items exist system-wide.
 */
export async function listCoveredPlanItemRefs(
  planSlug: string,
  harnessSlug: string,
  itemIds: readonly string[],
  workspaceIds?: readonly string[],
): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const { sql } = getOrgPg();
  const scopes = implementsLinkScopes(workspaceIds);
  const refs = itemIds.map((id) => planItemRef(planSlug, id));
  const out = new Set<string>();

  const edgeRows = await sql<{ dst_ref: string }[]>`
    SELECT DISTINCT dst_ref
      FROM harness_shared.coord_links
     WHERE workspace_id = ANY(${scopes})
       AND rel = ANY(${[IMPLEMENTS_REL, 'relates']})
       AND dst_kind = ${PLAN_ITEM_KIND}
       AND dst_ref = ANY(${refs})`;
  for (const r of edgeRows) out.add(r.dst_ref);

  // Defensive fallback: a stamp with no edge at all (see findConvertedWorkItemByStamp's
  // header for why the edge alone cannot be trusted as the complete truth).
  const stampMatch = () =>
    sql`payload->'plan_item' IS NOT NULL
    AND payload->'plan_item'->>'plan_slug' = ${planSlug}
    AND payload->'plan_item'->>'item_id' = ANY(${itemIds}::text[])`;
  const featureRows = await sql<{ item_id: string }[]>`
    SELECT payload->'plan_item'->>'item_id' AS item_id
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${harnessSlug} AND ${stampMatch()}`;
  for (const r of featureRows) out.add(planItemRef(planSlug, r.item_id));
  const issueRows = await sql<{ item_id: string }[]>`
    SELECT payload->'plan_item'->>'item_id' AS item_id
      FROM harness_shared.work_items
     WHERE item_kind = ANY(${[...ISSUE_FAMILY_KINDS]}::text[])
       AND ${stampMatch()}`;
  for (const r of issueRows) out.add(planItemRef(planSlug, r.item_id));

  return out;
}

/** First ~`max` chars of a plan item's text as a work-item title (one line). */
export function planItemTitle(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Convert a plan item to a work_item at pickup (D-015): policy-checked lease →
 * mint-or-resume the work_item → claim it → link it back. See module header.
 */
export async function convertPlanItem(opts: ConvertPlanItemOpts): Promise<ConvertPlanItemResult> {
  const kind = opts.kind ?? 'task';
  if (!isWorkItemKind(kind)) return { status: 'refused', reason: `unknown work_item kind '${kind}'` };

  // ── The plan item itself ───────────────────────────────────────────────────
  const read = await readPlanBySlug(opts.planSlug, {
    harnessSlug: opts.harnessSlug,
    workspaceId: opts.workspaceId,
  });
  if (!read) return { status: 'refused', reason: `plan '${opts.planSlug}' not found` };
  const items =
    read.row.items.length > 0
      ? read.row.items.map((i) => ({ id: i.id, status: i.status as string | null, text: i.text as string | null }))
      : read.parsed.items.map((i) => ({ id: i.id, status: i.storedStatus as string | null, text: i.text ?? null }));
  const item = items.find((i) => i.id === opts.itemId);
  if (!item) {
    return { status: 'refused', reason: `plan item ${opts.itemId} not found in '${opts.planSlug}'` };
  }
  if (item.status === 'done' || item.status === 'dropped') {
    return { status: 'refused', reason: `plan item ${opts.itemId} is already ${item.status}` };
  }

  // ── 1. Policy + lease FIRST (assignment / work-group / mutual exclusion) ──
  const claimRes = await claimPlanItem({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    planSlug: opts.planSlug,
    itemId: opts.itemId,
    owner: opts.owner,
    ownerLabel: opts.ownerLabel,
    ownerName: opts.ownerName,
    ownerUser: opts.ownerUser,
    intent: opts.intent ?? `convert-at-pickup → work_item[kind=${kind}]`,
    livenessMode: opts.livenessMode,
    ttlSec: opts.ttlSec,
  });
  if (claimRes.status !== 'claimed') return claimRes;

  const stamp: PlanItemStamp = {
    plan_slug: opts.planSlug,
    item_id: opts.itemId,
    harness_slug: opts.harnessSlug,
  };
  const planItem = { plan: opts.planSlug, item: opts.itemId, status: item.status, text: item.text };

  // ── 2. Resume an existing non-terminal execution record, if any ───────────
  // Primary key: the `implements` edge. Fallback: the durable `payload.plan_item`
  // STAMP — covers an edge deleted out-of-band, so a re-pickup never SILENTLY mints
  // a second work_item for the same plan item (the re-pick-resumes contract; §2).
  let existing = await findImplementingWorkItem(opts.planSlug, opts.itemId);
  let edgeMissing = false;
  if (!existing) {
    existing = await findConvertedWorkItemByStamp(opts.planSlug, opts.itemId, opts.harnessSlug);
    edgeMissing = existing !== null; // found by stamp ⇒ the edge was gone, re-link below.
  }
  if (existing && !TERMINAL_WORK_ITEM_STATES.has(existing.state)) {
    let resumed = await claimWorkItem(existing.id, opts.owner, { harness: existing.harness ?? undefined });
    if (!resumed) {
      // Held by a lapsed peer. The plan-item lease (step 1) is the exclusion
      // authority — we hold it, so take the execution record over.
      await releaseWorkItem(existing.id, { harness: existing.harness ?? undefined });
      resumed = await claimWorkItem(existing.id, opts.owner, { harness: existing.harness ?? undefined });
    }
    // Self-heal the missing idempotency edge so subsequent reads (the Queue's
    // listConvertedPlanItemRefs, detail views) and the next resume see it again.
    if (edgeMissing) {
      const wiForLink = resumed ?? existing;
      await linkWorkItem(
        wiForLink.id,
        { kind: PLAN_ITEM_KIND, ref: planItemRef(opts.planSlug, opts.itemId) },
        IMPLEMENTS_REL,
        { harness: wiForLink.harness ?? undefined, by: opts.owner },
      );
    }
    return {
      status: 'resumed',
      workItem: resumed ?? existing,
      claim: claimRes.claim,
      mode: claimRes.mode,
      viaAssignment: claimRes.viaAssignment,
      planItem,
      priorHolderWarning: claimRes.priorHolderWarning,
    };
  }

  // ── 3. Mint the work_item (kind + claim + back-link) ──────────────────────
  const title = opts.title ?? (item.text ? planItemTitle(item.text) : `${opts.planSlug} ${opts.itemId}`);
  // P-003 compiled-briefs: when enabled (flag read at the caller) and no explicit
  // brief was supplied, derive one from the plan focus + the decisions bearing on
  // this item. '' (no enrichment) collapses to undefined → no brief stamped, i.e.
  // identical to the pre-P-003 path.
  const effectiveBrief =
    opts.brief ??
    (opts.compileBriefIfMissing
      ? compilePlanItemBrief({
          itemId: opts.itemId,
          itemText: item.text ?? '',
          planTitle: read.parsed.frontmatter?.title ?? null,
          planFocus: read.parsed.now
            ? { state: read.parsed.now.state, next: read.parsed.now.next }
            : null,
          decisions: decisionsForItem(read.parsed, opts.itemId),
        }) || undefined
      : undefined);
  const created = await createWorkItem({
    kind,
    title,
    summary: item.text ?? undefined,
    harness: opts.harnessSlug,
    payload: {
      plan_item: stamp,
      ...(opts.planRun ? { plan_run: opts.planRun } : {}),
      ...(effectiveBrief ? { brief: effectiveBrief } : {}),
    },
    // queen-steering-panel P-008: stamp the source plan slug on the minted work-item
    // so the Queen's survey can HARD-filter the frontier by the owner's eligible-plans
    // (surveyHive scopeFilter). Feature-family kinds write the source_plan_slug column;
    // issue-family kinds ignore it (no frontier row). Scheduled-run work items group
    // under the TEMPLATE slug (the stable plan identity) so that filter works
    // unchanged; the specific run rides payload.plan_run (scheduled-recurring-plans D-016).
    sourcePlanSlug: opts.planRun?.templateSlug ?? opts.planSlug,
    createdBy: opts.owner,
    // Issue-family kinds take the assignee at creation; feature-family is
    // claimed right after (no assignee column on insert).
    assignee: opts.owner,
  });
  const claimed = await claimWorkItem(created.id, opts.owner, { harness: created.harness ?? undefined });
  await linkWorkItem(
    created.id,
    { kind: PLAN_ITEM_KIND, ref: planItemRef(opts.planSlug, opts.itemId) },
    IMPLEMENTS_REL,
    { harness: created.harness ?? undefined, by: opts.owner },
  );
  return {
    status: 'converted',
    workItem: claimed ?? created,
    claim: claimRes.claim,
    mode: claimRes.mode,
    viaAssignment: claimRes.viaAssignment,
    planItem,
    priorHolderWarning: claimRes.priorHolderWarning,
  };
}
