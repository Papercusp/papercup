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
import { Bot, Wrench } from 'lucide-react';
import { ChatConversation, type ChatMessage, type ChatToolCall } from './chat/ChatConversation';

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
}

export function OperatorChat({
  messages, busy, passive, onSend, banner, error,
  onLoadEarlier, hasMoreEarlier, loadingEarlier,
}: Props) {
  const [input, setInput] = useState('');

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    onSend(text);
  }, [input, onSend]);

  return (
    <ChatConversation
      messages={messages}
      busy={busy}
      error={error}
      banner={banner}
      emptyState={{
        title: 'Operator',
        body: passive
          ? 'In passive mode. Type below to wake them.'
          : 'Say what you’re thinking.',
        icon: Bot,
      }}
      inputPlaceholder={passive ? 'Type to wake the Operator…' : 'Reply to the Operator…'}
      inputValue={input}
      onInputChange={setInput}
      onSubmit={submit}
      renderToolChip={renderOperatorToolChip}
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
