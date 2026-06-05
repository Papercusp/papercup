/**
 * AttentionItem — the unified read-model behind the Planning tab
 * (planning-attention-importance-2026-05-31, P-008 / D-004).
 *
 * A single shape every "needs the human / pick this up" surface adapts
 * into, so they render in one master-detail view: left list grouped by
 * plan, right detail pane, per-kind action buttons. Plan items remain
 * the authoring surface; the other kinds (coord escalations, coord
 * messages-to-human, smoke-fails, plan reviews) ADAPT in — they are NOT
 * rewritten as plan markdown. `planSlug`/`itemRef` are nullable: an
 * unattached item (an escalation with no plan, a smoke-fail) carries
 * only a body message and groups under a synthetic "Alerts" bucket.
 *
 * This is the server-side canonical type; the UI mirrors it as a wire
 * type (per the plans-api decoupling pattern).
 */

import { type Importance, IMPORTANCE_LEVELS } from '@papercusp/plan-parser';

export type AttentionKind =
  | 'plan-item'
  | 'coord-escalation'
  | 'coord-message'
  | 'smoke-fail'
  | 'plan-review';

export type AttentionSource = 'plan' | 'coord' | 'harness';

/**
 * The four inbox tiers (inbox-tiering-and-message-agent-2026-06-05 D-002/D-006).
 * Orthogonal to {@link AttentionKind} — every item is exactly one tier, ordered
 * Decision ▸ Handled ▸ Alert ▸ Activity (only Decisions demands the user):
 *   - `decision` — demands the human: needs-human plan items, plan-review
 *     gates, blocker/question escalations, direct non-auto messages to the
 *     human (untriaged), plus operator-confirmed/escalated items. The ONLY
 *     tier that sets `needsHuman: true`.
 *   - `handled` — the operator triaged it away (downgraded a false positive,
 *     or resolved it). Kept VISIBLE + auditable (`triageNote` = what + why) so
 *     a downgrade never silently vanishes (D-006).
 *   - `alert` — a problem worth surfacing but not a required decision:
 *     smoke-fails, advisory escalations, blocked plan items.
 *   - `activity` — lifecycle/status: `auto` coord:emit broadcasts, normal
 *     todo/wip plan items, non-auto broadcast FYI.
 */
export type AttentionTier = 'decision' | 'handled' | 'alert' | 'activity';

export const ATTENTION_TIERS: readonly AttentionTier[] = ['decision', 'handled', 'alert', 'activity'];

/** The single source of truth for {@link AttentionItem.needsHuman}: an item
 *  awaits the human iff it is a Decision (D-001/D-002 invariant). */
export function needsHumanForTier(tier: AttentionTier): boolean {
  return tier === 'decision';
}

/**
 * The operator-triage state on an item (D-006). `untriaged` is the default
 * (the operator hasn't looked at it this wake). The operator's triage PASS sets
 * one of: `confirmed` (a real decision — stays Decision, now vetted),
 * `escalated` (was under-flagged — promote to Decision), `downgraded` (a false
 * positive — moves to Handled), `resolved` (the operator handled it — Handled).
 */
export type TriageState = 'untriaged' | 'confirmed' | 'escalated' | 'downgraded' | 'resolved';

/** Operator triage actions, the verbs the `inbox:triage` tool accepts. Map 1:1
 *  onto the non-`untriaged` {@link TriageState}s. */
export type TriageAction = 'confirm' | 'escalate' | 'downgrade' | 'resolve';

export const TRIAGE_ACTIONS: readonly TriageAction[] = ['confirm', 'escalate', 'downgrade', 'resolve'];

/** Map a triage action to the state it records. */
export function triageActionToState(a: TriageAction): Exclude<TriageState, 'untriaged'> {
  switch (a) {
    case 'confirm':
      return 'confirmed';
    case 'escalate':
      return 'escalated';
    case 'downgrade':
      return 'downgraded';
    case 'resolve':
      return 'resolved';
  }
}

/** Stable action ids the detail pane renders as buttons. The
 *  (kind, action.id) pair plus the item's `ref` is what the UI
 *  dispatches on (P-017). */
export type AttentionActionId =
  | 'chat'
  | 'message-owner'
  | 'resolve'
  | 'mark-done'
  | 'answer'
  | 'drop'
  | 'view-log'
  | 'open'
  | 'ack';

export interface AttentionAction {
  id: AttentionActionId;
  label: string;
  /** Rendered as the filled primary button. At most one per item. */
  primary?: boolean;
}

/** The backend handle the UI needs to carry out an item's actions —
 *  discriminated by kind so resolution dispatches to the right place. */
export type AttentionRef =
  | { kind: 'plan-item'; slug: string; itemId: string }
  | { kind: 'coord-escalation'; msgId: string; options: { id: string; label: string }[] }
  | { kind: 'coord-message'; msgId: string }
  | { kind: 'smoke-fail'; harnessSlug: string }
  | { kind: 'plan-review'; harnessSlug: string };

export interface AttentionItem {
  /** Unique within a reader response. `<kind>:<...>`. */
  id: string;
  kind: AttentionKind;
  source: AttentionSource;
  harnessSlug: string | null;
  /** Grouping key. null → the synthetic per-harness "Alerts" bucket. */
  planSlug: string | null;
  /** P-NNN when this maps to a plan item; null otherwise. */
  itemRef: string | null;
  /** One-line label for the list row. */
  title: string;
  /** Detail for the right pane; may be empty. */
  body: string;
  /** Display status (e.g. needs-human, open, fail, pending-review). */
  status: string;
  importance: Importance;
  /** Which inbox tier this belongs to (D-002). */
  tier: AttentionTier;
  /** True when this awaits a human (vs agent-actionable work). Invariant:
   *  `needsHuman === (tier === 'decision')` — see {@link needsHumanForTier}. */
  needsHuman: boolean;
  /** The agent that owns this item (the coord record's `from` for
   *  messages/escalations), or null when there is no single agent owner
   *  (plan items, smoke-fails, plan-reviews). Drives the "Message owner"
   *  action's recipient (D-005). */
  ownerAgentId: string | null;
  /** Human-friendly label for {@link ownerAgentId}, when known. */
  ownerLabel: string | null;
  /** Operator-triage state (D-006). Default `untriaged`. */
  triageState: TriageState;
  /** What the operator did + why, recorded on triage. Drives the
   *  "Handled by operator" audit line. Null until triaged. */
  triageNote: string | null;
  /** Owner id of the operator that triaged this, when triaged. */
  triagedBy: string | null;
  /** ISO timestamp of the triage, when triaged. */
  triagedAt: string | null;
  actions: AttentionAction[];
  ref: AttentionRef;
}

/** The untriaged-default triage fields every adapter spreads into its item
 *  (the reader later overlays a real triage row via {@link applyTriage}). */
export function untriaged(): Pick<
  AttentionItem,
  'triageState' | 'triageNote' | 'triagedBy' | 'triagedAt'
> {
  return { triageState: 'untriaged', triageNote: null, triagedBy: null, triagedAt: null };
}

/** A persisted operator-triage record (the `attention_triage` row). */
export interface TriageRecord {
  action: TriageAction;
  note: string | null;
  triagedBy: string | null;
  triagedAt: string | null;
}

/**
 * Overlay an operator-triage record onto a freshly-adapted item, producing the
 * FINAL tier (D-006). PURE — the reader calls this after assembling the base
 * items and looking up each item's triage row:
 *   - `downgrade`/`resolve` → `handled` (kept visible + auditable).
 *   - `escalate` → `decision` (promote an under-flagged item).
 *   - `confirm`   → `decision` (a real decision, now vetted).
 * `needsHuman` is re-derived from the final tier so the invariant holds.
 */
export function applyTriage(item: AttentionItem, rec: TriageRecord): AttentionItem {
  const triageState = triageActionToState(rec.action);
  const tier: AttentionTier =
    triageState === 'downgraded' || triageState === 'resolved' ? 'handled' : 'decision';
  return {
    ...item,
    tier,
    needsHuman: needsHumanForTier(tier),
    triageState,
    triageNote: rec.note,
    triagedBy: rec.triagedBy,
    triagedAt: rec.triagedAt,
  };
}

/** Sort rank — lower = more important (urgent=0 … low=3). Unknown→normal. */
export function importanceRank(i: Importance): number {
  const r = IMPORTANCE_LEVELS.indexOf(i);
  return r === -1 ? IMPORTANCE_LEVELS.indexOf('normal') : r;
}

/** Stable sort, most-important first. */
export function sortByImportance<T extends { importance: Importance }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => importanceRank(a.importance) - importanceRank(b.importance));
}

/**
 * Map a coord escalation severity to importance.
 *
 * `blocker` fully blocks progress → `urgent`. `question` is an agent
 * explicitly escalating a decision to the human — by escalating rather
 * than proceeding, its thread is paused → `high` (this is a deliberate
 * refinement of the plan's first-draft D-003 "question→normal", which
 * would bury an agent's explicit ask among routine items). `advisory`
 * is FYI → `low`.
 */
export function severityToImportance(sev: 'blocker' | 'question' | 'advisory'): Importance {
  switch (sev) {
    case 'blocker':
      return 'urgent';
    case 'question':
      return 'high';
    case 'advisory':
      return 'low';
    default:
      return 'normal';
  }
}

/** Per-tier buckets, each importance-sorted, plus counts — the shape the
 *  tiered inbox (Decisions ▸ Handled ▸ Alerts ▸ Activity) renders (D-002/D-006).
 *  PURE. */
export interface TieredAttention {
  decision: AttentionItem[];
  handled: AttentionItem[];
  alert: AttentionItem[];
  activity: AttentionItem[];
  counts: Record<AttentionTier, number>;
}

/** Partition items into the four tiers, importance-sorted within each. */
export function groupByTier(items: readonly AttentionItem[]): TieredAttention {
  const out: TieredAttention = {
    decision: [],
    handled: [],
    alert: [],
    activity: [],
    counts: { decision: 0, handled: 0, alert: 0, activity: 0 },
  };
  for (const it of items) out[it.tier].push(it);
  for (const tier of ATTENTION_TIERS) {
    out[tier] = sortByImportance(out[tier]);
    out.counts[tier] = out[tier].length;
  }
  return out;
}
