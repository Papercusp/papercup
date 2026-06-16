/**
 * Adapters: each live attention surface → AttentionItem
 * (planning-attention-importance-2026-05-31, P-009/P-010/P-025/P-026/P-027;
 *  inbox-tiering-and-message-agent-2026-06-05 — tier + owner + message-owner).
 *
 * Pure functions — input record shape in, AttentionItem out. The reader
 * (P-011) fetches the real records from each source and maps them to
 * these minimal input shapes, keeping the adapters free of I/O and of
 * the (submodule-bound) source types. Each adapter is where a kind's
 * title / body / status / importance / tier / owner / action buttons are defined.
 *
 * `tier` (D-002) is computed here from each kind's real meaning, and
 * `needsHuman` is DERIVED from it (`needsHumanForTier`) — never hard-coded —
 * so the invariant `needsHuman === (tier === 'decision')` holds for every item.
 */

import { type Importance } from '@papercusp/plan-parser';
import type { ReportBlock } from '@papercusp/chat-protocol';
import {
  type AttentionItem,
  type AttentionAction,
  type AttentionTier,
  ATTENTION_KIND_CATEGORY,
  needsHumanForTier,
  reportTier,
  severityToImportance,
  severityToRiskTier,
  riskTierIsDecision,
  untriaged,
} from './types';

const CHAT: AttentionAction = { id: 'chat', label: 'Chat' };
/** Open a work-item-scoped conversation with the item's owning agent (D-004).
 *  A navigate action (opens a thread sub-surface), present on every item. */
const MESSAGE_OWNER: AttentionAction = { id: 'message-owner', label: 'Message owner' };

/** First non-empty line, trimmed and truncated for a list-row title. */
function clip(s: string | null | undefined, n = 120): string {
  const firstLine = (s ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return firstLine.length > n ? `${firstLine.slice(0, n - 1)}…` : firstLine;
}

/* ── plan item (P-009) ──────────────────────────────────────────────── */

export interface PlanItemInput {
  slug: string;
  harnessSlug: string | null;
  /** P-NNN. */
  id: string;
  text: string;
  storedStatus: string;
  effectiveStatus: string;
  importance: Importance;
  /** The current claimant/assignee, when the reader can resolve one. */
  ownerAgentId?: string | null;
  ownerLabel?: string | null;
}

export function planItemToAttention(it: PlanItemInput): AttentionItem {
  // Tier (D-002): a needs-human item is a Decision; a blocked item is an Alert
  // (work is stuck, worth surfacing); a normal todo/wip item is Activity
  // (agent-actionable, pickable work).
  const tier: AttentionTier =
    it.storedStatus === 'needs-human'
      ? 'decision'
      : it.storedStatus === 'blocked' || it.effectiveStatus === 'blocked'
        ? 'alert'
        : 'activity';
  const needsHuman = needsHumanForTier(tier);
  // The full needs-human toolkit lives in `actions[]` (the single source the
  // card mapper reads — inbox-cards-unification P-009): Answer (free-text
  // decision, navigate → inline InputCard), Resolve (quick done), Drop
  // (won't-do), Chat, Message owner. Non-needs-human plan items are
  // agent-actionable, so the human only gets Chat + Message owner.
  const actions: AttentionAction[] = needsHuman
    ? [
        { id: 'answer', label: 'Answer' },
        { id: 'mark-done', label: 'Resolve', primary: true },
        { id: 'drop', label: 'Drop' },
        CHAT,
        MESSAGE_OWNER,
      ]
    : [CHAT, MESSAGE_OWNER];
  return {
    id: `plan-item:${it.slug}:${it.id}`,
    kind: 'plan-item',
    category: ATTENTION_KIND_CATEGORY['plan-item'],
    source: 'plan',
    harnessSlug: it.harnessSlug,
    planSlug: it.slug,
    itemRef: it.id,
    title: clip(it.text),
    body: it.text,
    status: it.effectiveStatus,
    importance: it.importance,
    tier,
    needsHuman,
    ownerAgentId: it.ownerAgentId ?? null,
    ownerLabel: it.ownerLabel ?? null,
    ...untriaged(),
    actions,
    ref: { kind: 'plan-item', slug: it.slug, itemId: it.id },
  };
}

/* ── coord escalation (P-010) ───────────────────────────────────────────
 * The DECISION coord-channel (P-102/D-011): an escalation is a BLOCKED decision
 * whose disposition is RESOLVE-WITH-CHOICE (coord:resolve, picking a named
 * option). blocker/question → Decision; advisory → Alert. Distinct from a
 * `coord-message` (a communication, ack) and a `conversation` (a non-blocking
 * coord:ask question, Alert). These three are the coherent coord disposition set.
 */

export interface CoordEscalationInput {
  msgId: string;
  severity: 'blocker' | 'question' | 'advisory';
  summary: string;
  body?: string;
  planSlug?: string | null;
  harnessSlug?: string | null;
  options?: { id: string; label: string }[];
  /** The escalating agent (the coord record's `from`) — drives Message owner. */
  from?: string | null;
  fromLabel?: string | null;
}

/**
 * queue-pending-accuracy D-005: an escalation is OPERATIONAL — a system/automated
 * alert, NOT a human decision — when its sender is a `system` owner (incl.
 * `system:<emitter>` like `system:hive-placement-watchdog`) AND it carries no
 * options (no choice to make). Placement-watchdog cursed placements + aging
 * sweeps are the dominant class (~7000 open, 135 ever resolved). Genuine human
 * decisions come from agents (coord:escalate / coord:ask-owner) — a real sender,
 * often with options. Operational escalations are surfaced in the ALERT tier and
 * auto-resolved by the reconciliation sweep; they never reach "waiting on you".
 * The shared classifier so the reader (tiering) and the reconcile sweep agree.
 */
export function isOperationalEscalation(from: string | null | undefined, hasOptions: boolean): boolean {
  return !hasOptions && typeof from === 'string' && (from === 'system' || from.startsWith('system:'));
}

export function coordEscalationToAttention(e: CoordEscalationInput): AttentionItem {
  const options = e.options ?? [];
  // Tier (D-002/D-001) via the canonical risk scale (queen-autonomy-policy P-013):
  // the escalation's severity folds into `risk_tier`, and the alert-vs-decision
  // tier derives from THAT — one scale, not two. blocker/question (critical/high)
  // → Decision (a genuine human call: coord:ask-owner + coord:escalate(blocker)
  // land here); advisory (low) → Alert (surface, don't demand).
  const riskTier = severityToRiskTier(e.severity);
  // queue-pending-accuracy D-005: a SYSTEM-emitted escalation with no options is
  // OPERATIONAL (placement-watchdog cursed placements, aging sweeps, breakers) —
  // an alert to surface, NOT a human decision-with-choice. Genuine decisions come
  // from agents (coord:escalate / coord:ask-owner) and either come from a real
  // sender or carry options to pick. Surfacing every cursed placement as a
  // "waiting on you" decision flooded the queue (~7000+ open, 135 ever resolved);
  // the derived placements.cursed health metric is the proper rollup.
  const operationalSystem = isOperationalEscalation(e.from, options.length > 0);
  const tier: AttentionTier = operationalSystem
    ? 'alert'
    : riskTierIsDecision(riskTier)
      ? 'decision'
      : 'alert';
  const needsHuman = needsHumanForTier(tier);
  return {
    id: `coord-escalation:${e.msgId}`,
    kind: 'coord-escalation',
    category: ATTENTION_KIND_CATEGORY['coord-escalation'],
    source: 'coord',
    harnessSlug: e.harnessSlug ?? null,
    planSlug: e.planSlug ?? null,
    itemRef: null,
    title: clip(e.summary),
    body: e.body?.trim() || e.summary,
    status: 'open',
    importance: severityToImportance(e.severity),
    tier,
    needsHuman,
    ownerAgentId: e.from ?? null,
    ownerLabel: e.fromLabel ?? e.from ?? null,
    ...untriaged(),
    // Resolve always (coord:resolve, with the escalation's named options).
    // Chat opens a per-harness agent chat, so only offer it when the escalation
    // carries a harness — workspace-level escalations have none and Chat would
    // dead-end on "not attached to a harness". Message owner is always offered.
    actions: e.harnessSlug
      ? [{ id: 'resolve', label: 'Resolve', primary: true }, CHAT, MESSAGE_OWNER]
      : [{ id: 'resolve', label: 'Resolve', primary: true }, MESSAGE_OWNER],
    ref: { kind: 'coord-escalation', msgId: e.msgId, options },
  };
}

/* ── coord message addressed to the human (P-027) ───────────────────────
 * The COMMUNICATION coord-channel (P-102/D-011): a message's disposition is ACK
 * (acknowledge/dismiss) — it is NEVER a Decision. A blocked decision is an
 * `coord-escalation` (resolve-with-choice); an open question is a `conversation`
 * (coord:ask). A directly-addressed message is an Alert; a broadcast is Activity.
 */

export interface CoordMessageInput {
  msgId: string;
  summary?: string;
  body?: string;
  from?: string;
  fromLabel?: string | null;
  planSlug?: string | null;
  harnessSlug?: string | null;
  /** `auto:true` marker that coord:emit stamps on lifecycle broadcasts. */
  auto?: boolean;
  /** `lifecycle:'<category>'` marker (completion/claim/intent/…) — presence
   *  alone marks the message as a system lifecycle broadcast. */
  lifecycle?: string | null;
  /** True when the message is addressed DIRECTLY to the human (its `to`
   *  includes the human owner id), not solely a `*` broadcast. */
  directToOwner?: boolean;
}

export function coordMessageToAttention(m: CoordMessageInput): AttentionItem {
  // Tier (D-002/D-003 + P-102/D-011): classify from STRUCTURED fields, never the
  // text. A message is a COMMUNICATION (its disposition is `ack`), NEVER a
  // Decision — acking is not deciding. Genuine human decisions route through
  // ESCALATIONS (coord:escalate → resolve-with-choice) or open QUESTIONS
  // (coord:ask → conversation); a plain coord:send to the human is an FYI. So:
  // a non-auto message addressed directly to the human → Alert (worth surfacing,
  // but ack-only); an auto/lifecycle broadcast or a plain `*` broadcast →
  // Activity. This collapses the old question-escalation ↔ direct-message overlap
  // (both used to land in Decisions): escalations are now the sole decision
  // coord-channel.
  const isAuto = m.auto === true || (typeof m.lifecycle === 'string' && m.lifecycle.length > 0);
  const tier: AttentionTier = isAuto ? 'activity' : m.directToOwner ? 'alert' : 'activity';
  const needsHuman = needsHumanForTier(tier);
  return {
    id: `coord-message:${m.msgId}`,
    kind: 'coord-message',
    category: ATTENTION_KIND_CATEGORY['coord-message'],
    source: 'coord',
    harnessSlug: m.harnessSlug ?? null,
    planSlug: m.planSlug ?? null,
    itemRef: null,
    title: clip(m.summary || m.body || 'Message'),
    body: m.body?.trim() || m.summary || '',
    // Neutral status — there is no real read/ack tracking yet, so don't
    // imply one with an "unread" badge.
    status: 'message',
    importance: 'normal',
    tier,
    needsHuman,
    ownerAgentId: m.from ?? null,
    ownerLabel: m.fromLabel ?? m.from ?? null,
    ...untriaged(),
    // Ack always; Chat only when the message carries a harness (workspace-level
    // broadcasts have none, so a per-harness chat can't open). Message owner
    // is always offered.
    actions: m.harnessSlug
      ? [{ id: 'ack', label: 'Acknowledge', primary: true }, CHAT, MESSAGE_OWNER]
      : [{ id: 'ack', label: 'Acknowledge', primary: true }, MESSAGE_OWNER],
    ref: { kind: 'coord-message', msgId: m.msgId },
  };
}

/* ── smoke-test failure (P-025) ─────────────────────────────────────── */

export interface SmokeFailInput {
  harnessSlug: string;
  failureContent?: string | null;
}

export function smokeFailToAttention(s: SmokeFailInput): AttentionItem {
  // A failing smoke test is a problem to surface, not a decision → Alert.
  const tier: AttentionTier = 'alert';
  return {
    id: `smoke-fail:${s.harnessSlug}`,
    kind: 'smoke-fail',
    category: ATTENTION_KIND_CATEGORY['smoke-fail'],
    source: 'harness',
    harnessSlug: s.harnessSlug,
    planSlug: null, // unattached → synthetic "Alerts" bucket
    itemRef: null,
    title: `Smoke test failing — ${s.harnessSlug}`,
    body: (s.failureContent ?? '').trim() || 'The smoke test is failing.',
    status: 'fail',
    importance: 'high',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    actions: [{ id: 'view-log', label: 'View log', primary: true }, CHAT, MESSAGE_OWNER],
    ref: { kind: 'smoke-fail', harnessSlug: s.harnessSlug },
  };
}

/* ── operator `<report>` turn (report-cards-inbox-reconciliation P-003) ── */

export interface OperatorReportInput {
  turnId: string;
  conversationId: string;
  /** The validated `ReportBlock` from `operator_turns.report`. */
  report: ReportBlock;
  /** The turn's `<say>` text — title fallback when the report has none. */
  sayText?: string | null;
}

/** Plain-text rendition of a report block for text-only surfaces (the
 *  mobile/device attention route, search). The structured payload rides
 *  `AttentionItem.report` for the native renderers. */
function reportBody(report: ReportBlock): string {
  const lines: string[] = [];
  for (const p of report.plans) {
    const status = p.status ? `[${p.status}] ` : '';
    const summary = p.summary ? ` — ${p.summary}` : '';
    lines.push(`${status}${p.title}${summary}`);
    for (const it of p.items ?? []) {
      const is = it.status ? `[${it.status}] ` : '';
      const id = it.id ? `${it.id} ` : '';
      lines.push(`  ${is}${id}${it.text}`);
    }
  }
  return lines.join('\n');
}

/**
 * One inbox item per `<report>` turn (D-003 — a 4-plan status report is one
 * row, not four). Tier = worst-of statuses via {@link reportTier}; the
 * operator's report is the precision-filtered output already (Brief 21
 * D-006), so `decision` here means the operator explicitly marked something
 * needs-human/review. Importance follows the tier (a "needs your review"
 * report should be seen today; a status snapshot can wait).
 */
export function operatorReportToAttention(r: OperatorReportInput): AttentionItem {
  const tier = reportTier(r.report);
  const importance: Importance =
    tier === 'decision' ? 'high' : tier === 'alert' ? 'normal' : 'low';
  // A single-plan report is *about* that plan — adopt its slug so the item
  // groups with the plan in the master list. Multi-plan snapshots stay
  // unattached (the synthetic bucket).
  const planSlug =
    r.report.plans.length === 1 ? r.report.plans[0]?.slug ?? null : null;
  const actions: AttentionAction[] = [
    { id: 'resolve', label: 'Resolve', primary: true },
  ];
  if (planSlug) actions.push({ id: 'open', label: 'Open plan' });
  return {
    id: `operator-report:${r.turnId}`,
    kind: 'operator-report',
    category: ATTENTION_KIND_CATEGORY['operator-report'],
    source: 'operator',
    harnessSlug: null, // the operator conversation is workspace-level
    planSlug,
    itemRef: null,
    title: r.report.title ?? (clip(r.sayText) || 'Operator report'),
    body: reportBody(r.report),
    status: 'report',
    importance,
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: 'Operator',
    ...untriaged(),
    actions,
    ref: { kind: 'operator-report', turnId: r.turnId, conversationId: r.conversationId },
    report: r.report,
  };
}

/* ── B-14 / P-100: the folded disposition channels (D-011) ───────────────────
 *
 * Each is a categorized decision/action the Queen did not auto-handle, surfaced
 * on the unified Queue. Resolution stays on the dedicated surface via a navigate
 * `open` action (the smoke-fail/operator-report pattern) — inline-disposition
 * buttons are a follow-on, not a blocker for the fold. CRITICAL: each adapter's
 * READER (plans:attention) filters to the genuinely-AWAITING-HUMAN slice, never
 * the full backlog — improvements only when `needsHuman` (the auto-implement
 * loop's human-routing flag); the execution backlog (work_items) stays separate.
 */

/** issue/improvement severity → importance (distinct from escalation severity). */
function issueSeverityToImportance(sev: string | null | undefined): Importance {
  switch (sev) {
    case 'critical':
      return 'urgent';
    case 'major':
      return 'high';
    case 'nit':
      return 'low';
    default:
      return 'normal'; // 'minor' / unknown
  }
}

/* ── improvement awaiting human triage (P-100) ──────────────────────────── */

export interface ImprovementInput {
  /** engineer_issues id (EI-NNN / WI-NNN). */
  issueId: string;
  title: string;
  body?: string | null;
  severity?: string | null;
  harnessSlug?: string | null;
}

export function improvementToAttention(i: ImprovementInput): AttentionItem {
  // The auto-implement loop set needsHuman → it explicitly routed this to the
  // owner (the reader only passes needsHuman-flagged items), so it is a Decision.
  const tier: AttentionTier = 'decision';
  return {
    id: `improvement:${i.issueId}`,
    kind: 'improvement',
    category: ATTENTION_KIND_CATEGORY['improvement'],
    source: 'harness',
    harnessSlug: i.harnessSlug ?? null,
    planSlug: null, // unattached → the synthetic "Alerts" bucket
    itemRef: null,
    title: clip(i.title),
    body: (i.body ?? '').trim() || i.title,
    status: 'needs-triage',
    importance: issueSeverityToImportance(i.severity),
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    // D-027 follow-on (1): inline Dismiss (improvements:triage reject — closes the
    // idea, and the recall matcher surfaces "already decided" on the next
    // same-signature capture). Triage stays a navigate to the full surface: ACCEPTING
    // an improvement is a routing decision (place/gate/gym), not a one-click — a bare
    // inline "accept" would record an un-targeted decision, so it lives on the source.
    actions: [
      { id: 'open', label: 'Triage', primary: true },
      { id: 'dismiss', label: 'Dismiss' },
    ],
    ref: { kind: 'improvement', issueId: i.issueId },
  };
}

/* ── standing-approval candidate awaiting the owner (P-100) ──────────────── */

export interface StandingApprovalInput {
  capability: string;
  targetHarness: string;
  /** Silent dispatches in the trailing 24h window (≥3 to qualify). */
  count: number;
  lastSeenAt?: string | null;
}

export function standingApprovalToAttention(s: StandingApprovalInput): AttentionItem {
  // The owner must decide whether to grant standing auto-dispatch — a genuine
  // Decision. Category system-control is PROTECTED (never-auto): the Queen can
  // never auto-grant herself a standing approval (the recursion D-005 guards).
  const tier: AttentionTier = 'decision';
  return {
    id: `standing-approval:${s.capability}:${s.targetHarness}`,
    kind: 'standing-approval',
    category: ATTENTION_KIND_CATEGORY['standing-approval'],
    source: 'operator',
    harnessSlug: s.targetHarness,
    planSlug: null,
    itemRef: null,
    title: `Standing approval? ${s.capability} → ${s.targetHarness}`,
    body: `The operator has auto-dispatched ${s.capability} to ${s.targetHarness} ${s.count}× in the last 24h. Grant a standing approval (auto-dispatch without asking) or dismiss.`,
    status: 'pending-approval',
    importance: 'normal',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    // D-027 follow-on (1): inline disposition — Grant writes the standing
    // [STANDING-APPROVE] preference entry, Dismiss drops the candidate
    // (operator:standing_approvals_decide). A clean owner binary, so resolve it
    // on the Queue rather than bouncing to the operator-settings surface.
    actions: [
      { id: 'grant', label: 'Grant', primary: true },
      { id: 'dismiss', label: 'Dismiss' },
    ],
    ref: { kind: 'standing-approval', capability: s.capability, targetHarness: s.targetHarness },
  };
}

/* ── open conversation / coord:ask awaiting an answer (P-100) ────────────── */

export interface ConversationInput {
  conversationId: string;
  title: string;
  body?: string | null;
  /** The asking agent (drives Message owner). */
  askerId?: string | null;
  askerLabel?: string | null;
  harnessSlug?: string | null;
}

export function conversationToAttention(c: ConversationInput): AttentionItem {
  // An open question is surfaced as an Alert, not a Decision: many coord:ask
  // conversations are agent↔agent and resolve without the human. The owner can
  // still answer; we surface, we don't demand (mirrors advisory escalations).
  const tier: AttentionTier = 'alert';
  return {
    id: `conversation:${c.conversationId}`,
    kind: 'conversation',
    category: ATTENTION_KIND_CATEGORY['conversation'],
    source: 'coord',
    harnessSlug: c.harnessSlug ?? null,
    planSlug: null,
    itemRef: null,
    title: clip(c.title),
    body: (c.body ?? '').trim() || c.title,
    status: 'open',
    importance: 'normal',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: c.askerId ?? null,
    ownerLabel: c.askerLabel ?? c.askerId ?? null,
    ...untriaged(),
    // D-027 follow-on (1): inline disposition — `answer` is a navigate id (the
    // detail pane reveals an inline InputCard); submitting resolves the question
    // with the owner's text (conversations:resolve { accepted_answer }), which
    // captures it to the knowledge layer AND drops it from the Queue (the reader
    // surfaces only open, unanswered conversations).
    actions: c.harnessSlug
      ? [{ id: 'answer', label: 'Answer', primary: true }, CHAT, MESSAGE_OWNER]
      : [{ id: 'answer', label: 'Answer', primary: true }, MESSAGE_OWNER],
    ref: { kind: 'conversation', conversationId: c.conversationId },
  };
}

/* ── Scout grading rollup (P-100) ────────────────────────────────────────── */

export interface ScoutGradeInput {
  /** Number of routed Scout ideas with no human grade yet. */
  count: number;
}

/**
 * ONE rollup item for the whole ungraded-Scout-ideas set (never one per idea —
 * routed ideas can number in the thousands, and a grade is OPTIONAL feedback
 * that tunes routing, not an owner-blocking decision). Activity tier, low
 * importance; navigates to the Scout/Learning grade view. The reader emits this
 * only when count > 0.
 */
export function scoutGradeToAttention(g: ScoutGradeInput): AttentionItem {
  const tier: AttentionTier = 'activity';
  return {
    id: 'scout-grade:pending',
    kind: 'scout-grade',
    category: ATTENTION_KIND_CATEGORY['scout-grade'],
    source: 'operator',
    harnessSlug: null,
    planSlug: null,
    itemRef: null,
    title: `${g.count} Scout idea${g.count === 1 ? '' : 's'} awaiting your grade`,
    body: 'Routed Scout ideas have no human grade yet — optional feedback (1–5) that tunes idea routing. Grade them in the Scout view.',
    status: 'ungraded',
    importance: 'low',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    actions: [{ id: 'open', label: 'Grade ideas', primary: true }],
    ref: { kind: 'scout-grade', count: g.count },
  };
}
