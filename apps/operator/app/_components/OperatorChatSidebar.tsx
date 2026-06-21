'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * OperatorChatSidebar — fixed left, full-height, and collapsible.
 *
 * Hosts the OperatorChat. Width is drag-resizable from the right
 * edge while expanded; the expanded width persists in localStorage
 * so it survives reloads. The open/closed state is user-meaningful,
 * so it lives in the URL via nuqs (`?chat=`).
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
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { reconcileProfilePref, writeProfileField } from '@papercusp/operator-core/lib/profile-pref';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { OperatorChat } from './OperatorChat';
import { LocalCardHost } from './chat/LocalCardHost';
import { useOperatorConversation } from './OperatorConversationProvider';
import { useShortcutAction } from '@/lib/hotkeys';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { OperatorLogoMark } from './OperatorLogoMark';
import { OperatorWordmarkLockup } from './OperatorWordmarkLockup';
import { OperatorActiveToggle } from './OperatorActiveToggle';
import { VoiceButton } from './voice/VoiceButton';
import { AudienceModeSelector } from './AudienceModeSelector';
import {
  OPERATOR_CHAT_COLLAPSED_WIDTH,
  OPERATOR_CHAT_DEFAULT_WIDTH,
  OPERATOR_CHAT_OPEN_QUERY_KEY,
  clampOperatorChatWidth,
} from './operator-chat-layout';

const STORAGE_KEY = 'papercusp.operatorChat.width';

/** Read the stored width from localStorage, clamped to the viewport ceiling. */
function readStoredWidth(): number {
  if (typeof window === 'undefined') return OPERATOR_CHAT_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(wsLocalKey(STORAGE_KEY));
    if (!raw) return OPERATOR_CHAT_DEFAULT_WIDTH;
    const n = Number(raw);
    return clampOperatorChatWidth(n, window.innerWidth);
  } catch {
    return OPERATOR_CHAT_DEFAULT_WIDTH;
  }
}

export function OperatorChatSidebar() {
  const [chatOpen, setChatOpen] = useQueryState(
    OPERATOR_CHAT_OPEN_QUERY_KEY,
    parseAsBoolean.withDefault(true),
  );
  const [width, setWidth] = useState<number>(OPERATOR_CHAT_DEFAULT_WIDTH);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate width from localStorage post-mount to keep SSR markup stable.
  useEffect(() => {
    setWidth(readStoredWidth());
    setHydrated(true);
  }, []);

  // Reconcile from PG (source of truth) on mount: if the stored profile width
  // differs from the local cache (set on another device, or the cache was
  // lost), adopt it. localStorage stays the instant first-paint value above.
  useEffect(() => {
    void reconcileProfilePref<number>({
      field: 'op_chat_width',
      parse: (raw) => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null),
      current: readStoredWidth,
      adopt: (n) => {
        const clamped = clampOperatorChatWidth(n, window.innerWidth);
        try {
          window.localStorage.setItem(wsLocalKey(STORAGE_KEY), String(clamped));
        } catch { /* sandbox / quota */ }
        setWidth(clamped);
      },
    });
  }, []);

  // Mirror the active offset width to a CSS var so app content shifts.
  useEffect(() => {
    if (!hydrated) return;
    const offsetWidth = chatOpen ? width : OPERATOR_CHAT_COLLAPSED_WIDTH;
    document.documentElement.style.setProperty('--op-chat-w', `${offsetWidth}px`);
    document.body.classList.add('has-op-chat');
    document.body.classList.toggle('op-chat-collapsed', !chatOpen);
    try {
      window.localStorage.setItem(wsLocalKey(STORAGE_KEY), String(width));
    } catch { /* sandbox / quota */ }
    return () => { /* leave the classes in place across re-renders */ };
  }, [chatOpen, hydrated, width]);

  useEffect(() => {
    if (!hydrated) return;
    const onResize = () => {
      setWidth((current) => clampOperatorChatWidth(current, window.innerWidth));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [hydrated]);

  // Strip the body class on unmount (chromeless routes don't render
  // this component — the cleanup is for completeness/HMR safety).
  useEffect(() => {
    return () => {
      try {
        document.body.classList.remove('has-op-chat');
        document.body.classList.remove('op-chat-collapsed');
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
    const next = clampOperatorChatWidth(e.clientX, window.innerWidth);
    setWidth(next);
  }, []);
  const onHandleUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    // Persist the final width to PG (source of truth) on drag-commit — once
    // per resize, not per pointermove. The cache is kept in sync by the width
    // effect; this just makes it durable across reload/restart.
    try {
      const final = clampOperatorChatWidth(e.clientX, window.innerWidth);
      writeProfileField('op_chat_width', final);
    } catch { /* ignore */ }
  }, []);

  const collapseChat = useCallback(() => {
    void setChatOpen(false);
  }, [setChatOpen]);

  const expandChat = useCallback(() => {
    void setChatOpen(true);
  }, [setChatOpen]);

  // Conversation state from the OperatorConversationProvider mounted
  // in the root layout. The provider owns the state machine + silence
  // timers + tag dispatch; this component is a presentational thin
  // wrapper around <OperatorChat> with the provider's value.
  const conv = useOperatorConversation();
  const workspaceId = useWorkspaceId();

  // Cmd/Ctrl+Shift+I → Generate ideas (same as clicking the lightbulb
  // button in the composer). Plan §C.9 promised this keyboard binding.
  useShortcutAction('operator.generateIdeas', () => {
    conv.generateIdeas();
  });

  // Pre-hydration: render the sidebar at its expanded default width so
  // the lazy mount lines up with the bootstrap script in layout.tsx.
  const renderedWidth = hydrated
    ? (chatOpen ? width : OPERATOR_CHAT_COLLAPSED_WIDTH)
    : OPERATOR_CHAT_DEFAULT_WIDTH;

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
    <aside
      className="op-chat-sidebar"
      style={sidebarStyle}
      aria-label="Papercup chat"
      data-collapsed={chatOpen ? 'false' : 'true'}
    >
      <style>{OP_CHAT_SIDEBAR_CSS}</style>
      <Tooltip label="Expand Papercup chat"><button
        type="button"
        className="op-chat-expand-rail"
        onClick={expandChat}
        aria-label="Expand Papercup chat"

        aria-hidden={chatOpen}
      >
        <span className="op-chat-expand-orb" aria-hidden="true">
          <OperatorLogoMark className="op-chat-expand-logo" />
        </span>
        <span className="op-chat-expand-label">Chat</span>
        <ChevronRight className="op-chat-expand-chevron" strokeWidth={1.9} aria-hidden="true" />
      </button></Tooltip>
      <div className="op-chat-expanded-shell" aria-hidden={!chatOpen}>
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
                <Tooltip label="Collapse Papercup chat"><button
                  type="button"
                  className="op-chat-toggle"
                  onClick={collapseChat}
                  aria-label="Collapse Papercup chat"

                >
                  <ChevronLeft strokeWidth={1.9} aria-hidden="true" />
                </button></Tooltip>
              </div>
              <div className="op-chat-controls" role="group" aria-label={`Papercup voice controls — ${statusText}`}>
                <AudienceModeSelector />
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
          onGenerateIdeas={conv.generateIdeas}
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
      </div>
      <div
        className="op-chat-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Papercup chat"
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
  /* Above .operator-panel (z-index 1200) so the Deck scrim + backdrop-filter
     don't dim/blur the chat when the Deck panel is open. */
  z-index: 1300;
  border-right: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%);
  background:
    radial-gradient(circle at 50% -12%, color-mix(in srgb, var(--accent), transparent 84%), transparent 34%),
    linear-gradient(180deg, var(--bg) 0%, var(--bg-deeper) 100%);
  color: var(--fg, #e7eef7);
  display: flex;
  flex-direction: column;
  box-shadow: inset -1px 0 0 rgba(255,255,255,0.03), 18px 0 44px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  /* Width set inline via style. */
}
.op-chat-expanded-shell {
  min-height: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
}

.op-chat-expand-rail {
  position: relative;
  z-index: 3;
  display: none;
  width: 100%;
  height: 100%;
  padding: 12px 8px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  align-items: center;
  justify-content: flex-start;
  flex-direction: column;
  gap: 12px;
  cursor: pointer;
}

.op-chat-expand-orb {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 76%);
  background: radial-gradient(circle at 35% 25%, rgba(255,255,255,0.18), transparent 24%), color-mix(in srgb, var(--accent), transparent 88%);
  color: var(--accent-strong, var(--accent-soft));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 28px color-mix(in srgb, var(--bg-deeper), transparent 76%);
}

.op-chat-expand-logo {
  width: 30px;
  height: 30px;
}

.op-chat-expand-label {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0;
  color: color-mix(in srgb, var(--fg), transparent 14%);
}

.op-chat-expand-chevron {
  width: 18px;
  height: 18px;
  color: var(--accent-soft);
}

.op-chat-sidebar[data-collapsed="true"] .op-chat-expanded-shell {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.op-chat-sidebar[data-collapsed="true"] .op-chat-expand-rail {
  display: flex;
}

.op-chat-sidebar[data-collapsed="true"] .op-chat-resize-handle {
  display: none;
}

.op-chat-header {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 10px 12px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-popover), transparent 16%), color-mix(in srgb, var(--bg), transparent 6%)),
    var(--bg);
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
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 80%);
  background: radial-gradient(circle at 35% 25%, rgba(255,255,255,0.18), transparent 24%), color-mix(in srgb, var(--accent), transparent 90%);
  color: var(--accent-strong, var(--accent-soft));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 28px color-mix(in srgb, var(--bg-deeper), transparent 72%);
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
  letter-spacing: 0;
}
.op-chat-toggle {
  margin-left: auto;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 78%);
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg-1), transparent 6%);
  color: #eef8ff;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
  cursor: pointer;
}

.op-chat-toggle svg {
  width: 16px;
  height: 16px;
}

.op-chat-expand-rail:hover,
.op-chat-toggle:hover {
  background: color-mix(in srgb, var(--bg-popover), transparent 2%);
  border-color: color-mix(in srgb, var(--accent-strong), transparent 66%);
}

.op-chat-expand-rail:focus-visible,
.op-chat-toggle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong), transparent 18%);
  outline-offset: 2px;
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
  letter-spacing: 0;
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
  letter-spacing: 0;
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
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%);
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent-strong), transparent 93%);
  color: #cfeeff;
  font-size: 12px;
  line-height: 1.4;
}

.op-chat-sidebar .oracle-body {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-deep), transparent 4%), color-mix(in srgb, var(--bg-deeper), transparent 2%)) !important;
  padding: 14px 13px;
  gap: 12px;
  scrollbar-color: color-mix(in srgb, var(--accent-strong), transparent 78%) transparent;
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
  border-color: color-mix(in srgb, var(--accent-strong), transparent 87%);
  background: color-mix(in srgb, var(--bg), transparent 8%) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.035), 0 10px 22px rgba(0,0,0,0.16);
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent), transparent 72%);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-raised-high), transparent 2%), color-mix(in srgb, var(--bg-popover), transparent 2%)) !important;
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
  border-top-color: color-mix(in srgb, var(--accent-strong), transparent 86%);
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg), transparent 8%), color-mix(in srgb, var(--bg-deeper), transparent 2%)) !important;
  padding: 12px;
}

.op-chat-sidebar .oracle-form input {
  background: rgba(255,255,255,0.04);
  border-color: color-mix(in srgb, var(--accent-strong), transparent 82%);
}

.op-chat-sidebar .oracle-form input:focus {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 52%);
}

.op-chat-sidebar .oracle-send-button {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 78%);
  background: color-mix(in srgb, var(--accent-strong), transparent 90%);
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
  background: color-mix(in srgb, var(--accent-strong), transparent 82%);
}

/* Body shift: every page absorbs the sidebar's width as left padding.
   Pages with margin: auto centered content stay centered within the
   remaining space (the centering algorithm absorbs the loss into
   what used to be margin). Edge-to-edge pages may need their own
   per-page padding tweaks. */
body.has-op-chat {
  padding-left: var(--op-chat-w, 360px);
}

/* Only the global fixed header needs an explicit left/width offset.
   The harness strip (.h-header) already sits inside body content, so the
   body padding-left above shifts it naturally; offsetting it again doubles
   the shift and clips the right-side controls after chat mount / resize. */
body.has-op-chat .pc-header {
  left: var(--op-chat-w, 360px);
  width: calc(100vw - var(--op-chat-w, 360px));
}

.op-chat-sidebar {
  isolation: isolate;
  background:
    radial-gradient(circle at 16% 0%, color-mix(in srgb, var(--accent-strong), transparent 84%), transparent 22%),
    radial-gradient(circle at 82% 12%, rgba(255,255,255,0.06), transparent 16%),
    linear-gradient(180deg, var(--bg) 0%, var(--bg-deeper) 58%, var(--bg-deepest) 100%);
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
  border-right: 1px solid color-mix(in srgb, var(--accent-soft), transparent 90%);
  background:
    linear-gradient(180deg, rgba(255,255,255,0.04), transparent 12%, transparent 88%, rgba(255,255,255,0.03));
  opacity: 0.8;
}

.op-chat-sidebar::after {
  inset: 118px 0 58px;
  background:
    linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--accent-strong), transparent 95.5%) 16%, transparent 36%),
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
    radial-gradient(circle at 12% 12%, color-mix(in srgb, var(--accent-strong), transparent 88%), transparent 18%),
    linear-gradient(180deg, color-mix(in srgb, var(--bg-popover), transparent 4%), color-mix(in srgb, var(--bg-deep), transparent 2%)),
    var(--bg);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--accent-strong), transparent 92%);
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
    linear-gradient(180deg, color-mix(in srgb, var(--accent), transparent 78%), color-mix(in srgb, var(--accent), transparent 92%));
}

.op-chat-header-orb::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 11px;
  border: 1px solid rgba(255,255,255,0.05);
}

.op-chat-header-logo {
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--accent-strong), transparent 74%));
}

.op-chat-sidebar .op-chat-banner {
  position: relative;
  overflow: hidden;
  backdrop-filter: blur(8px);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--accent), transparent 90%), color-mix(in srgb, var(--accent), transparent 95%));
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
    linear-gradient(180deg, color-mix(in srgb, var(--bg-deep), transparent 4%), color-mix(in srgb, var(--bg-deeper), transparent 1.5%)) !important;
}

.op-chat-sidebar .oracle-msg-content {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-1), transparent 3%), color-mix(in srgb, var(--bg-deep), transparent 1%)) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.04),
    inset 0 -1px 0 rgba(0,0,0,0.18),
    0 12px 24px rgba(0,0,0,0.18);
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-raised-high), transparent 1%), color-mix(in srgb, var(--bg-popover), transparent 1%)) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.05),
    inset 0 -1px 0 rgba(0,0,0,0.18),
    0 14px 28px color-mix(in srgb, var(--bg-deeper), transparent 78%);
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
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent-strong), transparent 76%), transparent);
}

.op-chat-sidebar .oracle-form input {
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
}

.op-chat-sidebar .oracle-send-button {
  position: relative;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--accent-strong), transparent 70%);
  background: linear-gradient(180deg, rgba(71, 198, 255, 0.22), color-mix(in srgb, var(--accent), transparent 88%));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.06),
    0 8px 18px color-mix(in srgb, var(--bg-deeper), transparent 82%);
  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease, background 120ms ease;
}

.op-chat-sidebar .oracle-send-button:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent-strong), transparent 58%);
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent), transparent 74%), color-mix(in srgb, var(--accent), transparent 84%));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.08),
    0 10px 20px color-mix(in srgb, var(--bg-deeper), transparent 78%);
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
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent-strong), transparent 96%), color-mix(in srgb, var(--accent-strong), transparent 78%), color-mix(in srgb, var(--accent-strong), transparent 96%));
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
    linear-gradient(180deg, color-mix(in srgb, var(--bg-deep), transparent 1%), color-mix(in srgb, var(--bg-deepest), transparent 1%)) !important;
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
  background: color-mix(in srgb, var(--bg-deep), transparent 4%) !important;
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--accent-strong), transparent 90%) !important;
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
  background: color-mix(in srgb, var(--accent), transparent 90%) !important;
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
  background: color-mix(in srgb, var(--bg-deepest), transparent 2%) !important;
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
  background: color-mix(in srgb, var(--bg), transparent 6%) !important;
  box-shadow: none !important;
  font-size: 13px !important;
  line-height: 1.5 !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  background: color-mix(in srgb, var(--bg-raised-high), transparent 4%) !important;
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
  background: color-mix(in srgb, var(--accent), transparent 92.5%) !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-form {
  padding: 8px !important;
  gap: 6px !important;
  background: color-mix(in srgb, var(--bg-deep), transparent 2%) !important;
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

/* Contrast follow-up: separate chat surfaces from the sidebar background so
   reading requires less effort at a glance. */
.op-chat-sidebar .oracle-body {
  background: color-mix(in srgb, var(--bg-deepest), transparent 1%) !important;
}

.op-chat-controls .op-active-toggle,
.op-chat-controls .pc-voice-btn,
.op-chat-controls .pc-voice-settings-link {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 74%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 4%) !important;
  color: #eef8ff !important;
}

.op-chat-controls .pc-voice-btn-orb {
  background: color-mix(in srgb, var(--accent), transparent 86%) !important;
}

.op-chat-sidebar .op-chat-banner {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 78%) !important;
  background: color-mix(in srgb, var(--accent), transparent 89%) !important;
  color: #e6f6ff !important;
}

.op-chat-sidebar .oracle-tool-chip {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 78%) !important;
  background: color-mix(in srgb, var(--accent), transparent 88%) !important;
  color: #c5edff !important;
  opacity: 0.92;
}

.op-chat-sidebar .oracle-msg-content {
  border: 1px solid rgba(148, 163, 184, 0.22) !important;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-popover), transparent 2%), color-mix(in srgb, var(--bg), transparent 1%)) !important;
  color: #f3f9ff !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 60%) !important;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-raised-high), transparent 1%), color-mix(in srgb, var(--bg-raised-high), transparent 1%)) !important;
  color: var(--fg) !important;
}

.op-chat-sidebar .oracle-input-shell {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 76%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 2%) !important;
}

.op-chat-sidebar .oracle-input-shell input {
  color: var(--fg) !important;
}

.op-chat-sidebar .oracle-input-shell input::placeholder {
  color: color-mix(in srgb, var(--accent-soft), transparent 44%) !important;
}

.op-chat-sidebar .oracle-send-button {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 66%) !important;
  background: color-mix(in srgb, var(--accent), transparent 83%) !important;
  color: var(--fg) !important;
}

.op-chat-sidebar .oracle-send-button:disabled {
  border-color: rgba(148, 163, 184, 0.18) !important;
  background: rgba(255, 255, 255, 0.05) !important;
  color: color-mix(in srgb, var(--fg), transparent 28%) !important;
}

.op-chat-sidebar .ask-choice-card {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 82%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 2%) !important;
}

.op-chat-sidebar .ask-choice-option {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 86%) !important;
  background: rgba(255, 255, 255, 0.028) !important;
}

/* Readability follow-up: clarify utility text and affordances without adding
   chrome. These are the surfaces users scan before typing or responding. */
.op-chat-sidebar .oracle-load-earlier {
  padding: 7px 0 8px !important;
  color: color-mix(in srgb, var(--fg), transparent 46%) !important;
  font-size: 10px !important;
  font-weight: 760 !important;
  letter-spacing: 0 !important;
}

.op-chat-sidebar .oracle-load-earlier-end {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: color-mix(in srgb, var(--fg), transparent 42%) !important;
}

.op-chat-sidebar .oracle-load-earlier-end::before,
.op-chat-sidebar .oracle-load-earlier-end::after {
  content: "";
  width: 42px;
  height: 1px;
  background: color-mix(in srgb, var(--accent-strong), transparent 86%);
}

.op-chat-sidebar .oracle-tool-chip {
  font-size: 11px;
  line-height: 1.25;
  letter-spacing: 0;
}

.op-chat-sidebar .oracle-msg-content {
  border-color: rgba(148, 163, 184, 0.30) !important;
  font-size: 13.25px !important;
  line-height: 1.54 !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 50%) !important;
}

.op-chat-sidebar .oracle-empty-state-title {
  color: var(--fg) !important;
}

.op-chat-sidebar .oracle-empty-state-text {
  color: color-mix(in srgb, var(--fg), transparent 22%) !important;
}

.op-chat-sidebar .op-chat-empty-panel {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 78%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 2%) !important;
}

.op-chat-sidebar .op-chat-empty-panel-label {
  color: color-mix(in srgb, var(--fg), transparent 18%) !important;
}

.op-chat-sidebar .op-chat-empty-row {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 84%) !important;
  background: rgba(255, 255, 255, 0.035) !important;
}

.op-chat-sidebar .op-chat-empty-row-hint {
  color: color-mix(in srgb, var(--fg), transparent 22%) !important;
}

.op-chat-sidebar .oracle-input-icon {
  color: color-mix(in srgb, var(--accent-soft), transparent 24%) !important;
}

.op-chat-sidebar .oracle-input-shell input::placeholder {
  color: color-mix(in srgb, var(--fg), transparent 34%) !important;
}

.op-chat-sidebar .oracle-send-button:disabled {
  opacity: 0.86 !important;
}

.op-chat-sidebar .ask-choice-question {
  color: var(--fg) !important;
}

.op-chat-sidebar .ask-choice-picked {
  color: color-mix(in srgb, var(--fg), transparent 14%) !important;
}

.op-chat-sidebar .ask-choice-picked span {
  color: var(--fg) !important;
  font-weight: 720 !important;
}

.op-chat-sidebar .ask-choice-option[data-picked="true"] {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 62%) !important;
  background: color-mix(in srgb, var(--accent), transparent 86%) !important;
}

.op-chat-sidebar .ask-choice-submit-hint {
  color: color-mix(in srgb, var(--fg), transparent 20%) !important;
}

/* Usability follow-up: make the first-run panel, composer, and selectable
   choices read as practical controls rather than decorative HUD pieces. */
.op-chat-sidebar .oracle-body {
  overflow-x: hidden !important;
}

.op-chat-sidebar .oracle-empty-state {
  gap: 11px !important;
}

.op-chat-sidebar .oracle-empty-state-icon {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 66%) !important;
  background: color-mix(in srgb, var(--bg-raised-high), transparent 2%) !important;
}

.op-chat-sidebar .op-chat-empty-panel {
  width: min(100%, 284px) !important;
  padding: 13px !important;
}

.op-chat-sidebar .op-chat-empty-panel-head {
  margin-bottom: 10px !important;
}

.op-chat-sidebar .op-chat-empty-panel-label {
  letter-spacing: 0 !important;
}

.op-chat-sidebar .op-chat-empty-row {
  gap: 3px !important;
  padding: 9px 10px !important;
  border-color: color-mix(in srgb, var(--accent-strong), transparent 80%) !important;
  background: color-mix(in srgb, var(--bg-popover), transparent 2%) !important;
}

.op-chat-sidebar .op-chat-empty-row-title {
  color: var(--fg) !important;
  font-size: 12.5px !important;
  line-height: 1.28 !important;
}

.op-chat-sidebar .op-chat-empty-row-hint {
  line-height: 1.42 !important;
}

.op-chat-sidebar .oracle-msg-content,
.op-chat-sidebar .oracle-tool-chip,
.op-chat-sidebar .ask-choice-question,
.op-chat-sidebar .ask-choice-option-label,
.op-chat-sidebar .ask-choice-option-hint {
  overflow-wrap: anywhere;
}

.op-chat-sidebar .ask-choice-option {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 82%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 8%) !important;
}

.op-chat-sidebar .ask-choice-option:hover:not([data-disabled="true"]) {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 68%) !important;
  background: color-mix(in srgb, var(--bg-raised), transparent 4%) !important;
}

.op-chat-sidebar .ask-choice-option-label {
  color: var(--fg) !important;
  line-height: 1.28 !important;
  white-space: normal !important;
}

.op-chat-sidebar .ask-choice-option-hint {
  color: color-mix(in srgb, var(--fg), transparent 20%) !important;
  line-height: 1.34 !important;
  white-space: normal !important;
}

.op-chat-sidebar .ask-choice-option-icon {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 76%) !important;
  background: color-mix(in srgb, var(--accent), transparent 85%) !important;
}

.op-chat-sidebar .ask-choice-option-chevron {
  color: color-mix(in srgb, var(--fg), transparent 18%) !important;
}

.op-chat-sidebar .oracle-form {
  position: relative;
  z-index: 4;
  border-top-color: color-mix(in srgb, var(--accent-strong), transparent 76%) !important;
  background: color-mix(in srgb, var(--bg-deep), transparent 1%) !important;
  box-shadow: 0 -14px 26px rgba(0, 0, 0, 0.24) !important;
}

.op-chat-sidebar .oracle-input-shell {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 70%) !important;
  background: color-mix(in srgb, var(--bg-1), transparent 1%) !important;
}

.op-chat-sidebar .oracle-input-shell::before {
  content: none !important;
  display: none !important;
}

.op-chat-sidebar .oracle-input-shell:hover {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 58%) !important;
  background: color-mix(in srgb, var(--bg-popover), transparent 1%) !important;
}

.op-chat-sidebar .oracle-input-shell:focus-within {
  border-color: color-mix(in srgb, var(--accent), transparent 42%) !important;
  background: color-mix(in srgb, var(--bg-popover), transparent 1%) !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 0 16px color-mix(in srgb, var(--accent), transparent 84%) !important;
}

.op-chat-sidebar .oracle-input-shell input {
  caret-color: var(--accent-strong);
}

.op-chat-sidebar .oracle-send-button:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent), transparent 52%) !important;
  background: color-mix(in srgb, var(--accent), transparent 76%) !important;
  color: var(--fg) !important;
}

.op-chat-sidebar .oracle-send-button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent), transparent 34%) !important;
  background: color-mix(in srgb, var(--accent), transparent 70%) !important;
}

.op-chat-sidebar button.op-chat-empty-row {
  position: relative;
  width: 100%;
  padding-right: 58px !important;
  appearance: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.op-chat-sidebar button.op-chat-empty-row::after {
  content: "Draft";
  position: absolute;
  right: 10px;
  top: 50%;
  height: 19px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 76%);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent), transparent 88%);
  color: rgba(224, 247, 255, 0.90);
  font-size: 9.5px;
  font-weight: 760;
  letter-spacing: 0;
  line-height: 1;
  text-transform: uppercase;
  transform: translateY(-50%);
}

.op-chat-sidebar button.op-chat-empty-row:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent), transparent 64%) !important;
  background: color-mix(in srgb, var(--bg-raised), transparent 1%) !important;
}

.op-chat-sidebar button.op-chat-empty-row:hover:not(:disabled)::after,
.op-chat-sidebar button.op-chat-empty-row:focus-visible::after {
  border-color: color-mix(in srgb, var(--accent), transparent 54%);
  background: color-mix(in srgb, var(--accent), transparent 82%);
  color: var(--fg);
}

.op-chat-sidebar button.op-chat-empty-row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent), transparent 38%);
  outline-offset: 3px;
}

.op-chat-sidebar button.op-chat-empty-row:disabled {
  cursor: wait;
  opacity: 0.72;
}

.op-chat-sidebar .oracle-send-button:disabled {
  border-color: rgba(148, 163, 184, 0.24) !important;
  background: rgba(255, 255, 255, 0.06) !important;
  color: color-mix(in srgb, var(--fg), transparent 24%) !important;
}

.op-chat-sidebar .oracle-tool-chip {
  max-width: min(100%, 286px);
  display: inline-flex !important;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.op-chat-sidebar .oracle-tool-chip svg {
  flex: 0 0 auto;
  opacity: 0.78;
}

.op-chat-sidebar .oracle-tool-chip span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.op-chat-sidebar .oracle-tool-chip:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent), transparent 38%);
  outline-offset: 3px;
}

.op-chat-tool-tooltip {
  display: grid;
  gap: 4px;
  max-width: 280px;
  overflow-wrap: anywhere;
}

.op-chat-tool-tooltip strong {
  color: var(--fg);
  font-size: 11px;
  line-height: 1.35;
}

.op-chat-tool-tooltip span {
  color: color-mix(in srgb, var(--fg), transparent 22%);
  font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
  font-size: 10px;
  line-height: 1.35;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-avatar {
  display: none !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-stack {
  max-width: min(86%, 300px) !important;
}

/* Readability/usability follow-up: keep transcript bubbles distinct in the
   narrow rail without making the chat feel loose. Padding lives on the
   virtualized row itself so the measured item height includes the gap. */
.op-chat-sidebar .oracle-body {
  padding: 10px 9px 11px !important;
}

.op-chat-sidebar .oracle-msg {
  padding-block: 2px !important;
}

.op-chat-sidebar .oracle-msg-stack {
  gap: 3px !important;
}

.op-chat-sidebar .oracle-msg-content {
  padding: 9px 11px !important;
  border-radius: 13px !important;
  border-color: rgba(148, 163, 184, 0.36) !important;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-popover), transparent 1%), color-mix(in srgb, var(--bg), transparent 0.5%)) !important;
  color: var(--fg) !important;
  line-height: 1.56 !important;
}

.op-chat-sidebar .oracle-msg-assistant .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent-strong), transparent 72%) !important;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-popover), transparent 0.5%), color-mix(in srgb, var(--bg), transparent 0.5%)) !important;
}

.op-chat-sidebar .oracle-msg-user .oracle-msg-content {
  border-color: color-mix(in srgb, var(--accent), transparent 38%) !important;
  background: linear-gradient(180deg, rgba(24, 78, 113, 0.99), color-mix(in srgb, var(--bg-raised-high), transparent 0.5%)) !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.055),
    0 8px 18px color-mix(in srgb, var(--bg-deeper), transparent 80%) !important;
}

.op-chat-sidebar .oracle-msg-system .oracle-msg-content {
  border-color: rgba(250, 204, 21, 0.30) !important;
  background: rgba(42, 31, 9, 0.86) !important;
  color: #fff7d6 !important;
}

.op-chat-sidebar .oracle-tool-chip {
  margin: 0 0 3px !important;
  border-color: color-mix(in srgb, var(--accent), transparent 66%) !important;
  background: color-mix(in srgb, var(--accent), transparent 84%) !important;
  color: #ddf6ff !important;
  opacity: 1 !important;
}

.op-chat-sidebar .oracle-input-shell input {
  height: 100% !important;
  border: 0 !important;
  border-radius: inherit !important;
  background: transparent !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-input-shell input:focus {
  border: 0 !important;
  box-shadow: none !important;
}

.op-chat-sidebar .oracle-thinking-row {
  flex-shrink: 0 !important;
  max-width: calc(100% - 38px) !important;
  margin: 4px 8px 12px 30px !important;
  border-color: color-mix(in srgb, var(--accent), transparent 66%) !important;
  border-radius: 13px !important;
  background: color-mix(in srgb, var(--bg-1), transparent 2%) !important;
  color: #dff6ff !important;
  overflow: visible !important;
}

/* Deck panel open → chat must stay fully visible and unblurred.
   The Deck (.operator-panel) sits behind chat at z-index 1200 and has
   a backdrop-filter blur + box-shadow scrim that bleeds through any
   translucent chat surface. Neutralize every backdrop-filter inside
   the chat and force its background to opaque so the chat reads as
   sharp, unblurred, fully interactive on top of the Deck. */
body:has(.operator-panel) .op-chat-sidebar,
body:has(.operator-panel) .op-chat-sidebar * {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
body:has(.operator-panel) .op-chat-sidebar {
  background:
    radial-gradient(circle at 50% -12%, color-mix(in srgb, var(--accent), transparent 84%), transparent 34%),
    linear-gradient(180deg, var(--bg) 0%, var(--bg-deeper) 100%),
    var(--bg-deeper) !important;
}
`;
