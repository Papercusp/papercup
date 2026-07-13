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
import { Lightbulb, Wrench } from 'lucide-react';
import { ChatConversation, type ChatMessage, type ChatToolCall } from './chat/ChatConversation';
import { PendingCardsBar } from './chat/PendingCardsBar';
import { renderCard } from '@/lib/chat-cards';
import { OperatorLogoMark } from './OperatorLogoMark';
import { Tooltip } from '../harness/Tooltip';

interface Props {
  /** Conversation messages, oldest first. */
  messages: ChatMessage[];
  /** True while the operator is composing/streaming. */
  busy: boolean;
  /** True while in passive mode — input still accepts text; no auto-replies. */
  passive: boolean;
  /** Called with the user's message when they submit. */
  onSend: (content: string) => void;
  /**
   * Optional callback for the "Generate ideas" button next to Send.
   * Fires user_says_ready under the hood; works in both active and
   * passive mode. Omit to hide the button.
   * Plan: active-mode-proactive-ticks-2026-05-14.md §C.9.
   */
  onGenerateIdeas?: () => void;
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
  messages, busy, passive, onSend, onGenerateIdeas, banner, error,
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

  // NOTE: no structured-report rendering here — the operator's `<report>`
  // payload routes to the tiered Inbox (rendered there via ReportBlockCard);
  // the chat stream (and the docked pane that reuses this path) shows
  // conversation only. report-cards-inbox-reconciliation-2026-06-05 D-002.

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
        title: 'Papercup',
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
      inputPlaceholder={passive ? 'Type to wake Papercup…' : 'Reply to Papercup…'}
      inputValue={input}
      onInputChange={setInput}
      onSubmit={submit}
      composerExtra={
        onGenerateIdeas ? (
          <Tooltip label="Generate ideas" side="top" align="center">
            <button
              type="button"
              aria-label="Generate ideas"
              onClick={onGenerateIdeas}
              disabled={busy}
              className="pc-button oracle-send-button op-chat-ideas-button"
            >
              <Lightbulb aria-hidden="true" className="oracle-send-icon" />
            </button>
          </Tooltip>
        ) : undefined
      }
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
 * Compact chip for an MCP/tool call the operator made during the preceding
 * turn. Keep the raw technical tool id in the title, but show a cleaned label
 * in the transcript so the left rail stays scannable.
 */
function renderOperatorToolChip(t: ChatToolCall, i: number): ReactNode {
  const input = (t.input ?? {}) as Record<string, unknown>;
  const detail =
    typeof input.role === 'string' ? input.role :
    typeof input.spawnId === 'string' ? input.spawnId :
    typeof input.featureId === 'string' ? input.featureId :
    typeof input.scope === 'string' ? input.scope :
    null;
  const label = `${formatOperatorToolName(t.name)}${detail ? ` (${detail})` : ''}`;
  const tooltip = (
    <span className="op-chat-tool-tooltip">
      <strong>{t.name}{detail ? ` (${detail})` : ''}</strong>
      <span>{JSON.stringify(input).slice(0, 240)}</span>
    </span>
  );

  return (
    <Tooltip key={i} label={tooltip} side="right" align="start">
      <span
        className="oracle-tool-chip"
        tabIndex={0}
        aria-label={`Tool call: ${label}. Raw id: ${t.name}`}
      >
        <Wrench size={12} />
        <span>{label}</span>
      </span>
    </Tooltip>
  );
}

function formatOperatorToolName(name: string): string {
  const compact = name
    .replace(/^mcp__agentmcp_/, '')
    .replace(/^mcp__/, '')
    .replace(/^agentmcp_/, '')
    .replace(/^search_tool_/, 'search_')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return compact.length > 0 ? compact : name;
}
