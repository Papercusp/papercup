'use client';

/**
 * PendingCardsBar — renders cards from the state-channel SSE stream.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md
 *
 * Renders one card at a time (L3 from the review: queue indicator
 * surfaces the count, no multi-card cliff). On user response, POSTs
 * to /card-response — the deferred resolves server-side; the next
 * snapshot drops the resolved card from openCards and the bar shows
 * the next one (or hides entirely).
 *
 * Sibling to the in-transcript tool_call card flow today. As tools
 * migrate to ctx.askUser (commit 8 + follow-ups), new cards appear
 * here. Historical chat:ask_choice cards (rendered from tool_call
 * args in the chat transcript) continue to work via the existing
 * renderToolCard path on OperatorChat.
 */

import { useState, type ReactNode } from 'react';

import {
  AskChoiceCard,
  type AskChoiceArgs,
  type AskChoiceResponse,
} from './AskChoiceCard';
import { useStateSnapshots, type OpenCardWithRun } from '@/lib/use-state-snapshots';
import { postCardResponse } from '@/lib/post-card-response';

interface Props {
  /** Active conversation id — passed into /card-response URL for audit. */
  conversationId: string;
  /** Active workspace id — POST body needs it for defense-in-depth. */
  workspaceId: string;
}

/**
 * Translate an OpenCardSnapshot's presentation into AskChoiceArgs.
 * Returns null for presentations the bar doesn't yet render (text,
 * date, slider — PR 3 expands AskChoiceCard).
 */
function toAskChoiceArgs(card: OpenCardWithRun): AskChoiceArgs | null {
  const p = card.presentation;
  if (!p) return null;
  if (p.kind !== 'radio' && p.kind !== 'checkbox') return null;
  return {
    question: card.prompt,
    options: p.options.map((o) => ({
      id: o.id,
      label: o.label,
      hint: o.hint,
      style: o.style,
    })),
    multi: p.kind === 'checkbox',
  };
}

export function PendingCardsBar({ conversationId, workspaceId }: Props): ReactNode {
  const { cards, connected } = useStateSnapshots();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Optimistic-dismiss: once /card-response returns ok:true, the
   * server has resolved the deferred and dropped the card from PENDING.
   * Normally the state-snapshot SSE pushes the updated openCards array
   * and this set is irrelevant. But if the SSE is disconnected mid-flow,
   * the snapshot update never arrives — the card would stay rendered
   * forever. Tracking dismissed correlationIds locally bridges that gap.
   */
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const visibleCards = cards.filter((c) => !dismissed.has(c.correlationId));
  if (visibleCards.length === 0) return null;
  const head = visibleCards[0];
  const remaining = visibleCards.length - 1;
  const args = toAskChoiceArgs(head);

  if (!args) {
    // Unknown presentation kind. Show a generic fallback so the user
    // isn't blocked; PR 3 adds renderers for text/date/slider.
    return (
      <div className="pending-cards-bar pending-cards-bar--fallback" role="status">
        <p>{head.prompt}</p>
        <p className="pending-cards-bar-hint">
          {head.fallbackText ?? 'No renderer for this card type yet.'}
        </p>
      </div>
    );
  }

  const respond = async (response: AskChoiceResponse): Promise<void> => {
    setBusy(true);
    setError(null);
    const correlationId = head.correlationId;
    try {
      const body =
        response.action === 'submit'
          ? {
              correlationId,
              workspaceId,
              action: 'submit' as const,
              payload: {
                picks: response.picks.map((p) => p.option_id),
              },
            }
          : response.action === 'decline'
          ? {
              correlationId,
              workspaceId,
              action: 'decline' as const,
              reason: response.reason,
            }
          : {
              correlationId,
              workspaceId,
              action: 'cancel' as const,
            };
      const r = await postCardResponse(conversationId, body);
      if (!r.ok) {
        setError(r.error ?? `card-response failed (${r.status})`);
      } else {
        // Optimistic-dismiss covers the SSE-disconnected case where the
        // server resolved the card but the snapshot update can't reach us.
        setDismissed((prev) => {
          const next = new Set(prev);
          next.add(correlationId);
          return next;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pending-cards-bar" data-busy={busy ? 'true' : 'false'}>
      <AskChoiceCard
        args={args}
        onResponse={respond}
        allowDecline={head.allowDecline ?? true}
      />
      {remaining > 0 && (
        <p className="pending-cards-bar-queue" aria-live="polite">
          {remaining} more {remaining === 1 ? 'card' : 'cards'} after this
        </p>
      )}
      {!connected && (
        <p className="pending-cards-bar-disconnected" role="status">
          Live updates disconnected — submitted answers still apply.
        </p>
      )}
      {error && (
        <p className="pending-cards-bar-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
