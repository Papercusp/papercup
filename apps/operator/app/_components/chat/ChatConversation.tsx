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

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ArrowUpRight, Coffee, CupSoda, Thermometer } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, ChatToolCall } from './chat-types';
import { remarkWorkRefs } from './remark-work-refs';
import { HydratedWorkRefPill } from './HydratedWorkRefPill';
import { MessageTimestamp } from './message-timestamp';
import type { WorkRefKind } from './parse-work-refs';
import { pickTopMessageIndex } from './session-turn-index';

// ChatMessage / ChatToolCall were lifted to ./chat-types.ts while this
// component was retired (design-simplification-2026-07-09 P-010) —
// OperatorConversationProvider kept storing turns in that shape. On revival
// (operator-chat-sidebar-revival-2026-07-13 P-001) the canonical declarations
// STAY in chat-types.ts; this re-export preserves the historical import
// surface (`from './chat/ChatConversation'`) without re-declaring the types.
export type { ChatMessage, ChatToolCall } from './chat-types';

export type ChatIconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean;
}>;

/**
 * Canonical per-agent avatar marks (WI-4731) — the SAME iconography the
 * LeftSidebar rail tabs use (LeftSidebar.tsx TAB table: Mug→Coffee,
 * Kettle→Thermometer, Papercup→CupSoda), so a message signed by an agent
 * wears the mark the user already knows that agent by. Unknown/unstamped
 * agents fall back to the hosting pane's icon.
 */
export const AGENT_MARKS: Record<string, ChatIconComponent> = {
  mug: Coffee,
  kettle: Thermometer,
  papercup: CupSoda,
};

/**
 * Markdown is a hard break on a single `\n` (2026-07-25 owner screenshot: a
 * standard markdown parser collapses a lone newline into a space, then
 * re-wraps — chat turns rely on single newlines as real line breaks). The
 * two-trailing-spaces-before-`\n` token is the CommonMark hard-break, so we
 * inject it rather than pulling in a whole extra remark plugin for one rule.
 */
function withHardBreaks(text: string): string {
  return text.replace(/\n/g, '  \n');
}

/**
 * Hoisted so the plugin list is REFERENTIALLY STABLE across renders. As an inline
 * `[remarkGfm, remarkWorkRefs]` literal this allocated a fresh array on every render
 * of every visible message, which denies react-markdown (and anything downstream of
 * it) any chance to skip work on an unchanged message. Same class of bug as an inline
 * arrow defeating the memo below — keep it module-level.
 */
const MESSAGE_REMARK_PLUGINS = [remarkGfm, remarkWorkRefs];

const MESSAGE_MARKDOWN_COMPONENTS = {
  // Paragraphs render as inline blocks inside the message bubble — a bare
  // <p> carries the browser's default 1em vertical margins, which reads as
  // a stray gap above/below a one-line chat message.
  p: ({ children }: { children?: ReactNode }) => <p className="oracle-msg-md-p">{children}</p>,
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

/** The `workrefpill` custom mdast/hast node's shape as react-markdown hands
 *  it to a `components` override — `node.properties` carries whatever
 *  `remarkWorkRefs` (chat-ref-pills-2026-07-26 P-004) put in `hProperties`. */
interface WorkRefPillHastNode {
  properties?: { refId?: unknown; refKind?: unknown };
}

/**
 * Message content renderer (WI gui-chat-session-controls-2026-07-25 P-009):
 * chat turns are plain-text markdown from the agent (bold, links, lists),
 * but the surface printed it literally (`**bold**`, a bare URL). Reuses the
 * same react-markdown + remark-gfm pairing HowItWorksHereCard already uses
 * for README rendering — no new markdown stack.
 *
 * chat-ref-pills-2026-07-26 P-004: `remarkWorkRefs` splices a `workrefpill`
 * node in place of every WI-/EI-/F-/P- ref found in the message's prose (see
 * that module for why fenced/inline code and existing-link labels are never
 * touched); the `workrefpill` entry below is the ONLY thing that turns that
 * node into a real pill — everything else about ReactMarkdown's usual
 * rendering is unchanged.
 *
 * `harnessSlug`/`planSlug` are just handed to HydratedWorkRefPill for live
 * status hydration (P-005) — this component makes no resolution decisions of
 * its own. `onWorkRefActivate` is a plain passthrough activation hook: P-004
 * only wires the MECHANISM (a pill that can be clicked); what a click
 * actually DOES (open a popup — D-001, P-008) is the caller's decision, so
 * this component takes no position on it and simply forwards clicks when a
 * handler is given (renders a static, non-interactive pill otherwise, same
 * WorkRefPill degrade as when no plan context resolves a P-ref).
 *
 * P-008: the payload also carries `planSlug` (the message's OWN plan_slug,
 * already in scope here for hydration) alongside `id`/`kind` — NOT a second
 * activation path, just enriching the one D-002 seam with the one extra bit
 * a 'plan-item' destination needs (which plan to open) that `id`/`kind` alone
 * can't carry. A 'work-item' destination ignores it; harmlessly `undefined`
 * when the message carries no plan_slug.
 */
/**
 * MEMOIZED — owner bug 2026-07-27 ("typing into the chat is incredibly laggy").
 *
 * The composer's text lives in `OperatorChat`'s `input` state and is threaded down
 * as ChatConversation's `inputValue` prop, so EVERY KEYSTROKE re-renders this whole
 * component tree. Without this memo that re-ran `ReactMarkdown` — a full parse with
 * `remarkGfm` + `remarkWorkRefs` — for every message currently on screen, on every
 * character typed. Virtualization caps that at the visible window rather than the
 * whole transcript, which is why it degrades with a tall pane rather than a long
 * conversation, but a dozen re-parses per keystroke is still far past the frame
 * budget and is exactly what the lag was.
 *
 * The memo holds because every prop here is stable across a keystroke: `content` /
 * `harnessSlug` / `planSlug` are primitives off the message, and the one function,
 * `onWorkRefActivate`, is `useCallback`-memoized at its source (OperatorChat's
 * `handleWorkRefActivate`). If a future caller passes an inline arrow for it this
 * silently stops memoizing and the lag returns — keep it stable.
 *
 * ── The OTHER half: typing WHILE AN AGENT STREAMS (WI-6502, measured 2026-07-28) ──
 * The memo above cannot help there, and that is not a bug in it: during a stream the
 * live message's `content` genuinely CHANGES. `sessionTimelineToChatMessages` joins a
 * turn's text parts, so the in-flight assistant message's content GROWS with every
 * streamed entry — and each growth re-parses the WHOLE accumulated message, which is
 * O(m²) across a turn. Benched (node, parse + element tree only, so a LOWER bound on
 * the real cost — the live path also pays reconciliation + DOM + layout + paint):
 *
 *     500ch 1.5ms | 2000ch 3.2ms | 4000ch 5.6ms | 8000ch 12.3ms | 16000ch 23.8ms
 *
 * i.e. an 8 KB answer streamed over 60 entries burns ~372ms of re-parse where parsing
 * once would cost 12ms. Those land in bursts (the server polls the transcript at 1Hz
 * and emits one SSE `event` PER ENTRY — see `adv-session-thinking-follow` in
 * endpoint-route/routes/harness/streams.ts), which is exactly the measured signature:
 * a dense series of 20-65ms tasks at burst onset, decaying after — no single long task,
 * which is why max-frame-gap instruments read "healthy" while real input latency hit
 * 100-166ms (hud-tab-public-release-2026-07-28#D-010).
 *
 * `useDeferredValue` is the fix: it marks the re-parse as NON-URGENT, so a keystroke
 * preempts a queued markdown render instead of landing behind the whole burst. The
 * displayed text is unchanged — it can just trail by a render under contention, which
 * is the correct trade for a pane you are typing into. Requires a concurrent root
 * (apps/operator-vite/src/main.tsx uses `createRoot`) — under a legacy root this
 * degrades to a plain passthrough, i.e. today's behavior, never a break.
 */
const ChatMessageContent = memo(function ChatMessageContent({
  content,
  harnessSlug,
  planSlug,
  onWorkRefActivate,
}: {
  content: string;
  harnessSlug?: string;
  planSlug?: string | null;
  onWorkRefActivate?: (ref: { id: string; kind: WorkRefKind; planSlug?: string | null }) => void;
}) {
  // Non-urgent: a keystroke's render jumps ahead of this one (see the doc above).
  const deferredContent = useDeferredValue(content);
  const components = useMemo(
    () => ({
      ...MESSAGE_MARKDOWN_COMPONENTS,
      workrefpill: ({ node }: { node?: WorkRefPillHastNode }) => {
        const id = typeof node?.properties?.refId === 'string' ? node.properties.refId : '';
        const kind: WorkRefKind = node?.properties?.refKind === 'plan-item' ? 'plan-item' : 'work-item';
        if (!id) return null;
        return (
          <HydratedWorkRefPill
            id={id}
            kind={kind}
            harnessSlug={harnessSlug ?? ''}
            planSlug={planSlug}
            size="xs"
            onActivate={onWorkRefActivate ? () => onWorkRefActivate({ id, kind, planSlug }) : undefined}
          />
        );
      },
    }),
    [harnessSlug, planSlug, onWorkRefActivate],
  );

  return (
    <ReactMarkdown remarkPlugins={MESSAGE_REMARK_PLUGINS} components={components}>
      {withHardBreaks(deferredContent)}
    </ReactMarkdown>
  );
});

/**
 * Discord's ↑-to-edit-last, adapted for an agent chat (discord-shortcuts
 * 2026-06-06): editing an already-answered turn is semantically murky in a
 * request→response conversation, so ↑ in the EMPTY composer instead RECALLS
 * your last sent message into the input to revise + resend.
 */
export function lastUserMessageText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content.trim()) return messages[i].content;
  }
  return null;
}

export interface ChatConversationProps {
  messages: ChatMessage[];
  /** True while the model is composing/streaming. Disables input + shows thinking row. */
  busy: boolean;
  /** A generation is in flight in a PEER window on the same thread
   *  (multi-window-chat-coherence P-009): shows the thinking row so the
   *  incoming reply doesn't appear out of nowhere, WITHOUT disabling this
   *  window's composer — user sends are never blocked by a peer. */
  peerThinking?: boolean;
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
   * Optional structured-CARD renderer for a message that carries a `report`
   * (deterministic-status-cards-2026-07-17 P-003). When it returns a node, that
   * card renders IN PLACE OF the message's plain-text `content` (the card is the
   * structured form of the same content — the curator's status card replacing
   * its flattened markdown lines). Returns null/undefined ⇒ the text renders as
   * normal (the flag-off / no-report path). msg is passed so the renderer can
   * read `msg.report` + route the drill-in.
   */
  renderReport?: (msg: ChatMessage) => ReactNode | null | undefined;

  /**
   * Harness scoping this conversation's WI-/EI-/F- ref pills
   * (chat-ref-pills-2026-07-26 P-004) — forwarded to HydratedWorkRefPill for
   * live status hydration (P-005). Omit when the surface isn't scoped to one
   * harness (e.g. a cross-harness feed); pills still render, just without
   * live state/title (HydratedWorkRefPill's own graceful degrade).
   */
  harnessSlug?: string;
  /**
   * Activation hook for a WI-/EI-/F-/P- ref pill rendered in a message's
   * markdown content (chat-ref-pills-2026-07-26 P-004). This component only
   * wires the MECHANISM — it takes no position on what a click should DO
   * (open a popup, per the 2026-07-26 owner re-spec D-001, is the caller's
   * decision). Omit to render static, non-interactive pills. P-008: the
   * payload also carries the message's own `planSlug` — the one extra bit a
   * 'plan-item' destination needs beyond `id`/`kind` (which plan to open);
   * `undefined` when the message carries no plan_slug context.
   */
  onWorkRefActivate?: (ref: { id: string; kind: WorkRefKind; planSlug?: string | null }) => void;

  /**
   * Optional per-message AVATAR override (gui-chat-session-controls-2026-07-25
   * P-012). When it returns a truthy node for a message, that node replaces the
   * default `.oracle-msg-avatar` span (icon mark) entirely — used by
   * SessionChatModal to swap the papercup agent-kind icon for a roster-driven
   * identity chip (handle + fleet colour + leader/member marker) on assistant
   * turns. Returns null/undefined ⇒ falls through to the default icon avatar
   * (AGENT_MARKS / iconForRole / emptyState.icon), same as when the prop is
   * omitted entirely.
   */
  renderAvatar?: (msg: ChatMessage) => ReactNode | null | undefined;

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

  /**
   * Optional live content rendered INSIDE the transcript scroller, after the
   * persisted message rows and before the thinking/error tail. Pending
   * interactive cards use this slot: they are chronological conversation
   * content, not a banner above history and not a footer below the composer.
   */
  transcriptTail?: ReactNode;

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

  /**
   * Optional slim informational row rendered UNDER the composer form
   * (gui-chat-session-controls-2026-07-25 P-007). Used by SessionChatModal to
   * surface the roster-driven session status (modes, context/compaction,
   * fleet, claims, plan, open await) below the reply box. Purely
   * informational — this component adds no behavior around it, same
   * passthrough pattern as composerExtra/renderAvatar. Omit to render
   * nothing (the default, unchanged for every other caller).
   */
  footer?: ReactNode;

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

  /**
   * Open the transcript ON a specific message instead of at the tail: a
   * literal run of text from the message to scroll to (HUD search → the
   * matched turn, owner ask 2026-08-02). See `findAnchoredMessageIndex` for
   * why this is TEXT and not an index.
   *
   * Changing it re-focuses; clearing it hands the transcript back to the
   * normal follow-the-tail behavior on the next message change. An anchor
   * that matches nothing is a no-op — the chat opens at the tail, which is
   * the honest degradation.
   */
  focusAnchor?: string | null;

  /**
   * The message to focus, when the caller can name it EXACTLY. Wins over
   * `focusAnchor`; -1/null means "no exact answer, fall back to the text".
   *
   * Both exist because they have different provenance and different failure
   * modes, not as two spellings of one thing. `focusIndex` is what a caller
   * derives from the stream's own `anchor` event (the server found the turn in
   * ITS store and named it, so the index is exact — but it is only present
   * when the deep-link carried an anchor and the server's window contained
   * it). `focusAnchor` is matched text, which resolves whenever the words are
   * present regardless of provenance, and so covers the cases the anchor event
   * does not reach.
   */
  focusIndex?: number | null;

  /**
   * Re-request the SAME focus target (chat-popup-turn-rail-2026-08-31 P-003).
   *
   * Focus is keyed on the request, not on the message, so an unchanged request
   * never re-steals a reader's scroll — correct for a search deep-link, which
   * fires once. It is wrong for the turn rail: clicking turn 3, reading on, and
   * clicking turn 3 AGAIN is a fresh request that must scroll again, and without
   * this it silently does nothing because `focusIndex` did not change.
   *
   * Callers bump this (a counter, a timestamp) per user gesture. Absent/null
   * behaves exactly as before.
   */
  focusNonce?: number | null;

  /**
   * Report which message is currently under the top of the viewport
   * (chat-popup-turn-rail-2026-08-31 P-005) — the reverse of `focusIndex`, and
   * what turns the turn rail from a menu into a position indicator.
   *
   * -1 means the transcript is empty. Otherwise it is a real message index,
   * clamped to the topmost RENDERED row when the reader is scrolled above the
   * first one — that is not a guess, it is where they are.
   *
   * Fires only on change, so a caller can put it straight into state.
   */
  onTopMessageIndex?: (index: number) => void;
}

/** How far below the viewport's top edge counts as "the message you are on"
 *  (P-005). Sized past the transcript's own top padding so a reader scrolled to
 *  the very top still resolves to the first message rather than to nothing. */
const TOP_INDEX_PROBE_PX = 32;

/**
 * Normalize for anchor matching: decode nothing (both sides are already plain
 * text), condense every whitespace run to one space, and case-fold.
 *
 * Condensing is load-bearing rather than cosmetic. The anchor comes from PG
 * `ts_headline`, which reflows the source text — a hard newline in the
 * transcript arrives as a single space in the headline — so a byte-exact
 * comparison against the transcript fails on any message containing a line
 * break, i.e. most agent output.
 */
function normalizeForAnchor(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Which message a `focusAnchor` refers to, or -1.
 *
 * TEXT, not an index, because the two stores disagree: the anchor originates
 * in `harness_shared.session_turns` (what search indexes) and is resolved
 * against the on-disk transcript the modal renders, which has been grouped
 * and filtered on the way in. Their row numbering is not the same numbering.
 * Matching on the words is immune to that — the words survive both stores.
 *
 * Progressive shortening, not all-or-nothing: an 18-word headline fragment
 * can straddle a boundary the mapper introduced (a tool chip lifted out of
 * the text, a `…` truncation), so a full-length miss is common and does NOT
 * mean the match is absent. Halving down to a floor recovers those; below the
 * floor an anchor stops discriminating between messages, so we stop rather
 * than return a confident wrong answer.
 *
 * Ties break toward `turnIdxHint` when one is supplied — the hint is not
 * trustworthy enough to select a message on its own (different store), but it
 * is a perfectly good tiebreak among messages that all genuinely contain the
 * matched text.
 */
export function findAnchoredMessageIndex(
  messages: readonly { content: string }[],
  anchor: string | null | undefined,
  turnIdxHint?: number,
): number {
  if (!anchor) return -1;
  const needleFull = normalizeForAnchor(anchor);
  if (needleFull.length < 8) return -1;

  const hay = messages.map((m) => normalizeForAnchor(m.content ?? ''));
  for (let len = needleFull.length; len >= 12; len = Math.floor(len / 2)) {
    const needle = needleFull.slice(0, len).trim();
    if (needle.length < 8) break;
    const found: number[] = [];
    for (let i = 0; i < hay.length; i += 1) if (hay[i].includes(needle)) found.push(i);
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      if (typeof turnIdxHint === 'number' && turnIdxHint >= 0) {
        // Nearest to the hint — a tiebreak, never a selector.
        return found.reduce((a, b) =>
          Math.abs(b - turnIdxHint) < Math.abs(a - turnIdxHint) ? b : a,
        );
      }
      return found[0];
    }
  }
  return -1;
}

type ChatMessageRowProps = {
  message: ChatMessage;
  index: number;
  start: number;
  measureElement: (node: HTMLElement | null) => void;
  /** Already resolved out of `emptyState` by the parent so the row never takes
   *  that inline object literal as a prop (it is rebuilt on every parent render). */
  fallbackIcon: ChatIconComponent;
  fallbackLabel: string;
  iconForRole?: ChatConversationProps['iconForRole'];
  labelForRole?: ChatConversationProps['labelForRole'];
  renderAvatar?: ChatConversationProps['renderAvatar'];
  renderToolChip?: ChatConversationProps['renderToolChip'];
  renderToolCard?: ChatConversationProps['renderToolCard'];
  renderReport?: ChatConversationProps['renderReport'];
  harnessSlug?: ChatConversationProps['harnessSlug'];
  onWorkRefActivate?: ChatConversationProps['onWorkRefActivate'];
  /** True while this row may still be STREAMING (the last row, parent busy).
   *  Only meaningful to the empty-turn notice below: an assistant row that is
   *  legitimately mid-flight has no text yet and must not be called a failure. */
  pending?: boolean;
  /** This is the message a `focusAnchor` resolved to. Marks it visually — a
   *  transcript scrolled to an arbitrary mid-list position, with nothing
   *  saying which row is the answer, reads as a scroll bug rather than a
   *  result. A stable boolean, false for every row but one, so the memo above
   *  still holds across a keystroke. */
  focused?: boolean;
};

/**
 * One transcript row — memoized. THE typing-lag boundary.
 *
 * WI-6502 [owner 2026-07-27, verbatim] "typing into the chat boxes is very
 * laggy." The composer's draft lives in OperatorChat's `input` state and arrives
 * in ChatConversation as `inputValue`, so every keystroke re-renders it. Before
 * this, that re-rendered the whole row body for every message on screen: avatar,
 * role label, tool cards, and one `renderToolChip` per tool — each of which
 * eagerly `JSON.stringify`s its full payload for a tooltip only visible on hover.
 * `ChatMessageContent` alone was memoized (the earlier markdown pass), which is
 * exactly why that guard kept passing while typing stayed slow.
 *
 * Measured in a driven Tauri webview against :3270, on the owner's own surface:
 * ~70ms of main-thread block per keystroke, with 28 chip tooltips rebuilt per
 * keystroke and ZERO network requests and ZERO forced reflows. Key auto-repeat is
 * ~33ms, so any per-keystroke cost above that queues without bound, which is why
 * the owner saw "half a second for each next character" while HOLDING a key
 * rather than a uniform slowness.
 *
 * ⚠ THAT MEASUREMENT IS PRE-FIX AND ITS OBVIOUS READING IS WRONG — do not plan a
 * fix from this comment alone. The 28 stringifies were real but were only ~7.6ms
 * of the ~70ms; the row memo below removed them (re-measured: 2.7x more chips,
 * ~3x fewer stringifies, sync work 4-5ms -> 1ms) and typing stayed slow. WI-6502
 * then eliminated 24 hypotheses by measurement, including React itself: setting
 * the input's value with the native setter and dispatching NO event — so React
 * never learns of the change — still costs 80-89ms, and the same cost reproduces
 * on a plain focused <input> on /adv with no chat mounted at all. The residual is
 * PAINT (it vanishes under `visibility:hidden` on <html> while React still
 * renders and commits), it requires the field to be FOCUSED, and it is flat in
 * draft length. So the memo below is worth keeping and is NOT the remaining cost.
 * Read WI-6502's checkpoint before touching this file for performance; it lists
 * every eliminated hypothesis so they are not re-run.
 *
 * A memo is only as good as its props' identity, so every callback here must be
 * stable at its source (see OperatorChat's module-level `labelForRole`). They are
 * kept as REAL memo deps rather than latest-ref shims: a latest-ref would freeze
 * the row against a genuine change, e.g. a new `rosterEntry` behind
 * `renderAvatar`.
 *
 * ⚠ That last sentence used to end "`ChatConversation.memo.test.tsx` guards both
 * directions" — and it did not: nothing in that file varied `renderAvatar` at
 * all, so the claim was vacuous for the one prop it named. WI-6547 was filed
 * against this exact path on the strength of it. The guard now genuinely exists —
 * see that file's "a late-arriving renderAvatar reaches ALREADY-PAINTED rows"
 * block, which pins BOTH directions plus a latest-ref control that must stay
 * frozen. Do not re-word this to cite a test without opening it first.
 */
const ChatMessageRow = memo(function ChatMessageRow({
  message: m,
  index,
  start,
  measureElement,
  fallbackIcon,
  fallbackLabel,
  iconForRole,
  labelForRole,
  renderAvatar,
  renderToolChip,
  renderToolCard,
  renderReport,
  harnessSlug,
  onWorkRefActivate,
  pending,
  focused,
}: ChatMessageRowProps) {
  // WI-4731: a message stamped with the speaking agent gets that
  // agent's canonical mark (the LeftSidebar tab iconography:
  // mug → Coffee, kettle → Thermometer, papercup → CupSoda) so a
  // Mug/Kettle message never wears the Papercup logo. Unstamped
  // messages keep the pane's own icon (iconForRole / empty-state).
  const AgentIcon = m.agent ? AGENT_MARKS[m.agent] : undefined;
  const Icon = AgentIcon ?? (iconForRole ? iconForRole(m.role) : fallbackIcon);
  const label = labelForRole?.(m.role) ?? (m.role === 'user' ? 'You' : fallbackLabel);
  const showRoleLabel = label.trim().length > 0;
  const avatarOverride = renderAvatar?.(m);

  // Each tool is offered to renderToolCard FIRST (below content).
  // If it returns a card, we DON'T also render the same tool as
  // a chip above — cards subsume chip representation. Otherwise
  // we fall through to renderToolChip (above content).
  const cardSlots: Array<{ index: number; node: ReactNode }> = [];
  const chipTools: Array<{ tool: ChatToolCall; index: number }> = [];
  m.tools?.forEach((t, ti) => {
    const card = renderToolCard?.(t, m, ti);
    if (card) cardSlots.push({ index: ti, node: card });
    else if (renderToolChip) chipTools.push({ tool: t, index: ti });
  });
  // deterministic-status-cards P-003: a status CARD (curator's
  // report) renders IN PLACE OF the plain-text content — the card
  // is the structured form of the same lines. Null ⇒ text as normal.
  const reportCard = renderReport?.(m);

  return (
    <div
      data-index={index}
      data-message-index={index}
      data-focus-match={focused ? 'true' : undefined}
      ref={measureElement}
      className={`oracle-msg oracle-msg-${m.role}${focused ? ' oracle-msg--focus-match' : ''}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${start}px)`,
      }}
    >
      {avatarOverride ? (
        avatarOverride
      ) : (
        <span className="oracle-msg-avatar" aria-hidden="true">
          <Icon className="oracle-msg-icon" />
        </span>
      )}
      <div className="oracle-msg-stack">
        {showRoleLabel && <div className="oracle-msg-role">{label}</div>}
        {chipTools.map(({ tool, index: ti }) => (renderToolChip ? renderToolChip(tool, ti) : null))}
        {reportCard
          ? <div className="oracle-msg-report">{reportCard}</div>
          : m.content && (
            <div className="oracle-msg-content">
              <ChatMessageContent
                content={m.content}
                harnessSlug={harnessSlug}
                planSlug={m.planSlug}
                onWorkRefActivate={onWorkRefActivate}
              />
            </div>
          )}
        {cardSlots.map(({ index: ci, node }) => (
          <div key={`tool-card-${ci}`}>{node}</div>
        ))}
        {/* hud-open-destinations-and-true-counts-2026-07-27 P-005 — an assistant
            turn that produced NOTHING must say so.

            The branch above renders content only `m.content &&`, so an assistant
            turn persisted with empty text rendered as literally nothing. That is
            not hypothetical: on 2026-07-27 the owner asked "whats the status of
            our pots?"; `pot:list` returned ok (19,400 bytes, twice) and
            `operator_turns` seq 16456 — the answer turn — persisted with empty
            text. Nothing rendered, ambient system cards filled the space, and it
            read as "the pot list did not return any results". The chat had no
            way to express "the model returned no answer", so a real failure was
            indistinguishable from absence.

            Deliberately narrow, because a false positive here would be noise on
            every turn: assistant role only, no text, no report, no tool cards,
            and NOT still streaming (`pending`). Tool CHIPS are allowed to be
            present — a turn that called tools and then said nothing is exactly
            the reported failure, not an exception to it. */}
        {m.role === 'assistant' &&
          !pending &&
          !reportCard &&
          cardSlots.length === 0 &&
          !m.content?.trim() && (
            <div className="oracle-msg-content oracle-msg-empty" role="status">
              <em>
                {/* Keyed off `m.tools`, NOT `chipTools`: the turn either ran
                    tools or it did not, and whether this surface happens to
                    render chips for them (chipTools is empty unless the caller
                    passes renderToolChip) is a presentation detail that must
                    not change what we tell the user happened. */}
                {(m.tools?.length ?? 0) > 0
                  ? 'Papercup ran its tools but returned no answer for this turn.'
                  : 'Papercup returned no answer for this turn.'}{' '}
                Ask again to retry.
              </em>
            </div>
          )}
        {/* session-chat-popup-timestamps-and-modes-2026-08-09 P-001 — the
            per-message time, under the bubble and inheriting the stack's own
            edge alignment (left for the agent, right for you).

            Self-gating: it renders nothing unless THIS message carries a `ts`,
            so a feed that does not stamp its messages (the operator's own
            conversation store, every card surface) is unchanged with no
            per-caller opt-in flag to thread.

            ⚠ It subscribes to the shared chat clock INTERNALLY. Do not "simplify"
            that into a prop on this row — see message-timestamp.tsx's header:
            this row is the WI-6502 typing-lag memo boundary, and a ticking prop
            would re-render every visible row's full body every 15s. */}
        <MessageTimestamp ts={m.ts} />
      </div>
    </div>
  );
});

export function ChatConversation(props: ChatConversationProps) {
  const {
    messages,
    busy,
    peerThinking,
    error,
    emptyState,
    iconForRole,
    labelForRole,
    renderToolChip,
    renderToolCard,
    renderReport,
    renderAvatar,
    harnessSlug,
    onWorkRefActivate,
    inputValue,
    onInputChange,
    onSubmit,
    inputPlaceholder = 'Send a message…',
    inputIcon,
    sendLabel = 'Send',
    busyLabel = '…',
    composerExtra,
    banner,
    transcriptTail,
    thinkingLabel,
    hideInput,
    bodyClassName,
    bodyStyle,
    footer,
    onLoadEarlier,
    hasMoreEarlier,
    loadingEarlier,
    focusAnchor,
    focusIndex: focusIndexProp,
    focusNonce,
    onTopMessageIndex,
  } = props;

  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const transcriptTailRef = useRef<HTMLDivElement | null>(null);
  const hasTranscriptTail = transcriptTail != null;

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

  // (The scroll-pinning effect lives BELOW the virtualizer declaration —
  // it pins via virtualizer.scrollToIndex, which doesn't exist yet here.)

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
  const requestEarlier = useCallback(() => {
    if (!onLoadEarlier || !hasMoreEarlier || fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    onLoadEarlier();
  }, [onLoadEarlier, hasMoreEarlier]);
  useEffect(() => {
    if (!requestEarlier) return;
    const el = topSentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        if (!userScrolledRef.current) continue;
        requestEarlier();
      }
    }, { root: scrollerRef.current ?? null, rootMargin: '120px 0px 0px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [requestEarlier]);

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
  // WI-6502: these two MUST keep a stable identity across renders. virtual-core
  // memoizes `getMeasurementOptions` on `getItemKey` by IDENTITY; a fresh arrow
  // each render resets `pendingMeasuredCacheIndexes`, which drops `min` to 0 and
  // re-walks the measurement loop over ALL `count` items — and makes
  // `getVirtualItems()` return a NEW array every render, which would defeat the
  // <ChatMessageRow> memo below no matter how stable its own props were. Cheap
  // today (the session popup pages 10 turns) and O(n) per keystroke the moment
  // that page size grows.
  const estimateSize = useCallback(() => 64, []); // typical bubble height; corrected by measureElement
  // Key by stable message identity when possible. Today ChatMessage is
  // {role, content, tools?} with no id; fall back to (role|content-prefix|index)
  // — index alone breaks cache on prepend (every item shifts), but combining
  // it with role + a content prefix keeps the cache hot for items the
  // user is actually looking at across a prepend.
  const getItemKey = useCallback(
    (i: number) => {
      const m = messages[i];
      if (!m) return i;
      return `${m.role}::${m.content.slice(0, 40)}::${i}`;
    },
    [messages],
  );
  const getScrollElement = useCallback(() => scrollerRef.current, []);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement,
    estimateSize,
    overscan: 8,
    getItemKey,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // ── Scroll pinning: "follow the tail" (WI-4692) ────────────────────────
  // The transcript FOLLOWS new output while the user sits at the bottom,
  // exactly like a terminal: follow starts ON; a genuine user scroll away
  // from the bottom turns it off; scrolling back to the bottom turns it
  // back on. While following, EVERY message change re-pins.
  //
  // Why not endRef.scrollIntoView({ behavior: 'smooth' }) (the pre-revival
  // code): on a virtualized transcript the smooth animation tweens across
  // thousands of px of *estimated* rows, measureElement corrections resize
  // the container mid-flight, and the view strands mid-history (observed
  // live: parked at ~29-50% after every hydration, so streamed replies
  // rendered off-screen and the chat looked dead). And a single scrollTop
  // write is not enough either: rows are estimated at 64px and measure
  // ~2x that, so each pin reveals more unmeasured rows below and the
  // bottom keeps moving. The pin is therefore virtualizer.scrollToIndex
  // (measurement-aware) + a bounded rAF settle loop that re-asserts the
  // bottom until estimates converge.
  //
  // Follow-state tracking distinguishes USER scrolls from the pin loop's
  // own programmatic writes via `programmaticScrollRef` (set before every
  // programmatic scrollTop write, consumed by the scroll listener).
  const followRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const pinFramesRef = useRef(0);
  const pinLoopActiveRef = useRef(false);
  const pinToBottom = useCallback(() => {
    pinFramesRef.current = 45; // ~750ms frame budget for measurement convergence
    if (pinLoopActiveRef.current) return; // already looping — budget extended
    pinLoopActiveRef.current = true;
    const step = () => {
      const sc = scrollerRef.current;
      if (!sc || pinFramesRef.current <= 0 || !followRef.current) {
        pinLoopActiveRef.current = false;
        return;
      }
      pinFramesRef.current -= 1;
      const target = sc.scrollHeight - sc.clientHeight;
      if (Math.abs(sc.scrollTop - target) > 1) {
        programmaticScrollRef.current = true;
        sc.scrollTop = target;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  // Pending cards arrive through their own state-channel subscription, so
  // their mount/queue changes do not necessarily change `messages` or `busy`
  // (the dependencies that drive the ordinary transcript tail pin below).
  // Observe this one tail slot directly: while the reader is following the
  // conversation, a newly-visible or resized card stays in view; while they
  // are reading scrollback, it never steals their position.
  useEffect(() => {
    const node = transcriptTailRef.current;
    if (!node) return;

    if (followRef.current) pinToBottom();
    if (typeof ResizeObserver === 'undefined') return;

    let lastHeight = node.getBoundingClientRect().height;
    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height ?? node.getBoundingClientRect().height;
      if (Math.abs(nextHeight - lastHeight) < 1) return;
      lastHeight = nextHeight;
      if (followRef.current) pinToBottom();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasTranscriptTail, pinToBottom]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }
      // A genuine user scroll: follow iff they are at (or near) the bottom.
      followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ── Which message is at the top of the viewport (P-005) ────────────────
  // Deliberately a SEPARATE listener from the follow-the-tail one above, which
  // returns early on a programmatic scroll. A rail-driven jump IS programmatic,
  // and it is exactly the moment the rail's own "you are here" row must move —
  // reusing that handler would make the feature silently not update on its own
  // click.
  //
  // Measured off the rendered rows' `data-message-index` rather than the
  // virtualizer's `start` offsets: the virtual container is a SIBLING of the
  // load-earlier block, so virtual coordinates and `scrollTop` differ by
  // whatever that block occupies. Rects need no such correction and cannot go
  // stale against it.
  const lastTopIndexRef = useRef<number>(-2);
  const reportTopIndex = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !onTopMessageIndex) return;
    const probe = el.getBoundingClientRect().top + TOP_INDEX_PROBE_PX;
    // Selection rule (incl. the above-the-first-row clamp) lives in
    // session-turn-index.ts so it is testable without a layout engine; this
    // callback's job is only to READ the geometry and feed it in.
    const best = pickTopMessageIndex(
      Array.from(el.querySelectorAll<HTMLElement>('[data-message-index]'), (node) => ({
        index: Number(node.dataset.messageIndex),
        top: node.getBoundingClientRect().top,
      })),
      probe,
    );
    if (best === lastTopIndexRef.current) return;
    lastTopIndexRef.current = best;
    onTopMessageIndex(best);
  }, [onTopMessageIndex]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !onTopMessageIndex) return;
    el.addEventListener('scroll', reportTopIndex, { passive: true });
    return () => el.removeEventListener('scroll', reportTopIndex);
  }, [onTopMessageIndex, reportTopIndex]);

  // Also on every commit that changes what is mounted: a streaming session grows
  // the transcript under a stationary reader, and rows measuring after mount
  // move everything below them. Neither fires a scroll event.
  useEffect(() => {
    reportTopIndex();
  }, [reportTopIndex, virtualItems, messages]);

  // ── Focus scroll: open ON a message instead of at the tail ─────────────
  // HUD search, owner ask 2026-08-02: clicking a search result must land on
  // the turn that matched.
  //
  // Three things make this more than one scrollToIndex call, and all three are
  // the SAME problems the tail pin above already solved — so this deliberately
  // reuses its shape rather than inventing a second scrolling idiom:
  //
  //  1. The target does not exist yet. The modal mounts with zero messages and
  //     the transcript streams in over the following second, so the anchor
  //     resolves on a LATER commit. Hence: attempt on every messages change
  //     until it lands, then stop (`focusedForRef`).
  //  2. Rows are estimated at 64px and measure ~2x, so one scroll lands short
  //     and the target drifts as rows above it measure. Hence the same bounded
  //     rAF re-assert loop, but re-asserting an INDEX rather than the bottom.
  //  3. The tail pin would immediately undo it: it re-pins on every message
  //     change while `followRef` is true, and a live session streams. Turning
  //     follow OFF is what suspends it — the same switch a user scrolling away
  //     flips — so this effect must be declared ABOVE it to win the commit
  //     where both fire.
  //
  // Re-focusing is keyed on the anchor STRING: a second search hit in the same
  // session re-scrolls, an unchanged anchor never re-steals the user's scroll.
  const [focusIndex, setFocusIndex] = useState(-1);
  const focusedForRef = useRef<string | null>(null);
  const focusFramesRef = useRef(0);
  // Each click owns a generation. A newer T# request invalidates the old rAF
  // closure immediately; otherwise an in-flight correction loop keeps
  // scrolling its OLD index while the new request is silently discarded.
  const focusGenerationRef = useRef(0);
  const exactIndex = typeof focusIndexProp === 'number' && focusIndexProp >= 0 ? focusIndexProp : -1;
  // One key for "which focus request is this", so a change in ANY input
  // re-focuses and an unchanged request never re-steals the user's scroll.
  // `focusNonce` is what lets a caller re-request the SAME index — the turn
  // rail's second click on the row you are already parked on (P-003).
  const nonceSuffix = focusNonce == null ? '' : `@${focusNonce}`;
  const focusKey = exactIndex >= 0 ? `#${exactIndex}${nonceSuffix}` : (focusAnchor ?? null);
  useEffect(() => {
    if (!focusKey) {
      focusGenerationRef.current += 1;
      programmaticScrollRef.current = false;
      focusedForRef.current = null;
      setFocusIndex(-1);
      return;
    }
    if (focusedForRef.current === focusKey) return;
    if (messages.length === 0) return;
    // Exact first (the server named this turn in its own store); text only as
    // the fallback for the cases the anchor event does not reach.
    const idx = exactIndex >= 0 && exactIndex < messages.length
      ? exactIndex
      : findAnchoredMessageIndex(messages, focusAnchor);
    if (idx < 0) return; // transcript may still be streaming — try again next commit
    focusedForRef.current = focusKey;
    setFocusIndex(idx);
    followRef.current = false; // suspend the tail pin (see 3 above)
    focusFramesRef.current = 45; // same ~750ms convergence budget as pinToBottom
    const generation = ++focusGenerationRef.current;
    const step = () => {
      if (
        generation !== focusGenerationRef.current
        || !scrollerRef.current
        || focusFramesRef.current <= 0
        || followRef.current
      ) {
        if (generation === focusGenerationRef.current) programmaticScrollRef.current = false;
        return;
      }
      focusFramesRef.current -= 1;
      // scrollToIndex emits a scroll event. Mark it before the call so the
      // transcript's user-scroll listener cannot read a near-bottom target as
      // a request to resume tail-follow and cancel the other 44 correction
      // frames. Clear on the next frame even when the virtualizer made no move,
      // so a later real user scroll is never swallowed by a stale boolean.
      programmaticScrollRef.current = true;
      virtualizer.scrollToIndex(idx, { align: 'start' });
      requestAnimationFrame(() => {
        if (generation === focusGenerationRef.current) programmaticScrollRef.current = false;
        step();
      });
    };
    requestAnimationFrame(step);
  }, [focusKey, exactIndex, focusAnchor, messages, virtualizer]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) {
      lastFirstKeyRef.current = firstKey;
      lastLastKeyRef.current = lastKey;
      return;
    }
    const isPrepend = preserveScrollHeightRef.current !== null;
    if (followRef.current) {
      // Following the tail — pin, whatever just changed (append, stream
      // delta, busy flip, or a hydration replace that swapped the whole
      // list under us: the sessionStorage paint-cache → the PG 200-turn
      // page has an identical tail but 100 turns more history above, so
      // key-diffing alone misreads it as a "prepend").
      const last = messages.length - 1;
      if (last >= 0) {
        virtualizer.scrollToIndex(last, { align: 'end' });
        pinToBottom();
      }
      preserveScrollHeightRef.current = null;
    } else if (isPrepend) {
      // Reading scrollback while older history lands above → preserve the
      // reading position.
      const delta = el.scrollHeight - preserveScrollHeightRef.current!;
      programmaticScrollRef.current = true;
      el.scrollTop = el.scrollTop + delta;
      preserveScrollHeightRef.current = null;
    }
    lastFirstKeyRef.current = firstKey;
    lastLastKeyRef.current = lastKey;
  }, [messages, busy, firstKey, lastKey, virtualizer, pinToBottom]);

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
            {hasMoreEarlier && (
              <div className="oracle-load-earlier" aria-live="polite">
                <button
                  type="button"
                  className="pc-button oracle-load-earlier-button"
                  onClick={requestEarlier}
                  disabled={loadingEarlier}
                >
                  {loadingEarlier ? 'Loading earlier…' : 'Load earlier messages'}
                </button>
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
              return (
                <ChatMessageRow
                  key={vi.key}
                  message={m}
                  index={vi.index}
                  start={vi.start}
                  measureElement={virtualizer.measureElement}
                  fallbackIcon={emptyState.icon}
                  fallbackLabel={emptyState.title}
                  iconForRole={iconForRole}
                  labelForRole={labelForRole}
                  renderAvatar={renderAvatar}
                  renderToolChip={renderToolChip}
                  renderToolCard={renderToolCard}
                  renderReport={renderReport}
                  harnessSlug={harnessSlug}
                  onWorkRefActivate={onWorkRefActivate}
                  /* Only the LAST row can still be streaming, so only it is
                     exempt from the empty-turn notice (P-005). */
                  pending={busy && vi.index === messages.length - 1}
                  focused={vi.index === focusIndex}
                />
              );
            })}
          </div>
        )}
        {hasTranscriptTail ? (
          <div ref={transcriptTailRef} className="oracle-transcript-tail">
            {transcriptTail}
          </div>
        ) : null}
        {(busy || peerThinking) && (
          <div className="oracle-thinking-row" aria-live="polite">
            <span>
              {busy
                ? `${thinkingLabelText} is thinking`
                : `${thinkingLabelText} is answering in another window`}
            </span>
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
              onKeyDown={(e) => {
                // ↑ in the EMPTY composer recalls the last sent message
                // (Discord ↑-to-edit analog — see lastUserMessageText).
                if (e.key !== 'ArrowUp' || inputValue !== '' || busy) return;
                const last = lastUserMessageText(messages);
                if (!last) return;
                e.preventDefault();
                onInputChange(last);
              }}
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
      {footer}
    </>
  );
}
