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
  /** Timestamps of the last N turns (for the 3-in-2min cadence check). */
  recentTurnTsMs: number[];
}

const INITIAL: State = {
  mode: 'active',
  sub: 'ready',
  messages: [],
  error: null,
  recentTurnTsMs: [],
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
  | { type: 'record_turn_ts'; tsMs: number }
  | { type: 'reset_messages' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set_mode': {
      // Mode flip resets the sub-state to a sensible default for the
      // new mode (passive → passive_idle; active → ready).
      const sub: SubState = action.mode === 'passive' ? 'passive_idle' : 'ready';
      return { ...state, mode: action.mode, sub };
    }
    case 'set_sub':
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
    case 'record_turn_ts': {
      // Trim to the last 2 min to keep the array bounded.
      const cutoff = action.tsMs - 2 * 60 * 1000;
      const next = state.recentTurnTsMs.filter((t) => t >= cutoff);
      next.push(action.tsMs);
      return { ...state, recentTurnTsMs: next };
    }
    case 'reset_messages':
      return { ...state, messages: [], error: null };
  }
}

// ─── Cadence helper ─────────────────────────────────────────────────────

const TURNS_PER_WINDOW_THRESHOLD = 3;
const WINDOW_MS = 2 * 60 * 1000;

/**
 * Returns true when the operator may ask "want me back to active?" —
 * gated on (a) ≥3 turns in the last 2 min AND (b) sleep timer expired.
 * The route + prompt see this as the [may_ask_active] context marker;
 * here we expose it for the dispatcher to read.
 */
export function mayAskActiveNow(state: State, nowMs: number = Date.now()): boolean {
  if (state.mode !== 'passive') return false;
  if (readSleepUntilMs() > nowMs) return false;
  const cutoff = nowMs - WINDOW_MS;
  const inWindow = state.recentTurnTsMs.filter((t) => t >= cutoff).length;
  return inWindow >= TURNS_PER_WINDOW_THRESHOLD;
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
  const res = await fetch('/api/agent-mcp/operator-converse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: req.messages,
      trigger: req.trigger,
      mayAskActive: req.mayAskActive,
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/operator/conversations');
        if (!res.ok) return;
        const json = (await res.json()) as {
          conversation: { id: string };
          turns: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>;
        };
        if (cancelled) return;
        conversationIdRef.current = json.conversation.id;
        setConvId(json.conversation.id);
        // Replace cached messages with PG truth. Only do this if PG actually
        // has turns — otherwise keep the sessionStorage seed so a brand-new
        // conversation row doesn't blow away an in-progress unsaved chat.
        if (json.turns.length > 0) {
          dispatch({ type: 'reset_messages' });
          for (const t of json.turns) {
            dispatch({
              type: 'append_message',
              message: { role: t.role, content: t.text },
            });
          }
        }
      } catch {
        /* offline / dev startup — fall back to sessionStorage seed */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Cross-tab sync. Subscribe to operatorTurns.byConversation via Zero
  // once we have a conversation id. When another tab appends a turn,
  // PG-NOTIFY → SSE → useSyncQuery rows update; we mirror any rows the
  // local state hasn't seen yet by appending them in seq order.
  //
  // Optimistic-write dedupe: the local tab dispatches append_message
  // before the POST returns, so this tab's own writes echo back via
  // Zero. We only act when the remote rows have *more* turns than our
  // optimistic state — same-count means "we've already shown it." This
  // is conservative; pathological cases (race between two tabs both
  // sending) get reconciled on next message rather than instantly.
  const turnsSync = useSyncQuery<OperatorTurnRow>({
    queryName: 'operatorTurns.byConversation',
    args: { conversationId: convId ?? '', limit: 500 },
    enabled: !!convId,
  });
  const remoteTurns = (turnsSync.data as OperatorTurnRow[] | undefined) ?? [];
  useEffect(() => {
    if (!Array.isArray(remoteTurns) || remoteTurns.length === 0) return;
    if (remoteTurns.length <= state.messages.length) return;
    // Append turns beyond what we've already optimistically rendered.
    // Sort by seq for safety even though the query is ordered.
    const sorted = [...remoteTurns].sort((a, b) => a.seq - b.seq);
    for (let i = state.messages.length; i < sorted.length; i++) {
      const t = sorted[i];
      dispatch({ type: 'append_message', message: { role: t.role, content: t.text } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteTurns.length, state.messages.length]);

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
      void fetch(`/api/operator/conversations/${id}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, text, source }),
      }).catch(() => { /* swallow — sessionStorage cache covers refresh */ });
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
          dispatch({ type: 'record_turn_ts', tsMs: Date.now() });
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

  useEffect(() => {
    if (state.mode !== 'active') return;
    if (voiceActive) return; // voice owns the conversation; no nudge filler
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (state.sub === 'ready') {
      timer = setTimeout(() => void runGeneration('silence_nudge'), SILENCE_NUDGE_MS);
    } else if (state.sub === 'silence_nudge') {
      timer = setTimeout(() => void runGeneration('silence_check'), SILENCE_CHECK_MS);
    } else if (state.sub === 'silence_check') {
      timer = setTimeout(() => dispatch({ type: 'set_sub', sub: 'quiet_wait' }), SILENCE_QUIET_WAIT_MS);
    }
    return () => { if (timer) clearTimeout(timer); };
  }, [state.mode, state.sub, runGeneration, voiceActive]);

  // ── Public actions ──────────────────────────────────────────────────

  const sendUserMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const userMsg: ChatMessage = { role: 'user', content: trimmed };
      dispatch({ type: 'append_message', message: userMsg });
      dispatch({ type: 'record_turn_ts', tsMs: Date.now() });
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
    }),
    [state.mode, state.sub, state.messages, state.error, sendUserMessage, flipMode, bannerText],
  );

  return (
    <OperatorConversationContext.Provider value={value}>
      {children}
    </OperatorConversationContext.Provider>
  );
}
