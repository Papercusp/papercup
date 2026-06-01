/**
 * Adapters: each live attention surface → AttentionItem
 * (planning-attention-importance-2026-05-31, P-009/P-010/P-025/P-026/P-027).
 *
 * Pure functions — input record shape in, AttentionItem out. The reader
 * (P-011) fetches the real records from each source and maps them to
 * these minimal input shapes, keeping the adapters free of I/O and of
 * the (submodule-bound) source types. Each adapter is where a kind's
 * title / body / status / importance / action buttons are defined.
 */

import { type Importance } from '@papercusp/plan-parser';
import { type AttentionItem, type AttentionAction, severityToImportance } from './types';

const CHAT: AttentionAction = { id: 'chat', label: 'Chat' };

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
}

export function planItemToAttention(it: PlanItemInput): AttentionItem {
  const needsHuman = it.storedStatus === 'needs-human';
  // The full needs-human toolkit lives in `actions[]` (the single source the
  // card mapper reads — inbox-cards-unification P-009): Answer (free-text
  // decision, navigate → inline InputCard), Resolve (quick done), Drop
  // (won't-do), Chat. Non-needs-human plan items are agent-actionable, so the
  // human only gets Chat.
  const actions: AttentionAction[] = needsHuman
    ? [
        { id: 'answer', label: 'Answer' },
        { id: 'mark-done', label: 'Resolve', primary: true },
        { id: 'drop', label: 'Drop' },
        CHAT,
      ]
    : [CHAT];
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
    needsHuman,
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
}

export function coordEscalationToAttention(e: CoordEscalationInput): AttentionItem {
  const options = e.options ?? [];
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
    needsHuman: true,
    // Resolve always (coord:resolve, with the escalation's named options).
    // Chat opens a per-harness agent chat, so only offer it when the escalation
    // carries a harness — workspace-level escalations have none and Chat would
    // dead-end on "not attached to a harness".
    actions: e.harnessSlug
      ? [{ id: 'resolve', label: 'Resolve', primary: true }, CHAT]
      : [{ id: 'resolve', label: 'Resolve', primary: true }],
    ref: { kind: 'coord-escalation', msgId: e.msgId, options },
  };
}

/* ── coord message addressed to the human (P-027) ───────────────────── */

export interface CoordMessageInput {
  msgId: string;
  summary?: string;
  body?: string;
  from?: string;
  planSlug?: string | null;
  harnessSlug?: string | null;
}

export function coordMessageToAttention(m: CoordMessageInput): AttentionItem {
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
    needsHuman: true,
    // Ack always; Chat only when the message carries a harness (workspace-level
    // broadcasts have none, so a per-harness chat can't open).
    actions: m.harnessSlug
      ? [{ id: 'ack', label: 'Acknowledge', primary: true }, CHAT]
      : [{ id: 'ack', label: 'Acknowledge', primary: true }],
    ref: { kind: 'coord-message', msgId: m.msgId },
  };
}

/* ── smoke-test failure (P-025) ─────────────────────────────────────── */

export interface SmokeFailInput {
  harnessSlug: string;
  failureContent?: string | null;
}

export function smokeFailToAttention(s: SmokeFailInput): AttentionItem {
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
    needsHuman: true,
    actions: [{ id: 'view-log', label: 'View log', primary: true }, CHAT],
    ref: { kind: 'smoke-fail', harnessSlug: s.harnessSlug },
  };
}

/* ── plan ready for review (P-026) ──────────────────────────────────── */

export interface PlanReviewInput {
  harnessSlug: string;
  content?: string | null;
}

export function planReviewToAttention(r: PlanReviewInput): AttentionItem {
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
    needsHuman: true,
    actions: [{ id: 'open', label: 'Review', primary: true }, CHAT],
    ref: { kind: 'plan-review', harnessSlug: r.harnessSlug },
  };
}
