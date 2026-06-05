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
import {
  type AttentionItem,
  type AttentionAction,
  type AttentionTier,
  needsHumanForTier,
  severityToImportance,
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

/* ── coord escalation (P-010) ───────────────────────────────────────── */

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

export function coordEscalationToAttention(e: CoordEscalationInput): AttentionItem {
  const options = e.options ?? [];
  // Tier (D-002/D-001): a blocker/question escalation is a genuine human
  // Decision — this is where coord:ask-owner + coord:escalate(blocker) land.
  // An advisory escalation is FYI → an Alert (surface, don't demand).
  const tier: AttentionTier = e.severity === 'advisory' ? 'alert' : 'decision';
  const needsHuman = needsHumanForTier(tier);
  return {
    id: `coord-escalation:${e.msgId}`,
    kind: 'coord-escalation',
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

/* ── coord message addressed to the human (P-027) ───────────────────── */

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
  // Tier (D-002/D-003): classify from STRUCTURED fields, never the text.
  // A lifecycle auto-broadcast (auto:true or lifecycle set) → Activity. A
  // non-auto message addressed directly to the human → a Decision (a real
  // ping the owner should see). A non-auto plain broadcast → Activity (FYI).
  const isAuto = m.auto === true || (typeof m.lifecycle === 'string' && m.lifecycle.length > 0);
  const tier: AttentionTier = isAuto ? 'activity' : m.directToOwner ? 'decision' : 'activity';
  const needsHuman = needsHumanForTier(tier);
  return {
    id: `coord-message:${m.msgId}`,
    kind: 'coord-message',
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

/* ── plan ready for review (P-026) ──────────────────────────────────── */

export interface PlanReviewInput {
  harnessSlug: string;
  content?: string | null;
}

export function planReviewToAttention(r: PlanReviewInput): AttentionItem {
  // A plan awaiting the human's review is a gate → Decision.
  const tier: AttentionTier = 'decision';
  return {
    id: `plan-review:${r.harnessSlug}`,
    kind: 'plan-review',
    source: 'harness',
    harnessSlug: r.harnessSlug,
    planSlug: null, // the review row is harness-keyed, not tied to a plan slug
    itemRef: null,
    title: `Plan ready for review — ${r.harnessSlug}`,
    body: (r.content ?? '').trim() || 'A plan is awaiting your review.',
    status: 'pending-review',
    importance: 'high',
    tier,
    needsHuman: needsHumanForTier(tier),
    ownerAgentId: null,
    ownerLabel: null,
    ...untriaged(),
    actions: [{ id: 'open', label: 'Review', primary: true }, CHAT, MESSAGE_OWNER],
    ref: { kind: 'plan-review', harnessSlug: r.harnessSlug },
  };
}
