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
 *   - `replyToAttentionItem(item, text)` (owner-inbox-single-pane-2026-07-17
 *     P-006) wraps `answerAttentionItem` with REPLY ROUTING (D-007): when the
 *     item's asker (`ownerAgentId`) is LIVE (coord:presence), the reply is
 *     ALSO delivered straight to their coord inbox and they are woken —
 *     stamped with owner-authoritative turn-provenance (D-006) — instead of
 *     relying solely on the resolve path's own (best-effort, awaiting-only)
 *     notification. A dead/unknown asker is untouched here; the existing
 *     Discuss (Papercup) button remains the fallback (D-007).
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
  deliverInboxReply,
} from './plans-api';
import type { AskChoiceArgs, AskChoiceOption } from '@/app/_components/chat/AskChoiceCard';

/** Action ids that open a sub-surface rather than answering the item. The
 *  component handles these; `resolveAttentionAction` ignores them. An id
 *  missing from this set is dispatched as a TERMINAL submit, so every
 *  navigate-style action the adapters emit MUST be listed — omitting
 *  `discuss` made the Discuss button resolve real escalations (EI-13037). */
export const NAVIGATE_ACTION_IDS: ReadonlySet<AttentionActionId> = new Set<AttentionActionId>([
  'chat',
  'message-owner',
  'answer',
  'view-log',
  'open',
  'discuss',
]);

export function isNavigateAction(id: string): boolean {
  return NAVIGATE_ACTION_IDS.has(id as AttentionActionId);
}

function optionStyle(a: AttentionAction): AskChoiceOption['style'] {
  if (a.id === 'drop') return 'danger';
  if (a.primary) return 'primary';
  return 'default';
}

/* ── What each button ACTUALLY does ──────────────────────────────────────────
 * [owner 2026-08-09] "What do those buttons actually do its unclear."
 *
 * `AskChoiceOption.hint` has always existed and QueueCardActions has always
 * rendered it as the button's Tooltip (`opt.hint ?? opt.label`) — but nothing
 * ever SET it, so every tooltip in the Queue, the HUD and the chat popup just
 * repeated the word already printed on the button. A designed seam sitting
 * unused. These fill it.
 *
 * The text is derived from `resolveAttentionAction` below and from
 * `OtherDetail.onResponse`, and lives HERE — beside the dispatch it describes —
 * precisely so it cannot drift from the behavior. If you change what a branch
 * of `resolveAttentionAction` does, change its sentence in the same edit.
 *
 * Two distinctions these exist to make legible, both of which cost real
 * incidents when they were invisible:
 *   - a TERMINAL pick closes the record for everyone and (for escalations)
 *     wakes the agent that asked. It is not undoable from this UI.
 *   - a NAVIGATE pick (`discuss`, `answer`) changes NOTHING server-side; it
 *     only opens a sub-surface. `discuss` missing from NAVIGATE_ACTION_IDS is
 *     what once made the Discuss button silently resolve real owner gates
 *     (EI-13037) — a button whose label admits neither outcome is how that
 *     stayed unnoticed.
 */
function hintFor(item: AttentionItem, optionId: string, namedEscalationOption: boolean): string | undefined {
  const kind = (item.ref as { kind: string }).kind;

  if (namedEscalationOption) {
    // Expanded from the generic `resolve`: the pick's LABEL is delivered to the
    // asking agent as the reply text, then the escalation is closed.
    return 'Answers the agent with this choice, wakes it, and closes this decision. Not undoable here.';
  }

  switch (optionId) {
    case 'discuss':
      return 'Opens a message thread with the agent below. Does not answer or close this.';
    case 'answer':
      if (kind === 'work-item-needs-human' || kind === 'owner-wall') {
        return 'Sends your answer to the live agent, wakes it, then clears this owner block after delivery.';
      }
      return 'Opens a text box below. Your reply is recorded as the accepted answer and closes this.';
    case 'chat':
    case 'message-owner':
      return 'Opens a chat below. Nothing is answered or closed.';
    case 'view-log':
    case 'open':
      return 'Opens this item where it lives. Nothing is answered or closed.';
    case 'ack':
      return 'Acknowledges the message and clears it from your queue.';
    case 'drop':
      return 'Marks the item dropped (won’t-do). Deliberately does NOT resume the agent’s loop.';
    case 'dismiss':
      return kind === 'standing-approval'
        ? 'Declines the standing approval and drops the candidate.'
        : 'Rejects the idea and closes it.';
    case 'grant':
      return 'Grants this capability standing approval — the agent stops asking each time.';
    case 'resolve':
    case 'mark-done':
      if (kind === 'coord-escalation') {
        // No named options to pick, so the reply text is the bare word "Resolved".
        return 'Closes this decision and replies “Resolved” to the agent — no detail. Not undoable here.';
      }
      if (kind === 'plan-item') return 'Marks the item done and wakes the agent’s loop to carry on.';
      if (kind === 'operator-report') return 'Files this report as handled (recorded, with who did it).';
      return 'Closes this item.';
    default:
      return undefined;
  }
}

type EscalationOption = { id: string; label: string };
function escalationOptions(item: AttentionItem): EscalationOption[] {
  const ref = item.ref as { kind: string; options?: unknown };
  if (ref.kind !== 'coord-escalation' || !Array.isArray(ref.options)) return [];
  return (ref.options as EscalationOption[]).filter((o) => o && typeof o.id === 'string');
}

/** True for a `coord-escalation` item carrying named pickable options — the
 *  set SessionChatModal (owner-inbox-single-pane-2026-07-17 P-008) surfaces
 *  inline as an AskChoiceCard. Exported so callers don't re-derive the
 *  `ref.kind === 'coord-escalation' && ref.options` shape check. */
export function isEscalationWithOptions(item: AttentionItem): boolean {
  return escalationOptions(item).length > 0;
}

/**
 * Map an inbox item to a card spec. Render with `allowDecline={false}` —
 * durable records have no "Skip" (D-008).
 */
export function attentionItemToCardSpec(item: AttentionItem): AskChoiceArgs {
  const escOpts = escalationOptions(item);
  const options: AskChoiceOption[] = [];

  // `?? []` is NOT defensive noise — the LIST FEED DELIBERATELY DROPS `actions`
  // (see PlanOtherList's toolbar comment: "actions is dropped from the list feed,
  // so rendering the bar early would show ZERO buttons"), and they only arrive
  // once the per-item DETAIL fetch lands. So between first paint and that fetch
  // resolving, this function is legitimately called with an item that has no
  // `actions` — and an unguarded for-of over undefined THROWS, which React turns
  // into a crashed HUD tab ("undefined is not an object (evaluating
  // 'item.actions')" — owner-visible 2026-07-28, whole tab replaced by an error
  // panel). The toolbar was already held back for exactly this reason; this call
  // path simply was not. An item with no actions yet correctly yields no options.
  //
  // The declared type USED to say `actions: AttentionAction[]` (non-optional) —
  // a TYPE LIE the list feed violated at runtime, and the reason tsc never
  // flagged this. That is now fixed: `AttentionItem.actions` is optional, so tsc
  // forces this guard at every consumer instead of leaving the next one to
  // rediscover the crash. `attention-list-feed-shape.test.ts` holds the line by
  // driving the REAL projection rather than a hand-written fixture.
  for (const a of item.actions ?? []) {
    // Escalation with named options: expand the generic `resolve` action into
    // one terminal option per named choice (each carries the option id the
    // dispatch passes as `choice`).
    if ((a.id === 'resolve' || a.id === 'mark-done') && escOpts.length) {
      for (const o of escOpts) {
        options.push({ id: o.id, label: o.label, style: 'primary', hint: hintFor(item, o.id, true) });
      }
      continue;
    }
    options.push({
      id: a.id,
      label: a.label,
      style: optionStyle(a),
      hint: hintFor(item, a.id, false),
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
function resumeLoop(_harnessSlug: string | null | undefined): void {
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
  /** Set only when a reply-delivery attempt was made (coord-escalation named-option
   *  resolve, or replyToAttentionItem): true when the asker was live and woken. */
  live?: boolean;
  /** Set alongside `live` — how many live sessions the reply woke. */
  woken?: number;
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
    // Resolve ONLY a named escalation option id, or the generic resolve
    // action itself. Any other id (a future navigate action missing from
    // NAVIGATE_ACTION_IDS, a typo'd adapter id) must NOT fall through to a
    // generic resolve — that silently closes a real owner gate (the Discuss
    // incident, EI-13037).
    const namedOpt = escalationOptions(item).find((o) => o.id === optionId);
    if (!namedOpt && optionId !== 'resolve' && optionId !== 'mark-done') return { resolved: false };
    const choice = namedOpt ? namedOpt.id : 'resolved';
    const res = await resolveEscalation({ msg_id: refField(item, 'msgId'), choice });
    if (res?.error) throw new Error(res.error);
    // P-009 E2E finding (owner-inbox-single-pane-2026-07-17): picking a NAMED
    // option (the AskChoiceCard path P-008 built) resolved the escalation
    // server-side but NEVER reached the asker — only the free-text Answer
    // path (replyToAttentionItem, conversation/plan-item only) delivered a
    // woken, provenance-stamped reply (D-006/D-007). An agent that asked via
    // <ask>{"options":[...]}</ask> (the P-001 Stop-hook mirror's own
    // documented wire shape) got its escalation silently closed with no
    // reply ever reaching it — reproduced live via a probe session whose
    // turn-provenance ledger never gained a coord-inject:owner entry after
    // an inbox operator clicked its option. Mirror replyToAttentionItem's
    // best-effort delivery here too, so a named-option resolve is no longer
    // a silent close. Never throws — a delivery hiccup must not surface as a
    // failed resolve; the resolve above already succeeded.
    const askerId = item.ownerAgentId;
    const replyText = namedOpt?.label ?? (optionId === 'mark-done' ? 'Resolved' : 'Resolved');
    if (askerId) {
      try {
        const reply = await deliverInboxReply({
          askerId,
          text: replyText,
          summary: `Owner answered your ${item.kind} (${item.id})`,
          planSlug: item.planSlug ?? undefined,
        });
        if (!reply.error) return { resolved: true, live: reply.live, woken: reply.woken };
      } catch {
        // best-effort — fall through to the plain resolved result below.
      }
    }
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

export interface ReplyResult extends ResolveResult {
  /** True when the asker was live (coord:presence) and the reply was pushed
   *  straight to their inbox + they were woken. False (including on any
   *  delivery error) means the caller should treat this like today — the
   *  answer still resolved the item; only the extra push didn't happen. */
  live: boolean;
  woken: number;
}

/**
 * D-006/D-007 (owner-inbox-single-pane-2026-07-17 P-006): answer an ask item
 * AND route the reply straight back to its asker. Resolves via the existing
 * `answerAttentionItem` path first (unchanged behavior — the item still
 * resolves even if reply-routing below fails or the asker is dead), then,
 * only when the item names an asker (`ownerAgentId`), best-effort delivers +
 * wakes them via the admin-UI-only inbox-reply route (D-007) — which also
 * stamps the delivered turn `coord-inject:owner` in the turn-provenance
 * ledger (D-006). Never throws for a dead/unknown asker or a delivery
 * fault — those degrade to `{ live: false, woken: 0 }`; the resolve itself
 * already landed via the (already-thrown-on-failure) `answerAttentionItem`
 * call above.
 */
export async function replyToAttentionItem(item: AttentionItem, answerText: string): Promise<ReplyResult> {
  const askerId = item.ownerAgentId;
  const body = answerText.trim();
  const kind = (item.ref as { kind: string }).kind;

  // P-013: needs-human work items and owner walls are already durable source
  // records; their missing operation was the OWNER'S TEXT reaching the live
  // agent that can clear the source. Deliver first, then triage the attention
  // card only after that authoritative owner turn lands. If the agent is gone
  // or delivery fails, leave the card unresolved — the adapter exposes the
  // honest source/session fallback instead of silently losing the answer.
  if (kind === 'work-item-needs-human' || kind === 'owner-wall') {
    if (!askerId || !body) return { resolved: false, live: false, woken: 0 };
    try {
      const delivered = await deliverInboxReply({
        askerId,
        text: body,
        summary: `Owner answered your ${item.kind} (${item.id})`,
        planSlug: item.planSlug ?? undefined,
      });
      if (delivered.error || !delivered.delivered) {
        return { resolved: false, live: delivered.live, woken: delivered.woken };
      }
      const triaged = await triageAttentionItem({
        itemId: item.id,
        action: 'resolve',
        note: 'Owner answer delivered from the Resolution Inbox',
      });
      if (triaged?.error) throw new Error(triaged.error);
      return { resolved: true, live: delivered.live, woken: delivered.woken };
    } catch {
      return { resolved: false, live: false, woken: 0 };
    }
  }

  const resolved = await answerAttentionItem(item, answerText);
  if (!resolved.resolved || !askerId || !body) return { ...resolved, live: false, woken: 0 };
  try {
    const res = await deliverInboxReply({
      askerId,
      text: body,
      summary: `Owner answered your ${item.kind} (${item.id})`,
      planSlug: item.planSlug ?? undefined,
    });
    if (res.error) return { ...resolved, live: false, woken: 0 };
    return { ...resolved, live: res.live, woken: res.woken };
  } catch {
    // D-007: reply-routing is best-effort layered on top of the (already
    // successful) resolve — a delivery hiccup must never surface as an
    // "answer failed" toast.
    return { ...resolved, live: false, woken: 0 };
  }
}
