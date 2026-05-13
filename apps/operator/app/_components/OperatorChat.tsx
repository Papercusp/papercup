'use client';

/**
 * OperatorChat — single-thread chat with the Operator.
 *
 * Thin wrapper around the shared `<ChatConversation>` component that
 * also powers OracleDock. The two surfaces share frontend (this
 * component + ChatConversation) and backend (same SSE event format
 * — `event: delta` per token, `event: error` on failure) — only the
 * styling, configuration, and route URL differ:
 *
 *   - Operator → /api/agent-mcp/operator-converse  (lands later)
 *   - Oracle   → /api/oracle/chat (or /api/harness/<slug>/agent-chats/...)
 *
 * In this commit OperatorChat is still UI-only (no live wiring); the
 * conversation engine + route both arrive in subsequent commits and
 * plug in via the `messages` / `busy` / `onSubmit` props this
 * component already exposes.
 */

import { useCallback, useState, type ReactNode } from 'react';
import { Wrench } from 'lucide-react';
import { ChatConversation, type ChatMessage, type ChatToolCall } from './chat/ChatConversation';
import { PendingCardsBar } from './chat/PendingCardsBar';
import { renderCard } from '@/lib/chat-cards';
import { OperatorLogoMark } from './OperatorLogoMark';

interface Props {
  /** Conversation messages, oldest first. */
  messages: ChatMessage[];
  /** True while the operator is composing/streaming. */
  busy: boolean;
  /** True while in passive mode — input still accepts text; no auto-replies. */
  passive: boolean;
  /** Called with the user's message when they submit. */
  onSend: (content: string) => void;
  /** Optional banner above the transcript (e.g. silence-check status). */
  banner?: React.ReactNode;
  /** Optional error string to render in the .oracle-error row. */
  error?: string | null;

  /** Infinite-scroll plumbing (forwarded to ChatConversation). */
  onLoadEarlier?: () => void;
  hasMoreEarlier?: boolean;
  loadingEarlier?: boolean;

  /**
   * chat:ask_choice resolution. Called when the user commits a
   * selection (one click for single-select, Submit for multi-select).
   * Parent does the I/O — typically the OperatorConversation context's
   * answerChoice() which POSTs to turn-answer. Required for cards to
   * be interactive; if omitted, cards render disabled.
   */
  onAnswerChoice?: (input: {
    assistantSeq: number;
    toolIndex: number;
    picks: Array<{ option_id: string; label: string }>;
  }) => Promise<void> | void;

  /**
   * Active conversation id. When provided alongside `workspaceId`,
   * the chat renders a PendingCardsBar that subscribes to the
   * state-snapshot SSE stream and shows ctx.askUser cards above the
   * composer. Omit either to disable the new-card surface.
   */
  conversationId?: string;
  workspaceId?: string;
}

const STARTING_PROMPTS = [
  {
    title: 'Scan workspaces',
    hint: 'find active harnesses and urgent issues',
    prompt: 'Scan my workspaces for active harnesses and urgent issues.',
  },
  {
    title: 'Review blockers',
    hint: 'surface failing runs, audits, and pending answers',
    prompt: 'Review current blockers, failing runs, audits, and pending answers.',
  },
  {
    title: 'Summarize state',
    hint: 'get a quick brief on what changed recently',
    prompt: 'Summarize the current workspace state and what changed recently.',
  },
] as const;

export function OperatorChat({
  messages, busy, passive, onSend, banner, error,
  onLoadEarlier, hasMoreEarlier, loadingEarlier, onAnswerChoice,
  conversationId, workspaceId,
}: Props) {
  const [input, setInput] = useState('');

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    onSend(text);
  }, [input, onSend]);

  // Tool-card dispatch via the chat-cards registry (phase-4 T2.1).
  // The registry maps tool names → renderers; we supply only the
  // onAnswer callback because the live-tail dispatch is consumer-
  // specific (Oracle handles it differently).
  const renderToolCard = useCallback(
    (t: ChatToolCall, msg: ChatMessage, ti: number): ReactNode | null => {
      return renderCard(t.name, {
        args: t.input ?? {},
        answered: t.answered,
        onAnswer: (payload) => {
          if (typeof msg.seq !== 'number' || !onAnswerChoice) return;
          const { picks } = payload as { picks: Array<{ option_id: string; label: string }> };
          // Fire-and-forget — server-side atomicity guarantees the
          // assistant-answered + user-turn rows land together. The
          // live-tail picks them up; we don't optimistically dispatch.
          void Promise.resolve(
            onAnswerChoice({
              assistantSeq: msg.seq,
              toolIndex: ti,
              picks,
            }),
          ).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn('[operator-chat] answerChoice failed:', err);
          });
        },
      });
    },
    [onAnswerChoice],
  );

  return (
    <ChatConversation
      messages={messages}
      busy={busy}
      error={error}
      banner={
        <>
          {banner}
          {conversationId && workspaceId && (
            <PendingCardsBar conversationId={conversationId} workspaceId={workspaceId} />
          )}
        </>
      }
      emptyState={{
        title: 'Operator',
        body: passive
          ? 'In passive mode. Type below to wake them.'
          : 'Tell me what you want to inspect, scan, or unblock.',
        icon: OperatorLogoMark,
        extra: (
          <div className="op-chat-empty-panel" aria-label="Quick draft prompts">
            <div className="op-chat-empty-panel-head">
              <OperatorLogoMark variant="compact" className="op-chat-empty-panel-logo" />
              <div className="op-chat-empty-panel-label">Quick draft prompts</div>
            </div>
            <div className="op-chat-empty-panel-list">
              {STARTING_PROMPTS.map(({ title, hint, prompt }) => (
                <button
                  key={title}
                  type="button"
                  className="op-chat-empty-row"
                  onClick={() => setInput(prompt)}
                  disabled={busy}
                  aria-label={`${title}: ${hint}. Draft this prompt.`}
                >
                  <span className="op-chat-empty-row-title">{title}</span>
                  <span className="op-chat-empty-row-hint">{hint}</span>
                </button>
              ))}
            </div>
          </div>
        ),
      }}
      labelForRole={() => ''}
      inputPlaceholder={passive ? 'Type to wake the Operator…' : 'Reply to the Operator…'}
      inputValue={input}
      onInputChange={setInput}
      onSubmit={submit}
      renderToolChip={renderOperatorToolChip}
      renderToolCard={renderToolCard}
      onLoadEarlier={onLoadEarlier}
      hasMoreEarlier={hasMoreEarlier}
      loadingEarlier={loadingEarlier}
    />
  );
}

// Keep the shared message type exported here so OperatorChatSidebar
// + the (forthcoming) OperatorConversation provider don't need to
// reach across the chat/ folder. Re-export, not redeclare.
export type { ChatMessage as OperatorChatMessage } from './chat/ChatConversation';

/**
 * Compact chip for an MCP tool call the operator made during the
 * preceding turn. Format: "→ orchestrator.spawn (worker)" — name first,
 * then the most-load-bearing arg (role / featureId / spawnId) when
 * present. Renders above the assistant text bubble.
 */
function renderOperatorToolChip(t: ChatToolCall, i: number): ReactNode {
  const input = (t.input ?? {}) as Record<string, unknown>;
  const detail =
    typeof input.role === 'string' ? input.role :
    typeof input.spawnId === 'string' ? input.spawnId :
    typeof input.featureId === 'string' ? input.featureId :
    typeof input.scope === 'string' ? input.scope :
    null;
  return (
    <div key={i} className="oracle-tool-chip" title={JSON.stringify(input).slice(0, 240)}>
      <Wrench size={12} />
      <span>→ {t.name}{detail ? ` (${detail})` : ''}</span>
    </div>
  );
}
