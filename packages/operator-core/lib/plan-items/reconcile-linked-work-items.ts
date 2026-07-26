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
  readWorkItemHeldOpenBy,
  SETTLED_WORK_ITEM_STATES,
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
      // EI-18653945816361859: this SAME reconciler has just confirmed the plan item
      // is genuinely terminal — so any plan-lane-sync hold it (or a prior blocked/
      // needs-human pass) left on this work-item is by definition stale. Without
      // this, a work-item that went blocked->done WITHOUT first passing back
      // through `actionable` (the common shape: a blocked item is resolved
      // straight to done) still carries the lane-sync `held_open_by` lease +
      // `plan-lane:` external blocker from applyLaneGateToWorkItem's gate leg, and
      // setWorkItemState's held-open guard below refuses the terminal transition
      // ("HELD OPEN by system:plan-item-lane-sync") — silently swallowed by this
      // function's outer try/catch, leaving the item non-terminal forever until an
      // agent discovers it and force-closes it by hand. Lift it FIRST (the exact
      // ungate mechanics applyLaneGateToWorkItem uses for an actionable lane) so
      // the terminal flip below never races a hold it itself makes obsolete.
      // Best-effort: a clear failure here must not block the transition attempt.
      await clearStaleLaneHold(wi, planLaneBlockerRef(item.planSlug, item.itemId));
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

// ── Non-terminal plan-item lane sync (EI-14699) ──────────────────────────────
// The reconciler above heals a plan item that reached done/dropped. Its GATED
// sibling problem: a plan item flipped to `blocked`/needs-human leaves its linked
// work-item at `state:'todo'`, so scheduler:get_next / the `work-item:claimable`
// pool keep serving it — each self-selector claims it, the plan-item-lane-guard
// (scheduler/plan-item-lane-guard.ts) discovers the blocked lane and RELEASES it,
// and the cycle repeats: a perpetual claim/release ping-pong that burns fleet
// cycles (WI-3475/WI-3467 each cycled 8+ times before a human hand-set `blocked`).
// reflect-rules.ts mirrors work_item → plan_item, and the reconciler above mirrors
// a TERMINAL plan_item → work_item — but the gated lane statuses had NO reverse
// leg, so the two surfaces drift.
//
// The durable fix mirrors the terminal reconciler's own "heal the data, not the
// view" pattern: the periodic sweep below ALSO syncs a blocked/needs-human plan
// lane ONTO its linked work-items — PARKING them out of the self-select pool (so
// the ping-pong stops at the source, not just at the post-claim guard) — and
// UN-parks them the moment the lane is actionable again. Parking reuses the
// external-blocker machinery (external-blockers.ts / work_items:set_blocker): a
// provenance-carrying `plan-lane:<plan>#<item>` blocker record IS the marker that
// THIS sync parked the item, so the un-park only ever lifts a park this sync
// created and restores to claimable ONLY when no OTHER active blocker remains —
// the exact rule work_items:set_blocker uses, so an independently-blocked item is
// never clobbered.

/** The blocker `kind` this lane sync stamps on a linked work-item while its plan
 *  lane is blocked/needs-human. A single stable kind + `plan-lane:` ref across
 *  BOTH gated statuses keeps the clear path a single (kind, ref) match. */
const PLAN_LANE_BLOCKER_KIND = 'gate' as const;
const PLAN_LANE_SYNC_ACTOR = 'system:plan-item-lane-sync';

/** The synthetic external-blocker ref that marks a lane-parked work-item. */
export function planLaneBlockerRef(planSlug: string, itemId: string): string {
  return `plan-lane:${planItemRef(planSlug, itemId)}`;
}

/**
 * EI-18653945816361859: lift a STALE plan-lane-sync hold from a work-item whose
 * plan item has just been confirmed terminal (done/dropped) — the exact `ungate`
 * mechanics `applyLaneGateToWorkItem` uses for an `actionable` lane, applied
 * inline ahead of a terminal transition rather than a lane re-sync. Clears BOTH
 * halves the gate leg can have stamped: the `plan-lane:` external blocker
 * (`updateExternalBlockerHistory`) and, when it is the holder, the
 * `held_open_by` lease (`setWorkItemClaimHold`'s `by` provenance) that would
 * otherwise trip `setWorkItemState`'s held-open guard ("HELD OPEN by
 * system:plan-item-lane-sync") and get silently swallowed by this reconciler's
 * per-item try/catch, leaving the work-item non-terminal forever. A no-op when
 * neither is present. Best-effort: never throws — the terminal transition
 * attempt that follows must run either way. */
async function clearStaleLaneHold(wi: WorkItem, laneRef: string): Promise<void> {
  try {
    const harness = wi.harness ?? undefined;
    const hasLaneBlocker = activeExternalBlockers(wi.payload).some(
      (b) => b.kind === PLAN_LANE_BLOCKER_KIND && b.ref === laneRef,
    );
    if (hasLaneBlocker) {
      const { blockers } = updateExternalBlockerHistory(
        wi.payload,
        { kind: PLAN_LANE_BLOCKER_KIND, ref: laneRef, clear: true },
        PLAN_LANE_SYNC_ACTOR,
      );
      await mergeWorkItemPayload(wi.id, { externalBlockers: blockers }, { harness });
    }
    const heldOpen = readWorkItemHeldOpenBy(wi.payload);
    if (heldOpen?.by === PLAN_LANE_SYNC_ACTOR) {
      await setWorkItemClaimHold(wi.id, false, { harness, by: PLAN_LANE_SYNC_ACTOR });
    }
  } catch {
    // best-effort — the terminal transition attempt below still runs either way.
  }
}

/** The lane status a linked work-item is synced to. `blocked`/`needs-human` PARK
 *  it out of self-select; `actionable` UN-parks a lane-parked item. */
export type PlanLaneSyncStatus = 'blocked' | 'needs-human' | 'actionable';

export type LaneGateOp =
  | { op: 'gate'; capability: ExternalBlockerCapability }
  | { op: 'ungate' }
  | { op: 'noop'; reason: 'terminal' | 'in-flight' | 'already-gated' | 'no-lane-blocker' };

/**
 * PURE decision (no I/O): what the lane sync should do to ONE linked work-item,
 * given its current state and the plan lane's status. Kept apart from the PG
 * effect below so the invariant is unit-testable without the lock/PG path
 * (mirrors set-status.ts's releaseTerminalGrips / releaseTodoClaim shape):
 *  - a settled work-item is never touched (its work is done/abandoned);
 *  - GATE never clobbers genuinely-active work (`lastProgressAt` set) and is
 *    idempotent (a re-gate of an already lane-parked item is a no-op);
 *  - UN-GATE only lifts a park THIS sync created (the `plan-lane:` blocker is
 *    present), so an item blocked for any other reason is left alone.
 */
export function decideLaneGate(
  wi: Pick<WorkItem, 'state' | 'lastProgressAt' | 'payload'>,
  laneStatus: PlanLaneSyncStatus,
  laneRef: string,
): LaneGateOp {
  if (isSettledWorkItemState(wi.state)) return { op: 'noop', reason: 'terminal' };
  const hasLaneBlocker = activeExternalBlockers(wi.payload).some(
    (b) => b.kind === PLAN_LANE_BLOCKER_KIND && b.ref === laneRef,
  );
  if (laneStatus === 'actionable') {
    return hasLaneBlocker ? { op: 'ungate' } : { op: 'noop', reason: 'no-lane-blocker' };
  }
  // Gate intent (blocked / needs-human).
  if (wi.lastProgressAt) return { op: 'noop', reason: 'in-flight' };
  if (hasLaneBlocker) return { op: 'noop', reason: 'already-gated' };
  return {
    op: 'gate',
    capability: laneStatus === 'needs-human' ? 'product-decision' : 'live-dependency',
  };
}

type LaneGateAction = 'gated' | 'ungated' | 'skipped-in-flight' | 'skipped-terminal' | 'noop';

/** Apply the pure decision to ONE work-item via the work-item lifecycle surface,
 *  reusing the exact park/restore mechanics of work_items:set_blocker. Never
 *  throws — a per-item lifecycle hiccup is caught and reported as a plain 'noop'. */
async function applyLaneGateToWorkItem(
  wi: WorkItem,
  laneStatus: PlanLaneSyncStatus,
  laneRef: string,
  laneItem: { planSlug: string; itemId: string },
): Promise<LaneGateAction> {
  const decision = decideLaneGate(wi, laneStatus, laneRef);
  if (decision.op === 'noop') {
    return decision.reason === 'terminal'
      ? 'skipped-terminal'
      : decision.reason === 'in-flight'
        ? 'skipped-in-flight'
        : 'noop';
  }
  const harness = wi.harness ?? undefined;
  try {
    if (decision.op === 'gate') {
      const summary = `plan lane ${laneItem.planSlug}#${laneItem.itemId} is ${
        laneStatus === 'needs-human' ? 'awaiting a human decision' : 'blocked'
      } — linked work-item parked until the lane clears (${PLAN_LANE_SYNC_ACTOR})`;
      const { blockers } = updateExternalBlockerHistory(
        wi.payload,
        { kind: PLAN_LANE_BLOCKER_KIND, capability: decision.capability, ref: laneRef, summary },
        PLAN_LANE_SYNC_ACTOR,
      );
      await mergeWorkItemPayload(wi.id, { externalBlockers: blockers }, { harness });
      // Park out of self-select — feature → native `blocked`; issue → open + claim hold
      // (setWorkItemStateWithAliasInfo applies the family-correct exclusion floor).
      await setWorkItemStateWithAliasInfo(wi.id, 'blocked', { harness, by: PLAN_LANE_SYNC_ACTOR });
      return 'gated';
    }
    // Un-gate: clear OUR lane blocker; restore to claimable ONLY when no OTHER
    // active blocker remains (the exact rule work_items:set_blocker uses, so an
    // independently-blocked item stays parked).
    const { blockers } = updateExternalBlockerHistory(
      wi.payload,
      { kind: PLAN_LANE_BLOCKER_KIND, ref: laneRef, clear: true },
      PLAN_LANE_SYNC_ACTOR,
    );
    await mergeWorkItemPayload(wi.id, { externalBlockers: blockers }, { harness });
    const stillActive = blockers.filter((b) => b.status === 'active');
    if (stillActive.length === 0) {
      if (wi.family === 'feature') {
        await setWorkItemStateWithAliasInfo(wi.id, 'todo', { harness, by: PLAN_LANE_SYNC_ACTOR });
      } else {
        await setWorkItemClaimHold(wi.id, false, {
          harness,
          by: PLAN_LANE_SYNC_ACTOR,
          reason: `plan lane ${laneItem.planSlug}#${laneItem.itemId} cleared`,
        });
      }
    }
    return 'ungated';
  } catch {
    // Best-effort — a per-item lifecycle hiccup must never break the sweep.
    return 'noop';
  }
}

export interface PlanLaneSyncResult {
  /** Work-item ids PARKED out of self-select (a blocked/needs-human lane). */
  gated: string[];
  /** Work-item ids RESTORED to claimable (the lane became actionable). */
  ungated: string[];
  /** Linked but carrying independent in-flight progress — left alone (gate only). */
  skippedInFlight: string[];
  /** Linked but already terminal — nothing to do. */
  skippedAlreadyTerminal: string[];
}

/**
 * Sync every work-item linked to ONE plan item to the plan lane's current gated
 * status (blocked / needs-human → park; actionable → un-park). Reuses BOTH truth
 * sources findAllLinkedWorkItems reads (the `implements` edge + the payload stamp)
 * and is fully fail-safe per item — never throws.
 */
export async function syncLinkedWorkItemsToPlanLane(
  item: CompletedPlanItem,
  laneStatus: PlanLaneSyncStatus,
): Promise<PlanLaneSyncResult> {
  const out: PlanLaneSyncResult = { gated: [], ungated: [], skippedInFlight: [], skippedAlreadyTerminal: [] };
  try {
    const laneRef = planLaneBlockerRef(item.planSlug, item.itemId);
    const linked = await findAllLinkedWorkItems(item.planSlug, item.itemId);
    for (const wi of linked) {
      const action = await applyLaneGateToWorkItem(wi, laneStatus, laneRef, {
        planSlug: item.planSlug,
        itemId: item.itemId,
      });
      if (action === 'gated') out.gated.push(wi.id);
      else if (action === 'ungated') out.ungated.push(wi.id);
      else if (action === 'skipped-in-flight') out.skippedInFlight.push(wi.id);
      else if (action === 'skipped-terminal') out.skippedAlreadyTerminal.push(wi.id);
    }
  } catch {
    // A DB hiccup — this is a best-effort sweep, never a hard dependency.
  }
  return out;
}

/**
 * Classify a plan item's CURRENT effective lane (blocked-by graph aware) the same
 * way scheduler/plan-item-lane-guard.ts does — so a plan item that is effectively
 * blocked by an unresolved dependency (its OWN stored status still `todo`) is
 * caught too, not just an explicit `blocked` flip. Returns null when the plan
 * row / item can't be resolved (fail-closed → the caller skips the lane sync).
 */
function classifyPlanLane(
  row: Awaited<ReturnType<typeof getPlanRow>>,
  itemId: string,
): PlanLaneSyncStatus | null {
  if (!row) return null;
  const { items } = resolveEffectiveStatusForItems(planItemsForRow(row));
  const it = items.find((i) => i.id === itemId);
  if (!it) return null;
  if (it.effectiveStatus === 'blocked') return 'blocked';
  if (it.needsHuman) return 'needs-human';
  return 'actionable';
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
  /** EI-14699: work-item ids PARKED out of self-select because their plan lane is
   *  blocked/needs-human (the reverse-mirror gate). */
  gated: string[];
  /** EI-14699: work-item ids RESTORED to claimable because their plan lane became
   *  actionable again (the reverse-mirror un-gate). */
  ungated: string[];
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
 * re-reads each referenced plan item's CURRENT status, and:
 *   - for the ones that are genuinely terminal (done OR dropped), reuses the exact
 *     same per-item reconciler — inheriting all its safety rails (skip
 *     already-terminal, skip independent in-flight `lastProgressAt` progress,
 *     never throw);
 *   - for the ones whose lane is blocked/needs-human, PARKS the linked work-items
 *     out of self-select (EI-14699 — ends the claim/release ping-pong at the
 *     source), and RESTORES them when the lane is actionable again. This half is
 *     blocked-by-graph aware, so an item effectively blocked by an unresolved
 *     dependency is caught even without an explicit `blocked` stored status.
 *
 * FAIL-CLOSED by construction: a candidate whose plan can't be resolved is SKIPPED
 * — never terminalized on a guess, and a lane-classify hiccup skips only the lane
 * sync. Idempotent: a re-park of an already lane-parked item, or a re-heal of
 * already-terminal data, is a clean no-op.
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
    gated: [],
    ungated: [],
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
  //    jsonb shape). `status` exclusion uses the FULL cross-family SETTLED_WORK_-
  //    ITEM_STATES superset (WI-5279: the legacy-only 4-value list here predated
  //    work-item-status-full-unify/2026-07-19 and silently stopped excluding rows
  //    already written with the unified 'done'/'dropped' spelling — live-verified
  //    1638 of 1898 plan_item-stamped rows now carry those spellings, so the stale
  //    filter let already-terminal noise crowd out the `LIMIT cap` candidate
  //    window, starving genuine orphans like WI-3676/WI-4669/EI-13337's class from
  //    ever being enumerated by this sweep). Workspace-agnostic on the stamp
  //    exactly like findAllLinkedWorkItems; `harness_slug` is the getPlanRow hint;
  //    the per-item reconciler re-resolves the plan.
  const cands = new Map<string, OrphanCandidate>();
  const npF = normalizedPayloadExpr(sql, 'payload');
  const key = (planSlug: string, itemId: string) => `${planSlug}\0${itemId}`;

  const rows = await sql<{ plan_slug: string; item_id: string; harness_slug: string | null }[]>`
    SELECT DISTINCT ${npF}->'plan_item'->>'plan_slug' AS plan_slug,
                    ${npF}->'plan_item'->>'item_id'  AS item_id,
                    harness_slug
      FROM harness_shared.work_items
     WHERE payload IS NOT NULL
       AND NOT (status = ANY(${SETTLED_WORK_ITEM_STATES}::text[]))
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

  // 3. Per plan: read once, then route each candidate by its plan-item status
  //    (fail-closed — an unresolvable plan is skipped):
  //     - TERMINAL (done/dropped) → the terminal reconciler (EI-14693, unchanged).
  //     - GATED/actionable → the EI-14699 lane sync (park a blocked/needs-human
  //       lane's linked work-items out of self-select; un-park an actionable one).
  //       Classification is blocked-by-graph aware, so an item effectively blocked
  //       by an unresolved dependency is caught even without an explicit `blocked`
  //       stored status. Fail-closed: a classify hiccup skips the lane sync only.
  for (const [planSlug, g] of byPlan) {
    const row = await getPlanRow(planSlug, { harnessSlug: g.harnessSlug ?? undefined }).catch(() => null);
    if (!row) continue; // fail-closed: cannot confirm status → touch nothing.
    const statusById = new Map(row.items.map((i) => [i.id, i.status]));
    for (const c of g.items) {
      const st = statusById.get(c.itemId);
      if (isTerminalPlanItemStatus(st)) {
        out.terminalPlanItems += 1;
        const r = await reconcileLinkedWorkItemsForPlanItem(
          { planSlug: c.planSlug, itemId: c.itemId, harnessSlug: c.harnessSlug },
          { knownTerminalStatus: st },
        );
        out.reconciled.push(...r.reconciled);
        out.skippedInFlight.push(...r.skippedInFlight);
        out.skippedAlreadyTerminal.push(...r.skippedAlreadyTerminal);
        continue;
      }
      // NON-terminal (EI-14699): sync the effective lane onto linked work-items.
      try {
        const laneStatus = classifyPlanLane(row, c.itemId);
        if (laneStatus) {
          const r = await syncLinkedWorkItemsToPlanLane(
            { planSlug: c.planSlug, itemId: c.itemId, harnessSlug: c.harnessSlug },
            laneStatus,
          );
          out.gated.push(...r.gated);
          out.ungated.push(...r.ungated);
          out.skippedInFlight.push(...r.skippedInFlight);
          out.skippedAlreadyTerminal.push(...r.skippedAlreadyTerminal);
        }
      } catch {
        // fail-closed — a lane-classify/sync hiccup must never wedge the sweep.
      }
    }
  }
  return out;
}
