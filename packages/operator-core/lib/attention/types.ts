/**
 * AttentionItem — the unified read-model behind the Planning tab
 * (planning-attention-importance-2026-05-31, P-008 / D-004).
 *
 * A single shape every "needs the human / pick this up" surface adapts
 * into, so they render in one master-detail view: left list grouped by
 * plan, right detail pane, per-kind action buttons. Plan items remain
 * the authoring surface; the other kinds (coord escalations, coord
 * messages-to-human, smoke-fails) ADAPT in — they are NOT
 * rewritten as plan markdown. `planSlug`/`itemRef` are nullable: an
 * unattached item (an escalation with no plan, a smoke-fail) carries
 * only a body message and groups under a synthetic "Alerts" bucket.
 *
 * This is the server-side canonical type; the UI mirrors it as a wire
 * type (per the plans-api decoupling pattern).
 */

import { type Importance, IMPORTANCE_LEVELS, type RiskTier, riskTierRank } from '@papercusp/plan-parser';
import type { ReportBlock } from '@papercusp/chat-protocol';
import type { AutonomyCategory } from '../autonomy/categories';

export type AttentionKind =
  | 'plan-item'
  | 'coord-escalation'
  | 'coord-message'
  | 'smoke-fail'
  | 'operator-report'
  // B-14 / P-100 (D-011): the folded disposition channels — each a categorized
  // decision/action the Queen did not auto-handle, surfaced on the unified Queue
  // (NOT the execution backlog: work_items stay separate).
  | 'improvement' // a human-routed self-improvement awaiting triage (ideation-intake)
  | 'standing-approval' // a standing-approval candidate awaiting the owner (system-control)
  | 'conversation' // an open agent question / coord:ask awaiting an answer (escalations)
  | 'scout-grade'; // a rollup nudge: N routed Scout ideas await the owner's grade (ideation-intake)

export type AttentionSource = 'plan' | 'coord' | 'harness' | 'operator';

/**
 * The autonomy CATEGORY each attention kind belongs to (queen-autonomy-policy
 * B-14 / P-100 · D-009/D-011): the functional domain whose per-category ceiling
 * (B-03 `autonomy_policy`) governs whether the Queen may AUTO-dispose the item
 * vs. surface it to the human on the unified Queue. The category is the
 * DISPOSITION's domain, not the underlying work's — a needs-human plan-item is a
 * `plan-governance` ratification whatever feature it gates. Mirrors the B-04
 * action-surface audit ({@link ../autonomy/action-surface}).
 *
 * `null` for an ephemeral SIGNAL / status report that is NOT a governed
 * human-driving decision (a failing smoke test, an operator status `<report>`):
 * it stays an Alert/Activity and is never auto-disposed — the fail-safe, since a
 * `null` category gives the gate nothing to open (D-009 unmapped → never-auto).
 */
export const ATTENTION_KIND_CATEGORY: Record<AttentionKind, AutonomyCategory | null> = {
  'plan-item': 'plan-governance', // ratify a needs-human item / milestone gate
  'coord-escalation': 'escalations', // resolve a blocker/question/advisory escalation
  'coord-message': 'inbox-triage', // ack / dismiss an inbox message
  'smoke-fail': null, // an alert/signal, not a governed decision
  'operator-report': null, // a status report, not a governed decision
  // B-14 / P-100 folded disposition channels (D-011):
  'improvement': 'ideation-intake', // triage / promote a human-routed improvement
  'standing-approval': 'system-control', // grant standing auto-dispatch — autonomy-widening, owner-authority (PROTECTED, never-auto: the recursion D-005 guards)
  'conversation': 'escalations', // answer an open agent question (coord:ask / the owner-decision-queue)
  'scout-grade': 'ideation-intake', // grade routed Scout ideas
};

/** The autonomy category for an attention kind — `null` for an ungoverned
 *  signal/report (see {@link ATTENTION_KIND_CATEGORY}). */
export function attentionCategory(kind: AttentionKind): AutonomyCategory | null {
  return ATTENTION_KIND_CATEGORY[kind];
}

/**
 * The four inbox tiers (inbox-tiering-and-message-agent-2026-06-05 D-002/D-006).
 * Orthogonal to {@link AttentionKind} — every item is exactly one tier, ordered
 * Decision ▸ Handled ▸ Alert ▸ Activity (only Decisions demands the user):
 *   - `decision` — demands the human: needs-human plan items (the plan-
 *     governance gate that replaced the retired plan-review source, P-101),
 *     blocker/question escalations, direct non-auto messages to the
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
  | { kind: 'operator-report'; turnId: string; conversationId: string }
  // B-14 / P-100 folded disposition channels (D-011):
  | { kind: 'improvement'; issueId: string }
  | { kind: 'standing-approval'; capability: string; targetHarness: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'scout-grade'; count: number };

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
   *  (plan items, smoke-fails). Drives the "Message owner"
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
  /** Structured report payload (kind `operator-report` only) — the one
   *  `ReportBlock` schema from `@papercusp/chat-protocol`, rendered natively
   *  in the detail pane (desktop card / TUI two-tier list). Absent on every
   *  other kind. report-cards-inbox-reconciliation-2026-06-05 D-001/D-003. */
  report?: ReportBlock;
  /** The autonomy category this item's disposition belongs to (B-14 / P-100 ·
   *  D-009/D-011), or `null` for an ungoverned signal/report. Set by the
   *  adapters from {@link ATTENTION_KIND_CATEGORY}; the unified Queue groups +
   *  the Queen decider (B-12) reads it to apply the per-category ceiling.
   *  Optional only so hand-built fixtures / the decoupled UI wire-type need not
   *  carry it — every adapted item sets it. */
  category?: AutonomyCategory | null;
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

/**
 * Worst-of tier for an operator `<report>` payload (D-003 of
 * report-cards-inbox-reconciliation-2026-06-05): scan every plan + item
 * status — any needs-human/review token → `decision`; else any
 * blocked/failing token → `alert`; else `activity`.
 *
 * Token families deliberately mirror the renderer's status-glyph map
 * (OperatorReportCard / TUI status_marker) so what *looks* like a review
 * ask or a failure *tiers* like one. Statuses are free strings (Brief 22
 * D-002); unknown tokens fall through to `activity` — per Brief 21 D-006
 * the source is a loose cheap pre-sort and the operator's `<report>` is
 * already operator-judged, so over-deriving here is the bigger error.
 */
export function reportTier(report: ReportBlock): AttentionTier {
  const DECISION = new Set(['needs-human', 'needs_human', 'review']);
  const ALERT = new Set(['blocked', 'failing', 'failed', 'error']);
  let sawAlert = false;
  const statuses = (s: string | undefined): string => (s ?? '').trim().toLowerCase();
  for (const plan of report.plans) {
    const ps = statuses(plan.status);
    if (DECISION.has(ps)) return 'decision';
    if (ALERT.has(ps)) sawAlert = true;
    for (const it of plan.items ?? []) {
      const is = statuses(it.status);
      if (DECISION.has(is)) return 'decision';
      if (ALERT.has(is)) sawAlert = true;
    }
  }
  return sawAlert ? 'alert' : 'activity';
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

/**
 * Map a coord escalation severity onto the canonical `risk_tier` scale
 * (queen-autonomy-policy-2026-06-13 / P-013): escalation severity is no longer
 * an independent PARALLEL scale — it is a labeled band of `risk_tier`, so the
 * autonomy gate and the inbox reason about ONE risk vocabulary, not two.
 *   - `blocker`  → `critical` (fully blocks; a decision the human must make)
 *   - `question` → `high` (an agent's explicit escalation of a paused decision)
 *   - `advisory` → `low` (FYI)
 * Kept SEPARATE from {@link severityToImportance} (P-014): `risk_tier` drives the
 * autonomy gate / the alert-vs-decision tier; `importance` drives the
 * within-tier ranker. The two derive from severity INDEPENDENTLY.
 */
export function severityToRiskTier(sev: 'blocker' | 'question' | 'advisory'): RiskTier {
  switch (sev) {
    case 'blocker':
      return 'critical';
    case 'question':
      return 'high';
    case 'advisory':
      return 'low';
    default:
      return 'moderate';
  }
}

/**
 * The `risk_tier` at/above which an item is a human DECISION rather than an FYI
 * Alert. Set to `moderate` so the escalation fold is behavior-neutral:
 * `advisory` (low) → Alert; `question`/`blocker` (high/critical) → Decision —
 * exactly the prior `severity === 'advisory' ? 'alert' : 'decision'` outcome.
 */
export const DECISION_RISK_TIER: RiskTier = 'moderate';

/** Whether a `risk_tier` rises to a human DECISION (≥ {@link DECISION_RISK_TIER}). */
export function riskTierIsDecision(t: RiskTier): boolean {
  return riskTierRank(t) >= riskTierRank(DECISION_RISK_TIER);
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
