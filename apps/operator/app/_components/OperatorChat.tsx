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

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Lightbulb, UserRound, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { parseAsString, useQueryState } from 'nuqs';
import {
  ChatConversation,
  type ChatIconComponent,
  type ChatMessage,
  type ChatToolCall,
} from './chat/ChatConversation';
import type { WorkRefKind } from './chat/parse-work-refs';
import {
  CHAT_PLAN_POPUP_PARAM,
  CHAT_WORK_ITEM_POPUP_PARAM,
  encodeScopedRef,
} from './chat/chat-ref-popup-params';
import { CardAnswerError } from './OperatorConversationProvider';
import { PendingCardsBar } from './chat/PendingCardsBar';
import { renderCard } from '@/lib/chat-cards';
import { CHAT_SEED_EVENT, consumePendingChatSeed, readChatDraft, writeChatDraft } from './inbox/chat-seed';
import { OperatorLogoMark } from './OperatorLogoMark';
import { Tooltip } from '../harness/Tooltip';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import { ReportBlockCard } from './chat/ReportBlockCard';
import { useCurrentUserIdentity } from './use-current-user';

interface Props {
  /** Conversation messages, oldest first. */
  messages: ChatMessage[];
  /** True while the operator is composing/streaming. */
  busy: boolean;
  /** Peer-window generation in flight (multi-window P-009) — thinking row only. */
  peerBusy?: boolean;
  /** True while in passive mode — input still accepts text; no auto-replies. */
  passive: boolean;
  /** Disable the composer when the counterparty cannot receive a message. */
  composerDisabled?: boolean;
  /** Copy shown when the composer is disabled (for example, relaunch guidance). */
  composerDisabledMessage?: string;
  /** Override the default global-operator empty-state guidance. */
  emptyStateBody?: string;
  /**
   * The workspace-wide Scan/Review/Summarize starters belong only to the
   * global Papercup thread. Scoped Papercup callers set this false while still
   * retaining the Papercup identity and full shared chat renderer.
   */
  showQuickDraftPrompts?: boolean;
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
  /** Open the transcript ON the message containing this text instead of at the
   *  tail — forwarded verbatim to ChatConversation (HUD search → the matched
   *  turn). Same passthrough pattern as the infinite-scroll props above. */
  focusAnchor?: string | null;
  /** Exact message index to focus, when the caller has one (the stream's own
   *  `anchor` event). Wins over `focusAnchor`. Forwarded verbatim. */
  focusIndex?: number | null;

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
    declined?: boolean;
  }) => Promise<void> | void;

  /**
   * Active conversation id. When provided alongside `workspaceId`,
   * the chat renders a PendingCardsBar that subscribes to the
   * state-snapshot SSE stream and shows ctx.askUser cards above the
   * composer. Omit either to disable the new-card surface.
   */
  conversationId?: string;
  workspaceId?: string;

  /**
   * Display name substituted into the default empty-state title + composer
   * placeholder copy (both hardcode "Papercup" otherwise). Override when this
   * conversation ISN'T with Papercup — e.g. the direct session-chat popup
   * (owner-inbox-single-pane-2026-07-17 P-007, SessionChatModal) reuses this
   * same component for a live chat with an arbitrary su agent. The props
   * audit that generalized this component for that reuse (D-005) found every
   * OTHER prop already generic (messages/busy/onSend et al.) — this was the
   * one hardcoded bit of copy standing in the way of a second caller.
   */
  agentName?: string;

  /**
   * deterministic-status-cards-2026-07-17 P-003: drill-in router for a curator
   * status card's row `ref`. Supplied by the PARENT (OperatorChatSidebar), which
   * owns the nuqs inbox navigation — so this component stays provider-free +
   * unit-testable. Omit ⇒ card rows render without an Open action (e.g. reuse in
   * a context with no inbox to navigate to).
   */
  onDrillIn?: (ref: string) => void;

  /**
   * Openability predicate for a card ref, forwarded to ReportBlockCard. Pure
   * passthrough (same pattern as onDrillIn) — the CALLER owns the resolver and
   * the live items, so it alone can say whether a ref opens anything. Omit ⇒
   * every ref keeps rendering an Open action.
   */
  canDrillIn?: (ref: string) => boolean;

  /**
   * Per-message avatar override, forwarded straight through to
   * ChatConversation (gui-chat-session-controls-2026-07-25 P-012). Used by
   * SessionChatModal to swap the default agent-kind icon for a roster-driven
   * identity chip (handle + fleet colour + leader/member marker). Omit to
   * keep the default icon avatar — this component adds no behavior of its
   * own around it, it's a pure passthrough (same pattern as onDrillIn).
   */
  renderAvatar?: (msg: ChatMessage) => ReactNode | null | undefined;

  /**
   * The PANE's own mark — the icon a message wears when nothing more specific
   * applies, and the icon of the empty state (ChatConversation derives its
   * `fallbackIcon` from `emptyState.icon`).
   *
   * WI-6503 [owner 2026-07-27, verbatim] "remove the papercup icon from the
   * chatbox for the chatboces where the conversation isnt with papercup." This
   * used to be the CONSTANT `OperatorLogoMark` — the Papercup brand cup — so a
   * SessionChatModal conversation with an arbitrary su agent branded every
   * unstamped message as Papercup (measured live: 11 of 12 rendered avatars).
   * The `extra` starting-prompts panel below was already gated for exactly this
   * reason; the icon on the same object was not.
   *
   * It is a PROP rather than an internal `agentName === 'Papercup'` test on
   * purpose: the item requires resolving from the conversation's actual
   * participant, never a title match. The caller knows its counterparty;
   * this component does not. Omit ⇒ the Papercup mark, which is correct for
   * the one pane whose counterparty really is Papercup (OperatorChatSidebar).
   */
  paneIcon?: ChatIconComponent;

  /**
   * Optional informational row rendered under the composer
   * (gui-chat-session-controls-2026-07-25 P-007). Pure passthrough to
   * ChatConversation's `footer` prop — same pattern as renderAvatar. Omit
   * to render nothing.
   */
  footer?: ReactNode;

  /**
   * Harness scoping this conversation's WI-/EI-/F- ref pills
   * (chat-ref-pills-2026-07-26 P-008) — forwarded to ChatConversation for
   * live pill hydration (P-005) AND used by this component's OWN
   * onWorkRefActivate wiring (below) to scope the WorkItemPopupModal query.
   * Omit when the caller has no single-harness context (e.g. the
   * cross-workspace operator sidebar) — pills still render, just static
   * (no live state, no click destination), same graceful degrade
   * ChatConversation already documents for a missing harnessSlug.
   */
  harnessSlug?: string;
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
  messages, busy, peerBusy, passive, onSend, onGenerateIdeas, banner, error,
  onLoadEarlier, hasMoreEarlier, loadingEarlier, focusAnchor, focusIndex, onAnswerChoice,
  conversationId, workspaceId, agentName = 'Papercup', onDrillIn, canDrillIn,
  renderAvatar, paneIcon, footer, harnessSlug, composerDisabled = false,
  composerDisabledMessage, emptyStateBody,
  showQuickDraftPrompts = true,
}: Props) {
  // chat-ref-pills-2026-07-26 P-008 / D-002: this is the seam where a
  // WI-/EI-/F-/P- ref pill's click actually DOES something. ChatConversation
  // (P-004) only exposes the plain `onWorkRefActivate` passthrough hook —
  // this component wires it by WRITING the "which item is open" nuqs params.
  // It does not render them: `chat/ChatRefPopupHost` owns the single mount at
  // the router root (WI-6601). Distinct param names from PlansPane's own
  // `pplan` (its Plans-pane popup and this chat-triggered one can be open
  // independently without fighting over the same URL key).
  //
  // Only the SETTERS are bound — reading these here would be the per-instance
  // render this component no longer does.
  const [, setOpenWorkItem] = useQueryState(CHAT_WORK_ITEM_POPUP_PARAM, parseAsString);
  const [, setOpenChatPlan] = useQueryState(CHAT_PLAN_POPUP_PARAM, parseAsString);

  const handleWorkRefActivate = useCallback(
    (ref: { id: string; kind: WorkRefKind; planSlug?: string | null }) => {
      if (ref.kind === 'plan-item') {
        // A P- ref opens the EXISTING PlanPopupModal (D-001) — do not build a
        // second plan popup. No message plan_slug context ⇒ nothing safe to
        // open (P-006's "no plan context" stance, one layer over).
        //
        // Carry THIS conversation's harness in the value: `plans:get` is
        // harness-scoped, and the single root-level renderer can only fall
        // back to the surface's `?slug` — which is the wrong harness whenever
        // a session chat for harness X is open over a board scoped to Y.
        if (ref.planSlug) void setOpenChatPlan(encodeScopedRef(harnessSlug, ref.planSlug));
        return;
      }
      // A WI-/EI-/F- ref needs a harness to scope workItems.detail — with
      // none, there is nothing safe to ENCODE (mirrors HydratedWorkRefPill's
      // own hydration gate one layer down).
      if (!harnessSlug) return;
      void setOpenWorkItem(encodeScopedRef(harnessSlug, ref.id));
    },
    [harnessSlug, setOpenChatPlan, setOpenWorkItem],
  );

  // WI-6503 [owner 2026-07-27, verbatim follow-up] "the chat box should disaply
  // the users profile icon in their chat, not the papercup icon."
  //
  // The user's OWN messages used to fall through to the pane mark — which is
  // the Papercup cup in the sidebar, and the counterparty AGENT's mark in
  // SessionChatModal. Either way the owner's own turns wore someone else's
  // branding. The `paneIcon` prop fixed only half the item (the pane no longer
  // brands a non-papercup conversation as Papercup); this is the other half,
  // and it is a SUBSTITUTION — rendering nothing would satisfy the item's
  // original title and is explicitly NOT what was asked for.
  //
  // It lives HERE rather than at each call site on purpose: OperatorChat is the
  // component every chat surface shares (OperatorChatSidebar + SessionChatModal),
  // so one implementation covers "every chat surface sharing the component"
  // without either caller having to remember. A caller's own `renderAvatar`
  // still wins — SessionChatModal's roster identity chip is consulted first and
  // only declines (returns null) for non-assistant turns.
  const currentUser = useCurrentUserIdentity();
  const renderAvatarWithUser = useCallback(
    (m: ChatMessage): ReactNode | null | undefined => {
      const override = renderAvatar?.(m);
      if (override) return override;
      if (m.role !== 'user') return override;
      // Identity not resolved yet (or unresolvable) ⇒ a neutral person glyph.
      // NEVER the papercup mark: that fallback is the reported bug.
      return (
        <span className="oracle-msg-avatar oracle-msg-avatar--user-identity">
          <span className="pc-sr-only">{currentUser ? `${currentUser.displayName} (you)` : 'You'}</span>
          {currentUser ? (
            <span aria-hidden="true">{currentUser.initial}</span>
          ) : (
            <UserRound className="oracle-msg-icon" aria-hidden="true" />
          )}
        </span>
      );
    },
    [renderAvatar, currentUser],
  );

  // Inbox "Discuss" hands a drafted message to this composer (chat-seed.ts):
  // consume a staged seed on mount (the usual path — the chat body was
  // unmounted while the inbox view showed), and listen for the live event in
  // case a seed arrives while mounted. Consume-once either way. A fresh seed
  // wins over a persisted draft; otherwise the draft survives REMOUNTS (body
  // swap to the inbox/pot view and back, reconnect re-keys) via the
  // per-workspace sessionStorage mirror kept in sync below.
  const [input, setInput] = useState<string>(() => consumePendingChatSeed() ?? readChatDraft() ?? '');
  useEffect(() => {
    writeChatDraft(input);
  }, [input]);
  useEffect(() => {
    const onSeed = () => {
      const t = consumePendingChatSeed();
      if (t) setInput(t);
    };
    window.addEventListener(CHAT_SEED_EVENT, onSeed);
    return () => window.removeEventListener(CHAT_SEED_EVENT, onSeed);
  }, []);

  const submit = useCallback(() => {
    if (composerDisabled) return;
    const text = input.trim();
    if (!text) return;
    setInput('');
    onSend(text);
  }, [composerDisabled, input, onSend]);

  const unavailableCopy =
    composerDisabledMessage ??
    'This session cannot receive messages. Relaunch or resume the agent to continue.';

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
          const { picks, declined } = payload as {
            picks: Array<{ option_id: string; label: string }>;
            declined?: boolean;
          };
          // WI-5175 (owner repro 2026-07-17: "I clicked an option and nothing
          // happened"). BOTH guards below used to `return` / `console.warn`
          // silently, so an unanswerable card was indistinguishable from a dead
          // button. A click ALWAYS produces feedback now.
          if (!onAnswerChoice) {
            toast.error("This card isn't interactive here.");
            return;
          }
          if (typeof msg.seq !== 'number') {
            // The message hasn't been assigned its persisted seq yet — the
            // answer has nowhere to land. Transient: it resolves once the turn
            // persists, so say "not yet", not "broken".
            toast.error('Still saving this message — try again in a moment.');
            return;
          }
          // Fire-and-forget — server-side atomicity guarantees the
          // assistant-answered + user-turn rows land together. The
          // live-tail picks them up; we don't optimistically dispatch.
          void Promise.resolve(
            onAnswerChoice({
              assistantSeq: msg.seq,
              toolIndex: ti,
              picks,
              ...(declined ? { declined: true } : {}),
            }),
          ).catch((err: unknown) => {
            const reason = err instanceof CardAnswerError ? err.reason : 'failed';
            const message =
              err instanceof Error ? err.message : 'Could not submit your answer.';
            // already_answered reconciles the card to the server's answer, so
            // it's informational — the user sees the truth appear. The rest are
            // real failures worth an error toast.
            if (reason === 'already_answered') toast.info(message);
            else toast.error(message);
            // eslint-disable-next-line no-console
            console.warn('[operator-chat] answerChoice failed:', err);
          });
        },
      });
    },
    [onAnswerChoice],
  );

  // deterministic-status-cards-2026-07-17 P-003: the CURATOR's deterministic
  // status turns (ChatMessage.report, mapped only for source:'system') render
  // as a structured card here — in place of their flattened markdown lines —
  // with each row's drill-in ref as a real action (routed by the parent's
  // `onDrillIn`, which owns the nuqs inbox nav — keeping this component
  // provider-free + unit-testable). The operator's OWN <report> still routes to
  // the Inbox (its turns never set ChatMessage.report). Flag-gated: OFF →
  // renderReport returns null → the plain-text content renders byte-identically
  // (the clean kill-switch).
  const curatorCardsOn = useFlag(FLAGS.CURATOR_STATUS_CARDS);
  const renderReport = useCallback(
    (msg: ChatMessage): ReactNode | null => {
      if (!curatorCardsOn || !msg.report) return null;
      return (
        <ReportBlockCard
          report={msg.report}
          onDrillIn={onDrillIn}
          canDrillIn={canDrillIn}
          harnessSlug={harnessSlug}
          planSlug={msg.planSlug}
          onWorkRefActivate={handleWorkRefActivate}
        />
      );
    },
    [curatorCardsOn, onDrillIn, canDrillIn, harnessSlug, handleWorkRefActivate],
  );

  return (
    <>
      <ChatConversation
        messages={messages}
        busy={busy}
        peerThinking={peerBusy}
        error={error}
        banner={
          <>
            {composerDisabled ? (
              <div className="oracle-session-composer-unavailable" data-testid="session-chat-composer-unavailable" role="status">
                {unavailableCopy}
              </div>
            ) : null}
            {banner}
          </>
        }
        transcriptTail={conversationId && workspaceId ? (
          <PendingCardsBar conversationId={conversationId} workspaceId={workspaceId} />
        ) : null}
        emptyState={{
          title: agentName,
          body: composerDisabled
            ? unavailableCopy
            : passive
            ? 'In passive mode. Type below to wake them.'
            : emptyStateBody ?? 'Tell me what you want to inspect, scan, or unblock.',
          // WI-6503: the pane's own mark, not a hard-coded Papercup cup. See
          // the `paneIcon` prop doc — ChatConversation also derives its
          // per-message `fallbackIcon` from this, so overriding it here is
          // what stops a non-Papercup conversation branding its messages
          // (and its empty state) as Papercup.
          icon: paneIcon ?? OperatorLogoMark,
          // The starting prompts are Papercup-specific ("scan workspaces", "review
          // blockers" — operator-scoped asks). A non-Papercup caller (SessionChatModal
          // messaging an arbitrary su agent) has no business drafting these — they'd be
          // actively misleading there, not just off-brand — so gate the whole panel on
          // agentName rather than showing it unconditionally.
          extra: agentName === 'Papercup' && showQuickDraftPrompts ? (
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
                    disabled={busy || composerDisabled}
                    aria-label={`${title}: ${hint}. Draft this prompt.`}
                  >
                    <span className="op-chat-empty-row-title">{title}</span>
                    <span className="op-chat-empty-row-hint">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : undefined,
        }}
        labelForRole={NO_ROLE_LABEL}
        inputPlaceholder={composerDisabled ? unavailableCopy : passive ? `Type to wake ${agentName}…` : `Reply to ${agentName}…`}
        inputValue={input}
        onInputChange={setInput}
        onSubmit={submit}
        hideInput={composerDisabled}
        composerExtra={
          onGenerateIdeas ? (
            <Tooltip label="Generate ideas" side="top" align="center">
              {/* EI-13109: never reuse the send button's class here — this button
                  renders BEFORE the real submit, so `.oracle-send-button` lookups
                  (and users) mistook it for Send and typed drafts went unsent.
                  Disabled while a draft is pending: with text in the composer the
                  only live affordance is Send, so a click can't discard the draft. */}
              <button
                type="button"
                aria-label="Generate ideas"
                onClick={onGenerateIdeas}
                disabled={busy || composerDisabled || input.trim() !== ''}
                className="pc-button op-chat-ideas-button"
              >
                <Lightbulb aria-hidden="true" className="oracle-send-icon" />
              </button>
            </Tooltip>
          ) : undefined
        }
        renderToolChip={renderOperatorToolChip}
        renderToolCard={renderToolCard}
        renderReport={renderReport}
        renderAvatar={renderAvatarWithUser}
        footer={footer}
        onLoadEarlier={onLoadEarlier}
        hasMoreEarlier={hasMoreEarlier}
        loadingEarlier={loadingEarlier}
        focusAnchor={focusAnchor}
        focusIndex={focusIndex}
        harnessSlug={harnessSlug}
        onWorkRefActivate={handleWorkRefActivate}
      />
      {/* chat-ref-pills-2026-07-26 P-008: the D-002 seam WRITES its
          destinations (`wpop`/`wppop`, above) and deliberately does NOT render
          them. Both popups are mounted exactly once, at the router root, by
          `chat/ChatRefPopupHost` — see WI-6601.

          This component used to mount them itself, gated on its own
          `harnessSlug` so the persistent sidebar instance and a harness-scoped
          one (SessionChatModal via HudView) could not double-render the same
          global param. But the sidebar is a CROSS-HARNESS surface and never
          receives a `harnessSlug`, so on any mount without a resolvable
          `?slug` that gate closed on the only instance present: the param was
          written correctly and nothing rendered it. One renderer at the root
          satisfies both ends — no duplicate, and no surface where the popup
          has no mount at all. */}
    </>
  );
}

// Keep the shared message type exported here so OperatorChatSidebar
// + the (forthcoming) OperatorConversation provider don't need to
// reach across the chat/ folder. Re-export, not redeclare.
export type { ChatMessage as OperatorChatMessage } from './chat/ChatConversation';

/**
 * This pane draws its own role label into the avatar column, so ChatConversation
 * must not draw one. Module-level (not an inline `() => ''`) because it is a prop
 * of every transcript row: a fresh arrow each render re-renders every row on every
 * keystroke, which is half of WI-6502's typing lag. See the <ChatMessageRow> memo.
 */
const NO_ROLE_LABEL = () => '';

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
