'use client';

/**
 * Shared chat-surface component used by both OracleDock (the dock
 * bubble) and OperatorChat (the always-on left sidebar).
 *
 * Pure presentational + form-handling — owns:
 *   - the transcript scroll container
 *   - per-message rendering (role-tinted bubbles, avatars, tool chips)
 *   - the empty state, thinking indicator, error row
 *   - the input form (controlled value, submit-on-enter, send button)
 *
 * Does NOT own:
 *   - the message store (parent passes `messages` array)
 *   - the send loop / SSE stream / model call (parent passes `onSubmit`)
 *   - tab management, target switching (oracle-only — stays in OracleDock)
 *
 * Both surfaces feed the same SSE event format from their route
 * (event: delta / event: tool_call / event: error). Surface-specific
 * events (oracle's ui_command, tutorial_end; operator's set_mode/sleep
 * tags inside the say-stream) are parsed in the parent's send loop.
 *
 * Styling pulls from the existing `.oracle-*` classes in globals.css
 * so the two surfaces look identical out of the box. Containers can
 * override via the className prop (e.g. OperatorChat's sidebar host
 * gives the body more vertical room).
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface ChatToolCall {
  /** Display name of the tool the model called. */
  name: string;
  /** Tool input — rendered as a short chip via `renderToolChip` if provided. */
  input?: unknown;
}

export interface ChatMessage {
  /** Role for styling (.oracle-msg-user / .oracle-msg-assistant / .oracle-msg-system). */
  role: 'user' | 'assistant' | 'system';
  /** Visible message text. May be empty while the assistant turn is still streaming. */
  content: string;
  /** Optional tool calls to render above the content. Oracle uses; operator doesn't. */
  tools?: ChatToolCall[];
}

export interface ChatConversationProps {
  messages: ChatMessage[];
  /** True while the model is composing/streaming. Disables input + shows thinking row. */
  busy: boolean;
  /** Short error string, or null. Renders as the `.oracle-error` row. */
  error?: string | null;

  /** Empty-state copy + icon shown when `messages.length === 0`. */
  emptyState: {
    title: string;
    body: string;
    icon: LucideIcon;
  };

  /** Per-message avatar icon picker. Defaults: user → Users, assistant/system → emptyState.icon. */
  iconForRole?: (role: ChatMessage['role']) => LucideIcon;
  /** Per-message label (default: 'You' for user, emptyState.title for the rest). */
  labelForRole?: (role: ChatMessage['role']) => string;

  /** Optional tool-chip renderer. When omitted, `m.tools` is ignored. */
  renderToolChip?: (tool: ChatToolCall, index: number) => ReactNode;

  /** Input form (controlled). */
  inputValue: string;
  onInputChange: (v: string) => void;
  onSubmit: () => void;
  /** Defaults to `'Send a message…'`. */
  inputPlaceholder?: string;
  /** Defaults to emptyState.icon. */
  inputIcon?: LucideIcon;
  /** Defaults to 'Send'. Visible label inside the send button. */
  sendLabel?: string;
  /** Label shown inside the send button while busy. Defaults to '…'. */
  busyLabel?: string;

  /** Optional banner node above the transcript (e.g. silence-check status). */
  banner?: ReactNode;

  /** Label for the "is thinking" row. Defaults to emptyState.title. */
  thinkingLabel?: string;

  /** Hide the input form entirely (e.g. OracleDock's chatwoot tab swaps it out). */
  hideInput?: boolean;

  /** Extra className appended to the `.oracle-body` div (e.g. animation classes). */
  bodyClassName?: string;
  /** Inline style for the `.oracle-body` div (e.g. display: none on tab swap). */
  bodyStyle?: React.CSSProperties;
}

export function ChatConversation(props: ChatConversationProps) {
  const {
    messages,
    busy,
    error,
    emptyState,
    iconForRole,
    labelForRole,
    renderToolChip,
    inputValue,
    onInputChange,
    onSubmit,
    inputPlaceholder = 'Send a message…',
    inputIcon,
    sendLabel = 'Send',
    busyLabel = '…',
    banner,
    thinkingLabel,
    hideInput,
    bodyClassName,
    bodyStyle,
  } = props;

  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy]);

  const InputIconComp = inputIcon ?? emptyState.icon;
  const EmptyIconComp = emptyState.icon;
  const thinkingLabelText = thinkingLabel ?? emptyState.title;

  const submit = () => {
    const text = inputValue.trim();
    if (!text || busy) return;
    onSubmit();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const renderedMessages = useMemo(
    () =>
      messages.map((m, i) => {
        const Icon = iconForRole ? iconForRole(m.role) : emptyState.icon;
        const label =
          labelForRole?.(m.role) ?? (m.role === 'user' ? 'You' : emptyState.title);
        return (
          <div
            key={i}
            data-message-index={i}
            className={`oracle-msg oracle-msg-${m.role}`}
          >
            <span className="oracle-msg-avatar" aria-hidden="true">
              <Icon className="oracle-msg-icon" />
            </span>
            <div className="oracle-msg-stack">
              <div className="oracle-msg-role">{label}</div>
              {renderToolChip && m.tools?.map((t, ti) => renderToolChip(t, ti))}
              {m.content && <div className="oracle-msg-content">{m.content}</div>}
            </div>
          </div>
        );
      }),
    [messages, iconForRole, labelForRole, renderToolChip, emptyState.icon, emptyState.title],
  );

  return (
    <>
      {banner}

      <div
        className={bodyClassName ? `oracle-body ${bodyClassName}` : 'oracle-body'}
        style={bodyStyle}
      >
        {messages.length === 0 ? (
          <div className="oracle-empty-state">
            <span className="oracle-empty-state-icon">
              <EmptyIconComp aria-hidden="true" className="oracle-empty-state-glyph" />
            </span>
            <strong className="oracle-empty-state-title">{emptyState.title}</strong>
            <span className="oracle-empty-state-text">{emptyState.body}</span>
          </div>
        ) : (
          renderedMessages
        )}
        {busy && (
          <div className="oracle-thinking-row" aria-live="polite">
            <span>{thinkingLabelText} is thinking</span>
            <span className="oracle-thinking-dots">
              <span /><span /><span />
            </span>
          </div>
        )}
        {error && <div className="oracle-error">⚠ {error}</div>}
        <div ref={endRef} />
      </div>

      {!hideInput && (
        <form
          className="oracle-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="oracle-input-shell">
            <InputIconComp aria-hidden="true" className="oracle-input-icon" />
            <input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => onInputChange(e.target.value)}
              placeholder={busy ? 'thinking…' : inputPlaceholder}
              disabled={busy}
              aria-label={inputPlaceholder}
            />
          </div>
          <button
            type="submit"
            disabled={busy || !inputValue.trim()}
            className="pc-button oracle-send-button"
          >
            <span>{busy ? busyLabel : sendLabel}</span>
          </button>
        </form>
      )}
    </>
  );
}
