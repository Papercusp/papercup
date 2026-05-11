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
  sleepTagToEpochMs,
  writeOperatorMessagesToSession,
  writeOperatorModeToSession,
  writeSleepUntilMs,
  type OperatorMode,
} from '@/lib/operator-converse-tags';
import { getVoiceState, subscribeVoiceState } from './voice/voice-mode';
import { useSyncQuery } from '@restart/sync';
import type { ChatMessage } from './chat/ChatConversation';

interface OperatorTurnRow {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

// ─── State + actions ────────────────────────────────────────────────────

type SubState =
  | 'ready'
  | 'generating'
  | 'silence_nudge'
  | 'silence_check'
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
  | { type: 'append_assistant_delta'; text: string }
  | { type: 'set_error'; error: string | null }
  | { type: 'record_user_turn'; tsMs: number }
  | { type: 'record_want_active_asked'; tsMs: number }
  | { type: 'record_want_active_declined'; tsMs: number }
  | { type: 'reset_messages' }
  | { type: 'replace_messages'; messages: ChatMessage[] }
  | { type: 'prepend_messages'; messages: ChatMessage[] };

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
    case 'reset_messages':
      return { ...state, messages: [], error: null };
    case 'replace_messages':
      return { ...state, messages: action.messages, error: null };
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

// ─── Silence-timer config ───────────────────────────────────────────────

// 10s nudge / 30s check / 30s quiet_wait — matches operator.converse.md.
const SILENCE_NUDGE_MS = 10_000;
const SILENCE_CHECK_MS = 30_000;
const SILENCE_QUIET_WAIT_MS = 30_000;

// ─── Generation transport ───────────────────────────────────────────────

export interface GenerationRequest {
  /** Conversation history at request time. */
  messages: ChatMessage[];
  /** Why we're calling — fed to the prompt as context. */
  trigger:
    | 'user_message'
    | 'silence_nudge'
    | 'silence_check'
    | 'quiet_wait_resume';
  /** True when we're allowed to ask "want active?" this turn. */
  mayAskActive: boolean;
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
          turns: Array<{ seq: number; role: 'user' | 'assistant' | 'system'; text: string }>;
          hasMoreEarlier: boolean;
        };
        if (cancelled) return;
        conversationIdRef.current = json.conversation.id;
        setConvId(json.conversation.id);
        if (json.turns.length > 0) {
          oldestLoadedSeqRef.current = json.turns[0].seq;
          newestLoadedSeqRef.current = json.turns[json.turns.length - 1].seq;
          setHasMoreEarlier(json.hasMoreEarlier);
          dispatch({
            type: 'replace_messages',
            messages: json.turns.map((t) => ({ role: t.role, content: t.text })),
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
        turns: Array<{ seq: number; role: 'user' | 'assistant' | 'system'; text: string }>;
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
        messages: page.turns.map((t) => ({ role: t.role, content: t.text })),
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
    for (const t of sorted) {
      if (since !== null && t.seq <= since) continue;
      dispatch({ type: 'append_message', message: { role: t.role, content: t.text } });
      newestLoadedSeqRef.current = t.seq;
      if (oldestLoadedSeqRef.current === null) oldestLoadedSeqRef.current = t.seq;
    }
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
    (role: 'user' | 'assistant', text: string, source: 'text_typed' | 'voice_stt' | 'voice_tts' = 'text_typed') => {
      const id = conversationIdRef.current;
      if (!id) return;
      // Bump newestLoadedSeqRef to the inserted seq so the live-tail
      // reconciler doesn't double-render our optimistic message when
      // it echoes back via Zero. Best-effort: if the POST fails we just
      // never bump and the live tail will treat the next remote row as
      // new (which still self-heals because the optimistic React row
      // already has the same content).
      void fetch(`/api/operator/conversations/${id}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, text, source }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { turn?: { seq?: number } } | null) => {
          const seq = j?.turn?.seq;
          if (typeof seq === 'number') {
            if (newestLoadedSeqRef.current === null || seq > newestLoadedSeqRef.current) {
              newestLoadedSeqRef.current = seq;
            }
            if (oldestLoadedSeqRef.current === null) oldestLoadedSeqRef.current = seq;
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
    return () => {
      cancelled = true;
      window.removeEventListener('papercusp:operatorMode', onModeEvent as EventListener);
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
      messagesOverride?: ChatMessage[],
    ) => {
      // Abort any in-flight generation first (e.g. user sent a new message
      // mid-thinking, or a mode flip happened).
      inFlightRef.current?.abort();
      const ctrl = new AbortController();
      inFlightRef.current = ctrl;

      dispatch({ type: 'set_sub', sub: 'generating' });
      dispatch({ type: 'set_error', error: null });

      const snapshot = stateRef.current;
      const history = messagesOverride ?? snapshot.messages;

      try {
        const stream = await generationFn({
          messages: history,
          trigger,
          mayAskActive: mayAskActiveNow(snapshot),
          signal: ctrl.signal,
        });

        let buf = '';
        for await (const chunk of stream.chunks) {
          if (ctrl.signal.aborted) return;
          buf += chunk;
        }

        const parsed = parseOperatorTurn(buf);

        if (parsed.say) {
          const collectedTools = stream.tools && stream.tools.length > 0 ? stream.tools.slice() : undefined;
          dispatch({
            type: 'append_message',
            message: collectedTools
              ? { role: 'assistant', content: parsed.say, tools: collectedTools }
              : { role: 'assistant', content: parsed.say },
          });
          // No record_turn_ts here — the engagement check tracks USER
          // turns only. Assistant turns just need the want-active probe.
          if (sayContainsWantActive(parsed.say)) {
            dispatch({ type: 'record_want_active_asked', tsMs: Date.now() });
          }
          persistTurn('assistant', parsed.say, 'text_typed');
        }

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
            workspace: 'default',
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

        if (parsed.setMode) {
          // Persist + fanout via the same channel the navbar toggle uses,
          // so subscribers update in lockstep.
          writeOperatorModeToSession(parsed.setMode);
          try {
            window.dispatchEvent(
              new CustomEvent('papercusp:operatorMode', { detail: { mode: parsed.setMode } }),
            );
          } catch { /* ignore */ }
          // Reducer also moves to the right sub-state via set_mode.
          dispatch({ type: 'set_mode', mode: parsed.setMode });
          return;
        }

        // End-of-turn sub-state depends on the trigger so the silence
        // ladder escalates correctly:
        //   user_message / quiet_wait_resume → ready (10s timer to nudge)
        //   silence_nudge                    → silence_nudge (30s timer to check)
        //   silence_check                    → silence_check (30s timer to quiet_wait)
        // Without this trigger-aware end state, every silence turn would
        // bounce back to 'ready' and the next 10s timer would fire ANOTHER
        // nudge instead of escalating to the check.
        const endSub: SubState =
          stateRef.current.mode === 'passive'
            ? 'passive_idle'
            : trigger === 'silence_nudge'
              ? 'silence_nudge'
              : trigger === 'silence_check'
                ? 'silence_check'
                : 'ready';
        dispatch({ type: 'set_sub', sub: endSub });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'set_error', error: msg });
        dispatch({
          type: 'set_sub',
          sub: stateRef.current.mode === 'passive' ? 'passive_idle' : 'ready',
        });
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

  useEffect(() => {
    if (state.mode !== 'active') return;
    if (voiceActive) return; // voice owns the conversation; no nudge filler
    if (sleepUntilMs > Date.now()) return; // operator self-quieted via <sleep> tag
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (state.sub === 'ready') {
      timer = setTimeout(() => void runGeneration('silence_nudge'), SILENCE_NUDGE_MS);
    } else if (state.sub === 'silence_nudge') {
      timer = setTimeout(() => void runGeneration('silence_check'), SILENCE_CHECK_MS);
    } else if (state.sub === 'silence_check') {
      timer = setTimeout(() => dispatch({ type: 'set_sub', sub: 'quiet_wait' }), SILENCE_QUIET_WAIT_MS);
    }
    return () => { if (timer) clearTimeout(timer); };
  }, [state.mode, state.sub, runGeneration, voiceActive, sleepUntilMs]);

  // ── Public actions ──────────────────────────────────────────────────

  const sendUserMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const userMsg: ChatMessage = { role: 'user', content: trimmed };
      dispatch({ type: 'append_message', message: userMsg });
      dispatch({ type: 'record_user_turn', tsMs: Date.now() });
      // Decline detection: if the operator just asked "want active?"
      // (within the last 60s) AND the user's reply reads as a "no",
      // record the decline so mayAskActiveNow() applies the cooldown.
      const askedAt = stateRef.current.wantActiveAskedAtMs;
      if (
        askedAt > 0
        && Date.now() - askedAt < 60_000
        && userReplyDeclinesActive(trimmed)
      ) {
        dispatch({ type: 'record_want_active_declined', tsMs: Date.now() });
      }
      persistTurn('user', trimmed, 'text_typed');
      // quiet_wait → user re-engaged; resume from the thread.
      const trigger: GenerationRequest['trigger'] =
        stateRef.current.sub === 'quiet_wait' ? 'quiet_wait_resume' : 'user_message';
      // Pass the explicit history including the just-dispatched user
      // turn so the model sees what the user actually said. State hasn't
      // committed yet on this tick; reading state.messages would miss it.
      const nextHistory = [...stateRef.current.messages, userMsg];
      void runGeneration(trigger, nextHistory);
    },
    [runGeneration, persistTurn],
  );

  const flipMode = useCallback((mode: OperatorMode) => {
    writeOperatorModeToSession(mode);
    // Flipping TO active wakes the operator if it was sleeping —
    // otherwise the user-visible chip says "Active" while the silence
    // timers stay parked. Per the active-mode plan, flipping to
    // active means "I'm here, talk to me."
    if (mode === 'active') writeSleepUntilMs(0);
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
    }),
    [
      state.mode, state.sub, state.messages, state.error,
      sendUserMessage, flipMode, bannerText,
      hasMoreEarlier, loadingEarlier, loadEarlier,
    ],
  );

  return (
    <OperatorConversationContext.Provider value={value}>
      {children}
    </OperatorConversationContext.Provider>
  );
}
