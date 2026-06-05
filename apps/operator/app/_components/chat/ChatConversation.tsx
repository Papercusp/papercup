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

import { useEffect, useMemo, useRef, type ComponentType, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface ChatToolCall {
  /** Display name of the tool the model called. */
  name: string;
  /** Tool input — rendered as a short chip via `renderToolChip` if provided. */
  input?: unknown;
  /**
   * For interactive tools (e.g. chat:ask_choice), the user's response.
   * When set, `renderToolCard` should render the answered state.
   * Persisted into operator_turns.tools jsonb (migration 015).
   *
   * Always an array of picks (length 1 for single-select cards,
   * length ≥1 for multi-select). Pre-alpha unified shape — no
   * legacy {option_id, label} variant.
   */
  answered?: {
    picks: Array<{ option_id: string; label: string }>;
    at: number;
  };
}

export interface ChatMessage {
  /** Role for styling (.oracle-msg-user / .oracle-msg-assistant / .oracle-msg-system). */
  role: 'user' | 'assistant' | 'system';
  /** Visible message text. May be empty while the assistant turn is still streaming. */
  content: string;
  /** Optional tool calls to render above the content. Oracle uses; operator does too as of 2026-05-11 (chat:ask_choice). */
  tools?: ChatToolCall[];
  // NOTE: there is deliberately NO structured-report field here. The chat
  // stream is conversation only — the operator's `<report>` payload routes
  // to the tiered Inbox as an attention item and renders there via
  // ReportBlockCard (report-cards-inbox-reconciliation-2026-06-05 D-002).
  /**
   * Stable id for optimistic-write dedup. Set client-side to a uuid
   * when an optimistic local turn is dispatched; once the POST returns,
   * the row's PG id replaces it. The live-tail Zero reconciler skips
   * any incoming row whose id matches an already-loaded message —
   * defeats the race where a Zero push arrives before the POST response
   * (would otherwise double-render the user's own message). G19 of
   * the active-mode audit.
   */
  id?: string;
  /**
   * Operator-side: the per-conversation sequence number from
   * operator_turns.seq. Needed by chat:ask_choice when the user picks
   * an option — the turn-answer endpoint addresses turns by seq. Not
   * set for optimistic local messages before they're persisted.
   */
  seq?: number;
}

export type ChatIconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean;
}>;

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
    icon: ChatIconComponent;
    extra?: ReactNode;
  };

  /** Per-message avatar icon picker. Defaults: user → Users, assistant/system → emptyState.icon. */
  iconForRole?: (role: ChatMessage['role']) => ChatIconComponent;
  /** Per-message label (default: 'You' for user, emptyState.title for the rest). */
  labelForRole?: (role: ChatMessage['role']) => string;

  /** Optional tool-chip renderer (above content). When omitted, m.tools is ignored. */
  renderToolChip?: (tool: ChatToolCall, index: number) => ReactNode;
  /**
   * Optional tool-card renderer (below content). Used for interactive
   * tools like chat:ask_choice that own significant UI. When provided,
   * each m.tools entry is offered to renderToolCard FIRST; if it
   * returns null/undefined, falls back to renderToolChip (above
   * content). When it returns a ReactNode, that node is rendered
   * below the message content.
   *
   * msg is passed so the renderer can use msg.id when posting back to
   * the server (e.g. the operator-converse turn-answer endpoint).
   */
  renderToolCard?: (
    tool: ChatToolCall,
    msg: ChatMessage,
    toolIndex: number,
  ) => ReactNode | null | undefined;
  /**
   * Optional renderer for a message's structured `<report>` payload,
   * rendered below the content (after any tool cards). When omitted,
   * `m.report` is ignored. structured-report-protocol-2026-06-05.
   */
  renderReport?: (report: ParsedReport, msg: ChatMessage) => ReactNode | null | undefined;

  /** Input form (controlled). */
  inputValue: string;
  onInputChange: (v: string) => void;
  onSubmit: () => void;
  /** Defaults to `'Send a message…'`. */
  inputPlaceholder?: string;
  /** Defaults to emptyState.icon. */
  inputIcon?: ChatIconComponent;
  /** Defaults to 'Send'. Visible label inside the send button. */
  sendLabel?: string;
  /** Label shown inside the send button while busy. Defaults to '…'. */
  busyLabel?: string;

  /** Optional banner node above the transcript (e.g. silence-check status). */
  banner?: ReactNode;

  /** Label for the "is thinking" row. Defaults to emptyState.title. */
  thinkingLabel?: string;

  /**
   * Optional element rendered inside the composer form, before the
   * Send button. Used by OperatorChat to surface a "Generate ideas"
   * button. Omit to hide.
   */
  composerExtra?: React.ReactNode;
  /** Hide the input form entirely (e.g. OracleDock's chatwoot tab swaps it out). */
  hideInput?: boolean;

  /** Extra className appended to the `.oracle-body` div (e.g. animation classes). */
  bodyClassName?: string;
  /** Inline style for the `.oracle-body` div (e.g. display: none on tab swap). */
  bodyStyle?: React.CSSProperties;

  /**
   * Infinite scroll for older history. When provided, the chat renders
   * a sentinel at the top of the list; an IntersectionObserver fires
   * `onLoadEarlier()` whenever the sentinel becomes visible AND
   * `hasMoreEarlier` is true AND `loadingEarlier` is false.
   *
   * Scroll position is preserved across the prepend by capturing
   * `scrollHeight` before and adjusting `scrollTop` after — same
   * pattern every chat surface uses (Slack, Linear, etc.).
   */
  onLoadEarlier?: () => void;
  hasMoreEarlier?: boolean;
  loadingEarlier?: boolean;
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
    renderToolCard,
    renderReport,
    inputValue,
    onInputChange,
    onSubmit,
    inputPlaceholder = 'Send a message…',
    inputIcon,
    sendLabel = 'Send',
    busyLabel = '…',
    composerExtra,
    banner,
    thinkingLabel,
    hideInput,
    bodyClassName,
    bodyStyle,
    onLoadEarlier,
    hasMoreEarlier,
    loadingEarlier,
  } = props;

  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);

  // Track the FIRST message identity to detect prepends (older history)
  // vs appends (new turn). On a prepend we preserve scroll position
  // instead of scrolling to bottom; on an append (or busy flip) we
  // scroll to bottom as before.
  const lastFirstKeyRef = useRef<string | null>(null);
  const lastLastKeyRef = useRef<string | null>(null);
  const preserveScrollHeightRef = useRef<number | null>(null);
  const firstKey = messages.length > 0 ? `${messages[0].role}:${messages[0].content.slice(0, 32)}` : null;
  const lastKey = messages.length > 0
    ? `${messages[messages.length - 1].role}:${messages[messages.length - 1].content.slice(0, 32)}`
    : null;

  // Capture scrollHeight just BEFORE a prepend lands. The hook below
  // detects firstKey changing and pins the prior scrollHeight; the
  // post-render layout effect then restores scrollTop = newH - priorH.
  if (
    typeof window !== 'undefined'
    && lastFirstKeyRef.current !== null
    && firstKey !== null
    && firstKey !== lastFirstKeyRef.current
    && scrollerRef.current
  ) {
    preserveScrollHeightRef.current = scrollerRef.current.scrollHeight;
  }

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) {
      lastFirstKeyRef.current = firstKey;
      lastLastKeyRef.current = lastKey;
      return;
    }
    const isPrepend = preserveScrollHeightRef.current !== null;
    if (isPrepend) {
      const delta = el.scrollHeight - preserveScrollHeightRef.current!;
      el.scrollTop = el.scrollTop + delta;
      preserveScrollHeightRef.current = null;
    } else if (lastLastKeyRef.current !== lastKey || busy) {
      // Append (new turn at bottom) OR busy flip → scroll to bottom.
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    lastFirstKeyRef.current = firstKey;
    lastLastKeyRef.current = lastKey;
  }, [messages.length, busy, firstKey, lastKey]);

  // Auto-load older turns when the top sentinel scrolls into view.
  // Gated on user-initiated scroll: a freshly-mounted chat scrolls to
  // bottom on its first paint, but the IntersectionObserver fires for
  // any element on screen during layout, including the top sentinel
  // before the auto-scroll happens. Without the gate we'd auto-fetch
  // the next page on every mount.
  //
  // Synchronous reentry lock (`fetchInFlightRef`) backstops the prop-
  // based `loadingEarlier` gate — setLoadingEarlier(true) is async, so
  // two observer ticks within one frame can both pass the prop guard
  // and fire onLoadEarlier twice for the same intersection.
  const userScrolledRef = useRef(false);
  const fetchInFlightRef = useRef(false);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => { userScrolledRef.current = true; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => { fetchInFlightRef.current = !!loadingEarlier; }, [loadingEarlier]);
  useEffect(() => {
    if (!onLoadEarlier) return;
    const el = topSentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (!userScrolledRef.current) continue;
        if (!hasMoreEarlier) continue;
        if (fetchInFlightRef.current) continue;
        fetchInFlightRef.current = true;
        onLoadEarlier();
      }
    }, { root: scrollerRef.current ?? null, rootMargin: '120px 0px 0px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [onLoadEarlier, hasMoreEarlier]);

  const InputIconComp = inputIcon ?? emptyState.icon;
  const EmptyIconComp = emptyState.icon;
  const thinkingLabelText = thinkingLabel ?? emptyState.title;

  const submit = () => {
    const text = inputValue.trim();
    if (!text || busy) return;
    onSubmit();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Virtualization. Renders only the messages currently in (or near)
  // the viewport. Bounded DOM cost regardless of how deep the scrollback
  // grows. Variable-height messages are measured via the IntersectionObserver-
  // backed `measureElement` so estimates self-correct on first paint.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 64, // typical bubble height; corrected by measureElement
    overscan: 8,
    // Key by stable message identity when possible. Today ChatMessage is
    // {role, content, tools?} with no id; fall back to (role|content-prefix|index)
    // — index alone breaks cache on prepend (every item shifts), but combining
    // it with role + a content prefix keeps the cache hot for items the
    // user is actually looking at across a prepend.
    getItemKey: (i) => {
      const m = messages[i];
      if (!m) return i;
      return `${m.role}::${m.content.slice(0, 40)}::${i}`;
    },
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return (
    <>
      {banner}

      <div
        ref={scrollerRef}
        className={bodyClassName ? `oracle-body ${bodyClassName}` : 'oracle-body'}
        style={bodyStyle}
        // Keyboard access for the scrollable message region (a11y:
        // scrollable-region-focusable) — keyboard users can scroll it.
        tabIndex={0}
        role="region"
        aria-label="Conversation messages"
      >
        {onLoadEarlier && messages.length > 0 && (
          <>
            <div ref={topSentinelRef} aria-hidden="true" style={{ height: 1 }} />
            {hasMoreEarlier && loadingEarlier && (
              <div className="oracle-load-earlier" aria-live="polite">
                <span>Loading earlier…</span>
              </div>
            )}
            {!hasMoreEarlier && (
              <div className="oracle-load-earlier" aria-hidden="true">
                <span className="oracle-load-earlier-end">Beginning of conversation</span>
              </div>
            )}
          </>
        )}
        {messages.length === 0 ? (
          <div className="oracle-empty-state">
            <span className="oracle-empty-state-icon">
              <EmptyIconComp aria-hidden className="oracle-empty-state-glyph" />
            </span>
            <strong className="oracle-empty-state-title">{emptyState.title}</strong>
            <span className="oracle-empty-state-text">{emptyState.body}</span>
            {emptyState.extra}
          </div>
        ) : (
          <div
            className="oracle-virtual-container"
            style={{
              height: totalSize,
              minHeight: totalSize,
              position: 'relative',
              width: '100%',
              flex: '0 0 auto',
            }}
          >
            {virtualItems.map((vi) => {
              const m = messages[vi.index];
              if (!m) return null;
              const Icon = iconForRole ? iconForRole(m.role) : emptyState.icon;
              const label =
                labelForRole?.(m.role) ?? (m.role === 'user' ? 'You' : emptyState.title);
              const showRoleLabel = label.trim().length > 0;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  data-message-index={vi.index}
                  ref={virtualizer.measureElement}
                  className={`oracle-msg oracle-msg-${m.role}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <span className="oracle-msg-avatar" aria-hidden="true">
                    <Icon className="oracle-msg-icon" />
                  </span>
                  <div className="oracle-msg-stack">
                    {showRoleLabel && <div className="oracle-msg-role">{label}</div>}
                    {/*
                      Each tool is offered to renderToolCard FIRST (below content).
                      If it returns a card, we DON'T also render the same tool as
                      a chip above — cards subsume chip representation. Otherwise
                      we fall through to renderToolChip (above content).
                    */}
                    {(() => {
                      const cardSlots: Array<{ index: number; node: ReactNode }> = [];
                      const chipTools: Array<{ tool: ChatToolCall; index: number }> = [];
                      m.tools?.forEach((t, ti) => {
                        const card = renderToolCard?.(t, m, ti);
                        if (card) cardSlots.push({ index: ti, node: card });
                        else if (renderToolChip) chipTools.push({ tool: t, index: ti });
                      });
                      return (
                        <>
                          {chipTools.map(({ tool, index }) =>
                            renderToolChip ? renderToolChip(tool, index) : null,
                          )}
                          {m.content && <div className="oracle-msg-content">{m.content}</div>}
                          {cardSlots.map(({ index, node }) => (
                            <div key={`tool-card-${index}`}>{node}</div>
                          ))}
                          {m.report && renderReport ? (
                            <div className="oracle-msg-report">{renderReport(m.report, m)}</div>
                          ) : null}
                        </>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
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
            <InputIconComp aria-hidden className="oracle-input-icon" />
            <input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => onInputChange(e.target.value)}
              placeholder={busy ? 'thinking…' : inputPlaceholder}
              disabled={busy}
              aria-label={inputPlaceholder}
            />
            <span className="oracle-input-meta" aria-hidden="true">
              {busy ? 'busy' : 'enter'}
            </span>
          </div>
          {composerExtra}
          <button
            type="submit"
            disabled={busy || !inputValue.trim()}
            className="pc-button oracle-send-button"
          >
            <ArrowUpRight aria-hidden="true" className="oracle-send-icon" />
            <span>{busy ? busyLabel : sendLabel}</span>
          </button>
        </form>
      )}
    </>
  );
}
