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

/** Stable action ids the detail pane renders as buttons. The
 *  (kind, action.id) pair plus the item's `ref` is what the UI
 *  dispatches on (P-017). */
export type AttentionActionId =
  | 'chat'
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
  /** True when this awaits a human (vs agent-actionable work). */
  needsHuman: boolean;
  actions: AttentionAction[];
  ref: AttentionRef;
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
