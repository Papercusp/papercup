'use client';

/**
 * OperatorConversationProvider — owns the operator's conversation
 * state machine.
 *
 * State sub-machine (active mode):
 *
 *   ready
 *     → user submits          → generating
 *     → 10s silent             → silence_nudge ("Still with me?")
 *   silence_nudge
 *     → user submits           → generating  (silence prompts treated as ordinary turns)
 *     → 30s still silent       → silence_check ("Want me to go into passive mode?")
 *   silence_check
 *     → user says yes          → PASSIVE
 *     → user says no           → ready (resume the thread)
 *     → 30s no response        → quiet_wait     ← still active, just silent
 *   quiet_wait
 *     → ANY user engagement    → generating (operator picks up the thread)
 *   generating → operator turn arrives → ready (timer restarts)
 *
 * Passive mode: silence timers are off entirely. User input still works
 * and triggers a single reply turn. The "want active?" gate is checked
 * in the dispatcher when the operator emits a turn (turns_in_last_2min ≥ 3
 * AND now > sleep_until).
 *
 * Tag dispatch (parsed by lib/operator-converse-tags.parseOperatorTurn):
 *   - <say>       → push assistant message, restart silence timer, end turn
 *   - <set_mode>  → flip mode (sets sessionStorage + fires event)
 *   - <sleep>     → write sleep_until clock, no message
 *
 * The actual model call (`runGeneration`) is a stub here and replaced by
 * a /api/agent-mcp/operator-converse fetch in a later commit. Parser +
 * dispatcher stay the same — only the transport differs.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  parseOperatorTurn,
  readOperatorMessagesFromSession,
  readOperatorModeFromSession,
  readSleepUntilMs,
  writePendingDismissalAtMs,
  sleepTagToEpochMs,
  writeOperatorMessagesToSession,
  writeOperatorModeToSession,
  writeSleepUntilMs,
  type OperatorMode,
} from '@/lib/operator-converse-tags';
import { getVoiceState, subscribeVoiceState } from './voice/voice-mode';
import { useSyncQuery } from '@restart/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import type { ChatMessage, ChatToolCall } from './chat/ChatConversation';

interface OperatorTurnRow {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
  tools?: ChatToolCall[] | null;
}

// ─── State + actions ────────────────────────────────────────────────────

// 2026-05-11 redesign: replaced the 3-rung ladder (silence_nudge →
// silence_check → quiet_wait) with a single-nudge model. The ladder
// generated "Still with me?" spam that annoyed users; the new model:
//   - awaiting_reply: assistant just asked something — arm ONE 30s nudge
//   - nudged: nudge fired — silent forever until user speaks or says "ready"
//   - quiet_wait: legacy state kept only for the "say ready" banner UX
type SubState =
  | 'ready'
  | 'generating'
  | 'awaiting_reply'
  | 'nudged'
  | 'quiet_wait'
  | 'passive_idle';

interface State {
  mode: OperatorMode;
  sub: SubState;
  messages: ChatMessage[];
  error: string | null;
  /**
   * Timestamps of the last N USER turns (assistant turns excluded).
   * Used by the 3-in-2min engagement check that gates `mayAskActiveNow`.
   * The plan calls this "fresh engagement" — operator's own turns
   * obviously don't count as the user engaging.
   */
  recentUserTurnTsMs: number[];
  /**
   * When the operator last asked "Do you want me to go back into active
   * mode?" — set when the parser detects the relevant phrase in a
   * <say>. Paired with `wantActiveDeclinedAtMs` below to enforce the
   * cooldown after the user says no.
   */
  wantActiveAskedAtMs: number;
  /**
   * When the user last declined the "want active?" prompt. Resets the
   * cooldown clock; the operator must wait either 5 fresh user turns
   * OR 10 minutes (whichever comes first) before re-asking.
   */
  wantActiveDeclinedAtMs: number;
  /** User turns recorded since the most recent decline. Resets to 0 on decline. */
  userTurnsSinceDecline: number;
  /**
   * Epoch ms of the most recent user-or-assistant turn. Anchors the
   * silence ladder's 10s nudge window so mounting an old conversation
   * doesn't immediately trigger "Still with me?". G13 of the audit.
   */
  lastTurnAtMs: number;
  /**
   * Consecutive operator-converse failures — drives exponential
   * backoff on the silence-timer so a broken route doesn't spam the
   * sidebar with retries. Reset to 0 on a successful turn. G14.
   */
  consecutiveErrorCount: number;
}

const INITIAL: State = {
  mode: 'active',
  sub: 'ready',
  messages: [],
  error: null,
  recentUserTurnTsMs: [],
  wantActiveAskedAtMs: 0,
  wantActiveDeclinedAtMs: 0,
  userTurnsSinceDecline: 0,
  lastTurnAtMs: 0,
  consecutiveErrorCount: 0,
};

/** Lazy-init for the reducer — pull persisted messages from sessionStorage
 *  so a refresh mid-conversation doesn't lose what the user was discussing.
 *  SSR-safe: returns empty list on the server. */
function initState(): State {
  if (typeof window === 'undefined') return INITIAL;
  const persisted = readOperatorMessagesFromSession();
  if (persisted.length === 0) return INITIAL;
  // Cast is safe — readOperatorMessagesFromSession already validated
  // role + content; tools is unknown[] and ChatMessage's tools field is
  // ChatToolCall[] | undefined. Tools-only-on-Oracle data shouldn't
  // round-trip here in practice, but keep the cast loose.
  return {
    ...INITIAL,
    messages: persisted as State['messages'],
  };
}

type Action =
  | { type: 'set_mode'; mode: OperatorMode }
  | { type: 'set_sub'; sub: SubState }
  | { type: 'append_message'; message: ChatMessage }
  | { type: 'replace_message_id'; oldId: string; newId: string }
  | { type: 'append_assistant_delta'; text: string }
  | { type: 'set_error'; error: string | null }
  | { type: 'record_user_turn'; tsMs: number }
  | { type: 'record_want_active_asked'; tsMs: number }
  | { type: 'record_want_active_declined'; tsMs: number }
  | { type: 'mark_turn'; tsMs: number }
  | { type: 'mark_error' }
  | { type: 'reset_error_count' }
  | { type: 'reset_messages' }
  | { type: 'replace_messages'; messages: ChatMessage[]; lastTurnAtMs?: number }
  | { type: 'prepend_messages'; messages: ChatMessage[] }
  /**
   * Surgical in-place update of a message identified by seq. Used by
   * the live-tail when a remote row's mutable fields change after the
   * row's already been loaded — chat:ask_choice's answered state is
   * the load-bearing case. Without this, Tab A clicks a card button,
   * Tab B never sees the assistant row's `tools[i].answered` set
   * because Tab B's live-tail only appends new seqs.
   */
  | { type: 'update_message_tools'; seq: number; tools: ChatToolCall[] };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set_mode': {
      // Mode flip resets the sub-state to a sensible default for the
      // new mode (passive → passive_idle; active → ready).
      const sub: SubState = action.mode === 'passive' ? 'passive_idle' : 'ready';
      return { ...state, mode: action.mode, sub };
    }
    case 'set_sub':
      // Fan out so the navbar chip + any other interested component
      // can reflect quiet_wait / silence_check / etc. without taking
      // the React-context route.
      try {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('papercusp:operatorSub', { detail: { sub: action.sub } }),
          );
        }
      } catch { /* ignore */ }
      return { ...state, sub: action.sub };
    case 'append_message':
      return { ...state, messages: [...state.messages, action.message] };
    case 'replace_message_id': {
      const idx = state.messages.findIndex((m) => m.id === action.oldId);
      if (idx < 0) return state;
      const next = state.messages.slice();
      next[idx] = { ...next[idx], id: action.newId };
      return { ...state, messages: next };
    }
    case 'update_message_tools': {
      const idx = state.messages.findIndex((m) => m.seq === action.seq);
      if (idx < 0) return state;
      // Compare structurally to avoid no-op re-renders.
      const before = state.messages[idx].tools;
      const beforeSerialized = before ? JSON.stringify(before) : '';
      const afterSerialized = JSON.stringify(action.tools);
      if (beforeSerialized === afterSerialized) return state;
      const next = state.messages.slice();
      next[idx] = { ...next[idx], tools: action.tools };
      return { ...state, messages: next };
    }
    case 'append_assistant_delta': {
      const last = state.messages[state.messages.length - 1];
      if (!last || last.role !== 'assistant') {
        // Open a new assistant message and seed it with the delta.
        return {
          ...state,
          messages: [...state.messages, { role: 'assistant', content: action.text }],
        };
      }
      const updated = [...state.messages];
      updated[updated.length - 1] = { ...last, content: last.content + action.text };
      return { ...state, messages: updated };
    }
    case 'set_error':
      return { ...state, error: action.error };
    case 'record_user_turn': {
      // Trim to the last 2 min to keep the array bounded.
      const cutoff = action.tsMs - 2 * 60 * 1000;
      const next = state.recentUserTurnTsMs.filter((t) => t >= cutoff);
      next.push(action.tsMs);
      return {
        ...state,
        recentUserTurnTsMs: next,
        userTurnsSinceDecline: state.userTurnsSinceDecline + 1,
      };
    }
    case 'record_want_active_asked':
      return { ...state, wantActiveAskedAtMs: action.tsMs };
    case 'record_want_active_declined':
      return {
        ...state,
        wantActiveDeclinedAtMs: action.tsMs,
        userTurnsSinceDecline: 0,
      };
    case 'mark_turn':
      return state.lastTurnAtMs === action.tsMs ? state : { ...state, lastTurnAtMs: action.tsMs };
    case 'mark_error':
      return { ...state, consecutiveErrorCount: state.consecutiveErrorCount + 1 };
    case 'reset_error_count':
      return state.consecutiveErrorCount === 0
        ? state
        : { ...state, consecutiveErrorCount: 0 };
    case 'reset_messages':
      return { ...state, messages: [], error: null };
    case 'replace_messages':
      return {
        ...state,
        messages: action.messages,
        error: null,
        lastTurnAtMs: action.lastTurnAtMs ?? state.lastTurnAtMs,
      };
    case 'prepend_messages':
      return { ...state, messages: [...action.messages, ...state.messages] };
  }
}

// ─── Cadence helper ─────────────────────────────────────────────────────

const TURNS_PER_WINDOW_THRESHOLD = 3;
const WINDOW_MS = 2 * 60 * 1000;

/**
 * Decline cooldown — after the user says no to "want active?", the
 * operator must wait either 5 fresh user turns OR 10 minutes (whichever
 * comes first) before re-asking. Per the active-mode plan.
 */
const DECLINE_COOLDOWN_MS = 10 * 60 * 1000;
const DECLINE_COOLDOWN_TURNS = 5;

/**
 * Returns true when the operator may ask "want me back to active?" —
 * all of:
 *   (a) mode === 'passive' (otherwise the question makes no sense)
 *   (b) sleep timer expired (don't disturb during a self-quiet)
 *   (c) ≥3 USER turns in the last 2 min (the "fresh engagement" signal)
 *   (d) cooldown after a prior decline has elapsed (5 user turns OR 10 min)
 *
 * Exposed to the route as the `[may_ask_active]` prompt context marker.
 */
export function mayAskActiveNow(state: State, nowMs: number = Date.now()): boolean {
  if (state.mode !== 'passive') return false;
  if (readSleepUntilMs() > nowMs) return false;
  const cutoff = nowMs - WINDOW_MS;
  const inWindow = state.recentUserTurnTsMs.filter((t) => t >= cutoff).length;
  if (inWindow < TURNS_PER_WINDOW_THRESHOLD) return false;
  // Cooldown gate: skip if neither the time nor the turn-count threshold
  // has been met since the most recent decline.
  if (state.wantActiveDeclinedAtMs > 0) {
    const sinceDecline = nowMs - state.wantActiveDeclinedAtMs;
    if (
      sinceDecline < DECLINE_COOLDOWN_MS &&
      state.userTurnsSinceDecline < DECLINE_COOLDOWN_TURNS
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Heuristic: does the assistant's `<say>` body contain the
 * "want me back to active?" question? Used to seed the decline-detection
 * window — when the next user turn is a "no", we know to record it.
 */
const WANT_ACTIVE_RE = /(want.*back.*active|back into active|go.*active.*mode)/i;
export function sayContainsWantActive(say: string): boolean {
  return WANT_ACTIVE_RE.test(say);
}

/**
 * Heuristic: does the user's reply read as a "no" to a recent
 * want-active prompt? Conservative — better to miss a decline (and
 * have the operator re-ask sooner) than to mis-detect (and cool down
 * when the user actually said yes).
 */
const DECLINE_RE = /^(no\b|nah\b|nope\b|not (yet|now|really)|keep (it )?(quiet|passive)|stay (passive|quiet)|leave it)/i;
export function userReplyDeclinesActive(text: string): boolean {
  return DECLINE_RE.test(text.trim());
}

/**
 * Plan: "Only flip yourself to passive when the user says, in plain
 * words, that they want quiet."  Examples in the prompt:
 *   - explicit dismissal: "stop", "shut up", "leave me alone", "I'm busy"
 *   - redirect to silence: "let me think", "let me work", "I need quiet"
 *   - frustration with the cadence: "you're talking too much", "ease off"
 *
 * The prompt asks the brain to emit <set_mode>passive</set_mode> when
 * it detects these. The plan flagged: "no server-side enforcement —
 * if the LLM forgets the tag, no fallback." This heuristic IS that
 * fallback — when the user's message matches AND the model's response
 * didn't include the tag, we force the flip.
 *
 * Conservative — better to miss a dismissal (chat keeps talking) than
 * to mis-detect (user types "stop sharing that screen" and we go
 * passive). Two layers of conservatism:
 *
 *   1. The phrase must START the message (with at most a brief
 *      filler like "hey", "ok", "wait"), OR be the entire message
 *      (length ≤ ~50 chars). A long sentence that incidentally
 *      contains "i'm busy" deep in it isn't a dismissal — it's
 *      context ("I'm busy with the worker right now, can you
 *      check on it?").
 *   2. Question marks anywhere → not a dismissal. Questions are
 *      engagement, not pushback ("are you busy with that?", "let me
 *      think — what are the options?").
 */
const DISMISS_PHRASE_RE = /(shut up|leave me alone|stop talking|stop asking|ease off|be quiet|go quiet|i'?m busy|i am busy|let me (think|work|focus)|i need (quiet|silence)|you'?re talking too much|too much talking)/i;
const SHORT_UTTERANCE_MAX = 50;
const PREAMBLE_RE = /^(hey|ok(ay)?|wait|listen|um|uh|so|well)[,!\s.]+/i;
export function userDismissesOperator(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Questions are engagement, not pushback.
  if (trimmed.includes('?')) return false;
  // Strip a brief conversational preamble so "ok, leave me alone"
  // still matches at start.
  const stripped = trimmed.replace(PREAMBLE_RE, '');
  // Whole message short and matches → dismissal.
  if (stripped.length <= SHORT_UTTERANCE_MAX && DISMISS_PHRASE_RE.test(stripped)) {
    return true;
  }
  // Long message must START with the phrase to count.
  const headRe = new RegExp('^' + DISMISS_PHRASE_RE.source, 'i');
  return headRe.test(stripped);
}

// ─── Silence-timer config ───────────────────────────────────────────────

/**
 * Detect whether an assistant turn is awaiting a user reply. Used by
 * the silence-timer effect: nudges only fire when the operator actually
 * asked something. If the operator just answered a question and didn't
 * pose one back, we stay silent indefinitely — no "still with me?"
 * spam.
 *
 * Rules:
 *   - Trimmed text ends with '?' → awaits
 *   - Used chat:ask_choice → awaits (definitionally)
 *   - Otherwise → does NOT await
 */
export function detectAwaitingReply(
  say: string | null | undefined,
  tools?: ReadonlyArray<{ name?: string }> | null,
): boolean {
  if (tools && tools.some((t) => t?.name === 'chat:ask_choice')) return true;
  if (!say) return false;
  const trimmed = say.trim().replace(/[*_`~]+$/g, '');
  return trimmed.endsWith('?');
}

/**
 * Detect a "ready"-style user utterance. Triggers a `user_says_ready`
 * generation that surfaces 2-3 concrete suggestions instead of waiting
 * for the user to specify what they want. Compromise between
 * "operator pesters" and "user must be explicit".
 */
const USER_READY_RE = /^\s*(ready|next|what's next\??|whats next\??|what now\??|go|continue|keep going|let's go|lets go|resume|what should i (do|work on)( next)?\??)\s*[.!?]*\s*$/i;
export function detectUserReadyTrigger(text: string): boolean {
  return USER_READY_RE.test(text);
}

// 2026-05-11 redesign — single 30s nudge after an assistant question.
// No further escalation; after the nudge fires the conversation stays
// quiet until the user types/speaks (or says "ready" to get suggestions).
const SILENCE_AFTER_QUESTION_MS = 30_000;

// ─── Generation transport ───────────────────────────────────────────────

export interface GenerationRequest {
  /** Conversation history at request time. */
  messages: ChatMessage[];
  /** Why we're calling — fed to the prompt as context. */
  trigger:
    | 'user_message'
    | 'silence_after_question'
    | 'quiet_wait_resume'
    | 'open_canvas'
    | 'user_says_ready'
    | 'user_welcomed';
  /** True when we're allowed to ask "want active?" this turn. */
  mayAskActive: boolean;
  /** Display name set on `user_welcomed` so brain greets by name. */
  welcomedUser?: { displayName: string };
  /**
   * Output surface for this turn. 'voice' when EL/Realtime is connected
   * so the brain knows text-only affordances (chat:ask_choice buttons)
   * are invisible to the user — must reply in plain say() instead.
   */
  modality: 'voice' | 'text';
  /** AbortSignal for cancellation (e.g. mode flip mid-generation). */
  signal: AbortSignal;
}

export interface GenerationStream {
  /** Async iterator yielding raw turn-output chunks. The caller buffers
   *  the chunks, parses with parseOperatorTurn(), then dispatches. */
  chunks: AsyncIterable<string>;
  /** Mutated by the chunks iterator as tool_call SSE events arrive.
   *  Read by the caller after `chunks` exhausts; attached to the
   *  resulting assistant message so the sidebar can render chips. */
  tools?: { name: string; input?: unknown }[];
}

/**
 * Function the provider calls to get a stream of operator output.
 * Stubbed in this commit; replaced by a fetch to /api/agent-mcp/operator-converse
 * (or, in voice mode, the realtime-session's turn output) in the next commit.
 */
export type GenerationFn = (req: GenerationRequest) => Promise<GenerationStream>;

/**
 * Default GenerationFn — POSTs to /api/agent-mcp/operator-converse and
 * yields the SSE delta-event payload as raw chunks. The buffered chunks
 * are parsed by parseOperatorTurn() back at the call site once the
 * stream completes.
 *
 * Same wire format Oracle's chat uses (event: delta with { text }), so
 * a future Voice path can plug in a different GenerationFn that drains
 * the realtime-session's turn output the same way.
 */
const defaultGenerationFn: GenerationFn = async (req) => {
  // Lazy import — avoids dragging the sessionStorage path into SSR.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getOrCreateClientId } = require('@/lib/ui/client-id') as typeof import('@/lib/ui/client-id');
  const uiClientId = getOrCreateClientId();
  const res = await fetch('/api/agent-mcp/operator-converse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: req.messages,
      trigger: req.trigger,
      mayAskActive: req.mayAskActive,
      modality: req.modality,
      welcomed_user: req.welcomedUser
        ? { display_name: req.welcomedUser.displayName }
        : undefined,
      uiClientId: uiClientId || undefined,
    }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(text || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const tools: { name: string; input?: unknown }[] = [];

  return {
    tools,
    chunks: (async function* () {
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frame parse — split on blank line.
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventMatch = frame.match(/^event:\s*(.+)$/m);
          const dataMatch = frame.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const event = eventMatch[1].trim();
          if (event !== 'delta' && event !== 'done' && event !== 'error' && event !== 'tool_call') continue;
          let data: unknown;
          try { data = JSON.parse(dataMatch[1]); } catch { continue; }

          if (event === 'delta') {
            const text = (data as { text?: unknown })?.text;
            if (typeof text === 'string') yield text;
          } else if (event === 'tool_call') {
            const d = data as { name?: unknown; input?: unknown };
            if (typeof d?.name === 'string') {
              tools.push({ name: d.name, input: d.input });
            }
          } else if (event === 'error') {
            const msg = (data as { message?: unknown })?.message;
            throw new Error(typeof msg === 'string' ? msg : 'stream error');
          } else if (event === 'done') {
            return;
          }
        }
      }
    })(),
  };
};

// ─── Context ────────────────────────────────────────────────────────────

interface OperatorConversationContextValue {
  mode: OperatorMode;
  sub: SubState;
  messages: ChatMessage[];
  error: string | null;
  busy: boolean;

  /** User-initiated send. Always allowed; restarts silence timer. */
  sendUserMessage: (text: string) => void;

  /** Imperative mode flip from the navbar toggle / set_mode tag. */
  flipMode: (mode: OperatorMode) => void;

  /** Banner text for the chat surface (e.g. silence-check status). */
  bannerText: string | null;

  /** True when at least one earlier turn exists below the oldest currently-loaded one. */
  hasMoreEarlier: boolean;
  /** True while a loadEarlier() fetch is in flight. */
  loadingEarlier: boolean;
  /**
   * Fetch and prepend the next batch of older turns. Idempotent while
   * a prior fetch is in flight; no-op when hasMoreEarlier is false.
   */
  loadEarlier: () => Promise<void>;

  /**
   * Resolve a chat:ask_choice card by POSTing the picked option(s)
   * to /api/operator/conversations/:id/turn-answer. The endpoint
   * atomically marks the assistant's tool as answered AND inserts
   * the user turn (text=joined-labels, source='card_pick'). On
   * success, the live-tail picks up both rows — no local mutation
   * needed. Throws on already-answered (409) or validation (400).
   *
   * picks is always an array — length 1 for single-select cards,
   * ≥1 for multi-select (args.multi=true).
   */
  answerChoice: (input: {
    assistantSeq: number;
    toolIndex: number;
    picks: Array<{ option_id: string; label: string }>;
  }) => Promise<void>;

  /**
   * Active conversation id, or null when no conversation is selected.
   * Consumed by PendingCardsBar to scope /card-response POSTs to the
   * active chat.
   */
  conversationId: string | null;
}

const OperatorConversationContext = createContext<OperatorConversationContextValue | null>(null);

export function useOperatorConversation(): OperatorConversationContextValue {
  const v = useContext(OperatorConversationContext);
  if (!v) {
    throw new Error('useOperatorConversation must be used inside OperatorConversationProvider');
  }
  return v;
}

interface ProviderProps {
  children: ReactNode;
  /** Optional override — tests inject a fake generation fn here. */
  generationFn?: GenerationFn;
}

export function OperatorConversationProvider({ children, generationFn = defaultGenerationFn }: ProviderProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL, initState);
  const workspaceId = useWorkspaceId();

  // PG-backed conversation identity. Loaded on mount; survives refresh
  // and is shared between the text path and (later) the EL voice path.
  // SessionStorage is kept as a paint-cache so refresh has no flash —
  // PG hydration overwrites it once the GET resolves.
  const conversationIdRef = useRef<string | null>(null);
  // Mirror conv ID into React state so useSyncQuery's `enabled` flips when
  // it lands. The ref alone is fine for the imperative POST path but a
  // hook gate needs reactive state.
  const [convId, setConvId] = useState<string | null>(null);

  // Infinite-scroll cursors. We track the oldest + newest turn `seq`
  // we've materialized into `state.messages` so we can:
  //   - fetch the next batch of older turns starting just below
  //     `oldestLoadedSeqRef`,
  //   - and let the live-tail Zero subscription only append turns whose
  //     `seq > newestLoadedSeqRef` (so prepending older history doesn't
  //     trigger the optimistic-write dedup heuristic).
  // The ref pair is the source of truth for the loadEarlier fetcher;
  // `hasMoreEarlier` mirrors it into reactive state for the chat UI.
  //
  // `hydratedRef` gates the live-tail reconciler until the initial
  // windowed fetch has set the cursors — otherwise a Zero subscription
  // that returns 100 turns before our REST hydrate lands would flood
  // the chat with the entire tail before the windowed view replaces it.
  const oldestLoadedSeqRef = useRef<number | null>(null);
  const newestLoadedSeqRef = useRef<number | null>(null);
  const hydratedRef = useRef(false);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  // Desktop-tuned: PG fetch is loopback, so the bottleneck is React
  // reconciliation on prepend, not bandwidth. 200/page keeps the
  // sidebar feeling close to "all in memory" while still bounding the
  // worst-case render burst on initial mount.
  const INITIAL_PAGE = 200;
  const PAGE_SIZE = 200;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/operator/conversations?limit=${INITIAL_PAGE}`);
        if (!res.ok) return;
        const json = (await res.json()) as {
          conversation: { id: string };
          turns: Array<{
            id?: string;
            seq: number;
            role: 'user' | 'assistant' | 'system';
            text: string;
            createdAt?: number;
            tools?: ChatToolCall[] | null;
          }>;
          hasMoreEarlier: boolean;
        };
        if (cancelled) return;
        conversationIdRef.current = json.conversation.id;
        setConvId(json.conversation.id);
        if (json.turns.length > 0) {
          oldestLoadedSeqRef.current = json.turns[0].seq;
          newestLoadedSeqRef.current = json.turns[json.turns.length - 1].seq;
          setHasMoreEarlier(json.hasMoreEarlier);
          // Anchor lastTurnAtMs to the most-recent turn's createdAt so
          // the silence ladder doesn't fire "Still with me?" on mount
          // of an old conversation. G13 of the audit.
          const lastCreated = json.turns[json.turns.length - 1].createdAt ?? 0;
          dispatch({
            type: 'replace_messages',
            messages: json.turns.map((t) => ({
              role: t.role,
              content: t.text,
              id: typeof t.id === 'string' ? t.id : undefined,
              seq: typeof t.seq === 'number' ? t.seq : undefined,
              tools: Array.isArray(t.tools) ? t.tools : undefined,
            })),
            lastTurnAtMs: lastCreated,
          });
        } else {
          // Brand-new conversation — keep the sessionStorage seed for
          // any in-progress unsaved input but reset cursors.
          oldestLoadedSeqRef.current = null;
          newestLoadedSeqRef.current = null;
          setHasMoreEarlier(false);
          // Replace any sessionStorage seed with empty so the live tail
          // doesn't see "messages.length>0 but cursors null" as a flood.
          dispatch({ type: 'replace_messages', messages: [] });
        }
        hydratedRef.current = true;
      } catch {
        /* offline / dev startup — fall back to sessionStorage seed */
        hydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadEarlier = useCallback(async (): Promise<void> => {
    const id = conversationIdRef.current;
    if (!id) return;
    if (loadingEarlier) return;
    if (oldestLoadedSeqRef.current === null) return;
    if (!hasMoreEarlier) return;
    setLoadingEarlier(true);
    try {
      const beforeSeq = oldestLoadedSeqRef.current;
      const res = await fetch(
        `/api/operator/conversations/${id}/turns?beforeSeq=${beforeSeq}&limit=${PAGE_SIZE}`,
      );
      if (!res.ok) return;
      const page = (await res.json()) as {
        turns: Array<{
          id?: string;
          seq: number;
          role: 'user' | 'assistant' | 'system';
          text: string;
          tools?: ChatToolCall[] | null;
        }>;
        hasMoreEarlier: boolean;
      };
      if (page.turns.length === 0) {
        setHasMoreEarlier(false);
        return;
      }
      oldestLoadedSeqRef.current = page.turns[0].seq;
      setHasMoreEarlier(page.hasMoreEarlier);
      dispatch({
        type: 'prepend_messages',
        messages: page.turns.map((t) => ({
          role: t.role,
          content: t.text,
          id: typeof t.id === 'string' ? t.id : undefined,
          seq: typeof t.seq === 'number' ? t.seq : undefined,
          tools: Array.isArray(t.tools) ? t.tools : undefined,
        })),
      });
    } catch {
      /* swallow — chat is still functional with the rows already loaded */
    } finally {
      setLoadingEarlier(false);
    }
  }, [hasMoreEarlier, loadingEarlier]);

  // Cross-tab live tail. Subscribe to the most-recent N turns; the
  // reconciler appends only those whose seq is strictly greater than
  // `newestLoadedSeqRef`. The previous "count > local.length" heuristic
  // doesn't survive infinite-scroll: prepending older history would
  // make the heuristic always think the remote is behind.
  //
  // Limit 200 mirrors INITIAL_PAGE: the live tail is a window, not the
  // conversation depth — the user-facing depth is bounded only by how
  // far they scroll back. Older turns land via loadEarlier() against PG.
  const turnsSync = useSyncQuery<OperatorTurnRow>({
    queryName: 'operatorTurns.byConversation',
    args: { conversationId: convId ?? '', limit: 200 },
    enabled: !!convId,
  });
  const remoteTurns = (turnsSync.data as OperatorTurnRow[] | undefined) ?? [];
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!Array.isArray(remoteTurns) || remoteTurns.length === 0) return;
    const sorted = [...remoteTurns].sort((a, b) => a.seq - b.seq);
    const since = newestLoadedSeqRef.current;
    // Dedup by id: if a remote row's id matches an already-loaded
    // message (optimistic uuid or real PG id), skip the append. G19.
    const localIds = new Set(state.messages.map((m) => m.id).filter((x): x is string => !!x));
    // B4: content-based dedup fallback for the optimistic-write race.
    // The optimistic id is local-only (PG never sees it); when Zero
    // echoes the inserted row back BEFORE persistTurn's .then() swaps
    // the id, the seq-cursor guard can't distinguish "real new turn"
    // from "echo of the local optimistic". Match by (role, content)
    // against the most recent few optimistic-prefixed messages and
    // swap the id in place rather than appending.
    const optimisticByKey = new Map<string, string>();
    for (let i = state.messages.length - 1; i >= Math.max(0, state.messages.length - 8); i--) {
      const m = state.messages[i];
      if (m.id && m.id.startsWith('opt-')) {
        optimisticByKey.set(`${m.role} ${m.content}`, m.id);
      }
    }
    let lastTurnTs = 0;
    // Build a quick seq → local-tools index so we can detect cross-tab
    // updates to mutable fields on already-loaded rows (specifically:
    // chat:ask_choice's answered state). Without this, Tab B never
    // sees the assistant row's tools[i].answered after Tab A clicks
    // the card button.
    const localToolsBySeq = new Map<number, ChatToolCall[] | undefined>();
    for (const m of state.messages) {
      if (typeof m.seq === 'number') localToolsBySeq.set(m.seq, m.tools);
    }
    for (const t of sorted) {
      if (since !== null && t.seq <= since) {
        // Already-loaded row: check if its mutable fields (tools) have
        // changed and dispatch a surgical update if so. Cross-tab
        // chat:ask_choice answered-state lives in this branch.
        if (Array.isArray(t.tools) && typeof t.seq === 'number') {
          const local = localToolsBySeq.get(t.seq);
          const remoteJson = JSON.stringify(t.tools);
          const localJson = local ? JSON.stringify(local) : '';
          if (remoteJson !== localJson) {
            dispatch({ type: 'update_message_tools', seq: t.seq, tools: t.tools as ChatToolCall[] });
          }
        }
        continue;
      }
      if (typeof t.id === 'string' && localIds.has(t.id)) {
        newestLoadedSeqRef.current = t.seq;
        continue;
      }
      const optKey = `${t.role} ${t.text}`;
      const optId = optimisticByKey.get(optKey);
      if (optId) {
        dispatch({ type: 'replace_message_id', oldId: optId, newId: t.id });
        optimisticByKey.delete(optKey);
        newestLoadedSeqRef.current = t.seq;
        continue;
      }
      dispatch({
        type: 'append_message',
        message: {
          role: t.role,
          content: t.text,
          id: typeof t.id === 'string' ? t.id : undefined,
          seq: typeof t.seq === 'number' ? t.seq : undefined,
          tools: Array.isArray(t.tools) ? t.tools : undefined,
        },
      });
      newestLoadedSeqRef.current = t.seq;
      if (oldestLoadedSeqRef.current === null) oldestLoadedSeqRef.current = t.seq;
      const ts = t.createdAt ?? Date.now();
      if (ts > lastTurnTs) lastTurnTs = ts;
      // B3: cross-tab user turns also count toward engagement. Without
      // this, a user typing in one tab while another tab is open
      // would never satisfy mayAskActiveNow()'s 3-in-2min threshold.
      if (t.role === 'user') {
        dispatch({ type: 'record_user_turn', tsMs: ts });
      }
    }
    if (lastTurnTs > 0) dispatch({ type: 'mark_turn', tsMs: lastTurnTs });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteTurns.length, convId]);

  // Persist messages on every change. SessionStorage is per-tab and
  // resets on app reopen, matching the mode + sleep semantics. The
  // cap inside writeOperatorMessagesToSession bounds the footprint.
  useEffect(() => {
    writeOperatorMessagesToSession(state.messages);
  }, [state.messages]);

  // Fire-and-forget PG turn write. Called from sendUserMessage and from
  // runGeneration once the assistant turn is parsed. We don't block the
  // UI on the network — the optimistic React state has already updated.
  const persistTurn = useCallback(
    (
      role: 'user' | 'assistant',
      text: string,
      source: 'text_typed' | 'voice_stt' | 'voice_tts' = 'text_typed',
      optimisticId?: string,
      tools?: ChatToolCall[],
    ) => {
      const id = conversationIdRef.current;
      if (!id) return;
      // After insert: bump cursor (seq dedup) AND swap optimistic uuid
      // for the real PG id (G19 id dedup). Either one alone has a race
      // window where the Zero push could double-render the optimistic
      // local message; together they're robust.
      // `tools` (added 2026-05-11 for chat:ask_choice) is omitted when
      // undefined so the server route can default to NULL.
      const body: Record<string, unknown> = { role, text, source };
      if (tools && tools.length > 0) body.tools = tools;
      void fetch(`/api/operator/conversations/${id}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { turn?: { id?: string; seq?: number } } | null) => {
          const seq = j?.turn?.seq;
          const realId = j?.turn?.id;
          if (typeof seq === 'number') {
            if (newestLoadedSeqRef.current === null || seq > newestLoadedSeqRef.current) {
              newestLoadedSeqRef.current = seq;
            }
            if (oldestLoadedSeqRef.current === null) oldestLoadedSeqRef.current = seq;
          }
          if (optimisticId && typeof realId === 'string') {
            dispatch({ type: 'replace_message_id', oldId: optimisticId, newId: realId });
          }
        })
        .catch(() => { /* swallow — sessionStorage cache covers refresh */ });
    },
    [],
  );

  // Hydrate mode from sessionStorage on mount. If the session is
  // empty (fresh app open, no prior toggle), fall back to the user's
  // operatorActiveOnStartup voice-pref setting (default true). If the
  // pref fetch fails, default to 'active' so the operator-as-collaborator
  // experience works even without persisted prefs.
  useEffect(() => {
    let cancelled = false;

    const seedFromSession = readOperatorModeFromSession();
    if (seedFromSession) {
      // Mid-session value is authoritative.
      if (seedFromSession !== state.mode) dispatch({ type: 'set_mode', mode: seedFromSession });
    } else {
      // First time this session — seed from the saved pref.
      // Render immediately as 'active' (the safe default); flip if the
      // pref says otherwise once the fetch lands.
      writeOperatorModeToSession('active');
      void (async () => {
        try {
          const res = await fetch('/api/agent-mcp/operator-voice-prefs');
          if (!res.ok) return;
          const prefs = (await res.json()) as { operatorActiveOnStartup?: boolean };
          if (cancelled) return;
          // Treat undefined as `true` (matches DEFAULT_VOICE_PREFS).
          const wantActive = prefs.operatorActiveOnStartup !== false;
          if (!wantActive) {
            writeOperatorModeToSession('passive');
            dispatch({ type: 'set_mode', mode: 'passive' });
            try {
              window.dispatchEvent(
                new CustomEvent('papercusp:operatorMode', { detail: { mode: 'passive' } }),
              );
            } catch { /* ignore */ }
          }
        } catch { /* keep default */ }
      })();
    }

    // Subscribe to mode-change events fired by the navbar toggle
    // (and the set_mode tag dispatcher / voice path).
    const onModeEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ mode: OperatorMode }>).detail;
      if (detail?.mode === 'active' || detail?.mode === 'passive') {
        dispatch({ type: 'set_mode', mode: detail.mode });
      }
    };
    window.addEventListener('papercusp:operatorMode', onModeEvent as EventListener);

    // Voice-engagement signal: STT delivers a user transcript →
    // count toward `recentUserTurnTsMs` so passive-mode's
    // mayAskActiveNow() satisfies the 3-in-2min threshold from
    // voice-only sessions too. Plan called this out as a known gap
    // at commit-time; now wired. Also marks the silence-ladder
    // freshness clock so it stays active after a voice exchange.
    const onVoiceUserTurn = (e: Event) => {
      const detail = (e as CustomEvent<{ tsMs?: number; text?: string }>).detail;
      const tsMs = typeof detail?.tsMs === 'number' ? detail.tsMs : Date.now();
      const text = typeof detail?.text === 'string' ? detail.text : '';
      dispatch({ type: 'record_user_turn', tsMs });
      dispatch({ type: 'mark_turn', tsMs });
      // E1: bridge text-path's server-side dismissal enforcement into
      // the voice path. The voice tag observer reads this stamp on the
      // next assistant flush and force-flips to passive if the brain
      // forgot to emit <set_mode>passive</set_mode>.
      if (text && stateRef.current.mode === 'active' && userDismissesOperator(text)) {
        writePendingDismissalAtMs(tsMs);
      }
    };
    window.addEventListener('papercusp:operatorUserTurn', onVoiceUserTurn as EventListener);

    return () => {
      cancelled = true;
      window.removeEventListener('papercusp:operatorMode', onModeEvent as EventListener);
      window.removeEventListener('papercusp:operatorUserTurn', onVoiceUserTurn as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── In-flight generation tracking ───────────────────────────────────
  const inFlightRef = useRef<AbortController | null>(null);

  // Mirror of state.messages + state.mode used inside runGeneration to
  // sidestep stale-closure issues. React's useReducer batches dispatches,
  // and runGeneration is often called immediately after an append (e.g.
  // the user just sent a message) — at that moment, state.messages still
  // reflects the PREVIOUS render. The ref is updated on every render
  // below so the runner always sees the latest committed state.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  // Voice-active mirror so runGeneration (which is declared before
  // useState voiceActive) can read the current value without a re-bind.
  // Initialized eagerly from the voice subscription so the very first
  // turn after voice connects sees the right modality.
  const voiceActiveRef = useRef<boolean>(false);

  // ── Generation runner ──────────────────────────────────────────────
  // Drains the stream, buffers chunks into a single string, parses tags
  // at end (NOT incrementally — the wire format is one tag-document per
  // turn; partial parses would produce wrong results). Dispatches the
  // parsed side effects.
  //
  // Optional `messagesOverride` lets the caller pass an explicit
  // history that includes a turn just dispatched in the same tick
  // (state hasn't committed yet).
  const runGeneration = useCallback(
    async (
      trigger: GenerationRequest['trigger'],
      opts?: {
        messagesOverride?: ChatMessage[];
        welcomedUser?: { displayName: string };
      },
    ) => {
      // Abort any in-flight generation first (e.g. user sent a new message
      // mid-thinking, or a mode flip happened).
      inFlightRef.current?.abort();
      const ctrl = new AbortController();
      inFlightRef.current = ctrl;

      dispatch({ type: 'set_sub', sub: 'generating' });
      dispatch({ type: 'set_error', error: null });

      const snapshot = stateRef.current;
      const history = opts?.messagesOverride ?? snapshot.messages;

      try {
        const stream = await generationFn({
          messages: history,
          trigger,
          mayAskActive: mayAskActiveNow(snapshot),
          modality: voiceActiveRef.current ? 'voice' : 'text',
          welcomedUser: opts?.welcomedUser,
          signal: ctrl.signal,
        });

        let buf = '';
        for await (const chunk of stream.chunks) {
          if (ctrl.signal.aborted) return;
          buf += chunk;
        }

        const parsed = parseOperatorTurn(buf);

        // The turn is meaningful if EITHER the model wrote `<say>` OR
        // it called a tool. Pre-2026-05-11 we only dispatched/persisted
        // when parsed.say was non-empty, which silently swallowed
        // tool-call-only turns (e.g. chat:ask_choice). The card never
        // appeared because the assistant row was never appended.
        // Now: a non-empty tool array also qualifies.
        const collectedTools = stream.tools && stream.tools.length > 0 ? stream.tools.slice() : undefined;
        const turnHasContent = !!parsed.say || !!collectedTools;

        if (turnHasContent) {
          const sayContent = parsed.say ?? '';
          dispatch({
            type: 'append_message',
            message: collectedTools
              ? { role: 'assistant', content: sayContent, tools: collectedTools }
              : { role: 'assistant', content: sayContent },
          });
          // Engagement check tracks USER turns only. Assistant turns
          // (a) probe for the want-active phrase to seed G2's decline
          // window, AND (b) RESET that seed on subsequent non-want-active
          // turns so a "no" to a later "want passive?" check doesn't
          // get misclassified as declining active. G12 of the audit.
          if (parsed.say && sayContainsWantActive(parsed.say)) {
            dispatch({ type: 'record_want_active_asked', tsMs: Date.now() });
          } else if (parsed.say) {
            dispatch({ type: 'record_want_active_asked', tsMs: 0 });
          }
          dispatch({ type: 'mark_turn', tsMs: Date.now() });
          // Persist text + tools. Empty say is fine for tool-only
          // turns; persistTurn writes whatever we send. The server-side
          // turns route was extended to accept the tools field
          // alongside text (POST /api/operator/conversations/:id/turns).
          persistTurn('assistant', sayContent, 'text_typed', undefined, collectedTools);
        }
        // Successful turn → clear backoff. G14.
        dispatch({ type: 'reset_error_count' });

        if (parsed.sleep) {
          writeSleepUntilMs(sleepTagToEpochMs(parsed.sleep));
        }

        // Spawn requests — fire-and-forget POSTs to the orchestrator
        // plugin endpoint. Sidesteps the omp MCP tool-surface gap: the
        // brain emits <spawn role="..."> tags as part of its turn
        // output, the runtime intercepts them and dispatches the spawn
        // via the existing HTTP API (which always works regardless of
        // whether the model has the MCP tool registered). The spawnId
        // and result land in the user-actions log + Intel panel.
        for (const sp of parsed.spawns) {
          const params = new URLSearchParams({
            workspace: workspaceId,
            harness: 'system',
            role: 'operator',
            run: `op-converse-${Date.now()}`,
            spawn: `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          });
          const body: Record<string, unknown> = { role: sp.role };
          if (sp.featureId) body.featureId = sp.featureId;
          if (sp.chunkId) body.chunkId = sp.chunkId;
          if (sp.extras.length > 0) body.extras = sp.extras;
          void fetch(`/api/plugins/orchestrator/spawn?${params.toString()}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn('[operator-converse] spawn failed', err);
          });
        }

        // Server-side disengagement enforcement: if the user's last
        // turn (the one that triggered this generation) explicitly
        // dismissed the operator AND the model's response didn't
        // include <set_mode>passive</set_mode>, force the flip. Plan
        // flagged the gap; this closes it.
        let effectiveMode = parsed.setMode;
        if (!effectiveMode && stateRef.current.mode === 'active') {
          const lastUser = [...history].reverse().find((m) => m.role === 'user');
          if (lastUser && userDismissesOperator(lastUser.content)) {
            effectiveMode = 'passive';
          }
        }
        if (effectiveMode) {
          // Persist + fanout via the same channel the navbar toggle uses,
          // so subscribers update in lockstep.
          writeOperatorModeToSession(effectiveMode);
          try {
            window.dispatchEvent(
              new CustomEvent('papercusp:operatorMode', { detail: { mode: effectiveMode } }),
            );
          } catch { /* ignore */ }
          // Reducer also moves to the right sub-state via set_mode.
          dispatch({ type: 'set_mode', mode: effectiveMode });
          return;
        }

        // End-of-turn sub-state (2026-05-11 redesign):
        //   silence_after_question → 'nudged' — terminal silence, no more
        //     escalation. The user must speak / type / say "ready" to
        //     re-engage.
        //   user_message / open_canvas / user_says_ready / quiet_wait_resume:
        //     If the assistant's reply awaits a response (parsed say
        //     ends with '?' or used chat:ask_choice), → 'awaiting_reply'
        //     (arms ONE 30s nudge). Otherwise → 'ready' (no timer).
        const awaitingReply = detectAwaitingReply(parsed.say, collectedTools);
        let endSub: SubState;
        if (stateRef.current.mode === 'passive') {
          endSub = 'passive_idle';
        } else if (trigger === 'silence_after_question') {
          endSub = 'nudged';
        } else if (awaitingReply) {
          endSub = 'awaiting_reply';
        } else {
          endSub = 'ready';
        }
        dispatch({ type: 'set_sub', sub: endSub });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'set_error', error: msg });
        dispatch({ type: 'mark_error' });
        dispatch({
          type: 'set_sub',
          sub: stateRef.current.mode === 'passive' ? 'passive_idle' : 'ready',
        });
      } finally {
        // G15 — aborted with no follow-up taking over → reset sub so
        // the chat doesn't get stranded in 'generating'.
        if (ctrl.signal.aborted && inFlightRef.current === ctrl) {
          dispatch({
            type: 'set_sub',
            sub: stateRef.current.mode === 'passive' ? 'passive_idle' : 'ready',
          });
          inFlightRef.current = null;
        }
      }
    },
    [generationFn, persistTurn],
  );

  // ── Silence timers ──────────────────────────────────────────────────
  // Active mode only. When `sub === 'ready'` and 10s elapsed → nudge.
  // When 'silence_nudge' and 30s more → silence_check. When
  // 'silence_check' and 30s more → quiet_wait.
  //
  // Voice gate: when a voice session owns the mic, the user IS speaking
  // (or being spoken to) — the chat sidebar must NOT also fire silence
  // nudges. Otherwise the voice agent says "X" while the chat
  // independently writes "Still with me?" / "Want me to go passive?",
  // and the unified-conversation log fills with two parallel monologues
  // ("Bug B" of the voice/text divergence audit).
  const [voiceActive, setVoiceActive] = useState(() => {
    try { return getVoiceState().mode !== 'off'; } catch { return false; }
  });
  // Ref mirror so runGeneration (declared above) can read the current
  // value without a useCallback re-bind on every voice state change.
  // Provider mounts BEFORE the first generation runs, so the initial
  // ref value matches the first useState init.
  useEffect(() => {
    voiceActiveRef.current = voiceActive;
  }, [voiceActive]);
  useEffect(() => {
    return subscribeVoiceState((s) => setVoiceActive(s.mode !== 'off'));
  }, []);

  // Sleep gate. The LLM emits `<sleep>{minutes}</sleep>` when the user
  // says "give me a minute" / "I'm busy" — the silence-nudge timer must
  // respect that or the operator keeps asking "Still with me?" while
  // the user explicitly asked for quiet. We mirror sessionStorage's
  // sleepUntilMs into reactive state so the effect re-arms when the
  // sleep deadline passes (or when the user wakes the operator via
  // the navbar chip).
  const [sleepUntilMs, setSleepUntilMsState] = useState(() => {
    try { return readSleepUntilMs(); } catch { return 0; }
  });
  useEffect(() => {
    const refresh = () => setSleepUntilMsState(readSleepUntilMs());
    refresh();
    window.addEventListener('papercusp:operatorSleep', refresh);
    return () => window.removeEventListener('papercusp:operatorSleep', refresh);
  }, []);
  // When sleep expires in the future, schedule a wake-up so the silence
  // timer re-arms automatically. Cleared on every effect re-run.
  useEffect(() => {
    if (sleepUntilMs <= 0) return;
    const remaining = sleepUntilMs - Date.now();
    if (remaining <= 0) {
      setSleepUntilMsState(0);
      return;
    }
    const t = setTimeout(() => setSleepUntilMsState(0), remaining + 100);
    return () => clearTimeout(t);
  }, [sleepUntilMs]);

  // G13/G14 — silence ladder respects freshness + applies error backoff.
  // SILENCE_FRESHNESS_MS: only run the ladder if the most recent turn
  // was within this window (5min). Outside it, the chat is stale and
  // nudges would feel out-of-context.
  // errorMul: exponential backoff on the silence-timer wait when
  // operator-converse keeps failing. Cap at 2^6 = 64x so the worst
  // case is ~10min between nudges.
  const SILENCE_FRESHNESS_MS = 5 * 60 * 1000;
  const errorMul = state.consecutiveErrorCount > 0
    ? Math.pow(2, Math.min(state.consecutiveErrorCount, 6))
    : 1;
  useEffect(() => {
    if (state.mode !== 'active') return;
    if (voiceActive) return; // voice owns the conversation; no nudge filler
    if (sleepUntilMs > Date.now()) return; // operator self-quieted via <sleep> tag
    const sinceLast = Date.now() - state.lastTurnAtMs;
    if (state.lastTurnAtMs === 0 || sinceLast > SILENCE_FRESHNESS_MS) return;
    // New ladder: ONLY arm a nudge when the last assistant turn was
    // explicitly awaiting a reply. After the nudge fires, transition to
    // 'nudged' and stay quiet — no further escalation, no "still with me?"
    // spam. The user can say "ready" / "next" to re-engage with
    // suggestions, or just type what they want.
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (state.sub === 'awaiting_reply') {
      const wait = Math.max(0, (SILENCE_AFTER_QUESTION_MS * errorMul) - sinceLast);
      timer = setTimeout(() => void runGeneration('silence_after_question'), wait);
    }
    // 'ready' and 'nudged' are quiet states — no timer.
    return () => { if (timer) clearTimeout(timer); };
  }, [state.mode, state.sub, state.lastTurnAtMs, errorMul, runGeneration, voiceActive, sleepUntilMs]);

  // G10 — opening utterance on fresh chat. Fires ONCE on mount when the
  // sidebar is empty AND mode is active AND voice is off AND not sleeping.
  // The ref guard prevents the effect from re-firing on dep changes
  // (e.g. another flag flipping during the in-flight generation).
  const openCanvasFiredRef = useRef(false);
  useEffect(() => {
    if (openCanvasFiredRef.current) return;
    if (!hydratedRef.current) return;
    if (state.mode !== 'active') return;
    if (voiceActive) return;
    if (sleepUntilMs > Date.now()) return;
    if (state.sub !== 'ready') return;

    // Welcome flow: the login page set sessionStorage on success.
    // Consume the flag and fire user_welcomed (overrides open_canvas
    // even when messages exist — login is a fresh conversational moment).
    // Plan 4.8.
    let welcomedName: string | null = null;
    try {
      welcomedName = sessionStorage.getItem('papercusp_just_logged_in');
      if (welcomedName) sessionStorage.removeItem('papercusp_just_logged_in');
    } catch { /* sessionStorage unavailable */ }
    if (welcomedName) {
      openCanvasFiredRef.current = true;
      void runGeneration('user_welcomed', { welcomedUser: { displayName: welcomedName } });
      return;
    }

    // Fall-through: only auto-fire open_canvas on truly empty conversation.
    if (state.messages.length > 0) return;
    openCanvasFiredRef.current = true;
    void runGeneration('open_canvas');
  }, [state.mode, state.sub, state.messages.length, voiceActive, sleepUntilMs, runGeneration]);

  // ── Public actions ──────────────────────────────────────────────────

  const sendUserMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // Optimistic id — swapped for the real PG id once the POST
      // returns (see persistTurn). The live-tail Zero reconciler
      // dedupes by id, so a fast Zero echo won't double-render the
      // user's message. G19.
      const optimisticId = `opt-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
      const userMsg: ChatMessage = { role: 'user', content: trimmed, id: optimisticId };
      const nowMs = Date.now();
      dispatch({ type: 'append_message', message: userMsg });
      dispatch({ type: 'record_user_turn', tsMs: nowMs });
      dispatch({ type: 'mark_turn', tsMs: nowMs });
      // Decline detection: if the operator just asked "want active?"
      // (within the last 60s) AND the user's reply reads as a "no",
      // record the decline so mayAskActiveNow() applies the cooldown.
      const askedAt = stateRef.current.wantActiveAskedAtMs;
      if (
        askedAt > 0
        && nowMs - askedAt < 60_000
        && userReplyDeclinesActive(trimmed)
      ) {
        dispatch({ type: 'record_want_active_declined', tsMs: nowMs });
      }
      persistTurn('user', trimmed, 'text_typed', optimisticId);
      // Trigger resolution (priority order):
      //   - "ready"-style utterance → user_says_ready (surfaces 2-3
      //     concrete suggestions from workspace inventory)
      //   - was in quiet_wait/nudged → quiet_wait_resume (reference
      //     where we left off)
      //   - otherwise → user_message (default)
      let trigger: GenerationRequest['trigger'] = 'user_message';
      if (detectUserReadyTrigger(trimmed)) {
        trigger = 'user_says_ready';
      } else if (
        stateRef.current.sub === 'quiet_wait'
        || stateRef.current.sub === 'nudged'
      ) {
        trigger = 'quiet_wait_resume';
      }
      // Pass the explicit history including the just-dispatched user
      // turn so the model sees what the user actually said. State hasn't
      // committed yet on this tick; reading state.messages would miss it.
      const nextHistory = [...stateRef.current.messages, userMsg];
      void runGeneration(trigger, { messagesOverride: nextHistory });
    },
    [runGeneration, persistTurn],
  );

  const flipMode = useCallback((mode: OperatorMode) => {
    writeOperatorModeToSession(mode);
    // Flipping TO active wakes the operator if it was sleeping —
    // otherwise the user-visible chip says "Active" while the silence
    // timers stay parked. Per the active-mode plan, flipping to
    // active means "I'm here, talk to me." Sleep event fires so the
    // chip's reactive sleepUntilMs state clears immediately. B5.
    if (mode === 'active') {
      writeSleepUntilMs(0);
      try { window.dispatchEvent(new Event('papercusp:operatorSleep')); } catch { /* ignore */ }
    }
    try {
      window.dispatchEvent(
        new CustomEvent('papercusp:operatorMode', { detail: { mode } }),
      );
    } catch { /* ignore */ }
    dispatch({ type: 'set_mode', mode });
  }, []);

  // Banner text for transient sub-states (silence prompts).
  const bannerText = useMemo<string | null>(() => {
    if (state.sub === 'quiet_wait') return 'Operator is quiet — type to pick up where you left off.';
    return null;
  }, [state.sub]);

  // chat:ask_choice card click → POST turn-answer. The endpoint is still
  // authoritative, but we now mirror the answered-state + picked user turn
  // locally on success so the sidebar updates immediately instead of waiting
  // for the live-tail invalidate round-trip.
  const answerChoice = useCallback(
    async (input: {
      assistantSeq: number;
      toolIndex: number;
      picks: Array<{ option_id: string; label: string }>;
    }): Promise<void> => {
      const id = conversationIdRef.current;
      if (!id) throw new Error('answerChoice: no active conversation');
      const r = await fetch(
        `/api/operator/conversations/${id}/turn-answer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`turn-answer ${r.status}: ${detail.slice(0, 200)}`);
      }

      const answeredAt = Date.now();
      const existing = stateRef.current.messages.find((m) => m.seq === input.assistantSeq);
      let nextHistory = stateRef.current.messages;
      if (existing?.tools && existing.tools[input.toolIndex]) {
        const nextTools = existing.tools.map((tool, index) =>
          index === input.toolIndex
            ? { ...tool, answered: { picks: input.picks, at: answeredAt } }
            : tool,
        );
        dispatch({ type: 'update_message_tools', seq: input.assistantSeq, tools: nextTools });
        nextHistory = nextHistory.map((msg) =>
          msg.seq === input.assistantSeq ? { ...msg, tools: nextTools } : msg,
        );
      }

      const joined = input.picks.map((p) => p.label).join(' · ');
      const optimisticId = `opt-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
      const userMsg: ChatMessage = { role: 'user', content: joined, id: optimisticId };
      dispatch({ type: 'append_message', message: userMsg });
      dispatch({ type: 'record_user_turn', tsMs: answeredAt });
      dispatch({ type: 'mark_turn', tsMs: answeredAt });
      const askedAt = stateRef.current.wantActiveAskedAtMs;
      if (
        askedAt > 0
        && answeredAt - askedAt < 60_000
        && userReplyDeclinesActive(joined)
      ) {
        dispatch({ type: 'record_want_active_declined', tsMs: answeredAt });
      }

      let trigger: GenerationRequest['trigger'] = 'user_message';
      if (detectUserReadyTrigger(joined)) {
        trigger = 'user_says_ready';
      } else if (
        stateRef.current.sub === 'quiet_wait'
        || stateRef.current.sub === 'nudged'
      ) {
        trigger = 'quiet_wait_resume';
      }
      void runGeneration(trigger, { messagesOverride: [...nextHistory, userMsg] });
    },
    [runGeneration],
  );

  const value: OperatorConversationContextValue = useMemo(
    () => ({
      mode: state.mode,
      sub: state.sub,
      messages: state.messages,
      error: state.error,
      busy: state.sub === 'generating',
      sendUserMessage,
      flipMode,
      bannerText,
      hasMoreEarlier,
      loadingEarlier,
      loadEarlier,
      answerChoice,
      conversationId: convId,
    }),
    [
      state.mode, state.sub, state.messages, state.error,
      sendUserMessage, flipMode, bannerText,
      hasMoreEarlier, loadingEarlier, loadEarlier, answerChoice,
      convId,
    ],
  );

  return (
    <OperatorConversationContext.Provider value={value}>
      {children}
    </OperatorConversationContext.Provider>
  );
}
