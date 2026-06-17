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
import { readPlanBySlug } from '../agent-tools/plans/source';
import { PLAN_ITEM_KIND, planItemRef } from '../issue-blocks-merge';
import {
  createWorkItem,
  claimWorkItem,
  releaseWorkItem,
  getWorkItem,
  linkWorkItem,
  isWorkItemKind,
  type WorkItem,
  type WorkItemKind,
} from '../work-items';
import { claimPlanItem } from './liveness';
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
    }
  | { status: 'refused'; reason: string; assignee?: string }
  | { status: 'conflict'; conflict: PlanItemClaim };

/** Resolve the work_item that `implements` a plan item (or null). Reads the
 *  coord_links edge written at conversion; src is an issue-family id or a
 *  harness-qualified feature ref ('<harness>#<id>'). */
export async function findImplementingWorkItem(
  planSlug: string,
  itemId: string,
): Promise<WorkItem | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ src_kind: string; src_ref: string }[]>`
    SELECT src_kind, src_ref
      FROM harness_shared.coord_links
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
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
  // `payload` is jsonb on both tables, but createWorkItem binds it as JSON.stringify(obj)
  // under a `$::jsonb` cast — which postgres-js stores as a jsonb STRING SCALAR, not an
  // object (agent-insights/postgres-js-jsonb-binding). So `payload->'plan_item'` is null
  // unless we first unwrap the scalar. `pj` normalizes BOTH shapes: a string scalar is
  // re-parsed via `(p #>> '{}')::jsonb`; a real object passes through. The stamp is
  // identical across families — match plan_slug + item_id (harness is in scope).
  const pj = (col: string) =>
    sql`(CASE WHEN jsonb_typeof(${sql.unsafe(col)}) = 'string'
              THEN (${sql.unsafe(col)} #>> '{}')::jsonb ELSE ${sql.unsafe(col)} END)`;
  const stampMatch = (col: string) =>
    sql`${pj(col)}->'plan_item'->>'plan_slug' = ${planSlug}
    AND ${pj(col)}->'plan_item'->>'item_id' = ${itemId}`;
  const featureRows = await sql<{ feature_id: string; harness_slug: string }[]>`
    SELECT feature_id, harness_slug
      FROM harness_shared.harness_features_consolidated
     WHERE harness_slug = ${harnessSlug} AND payload IS NOT NULL AND ${stampMatch('payload')}
     ORDER BY updated_ts DESC NULLS LAST`;
  for (const r of featureRows) {
    const wi = await getWorkItem(r.feature_id, r.harness_slug);
    if (wi) return wi;
  }
  const issueRows = await sql<{ issue_id: string }[]>`
    SELECT issue_id
      FROM harness_shared.engineer_issues
     WHERE payload IS NOT NULL AND ${stampMatch('payload')}
     ORDER BY updated_at DESC NULLS LAST`;
  for (const r of issueRows) {
    const wi = await getWorkItem(r.issue_id);
    if (wi) return wi;
  }
  return null;
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
 */
export async function listConvertedPlanItemRefs(
  workspaceId: string = DEFAULT_COORD_WORKSPACE,
): Promise<Set<string>> {
  const { sql } = getOrgPg();
  const rows = await sql<{ dst_ref: string }[]>`
    SELECT DISTINCT dst_ref
      FROM harness_shared.coord_links
     WHERE workspace_id = ${workspaceId}
       AND rel = ${IMPLEMENTS_REL}
       AND dst_kind = ${PLAN_ITEM_KIND}`;
  return new Set(rows.map((r) => r.dst_ref));
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
  };
}
