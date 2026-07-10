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
import { getWorkItem, setWorkItemState, isSettledWorkItemState, type WorkItem } from '../work-items';
import { getPlanRow } from '../agent-tools/plans/source';

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
function stampMatchFragment(sql: ReturnType<typeof getOrgPg>['sql'], col: string, planSlug: string, itemId: string) {
  const pj = sql`(CASE WHEN jsonb_typeof(${sql.unsafe(col)}) = 'string'
            THEN (${sql.unsafe(col)} #>> '{}')::jsonb ELSE ${sql.unsafe(col)} END)`;
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
): Promise<ReconcileLinkedWorkItemsResult> {
  const out: ReconcileLinkedWorkItemsResult = {
    planSlug: item.planSlug,
    itemId: item.itemId,
    reconciled: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
  };
  try {
    // EI-8970: this reaction fires fire-and-forget off the triggering
    // `plans:set-status` event's SNAPSHOT ("this item just went done"). By the
    // time the sweep actually runs, a peer may already have CORRECTED the
    // SAME plan item back off `done` (e.g. a premature done, caught and
    // flipped back to wip moments later). Acting on the stale snapshot would
    // terminal-flip every linked work-item under a now-false premise — the
    // exact race observed on cup-lexicon-full-rename-2026-07-09#P-006 /
    // WI-3463. Re-read the plan item's CURRENT stored status right before
    // acting and bail the WHOLE sweep (touch nothing) if it is no longer
    // `done` — the next genuine ->done transition re-fires this rule and
    // reconciles correctly then. Fails OPEN (proceeds as before) on any read
    // hiccup or when the row/item can't be resolved — this guard must never
    // turn a DB blip or a missing derived index into a missed reconcile.
    const row = await getPlanRow(item.planSlug, {
      harnessSlug: item.harnessSlug ?? undefined,
    }).catch(() => null);
    if (row) {
      const current = row.items.find((i) => i.id === item.itemId);
      if (current && current.status !== 'done') {
        return out;
      }
    }

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
      const targetState = wi.family === 'feature' ? 'passed' : 'resolved';
      try {
        await setWorkItemState(wi.id, targetState, {
          harness: wi.harness ?? undefined,
          by: 'system:plan-item-reconcile',
          completionRef: `Reconciled via plan-item status: ${item.planSlug}#${item.itemId} completed`,
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
