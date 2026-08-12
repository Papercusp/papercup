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
  ISSUE_FAMILY_KINDS,
  SETTLED_WORK_ITEM_STATES,
  type WorkItem,
} from '../work-items';
import { getPlanRow, planItemsForRow } from '../agent-tools/plans/source';
import { resolveEffectiveStatusForItems } from '@papercusp/plan-parser';
import {
  activeExternalBlockers,
  readExternalBlockers,
  updateExternalBlockerHistory,
  type ExternalBlockerCapability,
} from '../external-blockers';
import { RECONCILER_SYSTEM_ACTOR } from '../completion-audit';

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
  /**
   * EI-18677799334390930: the coordination identity (ownerId) of whoever actually
   * flipped the plan item to done/dropped, when the trigger's ctx resolved one —
   * best-effort, may be absent (e.g. a system-triggered flip). Retained as transient
   * trigger context for callers, but deliberately NOT persisted as completion evidence:
   * mirroring a plan status is only a proposed judgement, not independent verification.
   */
  triggeredBy?: string | null;
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
  /**
   * EI-19460536530145188: issue-family work-items (bug/change/task) reached ONLY
   * via the `payload.plan_item` stamp, with no `implements` edge to prove they
   * are an IMPLEMENTATION of the plan item. Deliberately NOT terminal-closed —
   * see the guard below for why a bare stamp is not evidence of implementation.
   */
  skippedUnprovenLink: string[];
}

/**
 * A work-item linked to a plan item, tagged with WHICH truth source found it.
 * `viaImplementsEdge` is the only evidence that the work-item IMPLEMENTS the
 * plan item rather than merely referencing it — see the reconcile guard.
 */
export type LinkedWorkItem = WorkItem & { viaImplementsEdge: boolean };

/** Match the durable `payload.plan_item` stamp (plan_slug + item_id) on either
 *  federated table.
 *
 *  The leading `payload->'plan_item' IS NOT NULL` is load-bearing, not a
 *  redundant guard: it matches the PARTIAL predicate of
 *  work_items_plan_item_stamp_idx (migration 725) exactly, which is what
 *  permits an index scan rather than a seq scan. harness_features_consolidated
 *  is a plain (non-aggregating) view over work_items, so a query against it
 *  inlines onto the same base-table index — there is no separate hfc-side
 *  index (WI-7049: migration 725 originally tried to add one directly on the
 *  view, which is illegal on Postgres and was removed).
 *
 *  ⚠ Do NOT reintroduce a `CASE WHEN jsonb_typeof(payload) = 'string'` unwrap
 *  here. That mitigation for the postgres-js `::jsonb` binding quirk
 *  (agent-insights/postgres-js-jsonb-binding) is exactly what defeated the index
 *  and made this lookup the single largest live consumer of DB time in the
 *  system — ~7.6 hours per day at 142 calls/min x 134ms to return ONE row
 *  (WI-6993). It is no longer needed at all: the write path is fixed at the
 *  source (restoreRawJsonbSerializer, EI-18698602043482898) and migration 725's
 *  CHECK constraint makes a non-object payload unstorable. */
function stampMatchFragment(sql: ReturnType<typeof getOrgPg>['sql'], planSlug: string, itemId: string) {
  return sql`payload->'plan_item' IS NOT NULL
         AND payload->'plan_item'->>'plan_slug' = ${planSlug}
         AND payload->'plan_item'->>'item_id' = ${itemId}`;
}

/**
 * Every work-item that implements-or-was-stamped-for one plan item, deduped by
 * (harness, id). No harness filter needed — a plan item's ref ('<plan>#<item>')
 * is already the join key on both truth sources.
 */
export async function findAllLinkedWorkItems(planSlug: string, itemId: string): Promise<LinkedWorkItem[]> {
  const { sql } = getOrgPg();
  const found = new Map<string, LinkedWorkItem>();
  // `viaImplementsEdge` is STICKY-TRUE: an item found by BOTH truth sources is
  // proven by the edge, and the later stamp pass must not downgrade it.
  const add = (wi: WorkItem | null, viaImplementsEdge: boolean) => {
    if (!wi) return;
    const key = `${wi.harness ?? ''}#${wi.id}`;
    const prior = found.get(key);
    found.set(key, {
      ...wi,
      viaImplementsEdge: viaImplementsEdge || prior?.viaImplementsEdge === true,
    });
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
      add(await getWorkItem(r.src_ref), true);
    } else if (r.src_kind === 'feature') {
      const i = r.src_ref.indexOf('#');
      if (i > 0) add(await getWorkItem(r.src_ref.slice(i + 1), r.src_ref.slice(0, i)), true);
    }
  }

  // Truth source 2: the payload.plan_item stamp — the backstop that survives an
  // out-of-band edge deletion (findConvertedWorkItemByStamp's rationale, here
  // collecting EVERY match rather than just the newest).
  const featureRows = await sql<{ feature_id: string; harness_slug: string }[]>`
    SELECT feature_id, harness_slug
      FROM harness_shared.harness_features_consolidated
     WHERE ${stampMatchFragment(sql, planSlug, itemId)}`;
  for (const r of featureRows) add(await getWorkItem(r.feature_id, r.harness_slug), false);

  // Read the UNIFIED base table rather than the engineer_issues view. The view
  // projects `payload - '_ei'`, and an index cannot be built on the base table to
  // serve that derived expression — so going through the view forced a seq scan on
  // every call. `engineer_issues` is exactly `work_items` filtered to the issue
  // family with feature_id aliased to issue_id, so this is the same row set.
  const issueRows = await sql<{ issue_id: string }[]>`
    SELECT feature_id AS issue_id
      FROM harness_shared.work_items
     WHERE item_kind = ANY(${[...ISSUE_FAMILY_KINDS]}::text[])
       AND ${stampMatchFragment(sql, planSlug, itemId)}`;
  for (const r of issueRows) add(await getWorkItem(r.issue_id), false);

  return [...found.values()];
}

/** Reconcile every work-item linked to ONE just-completed plan item. Never
 *  throws — a per-item DB hiccup is caught and surfaced via `reconciled: []`
 *  rather than breaking the caller's (fire-and-forget reaction) path. */
export async function reconcileLinkedWorkItemsForPlanItem(
  item: CompletedPlanItem,
  opts: {
    knownTerminalStatus?: TerminalPlanItemStatus;
  } = {},
): Promise<ReconcileLinkedWorkItemsResult> {
  const out: ReconcileLinkedWorkItemsResult = {
    planSlug: item.planSlug,
    itemId: item.itemId,
    reconciled: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
    skippedUnprovenLink: [],
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
      // EI-19968934836644509: lift a stale plan-lane-sync hold on EVERY non-
      // settled linked item, UNCONDITIONALLY — before either skip check below.
      // This reconciler has just confirmed the plan item is genuinely terminal,
      // so a `plan-lane:` external blocker / held_open lease this same sync
      // mechanism left behind is stale REGARDLESS of whether the terminal STATE
      // flip itself proceeds. It previously sat AFTER both skip checks, so an
      // item that hit either — in-flight (an active assignee still working it)
      // or unproven-link (issue-family, stamp-only) — `continue`d past it every
      // single sweep pass and could stay gate-parked forever even though every
      // pass re-confirmed its plan item was done: WI-37408 sat blocked
      // ~1h20m behind a live `lastProgressAt`+assignee (genuinely being worked,
      // correctly never auto-closed) while its lane hold, which is orthogonal to
      // whether we trust the completion, was never lifted. Best-effort: a clear
      // failure here must never block the skip/flip logic that follows.
      await clearStaleLaneHold(wi, planLaneBlockerRef(item.planSlug, item.itemId));
      if (wi.lastProgressAt && wi.assignee) {
        // Independent in-flight progress recorded on THIS item AND someone
        // currently holds it — a sibling completed the plan item, but this one
        // is genuinely still being worked. Never clobber it.
        //
        // WI-6303: `lastProgressAt` alone is NOT a safe in-flight signal — three
        // reclaim paths (work-items-stale-claims.ts's dead/stalled-holder reaper,
        // shared-pot-loop/fleet-monitors.ts's sweepOrphanedTakenBy, and
        // fleet/pg-stores.ts's fleet:cancel claim release) clear `taken_by`/
        // `taken_at` on reclaim but leave `last_progress_at` stamped from
        // whatever the dead/orphaned holder last did — unlike the voluntary
        // release path and the terminal-transition path, which both clear it
        // (see the "release clears the progress signal too" comment on
        // releaseWorkItem). A work-item reclaimed by any of those three paths
        // then reads as "genuinely active" FOREVER (no staleness decay, no
        // re-check), permanently hiding it from this reconciler even with zero
        // claimant — the live-verified root cause of WI-5130/WI-5136/WI-5137
        // drifting from their already-`done` plan items P-104/P-301/P-402 for
        // 10+ days. Requiring a CURRENT assignee closes the gap for both new
        // occurrences (once the three reclaim paths below are fixed to clear
        // last_progress_at) and existing corrupted rows (an unclaimed item with
        // a stale timestamp is no longer treated as in-flight).
        out.skippedInFlight.push(wi.id);
        continue;
      }
      if (wi.family === 'issue' && !wi.viaImplementsEdge) {
        // EI-19460536530145188: an ISSUE-family item reached only by the
        // `payload.plan_item` STAMP, with no `implements` edge. The stamp is NOT
        // evidence of implementation, and closing on it destroys real work.
        //
        // WHY THE STAMP IS NOT EVIDENCE: `work_items:create { plan_item }` writes
        // its coord edge with rel `'relates'` (_create-core.ts) — deliberately
        // weaker than `implements`. It writes the stamp too, but ONLY so that
        // work_items:complete's plan-item auto-flip can find it
        // (EI-19390496242545842, which added the stamp write for that FORWARD
        // direction alone). This reconciler then read the same stamp in the
        // REVERSE direction as if it asserted implementation. It does not: an
        // agent who files a bug DISCOVERED while working P-007 passes
        // `plan_item:{...}` because it is the only linking field offered, and the
        // tool describes it as a coverage edge — not as a self-destruct.
        //
        // MEASURED before this guard (whole history, 1,210 reconciler-closed rows):
        //   task    593 — 593 via implements edge,   0 stamp-only
        //   feature 585 —   0 via implements edge, 585 stamp-only  (feature-family, unaffected)
        //   change   30 —  29 via implements edge,   1 stamp-only
        //   bug       1 —   0 via implements edge,   1 stamp-only  (WI-9333, destroyed)
        // So every legitimately-reconciled issue-family item (593 task + 29 change)
        // carries the edge and is UNAFFECTED; only the 2 stamp-only issue rows are
        // spared. Feature-family is untouched — it is entirely stamp-borne by
        // design (convert.ts / plan-run minting), which is why the stamp path
        // cannot simply be dropped, and why this guard is scoped to `issue`.
        //
        // ⚠ Do NOT "fix" this by excluding bug/change by KIND instead. 29 of the
        // 30 reconciled `change` rows are genuine plan-item implementations
        // ("P-005: Tests + gates…", "Apply compact icon-only rail…") minted with
        // the edge by convert.ts; a kind-based exclusion would strand all of them
        // as the phantom-todos EI-5925 created this module to eliminate — breaking
        // 30 to save 1. The truth source, not the kind, is the discriminator.
        //
        // Skipping (rather than closing as `closed`/abandoned) is the deliberate
        // choice: a surviving open item is RECOVERABLE — an agent claims it, sees
        // the work already landed, and closes it with evidence. A silent terminal
        // close is not: nobody looks at it again, and it reads as a shipped fix.
        out.skippedUnprovenLink.push(wi.id);
        continue;
      }
      const targetState = wi.family === 'feature' ? target.feature : target.issue;
      // EI-18653945816361859 / EI-19968934836644509: the stale plan-lane-sync
      // hold on this item was already lifted above (hoisted ahead of the
      // in-flight/unproven-link skip checks, unconditionally, for every
      // non-settled linked item) — so by the time control reaches here
      // setWorkItemState's held-open guard never has stale gate state left to
      // trip on. No second clearStaleLaneHold call needed; it is idempotent
      // but redundant.
      try {
        await setWorkItemState(wi.id, targetState, {
          harness: wi.harness ?? undefined,
          by: RECONCILER_SYSTEM_ACTOR,
          completionAuthority: 'proposed',
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

/**
 * WI-37914: the payload key recording the state a work-item held BEFORE this sync
 * parked it, so the un-park restores what was actually there instead of flattening
 * every item to the family's claimable default (an item parked while `wip` must not
 * silently reopen as unclaimed work).
 */
const PLAN_LANE_PARKED_FROM_KEY = 'planLaneParkedFrom';

/** The stashed pre-park state, or null. Defensive — payload is federated JSON. */
export function readPlanLaneParkedFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const v = (payload as Record<string, unknown>)[PLAN_LANE_PARKED_FROM_KEY];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Work-item states that mean "somebody is holding this" — restored only when the
 *  holder is still on it (see {@link restoreStateAfterUngate}). */
const IN_PROGRESS_WORK_ITEM_STATES = new Set(['wip', 'in_progress', 'in-progress', 'validating']);

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
  /** `via` says WHICH un-park this is: the normal one (our blocker is still active),
   *  or the WI-37914 repair of a park whose blocker was cleared without its state
   *  being restored — the two differ only in whether a blocker write is still owed. */
  | { op: 'ungate'; via: 'active-lane-blocker' | 'stale-park-repair' }
  | { op: 'noop'; reason: 'terminal' | 'in-flight' | 'already-gated' | 'no-lane-blocker' };

/**
 * WI-37914: the state an un-parked work-item is restored TO — pure, so the
 * "never silently reopen claimed work" invariant is testable without PG.
 *
 * Prefers the state stashed at park time; falls back to the family's claimable
 * default (`todo` for a feature, `open` for an issue) when there is nothing usable
 * to restore — which is also the path every item parked BEFORE this fix takes,
 * since none of them carry a stash.
 *
 * An in-progress stash (`wip`/`validating`) is only honoured while an assignee is
 * still on the row: the holder can be reaped while the item sits parked, and
 * restoring `wip` with nobody on it recreates the orphaned-claim state the stale-
 * claim reaper then has to clean up again.
 */
export function restoreStateAfterUngate(
  wi: Pick<WorkItem, 'state' | 'family' | 'payload' | 'assignee'>,
): string {
  const fallback = wi.family === 'feature' ? 'todo' : 'open';
  const parkedFrom = readPlanLaneParkedFrom(wi.payload);
  if (!parkedFrom) return fallback;
  const normalized = parkedFrom.toLowerCase();
  // Never restore INTO a gated or settled state — that is the park we are lifting.
  if (normalized === 'blocked' || normalized === 'needs-human' || isSettledWorkItemState(parkedFrom)) return fallback;
  if (IN_PROGRESS_WORK_ITEM_STATES.has(normalized) && !wi.assignee) return fallback;
  return parkedFrom;
}

/**
 * PURE decision (no I/O): what the lane sync should do to ONE linked work-item,
 * given its current state and the plan lane's status. Kept apart from the PG
 * effect below so the invariant is unit-testable without the lock/PG path
 * (mirrors set-status.ts's releaseTerminalGrips / releaseTodoClaim shape):
 *  - a settled work-item is never touched (its work is done/abandoned);
 *  - GATE never clobbers genuinely-active work (`lastProgressAt` set AND a
 *    live `assignee` — WI-6303: a bare `lastProgressAt` can be a stale stamp
 *    left behind by a dead/orphaned-claim reclaim path that never cleared it,
 *    not real in-flight work; see reconcileLinkedWorkItemsForPlanItem's
 *    identical guard for the full root-cause writeup) and is idempotent (a
 *    re-gate of an already lane-parked item is a no-op);
 *  - UN-GATE only lifts a park THIS sync created (the `plan-lane:` blocker is
 *    present), so an item blocked for any other reason is left alone.
 */
export function decideLaneGate(
  wi: Pick<WorkItem, 'state' | 'lastProgressAt' | 'payload' | 'assignee'>,
  laneStatus: PlanLaneSyncStatus,
  laneRef: string,
): LaneGateOp {
  if (isSettledWorkItemState(wi.state)) return { op: 'noop', reason: 'terminal' };
  const hasLaneBlocker = activeExternalBlockers(wi.payload).some(
    (b) => b.kind === PLAN_LANE_BLOCKER_KIND && b.ref === laneRef,
  );
  if (laneStatus === 'actionable') {
    if (hasLaneBlocker) return { op: 'ungate', via: 'active-lane-blocker' };
    // WI-37914 REPAIR PATH. The un-park used to clear the blocker and stop there,
    // leaving `state:'blocked'` behind — and because the check above keys on an
    // ACTIVE blocker, the very next sweep read the item as "not parked by us" and
    // walked past it. The contradiction was therefore permanent: every claim spec
    // filters `states:['open']`, so the item was invisible to `work_items:claimable`
    // and `scheduler:get_next` while the plan reported it unblocked, and a whole
    // fleet sat idle beside work it could not see (measured live on
    // hud-chat-release-audit, 3 members, 2026-08-11).
    //
    // Heal it from the CLEARED history rather than from `state` alone: a `blocked`
    // row whose plan-lane blocker WE cleared, with no other active blocker left, is
    // a park we failed to lift. An item blocked for any other reason still has no
    // cleared lane record of ours and is left alone — the same provenance rule the
    // active path uses, read one status over.
    const ourClearedPark = readExternalBlockers(wi.payload).some(
      (b) =>
        b.kind === PLAN_LANE_BLOCKER_KIND &&
        b.ref === laneRef &&
        b.status === 'cleared' &&
        b.clearedBy === PLAN_LANE_SYNC_ACTOR,
    );
    const stranded = wi.state.trim().toLowerCase() === 'blocked' && ourClearedPark;
    if (stranded && activeExternalBlockers(wi.payload).length === 0) {
      return { op: 'ungate', via: 'stale-park-repair' };
    }
    return { op: 'noop', reason: 'no-lane-blocker' };
  }
  // Gate intent (blocked / needs-human).
  if (wi.lastProgressAt && wi.assignee) return { op: 'noop', reason: 'in-flight' };
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
      // WI-37914: stash the pre-park state IN THE SAME merge as the blocker record, so
      // the un-park can restore what was actually here. Both families store `blocked`
      // natively post-unify (work-item-status-full-unify P-003) — the issue family ALSO
      // picks up setWorkItemStateWithAliasInfo's auto claim-hold, so the un-park owes a
      // state restore AND a hold release, not just the hold.
      await mergeWorkItemPayload(
        wi.id,
        { externalBlockers: blockers, [PLAN_LANE_PARKED_FROM_KEY]: wi.state },
        { harness },
      );
      await setWorkItemStateWithAliasInfo(wi.id, 'blocked', { harness, by: PLAN_LANE_SYNC_ACTOR });
      return 'gated';
    }
    // Un-gate: clear OUR lane blocker; restore to claimable ONLY when no OTHER
    // active blocker remains (the exact rule work_items:set_blocker uses, so an
    // independently-blocked item stays parked).
    const { blockers, changed } = updateExternalBlockerHistory(
      wi.payload,
      { kind: PLAN_LANE_BLOCKER_KIND, ref: laneRef, clear: true },
      PLAN_LANE_SYNC_ACTOR,
    );
    // On the WI-37914 repair path the blocker is ALREADY cleared, so this is a no-op
    // clear (changed:false) and the only thing still owed is the state restore below.
    if (changed) await mergeWorkItemPayload(wi.id, { externalBlockers: blockers }, { harness });
    const stillActive = blockers.filter((b) => b.status === 'active');
    if (stillActive.length === 0) {
      // WI-37914: BOTH halves of the park have to come off, in this order. Clearing
      // the claim hold alone left `state:'blocked'` behind, and every fleet claim spec
      // filters `states:['open']` — so the item read as unblocked on the plan while
      // staying structurally invisible to `scheduler:get_next`, stranding the lane.
      const restored = restoreStateAfterUngate(wi);
      await setWorkItemStateWithAliasInfo(wi.id, restored, { harness, by: PLAN_LANE_SYNC_ACTOR });
      if (wi.family !== 'feature') {
        await setWorkItemClaimHold(wi.id, false, {
          harness,
          by: PLAN_LANE_SYNC_ACTOR,
          reason: `plan lane ${laneItem.planSlug}#${laneItem.itemId} cleared`,
        });
      }
      // Drop the stash — it describes a park that no longer exists, and leaving it
      // would let a LATER un-park restore a state from the wrong era.
      await mergeWorkItemPayload(wi.id, { [PLAN_LANE_PARKED_FROM_KEY]: null }, { harness });
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

/**
 * EI-18732669095544832: resync ONE plan item's lane status onto its linked
 * work-items RIGHT NOW — the inline counterpart to the periodic orphan sweep's
 * non-terminal leg above (EI-14699). Before this, the ONLY thing that ever ran
 * `syncLinkedWorkItemsToPlanLane` for a non-terminal item was the 15-minute
 * `plan-item-orphan-reconcile` cron sweep — so a tool call that changes an item's
 * EFFECTIVE lane WITHOUT going through `plans:set-status` itself (chiefly
 * `plans:set-item-blocked-by` adding/clearing a `blocked-by` edge) reported
 * `ok:true` while the linked work-item silently stayed parked/unparked for up to
 * 15 minutes — indistinguishable from a no-op to the caller (`plan-item-lane-
 * sync:blocked-by-changed` in `lane-sync-rule.ts` fires this off exactly that
 * tool, the same reaction-rule pattern `reconcile-rule.ts` uses for the terminal
 * leg — see that file's header for why this is a rule, not a hardcoded call
 * inside `plans/set-item-blocked-by.ts`).
 *
 * Re-reads the plan row FRESH (never trusts a caller-supplied snapshot) and
 * classifies the item's CURRENT effective lane the same blocked-by-graph-aware
 * way the periodic sweep does — so this is correct even when several edges
 * changed since the triggering call. Fail-closed + never throws: a plan/item
 * that can't be resolved, or a lane-classify hiccup, is a silent no-op — the
 * periodic sweep remains the backstop for anything this misses.
 */
export async function resyncPlanItemLaneNow(
  planSlug: string,
  itemId: string,
  harnessSlug?: string | null,
): Promise<PlanLaneSyncResult | null> {
  try {
    const row = await getPlanRow(planSlug, { harnessSlug: harnessSlug ?? undefined }).catch(() => null);
    if (!row) return null;
    const laneStatus = classifyPlanLane(row, itemId);
    if (!laneStatus) return null;
    return await syncLinkedWorkItemsToPlanLane(
      { planSlug, itemId, harnessSlug: harnessSlug ?? null },
      laneStatus,
    );
  } catch {
    return null;
  }
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
  /**
   * EI-19460536530145188: issue-family work-items left OPEN because only the
   * `payload.plan_item` stamp linked them to the completed plan item — no
   * `implements` edge, so nothing asserts they implement it. Surfaced here (not
   * merely omitted from `reconciled`) so the sweep's own report says what it
   * declined to close: a skip that is invisible is the same silence this guard
   * exists to end.
   */
  skippedUnprovenLink: string[];
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
    skippedUnprovenLink: [],
  };

  const { sql } = getOrgPg();
  // 1. Enumerate candidate plan-items from NON-terminal work-items carrying a
  //    plan_item stamp, in ONE query over the unified base table
  //    (harness_shared.work_items, mig 374) rather than the harness_features_-
  //    consolidated / engineer_issues VIEWS. The issues view projects
  //    `(payload - '_ei')`, which throws `cannot delete from scalar` when the
  //    planner evaluates it over a string-scalar payload during inlining; the base
  //    table exposes the raw `payload` (always a jsonb object — migration 725's
  //    CHECK constraint). `status` exclusion uses the FULL cross-family SETTLED_WORK_-
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
  const key = (planSlug: string, itemId: string) => `${planSlug}\0${itemId}`;

  const rows = await sql<{ plan_slug: string; item_id: string; harness_slug: string | null }[]>`
    SELECT DISTINCT payload->'plan_item'->>'plan_slug' AS plan_slug,
                    payload->'plan_item'->>'item_id'  AS item_id,
                    harness_slug
      FROM harness_shared.work_items
     WHERE payload->'plan_item' IS NOT NULL
       AND NOT (status = ANY(${SETTLED_WORK_ITEM_STATES}::text[]))
       AND payload->'plan_item'->>'plan_slug' IS NOT NULL
       AND payload->'plan_item'->>'item_id' IS NOT NULL
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
        out.skippedUnprovenLink.push(...r.skippedUnprovenLink);
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
