'use client';

/**
 * OperatorChatSidebar — fixed left, full-height, not collapsible.
 *
 * Hosts the OperatorChat. Width is drag-resizable from the right
 * edge; min 360px, no upper bound. Width persists in localStorage
 * so it survives reloads (mode persistence is sessionStorage; that
 * one is intentionally per-session).
 *
 * Sets `--op-chat-w` on :root so the rest of the app can use it
 * for left-padding on the body. Pages with centered content
 * absorb the loss into existing margin; edge-to-edge pages may
 * need per-page padding tweaks (caught visually post-mount).
 *
 * In this commit the chat content is a placeholder driver — turns
 * are local state only and onSend just echoes locally. The real
 * conversation engine wires in via the OperatorConversation provider
 * commit; this file's contract with it is `useOperatorConversation()`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Radio } from 'lucide-react';
import { OperatorChat } from './OperatorChat';
import { useOperatorConversation } from './OperatorConversationProvider';

const STORAGE_KEY = 'papercusp.operatorChat.width';
const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 360;

/** Read the stored width from localStorage, clamped to [MIN, vw/2]. */
function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < MIN_WIDTH) return MIN_WIDTH;
    // Hard ceiling at 75% viewport so a misclick can't lock the user out.
    const ceiling = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.75));
    return Math.min(n, ceiling);
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function OperatorChatSidebar() {
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate width from localStorage post-mount to keep SSR markup stable.
  useEffect(() => {
    setWidth(readStoredWidth());
    setHydrated(true);
  }, []);

  // Mirror to a CSS var on :root + body padding so app content shifts.
  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.style.setProperty('--op-chat-w', `${width}px`);
    document.body.classList.add('has-op-chat');
    try {
      window.localStorage.setItem(STORAGE_KEY, String(width));
    } catch { /* sandbox / quota */ }
    return () => { /* leave the class in place across re-renders */ };
  }, [width, hydrated]);

  // Strip the body class on unmount (chromeless routes don't render
  // this component — the cleanup is for completeness/HMR safety).
  useEffect(() => {
    return () => {
      try {
        document.body.classList.remove('has-op-chat');
        document.documentElement.style.removeProperty('--op-chat-w');
      } catch { /* DOM may be torn down already */ }
    };
  }, []);

  // Drag-to-resize handle. Pointer events are captured on the handle,
  // moves are tracked at window level so the cursor stays grabby even
  // if it drifts off the handle during a fast drag.
  const draggingRef = useRef(false);
  const onHandleDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);
  const onHandleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    // Width = pointer X (sidebar is fixed at left:0). Clamp to MIN
    // and a generous ceiling so a runaway drag doesn't hide content.
    const ceiling = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.75));
    const next = Math.max(MIN_WIDTH, Math.min(ceiling, e.clientX));
    setWidth(next);
  }, []);
  const onHandleUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, []);

  // Conversation state from the OperatorConversationProvider mounted
  // in the root layout. The provider owns the state machine + silence
  // timers + tag dispatch; this component is a presentational thin
  // wrapper around <OperatorChat> with the provider's value.
  const conv = useOperatorConversation();

  // Pre-hydration: render the sidebar at default width so the layout
  // doesn't jump after JS evaluates. The body padding-left is set by
  // the inline bootstrap script in layout.tsx.
  const renderedWidth = hydrated ? width : DEFAULT_WIDTH;

  const sidebarStyle = useMemo<React.CSSProperties>(() => ({
    width: renderedWidth,
  }), [renderedWidth]);

  let statusText: string;
  if (conv.busy) {
    statusText = 'thinking';
  } else if (conv.mode === 'passive') {
    statusText = 'quiet until asked';
  } else {
    statusText = 'ready';
  }

  return (
    <aside className="op-chat-sidebar" style={sidebarStyle} aria-label="Operator chat">
      <style>{OP_CHAT_SIDEBAR_CSS}</style>
      <div className="op-chat-header">
        <div className="op-chat-header-orb" aria-hidden="true">
          <Bot className="op-chat-header-icon" />
        </div>
        <div className="op-chat-header-copy">
          <div className="op-chat-header-title-row">
            <strong>Operator</strong>
            <span className={`op-chat-mode op-chat-mode-${conv.mode}`}>
              <span className="op-chat-mode-dot" aria-hidden="true" />
              {conv.mode}
            </span>
          </div>
          <span className="op-chat-header-subtitle">
            Workspace assistant · {statusText}
          </span>
        </div>
        <Radio className="op-chat-header-signal" aria-hidden="true" />
      </div>
      <OperatorChat
        messages={conv.messages}
        busy={conv.busy}
        passive={conv.mode === 'passive'}
        onSend={conv.sendUserMessage}
        banner={conv.bannerText ? <div className="op-chat-banner">{conv.bannerText}</div> : null}
        error={conv.error}
        onLoadEarlier={conv.loadEarlier}
        hasMoreEarlier={conv.hasMoreEarlier}
        loadingEarlier={conv.loadingEarlier}
        onAnswerChoice={conv.answerChoice}
      />
      <div
        className="op-chat-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize operator chat"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
      />
    </aside>
  );
}

const OP_CHAT_SIDEBAR_CSS = `
.op-chat-sidebar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 60;
  border-right: 1px solid rgba(125, 211, 252, 0.18);
  background:
    radial-gradient(circle at 50% -12%, rgba(56, 189, 248, 0.16), transparent 34%),
    linear-gradient(180deg, #07101d 0%, #050b14 100%);
  color: var(--fg, #e7eef7);
  display: flex;
  flex-direction: column;
  box-shadow: inset -1px 0 0 rgba(255,255,255,0.03), 18px 0 44px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  /* Width set inline via style. */
}

.op-chat-header {
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 74px;
  padding: 14px 14px 13px;
  border-bottom: 1px solid rgba(125, 211, 252, 0.14);
  background:
    linear-gradient(180deg, rgba(11, 25, 42, 0.84), rgba(7, 16, 29, 0.94)),
    #07101d;
}

.op-chat-header-orb {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  border: 1px solid rgba(125, 211, 252, 0.20);
  background: radial-gradient(circle at 35% 25%, rgba(255,255,255,0.18), transparent 24%), rgba(56, 189, 248, 0.10);
  color: #7dd3fc;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 28px rgba(2, 8, 23, 0.28);
}

.op-chat-header-icon {
  width: 18px;
  height: 18px;
}

.op-chat-header-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.op-chat-header-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.op-chat-header-title-row strong {
  color: #f3f8ff;
  font-size: 14px;
  line-height: 1.1;
  letter-spacing: 0.01em;
}

.op-chat-header-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(148, 163, 184, 0.92);
  font-size: 11px;
  line-height: 1.3;
}

.op-chat-mode {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border: 1px solid rgba(125, 211, 252, 0.18);
  border-radius: 999px;
  background: rgba(125, 211, 252, 0.07);
  color: #bae6fd;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.op-chat-mode-passive {
  border-color: rgba(251, 191, 36, 0.24);
  background: rgba(251, 191, 36, 0.08);
  color: #fde68a;
}

.op-chat-mode-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #34d399;
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.75);
}

.op-chat-mode-passive .op-chat-mode-dot {
  background: #fbbf24;
  box-shadow: 0 0 8px rgba(251, 191, 36, 0.65);
}

.op-chat-header-signal {
  width: 16px;
  height: 16px;
  color: rgba(125, 211, 252, 0.52);
}

.op-chat-sidebar .op-chat-banner {
  margin: 10px 12px 0;
  padding: 9px 10px;
  border: 1px solid rgba(125, 211, 252, 0.18);
  border-radius: 12px;
  background: rgba(125, 211, 252, 0.07);
  color: #cfeeff;
  font-size: 12px;
  line-height: 1.4;
}

.op-chat-sidebar .oracle-body {
  background:
    linear-gradient(180deg, rgba(6, 13, 24, 0.96), rgba(4, 9, 17, 0.98)) !important;
  padding: 14px 13px;
  gap: 12px;
  scrollbar-color: rgba(125, 211, 252, 0.22) transparent;
}

.op-chat-sidebar .oracle-virtual-container {
  flex: 0 0 auto;
}

.op-chat-sidebar .oracle-msg {
  width: 100% !important;
  max-width: 100% !important;
  padding: 0 2px;
  box-sizing: border-box;
}

.op-chat-sidebar .oracle-msg-avatar {
  width: 26px;
  height: 26px;
  flex-basis: 26px;
}

.op-chat-sidebar .oracle-msg-stack {
  max-width: calc(100% - 36px);
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-stack {
  margin-left: auto;
}

.op-chat-sidebar .oracle-msg-content {
  border-color: rgba(125, 211, 252, 0.13);
  background: rgba(7, 16, 29, 0.92) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.035), 0 10px 22px rgba(0,0,0,0.16);
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  border-color: rgba(56, 189, 248, 0.28);
  background: linear-gradient(180deg, rgba(17, 44, 69, 0.98), rgba(9, 31, 52, 0.98)) !important;
}

.op-chat-sidebar .oracle-msg-content:empty,
.op-chat-sidebar .oracle-msg-content:has(> :only-child:empty) {
  display: none;
}

.op-chat-sidebar .oracle-tool-chip {
  max-width: 100%;
  overflow: hidden;
}

.op-chat-sidebar .oracle-form {
  border-top-color: rgba(125, 211, 252, 0.14);
  background: linear-gradient(180deg, rgba(7, 16, 29, 0.92), rgba(5, 11, 20, 0.98)) !important;
  padding: 12px;
}

.op-chat-sidebar .oracle-form input {
  background: rgba(255,255,255,0.04);
  border-color: rgba(125, 211, 252, 0.18);
}

.op-chat-sidebar .oracle-form input:focus {
  border-color: rgba(125, 211, 252, 0.48);
}

.op-chat-sidebar .oracle-send-button {
  border-color: rgba(125, 211, 252, 0.22);
  background: rgba(125, 211, 252, 0.10);
}

.op-chat-resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  background: transparent;
  z-index: 1;
  touch-action: none;
}
.op-chat-resize-handle:hover {
  background: rgba(125, 211, 252, 0.18);
}

/* Body shift: every page absorbs the sidebar's width as left padding.
   Pages with margin: auto centered content stay centered within the
   remaining space (the centering algorithm absorbs the loss into
   what used to be margin). Edge-to-edge pages may need their own
   per-page padding tweaks. */
body.has-op-chat {
  padding-left: var(--op-chat-w, 360px);
}

/* Header (.pc-header) is fixed at the top; same shift applies so it
   doesn't render under the sidebar. */
body.has-op-chat .pc-header,
body.has-op-chat .h-header {
  left: var(--op-chat-w, 360px);
  width: calc(100vw - var(--op-chat-w, 360px));
}
`;
