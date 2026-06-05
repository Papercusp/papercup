'use client';

/**
 * LocalCardHost — host component for `askUserLocal` calls.
 *
 * Plan: bespoke-card-improvements-2026-05-13.md §4.4 (M6 boundary)
 *
 * `askUserLocal` (in lib/chat-cards/ask-user-local.ts) is the
 * client-side companion to server-side `ctx.askUser`. It uses a
 * subscriber registry — call sites push a CardSpec into the registry,
 * the FIRST mounted host renders the card, the user's response
 * resolves the call's promise.
 *
 * Mount LocalCardHost anywhere a card-rendering slot makes sense
 * (the operator chat sidebar mounts it once; OracleDock mounts a
 * separate instance for its own tabs). Without a mounted host, every
 * askUserLocal call immediately resolves `{action:'cancel'}`.
 *
 * Renderer reuse: same AskChoiceCard / InputCard dispatch as
 * PendingCardsBar (the server-side state-channel consumer), so cards
 * look identical regardless of which path emitted them.
 */

import { useEffect, useState, type ReactNode } from 'react';

import {
  AskChoiceCard,
  type AskChoiceArgs,
  type AskChoiceResponse,
} from './AskChoiceCard';
import { InputCard, type InputCardResponse } from './InputCard';
import {
  subscribeAskUserLocal,
  type OpenLocalCard,
} from '@/lib/chat-cards/ask-user-local';
import type { CardPresentation } from '@papercusp/agent-mcp';
import type { ReportBlock } from '@papercusp/chat-protocol';

interface SchemaWithPresentation {
  presentation?: CardPresentation;
  prompt?: string;
  fallbackText?: string;
  allowDecline?: boolean;
  report?: ReportBlock;
}

export function LocalCardHost(): ReactNode {
  const [queue, setQueue] = useState<OpenLocalCard[]>([]);

  useEffect(() => {
    return subscribeAskUserLocal((card) => {
      setQueue((prev) => [...prev, card]);
    });
  }, []);

  if (queue.length === 0) return null;
  const head = queue[0];
  const remaining = queue.length - 1;

  // The spec is CardSpec<T>; we read presentation/prompt/fallbackText/
  // allowDecline off it the same way PendingCardsBar reads them off
  // OpenCardWithRun. Fields are optional — fall back to fallbackText
  // when no presentation is set.
  const spec = head.spec as SchemaWithPresentation;
  const prompt = spec.prompt ?? '';
  const presentation = spec.presentation;
  const fallbackText = spec.fallbackText;
  const allowDecline = spec.allowDecline ?? true;

  const resolveHead = (response: ReturnType<typeof inputToCardResponse>): void => {
    head.resolve(response);
    setQueue((prev) => prev.slice(1));
  };

  let body: ReactNode;
  if (presentation && (presentation.kind === 'radio' || presentation.kind === 'checkbox')) {
    const args: AskChoiceArgs = {
      question: prompt,
      options: presentation.options.map((o) => ({
        id: o.id,
        label: o.label,
        hint: o.hint,
        style: o.style,
      })),
      multi: presentation.kind === 'checkbox',
      report: spec.report,
    };
    const onChoice = (r: AskChoiceResponse): void => {
      if (r.action === 'submit') {
        // Match the same payload shape used by PendingCardsBar for
        // server-side cards. Local consumers parse this directly.
        resolveHead({
          action: 'submit',
          payload: { picks: r.picks.map((p) => p.option_id) },
        });
      } else if (r.action === 'decline') {
        resolveHead({ action: 'decline', reason: r.reason });
      } else {
        resolveHead({ action: 'cancel' });
      }
    };
    body = (
      <AskChoiceCard args={args} onResponse={onChoice} allowDecline={allowDecline} />
    );
  } else if (
    presentation &&
    (presentation.kind === 'text' || presentation.kind === 'date' || presentation.kind === 'slider')
  ) {
    const onInput = (r: InputCardResponse): void => {
      if (r.action === 'submit') {
        resolveHead({ action: 'submit', payload: { value: r.value } });
      } else {
        resolveHead({ action: 'decline', reason: r.reason });
      }
    };
    body = (
      <InputCard
        prompt={prompt}
        presentation={presentation}
        fallbackText={fallbackText}
        allowDecline={allowDecline}
        onResponse={onInput}
      />
    );
  } else {
    body = (
      <div className="local-card-host-fallback" role="status">
        <p>{prompt || fallbackText || 'No renderer available'}</p>
        <button
          type="button"
          onClick={() => resolveHead({ action: 'cancel' })}
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="local-card-host" data-remaining={remaining}>
      {body}
      {remaining > 0 && (
        <p className="local-card-host-queue" aria-live="polite">
          {remaining} more {remaining === 1 ? 'card' : 'cards'} after this
        </p>
      )}
    </div>
  );
}

// Helper so the response type is enforceable without exporting
// CardResponse from a client module (avoids a Zod runtime import here).
function inputToCardResponse<P>(r:
  | { action: 'submit'; payload: P }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' },
):
  | { action: 'submit'; payload: P }
  | { action: 'decline'; reason?: string }
  | { action: 'cancel' } {
  return r;
}
