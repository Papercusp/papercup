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

  return (
    <>
      <aside className="op-chat-sidebar" style={sidebarStyle} aria-label="Operator chat">
        <style>{OP_CHAT_SIDEBAR_CSS}</style>
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
    </>
  );
}

const OP_CHAT_SIDEBAR_CSS = `
.op-chat-sidebar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 60;
  border-right: 1px solid var(--border, rgba(125, 211, 252, 0.18));
  background: var(--bg-1, #0b0c10);
  display: flex;
  flex-direction: column;
  /* Width set inline via style. */
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
