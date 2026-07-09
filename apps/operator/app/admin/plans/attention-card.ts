/**
 * attention-card — bridges an inbox `AttentionItem` onto the shared chat
 * card renderer (inbox-cards-unification P-010/P-011/P-012).
 *
 * Two pure-ish pieces:
 *   - `attentionItemToCardSpec(item)` maps an item → `AskChoiceArgs` (the
 *     question + styled options). `actions[]` is the single source of truth
 *     (P-009 made it complete); escalations expand their generic `resolve`
 *     action into the named `ref.options` so each becomes a pickable option.
 *   - `resolveAttentionAction(item, optionId)` dispatches a TERMINAL pick to
 *     the item's existing backend helper (D-007: no new route), preserving
 *     the resume-on-resolve / no-resume-on-drop distinction. Navigate ids
 *     (`chat`/`answer`/`view-log`/`open`) are NOT handled here — the
 *     component owns them (inline chat / inline InputCard / harness view).
 *   - `answerAttentionItem(item, text)` is the Answer InputCard submit: for a
 *     plan-item, record a decision + mark done + resume (mirrors the retired
 *     `InboxItemActions.handleAnswer`); for a conversation (D-027 follow-on (1)),
 *     resolve the question with the owner's text as the accepted answer.
 *   - `resolveAttentionAction` also dispatches the standing-approval terminal
 *     grant/dismiss and the improvement Dismiss (reject) (D-027 follow-on (1)).
 *
 * These deliberately reproduce today's `OtherDetail` / `InboxItemActions`
 * behavior — see attention-card.test.ts for the parity assertions (P-013).
 */

import type {
  AttentionItem,
  AttentionAction,
  AttentionActionId,
} from './plans-api';
import {
  resolveEscalation,
  ackCoordMessage,
  setItemStatus,
  addPlanDecision,
  triageAttentionItem,
  decideStandingApproval,
  resolveConversationAnswer,
  dismissImprovement,
} from './plans-api';
import type { AskChoiceArgs, AskChoiceOption } from '@/app/_components/chat/AskChoiceCard';

/** Action ids that open a sub-surface rather than answering the item. The
 *  component handles these; `resolveAttentionAction` ignores them. */
export const NAVIGATE_ACTION_IDS: ReadonlySet<AttentionActionId> = new Set<AttentionActionId>([
  'chat',
  'message-owner',
  'answer',
  'view-log',
  'open',
]);

export function isNavigateAction(id: string): boolean {
  return NAVIGATE_ACTION_IDS.has(id as AttentionActionId);
}

function optionStyle(a: AttentionAction): AskChoiceOption['style'] {
  if (a.id === 'drop') return 'danger';
  if (a.primary) return 'primary';
  return 'default';
}

type EscalationOption = { id: string; label: string };
function escalationOptions(item: AttentionItem): EscalationOption[] {
  const ref = item.ref as { kind: string; options?: unknown };
  if (ref.kind !== 'coord-escalation' || !Array.isArray(ref.options)) return [];
  return (ref.options as EscalationOption[]).filter((o) => o && typeof o.id === 'string');
}

/**
 * Map an inbox item to a card spec. Render with `allowDecline={false}` —
 * durable records have no "Skip" (D-008).
 */
export function attentionItemToCardSpec(item: AttentionItem): AskChoiceArgs {
  const escOpts = escalationOptions(item);
  const options: AskChoiceOption[] = [];

  for (const a of item.actions) {
    // Escalation with named options: expand the generic `resolve` action into
    // one terminal option per named choice (each carries the option id the
    // dispatch passes as `choice`).
    if ((a.id === 'resolve' || a.id === 'mark-done') && escOpts.length) {
      for (const o of escOpts) {
        options.push({ id: o.id, label: o.label, style: 'primary' });
      }
      continue;
    }
    options.push({
      id: a.id,
      label: a.label,
      style: optionStyle(a),
      // Navigate options stay live (open a sub-surface); terminal options
      // commit + disable. `undefined` ⇒ terminal (the renderer default).
      terminal: NAVIGATE_ACTION_IDS.has(a.id) ? false : undefined,
    });
  }

  // An operator-report item renders its ReportBlock natively (the card body
  // via ReportBlockCard) — the question stays the short title so the plain-
  // text body dump isn't duplicated above the structured block.
  if (item.report) {
    return { question: item.title, options, report: item.report };
  }

  return {
    question: item.body?.trim() || item.title,
    options,
  };
}

/** Fire-and-forget brain nudge — the human just unblocked something, so wake
 *  the Queen now (`pot:wake`, floor-debounced) instead of waiting for her
 *  next armed wake. Replaces the retired `/harness/:slug/launch` legacy
 *  run-loop kick (the orchestrator bin was archived 2026-06-06). No `harness`
 *  arg: the hive home slug is resolved server-side (PAPERCUSP_POT_HOME_SLUG)
 *  — the attention item's harness may be a managed harness, not the hive
 *  home. Unresolvable → harmless no-op; the always-armed-wake invariant
 *  (start-hive-wake-orchestration D-002) still guarantees pickup. */
function resumeLoop(_harnessSlug: string | null): void {
  void fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'pot:wake',
      args: { source: 'user', reason: 'Attention item resolved — pick up the unblocked work' },
      confirmed: true,
    }),
  }).catch(() => {});
}

function refField(item: AttentionItem, key: string): string {
  return String((item.ref as Record<string, unknown>)[key] ?? '');
}

export interface ResolveResult {
  /** True when the item's backing record was changed (card → answered). */
  resolved: boolean;
}

/**
 * Dispatch a TERMINAL option pick to the right backend (D-007 helpers).
 * Throws on backend error (the caller toasts). Navigate ids return
 * `{resolved:false}` untouched — they are the component's job.
 */
export async function resolveAttentionAction(
  item: AttentionItem,
  optionId: string,
): Promise<ResolveResult> {
  if (NAVIGATE_ACTION_IDS.has(optionId as AttentionActionId)) return { resolved: false };

  const ref = item.ref as { kind: string };

  if (ref.kind === 'coord-escalation') {
    // optionId is a named escalation option id, or the generic resolve fallback.
    const named = escalationOptions(item).some((o) => o.id === optionId);
    const choice = named ? optionId : 'resolved';
    const res = await resolveEscalation({ msg_id: refField(item, 'msgId'), choice });
    if (res?.error) throw new Error(res.error);
    return { resolved: true };
  }

  if (ref.kind === 'coord-message' && optionId === 'ack') {
    const res = await ackCoordMessage({ msg_id: refField(item, 'msgId') });
    if (res?.error) throw new Error(res.error);
    return { resolved: true };
  }

  if (ref.kind === 'plan-item') {
    const slug = refField(item, 'slug');
    const itemId = refField(item, 'itemId');
    if (optionId === 'mark-done' || optionId === 'resolve') {
      const r = await setItemStatus({ slug, itemId, status: 'done' });
      if ('error' in r) throw new Error(r.error ?? 'set-status failed');
      resumeLoop(item.harnessSlug); // Resolve resumes the loop…
      return { resolved: true };
    }
    if (optionId === 'drop') {
      const r = await setItemStatus({ slug, itemId, status: 'dropped' });
      if ('error' in r) throw new Error(r.error ?? 'set-status failed');
      // …Drop deliberately does NOT (won't-do; preserve today's distinction).
      return { resolved: true };
    }
  }

  if (ref.kind === 'improvement' && optionId === 'dismiss') {
    // D-027 follow-on (1): inline Dismiss → improvements:triage reject (closes the
    // idea, recall-remembers). Accepting/routing stays the navigate `open` (Triage).
    const res = await dismissImprovement(refField(item, 'issueId'));
    if (res?.error) throw new Error(res.error);
    return { resolved: true };
  }

  if (ref.kind === 'standing-approval' && (optionId === 'grant' || optionId === 'dismiss')) {
    // D-027 follow-on (1): inline owner decision on a standing-approval candidate.
    // Grant ('approve') writes the persistent [STANDING-APPROVE] preference entry;
    // Dismiss drops the candidate. Both refresh the candidate list so the row leaves.
    const res = await decideStandingApproval({
      capability: refField(item, 'capability'),
      targetHarness: refField(item, 'targetHarness'),
      decision: optionId === 'grant' ? 'approve' : 'dismiss',
    });
    if (res?.error) throw new Error(res.error);
    return { resolved: true };
  }

  if (ref.kind === 'operator-report' && (optionId === 'resolve' || optionId === 'mark-done')) {
    // Resolving an operator report IS the triage state machine (resolve →
    // handled tier, auditable — Brief 21 D-006); the item id is stable
    // (`operator-report:<turn-id>`) so the triage row sticks across reads.
    const res = await triageAttentionItem({
      itemId: item.id,
      action: 'resolve',
      note: 'Resolved from the inbox detail pane',
    });
    if (res?.error) throw new Error(res.error);
    return { resolved: true };
  }

  // smoke-fail has only navigate actions (view-log / open) — nothing terminal
  // to resolve here.
  return { resolved: false };
}

/**
 * Submit the inline Answer InputCard's free text. Two kinds answer with text:
 *
 *  - `plan-item` (P-021): record a plan decision the agent reads next, mark the
 *    item done, resume the loop. Mirrors the retired `InboxItemActions.handleAnswer`.
 *  - `conversation` (D-027 follow-on (1)): resolve the open question with the
 *    owner's text as the accepted answer — captures it to the knowledge layer for
 *    the next asker and drops it from the Queue. No loop resume (a coord:ask
 *    conversation isn't a plan-blocking decision).
 *
 * Any other kind (or empty text) is a no-op.
 */
export async function answerAttentionItem(item: AttentionItem, answerText: string): Promise<ResolveResult> {
  const body = answerText.trim();
  if (!body) return { resolved: false };
  const kind = (item.ref as { kind: string }).kind;

  if (kind === 'conversation') {
    const res = await resolveConversationAnswer({
      conversation_id: refField(item, 'conversationId'),
      accepted_answer: body,
    });
    if (res?.error) throw new Error(res.error);
    return { resolved: true };
  }

  if (kind !== 'plan-item') return { resolved: false };
  const slug = refField(item, 'slug');
  const itemId = refField(item, 'itemId');
  const dec = await addPlanDecision({ slug, title: `Answer to ${itemId}`, body, refs: [itemId] });
  if ('error' in dec) throw new Error(dec.error ?? 'add-decision failed');
  const r = await setItemStatus({ slug, itemId, status: 'done' });
  if ('error' in r) throw new Error(r.error ?? 'set-status failed');
  resumeLoop(item.harnessSlug);
  return { resolved: true };
}
