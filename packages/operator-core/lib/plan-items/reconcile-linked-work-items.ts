/**
 * reconcileLinkedWorkItems — the MISSING reverse half of reflect-rules.ts
 * (EI-5925: "completing a plan item doesn't auto-reconcile its linked/mirror
 * work-items -> a large phantom-todo backlog causing fleet-wide claim-churn").
 *
 * reflect-rules.ts already mirrors a work_item's lifecycle ONTO its linked plan
 * item (complete/set_state -> plans:set-status). But when a plan item is flipped
 * to `done` via some OTHER path — directly on the plan, or by a SIBLING work-item
 * that also implements it — any OTHER work-item still pointing at that same plan
 * item is never told: it sits non-terminal forever, a phantom "todo" that
 * multiple agents independently re-verify and race to close by hand (the exact
 * fleet-time cost this ticket reports; su-bda6c's manual "Reconciled via
 * plan-item status" sweeps are precisely this operation, done by a human/agent
 * instead of the system).
 *
 * This module is the reverse mirror: given a plan item that just went `done`,
 * find EVERY work-item still pointing at it — via BOTH truth sources convert.ts
 * writes (the `implements` coord_links edge AND the `payload.plan_item` stamp,
 * since either can survive the other's deletion) — and auto-resolve any that are
 * (a) still non-terminal AND (b) carry NO independent in-flight progress
 * (`lastProgressAt` unset — the real item-scoped progress signal, distinct from
 * a mere claim/heartbeat per work-items.ts's own docs). Guard (b) is exactly the
 * ticket's own stated safety rail: never clobber genuinely-active parallel work
 * on the same item.
 *
 * Wired as a builtin reaction action (events/builtin-actions.ts) fired by a rule
 * on `plans:set-status` (plan-items/reconcile-rule.ts) — NOT a hardcoded call
 * inside plans/set-status.ts — so the whole plan-item <-> work-item lifecycle
 * interplay stays ONE mechanism, inspectable in events:graph, matching the
 * architecture reflect-rules.ts already established.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { PLAN_ITEM_KIND, planItemRef } from '../issue-blocks-merge';
import { IMPLEMENTS_REL } from './convert';
import {
  getWorkItem,
  setWorkItemState,
  setWorkItemStateWithAliasInfo,
  setWorkItemClaimHold,
  mergeWorkItemPayload,
  isSettledWorkItemState,
  type WorkItem,
} from '../work-items';
import { getPlanRow, planItemsForRow } from '../agent-tools/plans/source';
import { resolveEffectiveStatusForItems } from '@papercusp/plan-parser';
import {
  activeExternalBlockers,
  updateExternalBlockerHistory,
  type ExternalBlockerCapability,
} from '../external-blockers';

/** The two TERMINAL plan-item statuses this reconciler heals (mirrors
 *  `isTerminalStatus` in agent-tools/plans/set-status.ts) and the settled
 *  work-item state each maps onto, per family:
 *   - `done`    → the work SHIPPED   → feature `passed`     / issue `resolved`
 *   - `dropped` → the work ABANDONED → feature `deprecated` / issue `closed`
 *  The `dropped` half is EI-14693's extension: the transition reaction only ever
 *  fired on `done` (reconcile-rule.ts's `newlyDonePlanItem`), so a WI linked to a
 *  `dropped` plan item was NEVER reconciled — the periodic sweep below closes that
 *  gap too. */
const TERMINAL_PLAN_ITEM_TARGET = {
  done: { feature: 'passed', issue: 'resolved' },
  dropped: { feature: 'deprecated', issue: 'closed' },
} as const;
type TerminalPlanItemStatus = keyof typeof TERMINAL_PLAN_ITEM_TARGET;
function isTerminalPlanItemStatus(s: string | null | undefined): s is TerminalPlanItemStatus {
  return s === 'done' || s === 'dropped';
}

/** One plan item that just transitioned to `done` (or an equivalent terminal
 *  status) — the minimal identity reconciliation needs. */
export interface CompletedPlanItem {
  planSlug: string;
  itemId: string;
  /** EI-8970: the harness the triggering `plans:set-status` flip ran under
   *  (its ctx.harnessSlug) — threads through to the stale-read guard below so
   *  it re-reads the SAME plan row the flip wrote, rather than guessing the
   *  operator-home harness for a plan that actually lives in a different one.
   *  Optional/omitted is safe — the guard degrades to a best-effort resolve. */
  harnessSlug?: string | null;
}

export interface ReconcileLinkedWorkItemsResult {
  planSlug: string;
  itemId: string;
  /** Work-item ids auto-resolved by this sweep. */
  reconciled: string[];
  /** Linked but carrying independent in-flight progress — left alone. */
  skippedInFlight: string[];
  /** Linked but already terminal — nothing to do. */
  skippedAlreadyTerminal: string[];
}

/** `payload` on both federated tables is jsonb, but createWorkItem binds it as a
 *  JSON-stringified scalar under a `::jsonb` cast (postgres-js-jsonb-binding) —
 *  so `payload->'plan_item'` is null unless the string-scalar shape is first
 *  unwrapped. Mirrors findConvertedWorkItemByStamp's identical normalization. */
function normalizedPayloadExpr(sql: ReturnType<typeof getOrgPg>['sql'], col: string) {
  return sql`(CASE WHEN jsonb_typeof(${sql.unsafe(col)}) = 'string'
            THEN (${sql.unsafe(col)} #>> '{}')::jsonb ELSE ${sql.unsafe(col)} END)`;
}

function stampMatchFragment(sql: ReturnType<typeof getOrgPg>['sql'], col: string, planSlug: string, itemId: string) {
  const pj = normalizedPayloadExpr(sql, col);
  return sql`${pj}->'plan_item'->>'plan_slug' = ${planSlug} AND ${pj}->'plan_item'->>'item_id' = ${itemId}`;
}

/**
 * Every work-item that implements-or-was-stamped-for one plan item, deduped by
 * (harness, id). No harness filter needed — a plan item's ref ('<plan>#<item>')
 * is already the join key on both truth sources.
 */
async function findAllLinkedWorkItems(planSlug: string, itemId: string): Promise<WorkItem[]> {
  const { sql } = getOrgPg();
  const found = new Map<string, WorkItem>();
  const add = (wi: WorkItem | null) => {
    if (wi) found.set(`${wi.harness ?? ''}#${wi.id}`, wi);
  };

  // Truth source 1: the `implements` coord_links edge (every row — a plan item
  // can, in principle, have accumulated more than one if a duplicate mint ever
  // slipped through; reconciling all of them is strictly safer than only the
  // newest).
  const linkRows = await sql<{ src_kind: string; src_ref: string }[]>`
    SELECT DISTINCT src_kind, src_ref
      FROM harness_shared.coord_links
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND rel = ${IMPLEMENTS_REL}
       AND dst_kind = ${PLAN_ITEM_KIND}
       AND dst_ref = ${planItemRef(planSlug, itemId)}`;
  for (const r of linkRows) {
    if (r.src_kind === 'issue') {
      add(await getWorkItem(r.src_ref));
    } else if (r.src_kind === 'feature') {
      const i = r.src_ref.indexOf('#');
      if (i > 0) add(await getWorkItem(r.src_ref.slice(i + 1), r.src_ref.slice(0, i)));
    }
  }

  // Truth source 2: the payload.plan_item stamp — the backstop that survives an
  // out-of-band edge deletion (findConvertedWorkItemByStamp's rationale, here
  // collecting EVERY match rather than just the newest).
  const featureRows = await sql<{ feature_id: string; harness_slug: string }[]>`
    SELECT feature_id, harness_slug
      FROM harness_shared.harness_features_consolidated
     WHERE payload IS NOT NULL AND ${stampMatchFragment(sql, 'payload', planSlug, itemId)}`;
  for (const r of featureRows) add(await getWorkItem(r.feature_id, r.harness_slug));

  const issueRows = await sql<{ issue_id: string }[]>`
    SELECT issue_id
      FROM harness_shared.engineer_issues
     WHERE payload IS NOT NULL AND ${stampMatchFragment(sql, 'payload', planSlug, itemId)}`;
  for (const r of issueRows) add(await getWorkItem(r.issue_id));

  return [...found.values()];
}

/** Reconcile every work-item linked to ONE just-completed plan item. Never
 *  throws — a per-item DB hiccup is caught and surfaced via `reconciled: []`
 *  rather than breaking the caller's (fire-and-forget reaction) path. */
export async function reconcileLinkedWorkItemsForPlanItem(
  item: CompletedPlanItem,
  opts: { knownTerminalStatus?: TerminalPlanItemStatus } = {},
): Promise<ReconcileLinkedWorkItemsResult> {
  const out: ReconcileLinkedWorkItemsResult = {
    planSlug: item.planSlug,
    itemId: item.itemId,
    reconciled: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
  };
  try {
    // Resolve the plan item's TERMINAL status (done vs dropped) — it both gates
    // the sweep (bail if it is no longer terminal) and selects the settled state
    // each linked work-item is flipped to (TERMINAL_PLAN_ITEM_TARGET).
    let terminalStatus: TerminalPlanItemStatus;
    if (opts.knownTerminalStatus) {
      // The periodic data-heal sweep (reconcileOrphanedPlanItemWorkItems) has
      // ALREADY re-read the plan row fresh and CONFIRMED this item terminal, so it
      // is fail-CLOSED at the caller (it never passes a non-terminal item). Trust
      // that read and skip a redundant per-item getPlanRow round-trip.
      terminalStatus = opts.knownTerminalStatus;
    } else {
      // EI-8970: the reaction path fires fire-and-forget off the triggering
      // `plans:set-status` event's SNAPSHOT ("this item just went done"). By the
      // time the sweep actually runs, a peer may already have CORRECTED the SAME
      // plan item back off terminal (a premature done, caught and flipped back to
      // wip moments later). Acting on the stale snapshot would terminal-flip every
      // linked work-item under a now-false premise — the exact race observed on
      // cup-lexicon-full-rename-2026-07-09#P-006 / WI-3463. Re-read the item's
      // CURRENT stored status and bail the WHOLE sweep (touch nothing) if it is no
      // longer terminal — the next genuine terminal transition re-fires this rule
      // and reconciles correctly then. Fails OPEN as `done` (the reaction only
      // ever fires on a done transition) on any read hiccup or when the row/item
      // can't be resolved — this guard must never turn a DB blip or a missing
      // derived index into a missed reconcile.
      const row = await getPlanRow(item.planSlug, {
        harnessSlug: item.harnessSlug ?? undefined,
      }).catch(() => null);
      const current = row?.items.find((i) => i.id === item.itemId);
      if (current && !isTerminalPlanItemStatus(current.status)) {
        return out;
      }
      terminalStatus = current && isTerminalPlanItemStatus(current.status) ? current.status : 'done';
    }
    const target = TERMINAL_PLAN_ITEM_TARGET[terminalStatus];

    const linked = await findAllLinkedWorkItems(item.planSlug, item.itemId);
    for (const wi of linked) {
      if (isSettledWorkItemState(wi.state)) {
        out.skippedAlreadyTerminal.push(wi.id);
        continue;
      }
      if (wi.lastProgressAt) {
        // Independent in-flight progress recorded on THIS item — a sibling
        // completed the plan item, but this one is genuinely still being
        // worked. Never clobber it.
        out.skippedInFlight.push(wi.id);
        continue;
      }
      const targetState = wi.family === 'feature' ? target.feature : target.issue;
      try {
        await setWorkItemState(wi.id, targetState, {
          harness: wi.harness ?? undefined,
          by: 'system:plan-item-reconcile',
          completionRef: `Reconciled via plan-item status: ${item.planSlug}#${item.itemId} ${
            terminalStatus === 'dropped' ? 'dropped' : 'completed'
          }`,
        });
        out.reconciled.push(wi.id);
      } catch {
        // A single item's flip failing (e.g. a race that terminalized it
        // between the read above and now) must not break the sweep.
      }
    }
  } catch {
    // DB hiccup — this is a best-effort sweep, never a hard dependency of the
    // plan-item flip that triggered it.
  }
  return out;
}

/** Reconcile a BATCH of just-completed plan items (the bulk plans:set-status
 *  shape) — one call per item, all failures isolated. */
export async function reconcileLinkedWorkItemsForCompletedPlanItems(
  items: CompletedPlanItem[],
): Promise<ReconcileLinkedWorkItemsResult[]> {
  const out: ReconcileLinkedWorkItemsResult[] = [];
  for (const item of items) {
    out.push(await reconcileLinkedWorkItemsForPlanItem(item));
  }
  return out;
}

interface OrphanCandidate {
  planSlug: string;
  itemId: string;
  harnessSlug: string | null;
}

export interface OrphanReconcileSweepResult {
  /** Distinct (plan_slug, item_id) pairs enumerated from non-terminal, stamped
   *  work-items — the candidate frontier before the terminal-status check. */
  candidatePlanItems: number;
  /** Of those candidates, how many were CONFIRMED terminal (done/dropped) and
   *  therefore actually swept. */
  terminalPlanItems: number;
  /** Work-item ids terminalized by this sweep. */
  reconciled: string[];
  /** Linked but carrying independent in-flight progress — left alone. */
  skippedInFlight: string[];
  /** Linked but already terminal — nothing to do. */
  skippedAlreadyTerminal: string[];
}

/** Default per-tick candidate cap — a generous bound (orphan residue is bursty at
 *  worst; a healthy fleet clears it in a few ticks). Overridable via the routine's
 *  trigger_config `candidate_cap`. */
export const DEFAULT_ORPHAN_SWEEP_CAP = 500;

/**
 * The PERIODIC data-heal (EI-14693). `reconcileLinkedWorkItemsForPlanItem` only
 * ever runs off the plan item's done *transition* (reconcile-rule.ts) — so a
 * work-item that lands in a non-terminal state AFTER its plan item is already
 * terminal (a reset [EI-13337], a complete-without-state [D-004: EI-13318/13346/
 * 14676], or a late create) is never re-healed and pollutes every surface that
 * reads raw work-item `state` (the claim path — now guarded by
 * plan-item-lane-guard.ts — plus pot:survey placement, backlog counts, …).
 *
 * This sweep closes the transition-gap "fix the data, not the view" style: it
 * finds every NON-terminal work-item still carrying a `payload.plan_item` stamp,
 * re-reads each referenced plan item's CURRENT status, and for the ones that are
 * genuinely terminal (done OR dropped), reuses the exact same per-item reconciler
 * — inheriting all its safety rails (skip already-terminal, skip independent
 * in-flight `lastProgressAt` progress, never throw).
 *
 * FAIL-CLOSED by construction: a candidate whose plan can't be resolved, or whose
 * item is not (or no longer) terminal, is SKIPPED — never terminalized on a guess.
 * Idempotent: a second pass over already-healed data is a clean no-op.
 *
 * Homed on the `system:plan-item-orphan-reconcile` routine (a bounded periodic
 * sweep — NOT a bare setInterval), mirroring `system:gc-plan-runs`.
 */
export async function reconcileOrphanedPlanItemWorkItems(
  opts: { candidateCap?: number } = {},
): Promise<OrphanReconcileSweepResult> {
  const cap = opts.candidateCap && opts.candidateCap > 0 ? opts.candidateCap : DEFAULT_ORPHAN_SWEEP_CAP;
  const out: OrphanReconcileSweepResult = {
    candidatePlanItems: 0,
    terminalPlanItems: 0,
    reconciled: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
  };

  const { sql } = getOrgPg();
  // 1. Enumerate candidate plan-items from NON-terminal work-items carrying a
  //    plan_item stamp, in ONE query over the unified base table
  //    (harness_shared.work_items, mig 374) rather than the harness_features_-
  //    consolidated / engineer_issues VIEWS. The issues view projects
  //    `(payload - '_ei')`, which throws `cannot delete from scalar` when the
  //    planner evaluates it over a string-scalar payload during inlining; the base
  //    table exposes the raw `payload` (the normalized-payload CASE handles either
  //    jsonb shape). `status` is family-agnostic here: a feature settles at
  //    passed/deprecated and an issue at resolved/closed, so one NOT IN the union of
  //    both excludes every terminal item across families. Workspace-agnostic on the
  //    stamp exactly like findAllLinkedWorkItems; `harness_slug` is the getPlanRow
  //    hint; the per-item reconciler re-resolves the plan.
  const cands = new Map<string, OrphanCandidate>();
  const npF = normalizedPayloadExpr(sql, 'payload');
  const key = (planSlug: string, itemId: string) => `${planSlug}\0${itemId}`;

  const rows = await sql<{ plan_slug: string; item_id: string; harness_slug: string | null }[]>`
    SELECT DISTINCT ${npF}->'plan_item'->>'plan_slug' AS plan_slug,
                    ${npF}->'plan_item'->>'item_id'  AS item_id,
                    harness_slug
      FROM harness_shared.work_items
     WHERE payload IS NOT NULL
       AND status NOT IN ('passed', 'deprecated', 'resolved', 'closed')
       AND ${npF}->'plan_item'->>'plan_slug' IS NOT NULL
       AND ${npF}->'plan_item'->>'item_id' IS NOT NULL
     LIMIT ${cap}`;
  for (const r of rows) {
    const k = key(r.plan_slug, r.item_id);
    if (!cands.has(k)) cands.set(k, { planSlug: r.plan_slug, itemId: r.item_id, harnessSlug: r.harness_slug ?? null });
  }
  out.candidatePlanItems = cands.size;

  // 2. Group candidates by plan so each plan is read ONCE.
  const byPlan = new Map<string, { harnessSlug: string | null; items: OrphanCandidate[] }>();
  for (const c of cands.values()) {
    let g = byPlan.get(c.planSlug);
    if (!g) {
      g = { harnessSlug: c.harnessSlug, items: [] };
      byPlan.set(c.planSlug, g);
    }
    if (!g.harnessSlug && c.harnessSlug) g.harnessSlug = c.harnessSlug;
    g.items.push(c);
  }

  // 3. Per plan: read once, CONFIRM which candidate items are terminal (fail-closed
  //    — an unresolvable plan or a non-terminal item is skipped), then heal each via
  //    the shared per-item reconciler with the confirmed status.
  for (const [planSlug, g] of byPlan) {
    const row = await getPlanRow(planSlug, { harnessSlug: g.harnessSlug ?? undefined }).catch(() => null);
    if (!row) continue; // fail-closed: cannot confirm terminality → touch nothing.
    const statusById = new Map(row.items.map((i) => [i.id, i.status]));
    for (const c of g.items) {
      const st = statusById.get(c.itemId);
      if (!isTerminalPlanItemStatus(st)) continue; // still open / unknown → leave alone.
      out.terminalPlanItems += 1;
      const r = await reconcileLinkedWorkItemsForPlanItem(
        { planSlug: c.planSlug, itemId: c.itemId, harnessSlug: c.harnessSlug },
        { knownTerminalStatus: st },
      );
      out.reconciled.push(...r.reconciled);
      out.skippedInFlight.push(...r.skippedInFlight);
      out.skippedAlreadyTerminal.push(...r.skippedAlreadyTerminal);
    }
  }
  return out;
}
