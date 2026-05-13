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
import { LocalCardHost } from './chat/LocalCardHost';
import { useOperatorConversation } from './OperatorConversationProvider';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { OperatorLogoMark } from './OperatorLogoMark';
import { OperatorWordmarkLockup } from './OperatorWordmarkLockup';
import { OperatorActiveToggle } from './OperatorActiveToggle';
import { VoiceButton } from './voice/VoiceButton';

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
  const workspaceId = useWorkspaceId();

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
        <div className="op-chat-header-main">
          <div className="op-chat-header-orb" aria-hidden="true">
            <OperatorLogoMark className="op-chat-header-logo" />
          </div>
          <div className="op-chat-header-copy">
            <div className="op-chat-header-title-row">
              <OperatorWordmarkLockup
                className="op-chat-wordmark"
                titleClassName="op-chat-wordmark-title"
                subtitleClassName="op-chat-wordmark-subtitle"
                subtitle=""
              />
            </div>
            <div className="op-chat-controls" role="group" aria-label={`Operator voice controls — ${statusText}`}>
              <OperatorActiveToggle />
              <VoiceButton />
            </div>
          </div>
        </div>
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
        conversationId={conv.conversationId ?? undefined}
        workspaceId={workspaceId}
      />
      {/* M6: askUserLocal renderer host. Mounted once per sidebar so any
          client-side caller of askUserLocal has a slot to render into.
          Cards render here when triggered by render-time UI affordances
          (tab pickers, confirms) rather than server-side tool flows
          which go through PendingCardsBar instead. */}
      <LocalCardHost />
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
  flex-direction: column;
  align-items: stretch;
  padding: 10px 12px 8px;
  border-bottom: 1px solid rgba(125, 211, 252, 0.14);
  background:
    linear-gradient(180deg, rgba(11, 25, 42, 0.84), rgba(7, 16, 29, 0.94)),
    #07101d;
}

.op-chat-header-main {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
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

.op-chat-header-logo {
  width: 30px;
  height: 30px;
}

.op-chat-header-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
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

.op-chat-controls {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: visible;
}

.op-chat-controls .op-active-toggle {
  flex: 0 0 auto;
  min-height: 26px;
  padding: 3px 7px;
  font-size: 10px;
  letter-spacing: 0.05em;
}

.op-chat-controls .pc-voice-control {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  gap: 4px;
  margin-left: 0;
  overflow: visible;
}

.op-chat-controls .pc-voice-btn {
  flex: 1 1 auto;
  justify-content: center;
  min-width: 0;
  min-height: 26px;
  padding: 3px 7px 3px 6px;
  gap: 5px;
}

.op-chat-controls .pc-voice-btn-orb {
  width: 16px;
  height: 16px;
}

.op-chat-controls .pc-voice-btn-label {
  font-size: 10px;
  letter-spacing: 0.05em;
}

.op-chat-controls .pc-voice-settings-link {
  flex: 0 0 auto;
  min-height: 26px;
  padding: 0 6px;
}
.op-chat-controls .pc-voice-settings-text {
  display: none;
}
.op-chat-controls .pc-voice-wake-hint {
  z-index: 5;
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

.op-chat-sidebar {
  isolation: isolate;
  background:
    radial-gradient(circle at 16% 0%, rgba(125, 211, 252, 0.16), transparent 22%),
    radial-gradient(circle at 82% 12%, rgba(255,255,255,0.06), transparent 16%),
    linear-gradient(180deg, #08111d 0%, #040913 58%, #03070f 100%);
  box-shadow:
    inset -1px 0 0 rgba(255,255,255,0.03),
    inset 0 1px 0 rgba(255,255,255,0.04),
    22px 0 54px rgba(0, 0, 0, 0.24);
}

.op-chat-sidebar::before,
.op-chat-sidebar::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.op-chat-sidebar::before {
  border-right: 1px solid rgba(186, 230, 253, 0.10);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.04), transparent 12%, transparent 88%, rgba(255,255,255,0.03));
  opacity: 0.8;
}

.op-chat-sidebar::after {
  inset: 118px 0 58px;
  background:
    linear-gradient(90deg, transparent 0%, rgba(125, 211, 252, 0.045) 16%, transparent 36%),
    repeating-linear-gradient(180deg, rgba(255,255,255,0.015) 0 1px, transparent 1px 32px);
  opacity: 0.55;
}

.op-chat-header {
  position: relative;
  z-index: 3;
  overflow: visible;
  isolation: isolate;
  backdrop-filter: blur(12px);
  background:
    radial-gradient(circle at 12% 12%, rgba(125, 211, 252, 0.12), transparent 18%),
    linear-gradient(180deg, rgba(10, 23, 39, 0.96), rgba(6, 14, 25, 0.98)),
    #07101d;
  box-shadow: inset 0 -1px 0 rgba(125, 211, 252, 0.08);
}
.op-chat-header-main {
  position: relative;
  z-index: 1;
}

.op-chat-header::after {
  content: '';
  position: absolute;
  z-index: 0;
  left: -18%;
  top: 0;
  width: 44%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
  transform: skewX(-20deg);
  animation: op-chat-header-sheen 9s ease-in-out infinite;
  pointer-events: none;
}

.op-chat-header-orb {
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(circle at 36% 28%, rgba(255,255,255,0.25), transparent 24%),
    linear-gradient(180deg, rgba(56, 189, 248, 0.22), rgba(56, 189, 248, 0.08));
}

.op-chat-header-orb::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 11px;
  border: 1px solid rgba(255,255,255,0.05);
}

.op-chat-header-logo {
  filter: drop-shadow(0 0 10px rgba(125, 211, 252, 0.26));
}

.op-chat-sidebar .op-chat-banner {
  position: relative;
  overflow: hidden;
  backdrop-filter: blur(8px);
  background:
    linear-gradient(180deg, rgba(56, 189, 248, 0.10), rgba(56, 189, 248, 0.05));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
}

.op-chat-sidebar .op-chat-banner::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.10), transparent);
  transform: translateX(-140%);
  animation: op-chat-banner-sheen 7s ease-in-out infinite;
  pointer-events: none;
}

.op-chat-sidebar .oracle-body {
  position: relative;
  z-index: 1;
  background:
    linear-gradient(180deg, rgba(7, 14, 24, 0.96), rgba(4, 9, 17, 0.985)) !important;
}

.op-chat-sidebar .oracle-msg-content {
  background:
    linear-gradient(180deg, rgba(9, 19, 31, 0.97), rgba(6, 12, 22, 0.99)) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.04),
    inset 0 -1px 0 rgba(0,0,0,0.18),
    0 12px 24px rgba(0,0,0,0.18);
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  background:
    linear-gradient(180deg, rgba(20, 53, 82, 0.99), rgba(9, 31, 52, 0.99)) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.05),
    inset 0 -1px 0 rgba(0,0,0,0.18),
    0 14px 28px rgba(2, 8, 23, 0.22);
}

.op-chat-sidebar .oracle-form {
  position: relative;
  overflow: hidden;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.025);
}

.op-chat-sidebar .oracle-form::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(125, 211, 252, 0.24), transparent);
}

.op-chat-sidebar .oracle-form input {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
}

.op-chat-sidebar .oracle-send-button {
  position: relative;
  overflow: hidden;
  border-color: rgba(125, 211, 252, 0.30);
  background: linear-gradient(180deg, rgba(71, 198, 255, 0.22), rgba(56, 189, 248, 0.12));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.06),
    0 8px 18px rgba(2, 8, 23, 0.18);
  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease, background 120ms ease;
}

.op-chat-sidebar .oracle-send-button:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: rgba(125, 211, 252, 0.42);
  background: linear-gradient(180deg, rgba(103, 232, 249, 0.26), rgba(56, 189, 248, 0.16));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.08),
    0 10px 20px rgba(2, 8, 23, 0.22);
}

.op-chat-sidebar .oracle-send-button::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.14), transparent);
  transform: translateX(-150%);
}

.op-chat-sidebar .oracle-send-button:hover:not(:disabled)::after {
  animation: op-chat-button-sheen 800ms ease;
}

.op-chat-resize-handle {
  width: 7px;
}

.op-chat-resize-handle:hover {
  background: linear-gradient(180deg, rgba(125, 211, 252, 0.04), rgba(125, 211, 252, 0.22), rgba(125, 211, 252, 0.04));
}

@keyframes op-chat-header-sheen {
  0%, 12%, 100% { transform: translateX(-160%) skewX(-20deg); opacity: 0; }
  18%, 32% { transform: translateX(280%) skewX(-20deg); opacity: 1; }
  36% { opacity: 0; }
}

@keyframes op-chat-banner-sheen {
  0%, 72%, 100% { transform: translateX(-150%); opacity: 0; }
  78%, 92% { transform: translateX(140%); opacity: 1; }
}

@keyframes op-chat-button-sheen {
  from { transform: translateX(-150%); }
  to { transform: translateX(150%); }
}

/* Simplicity/readability pass: flatten decorative motion, tighten message
   rhythm, and give the composer more useful text space. */
.op-chat-sidebar {
  background:
    linear-gradient(180deg, rgba(6, 14, 24, 0.99), rgba(3, 8, 15, 0.99)) !important;
  box-shadow:
    inset -1px 0 0 rgba(255,255,255,0.035),
    14px 0 34px rgba(0, 0, 0, 0.18) !important;
}

.op-chat-sidebar::after,
.op-chat-header::after,
.op-chat-sidebar .op-chat-banner::after,
.op-chat-sidebar .oracle-form::before,
.op-chat-sidebar .oracle-send-button::after,
.op-chat-sidebar .oracle-msg-assistant .oracle-msg-content::before,
.op-chat-sidebar .oracle-msg-assistant .oracle-msg-content::after {
  display: none !important;
}

.op-chat-sidebar::before {
  opacity: 0.42 !important;
  background: none !important;
}

.op-chat-header {
  padding: 8px 10px 7px !important;
  background: rgba(5, 13, 23, 0.96) !important;
  box-shadow: inset 0 -1px 0 rgba(125, 211, 252, 0.10) !important;
  backdrop-filter: none !important;
}

.op-chat-header-main {
  gap: 9px !important;
}

.op-chat-header-orb {
  width: 34px !important;
  height: 34px !important;
  flex-basis: 34px !important;
  border-radius: 12px !important;
  background: rgba(56, 189, 248, 0.10) !important;
  box-shadow: none !important;
}

.op-chat-header-orb::after {
  inset: 2px !important;
  border-radius: 10px !important;
}

.op-chat-header-logo {
  width: 26px !important;
  height: 26px !important;
  filter: none !important;
}

.op-chat-header-copy {
  gap: 3px !important;
}

.op-chat-header-title-row strong {
  font-size: 13.5px !important;
}

.op-chat-controls .op-active-toggle,
.op-chat-controls .pc-voice-btn,
.op-chat-controls .pc-voice-settings-link {
  min-height: 27px !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-body {
  padding: 8px 8px 9px !important;
  gap: 7px !important;
  background: rgba(3, 8, 15, 0.98) !important;
}

.op-chat-sidebar .oracle-msg {
  padding-inline: 0 !important;
  column-gap: 7px !important;
}

.op-chat-sidebar .oracle-msg-avatar {
  width: 20px !important;
  height: 20px !important;
  flex-basis: 20px !important;
  margin-top: 3px;
  opacity: 0.66;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-msg-icon {
  width: 12px !important;
  height: 12px !important;
}

.op-chat-sidebar .oracle-msg-stack {
  max-width: calc(100% - 28px) !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-stack {
  max-width: min(84%, 286px) !important;
}

.op-chat-sidebar .oracle-msg-content {
  padding: 9px 10px !important;
  border-radius: 12px !important;
  background: rgba(7, 15, 27, 0.94) !important;
  box-shadow: none !important;
  font-size: 13px !important;
  line-height: 1.5 !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  background: rgba(14, 45, 70, 0.96) !important;
}

.op-chat-sidebar .oracle-tool-chip {
  min-height: 22px;
  padding: 3px 8px;
  border-radius: 999px;
  opacity: 0.74;
  font-size: 10.5px;
  box-shadow: none !important;
}

.op-chat-sidebar .op-chat-banner {
  margin: 8px 9px 0 !important;
  padding: 8px 9px !important;
  border-radius: 10px !important;
  background: rgba(56, 189, 248, 0.075) !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-form {
  padding: 8px !important;
  gap: 6px !important;
  background: rgba(5, 12, 22, 0.98) !important;
}

.op-chat-sidebar .oracle-input-shell {
  min-height: 38px !important;
  border-radius: 12px !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-input-shell input {
  padding-right: 12px !important;
  font-size: 13px !important;
}

.op-chat-sidebar .oracle-input-meta {
  display: none !important;
}

.op-chat-sidebar .oracle-send-button {
  min-width: 58px !important;
  min-height: 38px !important;
  border-radius: 12px !important;
  box-shadow: none !important;
  transform: none !important;
}
`;
