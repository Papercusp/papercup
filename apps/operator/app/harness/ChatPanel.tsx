'use client';

/**
 * ChatPanel — multi-turn conversational UI for an agent_chats row.
 *
 * Mounted inside the pi-dock as the 'chat' panel type. On mount it loads
 * the chat (GET /agent-chats/:chatId), renders the transcript, and
 * exposes a compose area. Send POSTs /messages and opens an EventSource
 * to stream deltas back, appending to the live assistant message. On
 * stream end, refetches the chat to pick up the persisted token/cost
 * counters and the canonical assistant turn.
 *
 * Side-channel design: the chat agent's prompt tells it not to commit
 * code, only to advise + write supervisor-notes. If the feature_lock is
 * active, a banner makes that visible to the user too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './PiPanel.css';
import { useConfirmDialog } from './useConfirmDialog';
import { Send, Archive, Loader2, AlertTriangle, Coins, RotateCcw } from 'lucide-react';
import { COLORS, FONTS, RADIUS, SIZES } from './theme';
import { Tooltip } from './Tooltip';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_cents?: number;
  /** Assistant turn that FAILED (rate-limit / backend error); content is the message. */
  error?: boolean;
}

interface FeatureLock {
  taken_by: string | null;
  taken_at: string | null;
  expires_at: string | null;
  active: boolean;
}

interface ChatRow {
  id: string;
  role: string;
  feature_id: string | null;
  title: string | null;
  transcript: TranscriptTurn[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd_cents: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  feature_lock?: FeatureLock | null;
}

export interface ChatPanelProps {
  slug: string;
  chatId: string;
  /** Conversation mode, sent with each message so the server assembles the
   *  right role prompt: 'discuss' reframes a worker to advise-first. Optional;
   *  the server defaults to 'chat' when absent. */
  mode?: 'chat' | 'discuss';
  /** Called when the user archives this chat — parent should remove the dock panel. */
  onArchive?: () => void;
}

type SendState =
  | { kind: 'idle' }
  | { kind: 'streaming'; partial: string }
  | { kind: 'error'; message: string };

export default function ChatPanel({ slug, chatId, mode, onArchive }: ChatPanelProps) {
  const workspaceId = useWorkspaceId(); // EI-1763: tenant-scope sync reads
  const [chat, setChat] = useState<ChatRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sendState, setSendState] = useState<SendState>({ kind: 'idle' });
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  // Freshness guards for loadChat: the cached subscription row can lag the
  // locally streamed transcript (per-harness agent_chats invalidation gap) —
  // a re-run must never clobber a LONGER local transcript or interrupt an
  // in-flight stream. Refs, not state: loadChat reads them without re-arming.
  const localTurnsRef = useRef(0);
  const streamingRef = useRef(false);

  // Eager via Zero — subscribe to all chats for this harness; pick out
  // the one matching chatId. Replaces the per-chatId REST fetch so the
  // panel renders the transcript same-frame on mount.
  const { data: zeroChatRows } = useSyncQuery<{
    harnessSlug: string;
    id: string;
    role: string;
    featureId?: string | null;
    title?: string | null;
    transcript: unknown;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsdCents: number;
    createdAt: number;
    updatedAt: number;
    archivedAt?: number | null;
  }>({
    queryName: 'agentChats.byHarness',
    args: { harnessSlug: slug, limit: 200, workspaceId },
    enabled: !!slug,
  });

  const loadChat = useCallback(async (opts?: { forceRest?: boolean }) => {
    // Never reload mid-stream — the streamed turns aren't on the server row
    // yet, and a setChat here wipes them from the panel. (The deliberate
    // post-stream refetch passes forceRest and skips both guards.)
    if (!opts?.forceRest && streamingRef.current) return;
    // Try the cached subscription first — UNLESS the caller knows it lags
    // (post-stream: the per-harness agent_chats invalidate may never arrive,
    // so the cached row would clobber the streamed transcript back to its
    // pre-send state; REST always has the persisted turns).
    const row = opts?.forceRest ? undefined : (zeroChatRows ?? []).find((r) => r.id === chatId);
    if (row) {
      // Stale-row guard: if the subscription row carries FEWER turns than
      // the panel already shows (locally streamed, not yet invalidated
      // through), keep the local transcript.
      const rowTurns = Array.isArray(row.transcript) ? row.transcript.length : 0;
      if (rowTurns < localTurnsRef.current) return;
      setChat({
        id: row.id,
        role: row.role,
        feature_id: row.featureId ?? null,
        title: row.title ?? null,
        transcript: (row.transcript ?? []) as TranscriptTurn[],
        total_input_tokens: row.totalInputTokens,
        total_output_tokens: row.totalOutputTokens,
        total_cost_usd_cents: row.totalCostUsdCents,
        created_at: new Date(row.createdAt).toISOString(),
        updated_at: new Date(row.updatedAt).toISOString(),
        archived_at: row.archivedAt ? new Date(row.archivedAt).toISOString() : null,
      } as unknown as ChatRow);
      setLoadError(null);
      return;
    }
    // Fall back to REST when the row hasn't been mirrored to consolidated
    // (e.g. chat created in the legacy per-harness table without a
    // consolidated dual-write yet).
    try {
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        setLoadError(body.error ?? `HTTP ${r.status}`);
        return;
      }
      setChat((await r.json()) as ChatRow);
      setLoadError(null);
    } catch (err) {
      setLoadError(`load failed: ${(err as Error).message}`);
    }
  }, [slug, chatId, zeroChatRows]);

  useEffect(() => { void loadChat(); }, [loadChat]);

  // Mirror the freshness guards (see the ref declarations above) on every
  // render so loadChat reads current values without re-arming itself.
  useEffect(() => {
    localTurnsRef.current = chat?.transcript.length ?? 0;
    streamingRef.current = sendState.kind === 'streaming';
  });

  // Auto-scroll on new content.
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat?.transcript.length, sendState.kind === 'streaming' ? sendState.partial : '']);

  // Cleanup any in-flight stream on unmount.
  useEffect(() => () => { eventSourceRef.current?.close(); }, []);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || !chat || sendState.kind === 'streaming') return;

    setSendState({ kind: 'streaming', partial: '' });
    setDraft('');

    // Optimistic — append the user turn locally so it appears immediately.
    setChat((prev) => prev ? {
      ...prev,
      transcript: [...prev.transcript, { role: 'user', content, ts: new Date().toISOString() }],
    } : prev);

    try {
      const res = await fetch(
        `/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, ...(mode ? { mode } : {}) }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        setSendState({
          kind: 'error',
          message: body.error ? `${body.error}${body.hint ? ` — ${body.hint}` : ''}` : `HTTP ${res.status}`,
        });
        return;
      }
      // Server returns SSE; read the response body as a stream.
      if (!res.body) {
        setSendState({ kind: 'error', message: 'no response body — server did not stream' });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let lineBuf = '';
      let pendingEvent: string | null = null;
      let assistantText = '';
      let streamError: string | null = null;
      // The server emits a terminal `event: done` on success and `event: error`
      // on a handled failure. A reader that closes with NEITHER means the
      // connection dropped mid-turn (operator recycle / OOM / network blip) —
      // no failure-marker turn was persisted, so we must surface it ourselves
      // rather than silently reset to idle (the same vanish symptom as EI-577).
      let sawDone = false;

      // Read the SSE stream. Format:
      //   event: delta
      //   data: {"text":"...."}
      //
      //   event: done
      //   data: {...}
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        lineBuf += decoder.decode(value, { stream: true });
        let nl: number;
        // eslint-disable-next-line no-cond-assign
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl).replace(/\r$/, '');
          lineBuf = lineBuf.slice(nl + 1);
          if (!line) {
            pendingEvent = null;
            continue;
          }
          if (line.startsWith('event:')) {
            pendingEvent = line.slice(6).trim();
            continue;
          }
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const data = JSON.parse(payload);
              if (pendingEvent === 'delta' && typeof data.text === 'string') {
                assistantText += data.text;
                setSendState({ kind: 'streaming', partial: assistantText });
              } else if (pendingEvent === 'error') {
                streamError = data.message ?? 'stream error';
                setSendState({ kind: 'error', message: streamError });
              } else if (pendingEvent === 'done') {
                sawDone = true;
              }
            } catch { /* malformed — ignore */ }
          }
        }
      }

      // Stream finished.
      if (streamError) {
        // Keep the inline error banner visible — do NOT reset to idle, or it gets
        // clobbered and the failed turn vanishes silently (the bug this fixes:
        // thinking cursor → nothing). Skip the refetch: the server persists a
        // failure-marker turn that surfaces on the next load, so in-session the
        // banner is the signal and we avoid stacking banner + freshly-loaded marker.
        return;
      }
      if (!sawDone) {
        // Stream closed without a terminal `done` or `error` — the operator
        // dropped the connection mid-turn (process recycle, OOM, network blip).
        // The server never reached its persist/emit code, so a refetch would
        // show only the user turn: the exact silent gap we are killing. Surface
        // it inline; the live agent_chats subscription still backfills a turn if
        // one was persisted before the drop.
        setSendState({
          kind: 'error',
          message: assistantText
            ? 'Connection dropped mid-response — the reply may be incomplete. Try again.'
            : 'No response: the connection closed before the agent replied (the operator may have restarted). Try again.',
        });
        return;
      }
      // Success — refetch to get the persisted assistant turn + counters.
      // forceRest: the cached subscription row may not have invalidated yet
      // and would reset the transcript to its pre-send state.
      setSendState({ kind: 'idle' });
      void loadChat({ forceRest: true });
    } catch (err) {
      setSendState({ kind: 'error', message: `send failed: ${(err as Error).message}` });
    }
  }, [chat, chatId, draft, loadChat, mode, sendState.kind, slug]);

  const onArchiveClick = useCallback(async () => {
    if (!await askConfirm({
      title: 'Archive this chat?',
      body: 'The transcript is retained but the chat disappears from the active list.',
      confirmLabel: 'Archive',
    })) return;
    try {
      await fetch(`/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
      onArchive?.();
    } catch { /* best effort */ }
  }, [slug, chatId, onArchive, askConfirm]);

  const costUsd = useMemo(() => (chat?.total_cost_usd_cents ?? 0) / 100, [chat?.total_cost_usd_cents]);
  const tokensTotal = (chat?.total_input_tokens ?? 0) + (chat?.total_output_tokens ?? 0);

  if (loadError) {
    return (
      <div className="chat-panel chat-panel--error">
        <AlertTriangle size={14} /> Failed to load chat: {loadError}
        <Tooltip label="Retry loading the chat transcript">
          <button className="chat-panel__retry" onClick={() => void loadChat()}>retry</button>
        </Tooltip>
      </div>
    );
  }
  if (!chat) {
    return (
      <div className="chat-panel chat-panel--loading">
        <Loader2 size={14} className="chat-panel__spin" /> loading chat…
      </div>
    );
  }

  return (
    <div className="chat-panel">
      {confirmEl}
      <div className="chat-panel__header">
        <span className="chat-panel__role">{chat.role}</span>
        {chat.feature_id && <span className="chat-panel__feature">{chat.feature_id}</span>}
        <span className="chat-panel__title">{chat.title ?? ''}</span>
        <Tooltip label={`${tokensTotal.toLocaleString()} tokens`}>
          <span className="chat-panel__cost">
            <Coins size={11} /> ${costUsd.toFixed(4)}
          </span>
        </Tooltip>
        <Tooltip label="Archive chat">
          <button onClick={onArchiveClick} className="chat-panel__archive">
            <Archive size={12} />
          </button>
        </Tooltip>
      </div>

      {chat.feature_lock?.active && (
        <div className="chat-panel__lock-warning" role="status">
          <AlertTriangle size={12} />
          <span>
            Feature {chat.feature_id} is being worked on autonomously
            {chat.feature_lock.taken_by ? ` (${chat.feature_lock.taken_by})` : ''}.
            This chat will advise but not commit code; for guidance the worker should pick up,
            ask it to leave a note in <code>.papercusp/notes/{chat.feature_id}.md</code>.
          </span>
        </div>
      )}

      <div ref={transcriptScrollRef} className="chat-panel__transcript">
        {chat.transcript.length === 0 && sendState.kind === 'idle' && (
          <div className="chat-panel__empty">
            Start the conversation. The agent has the same context the autonomous {chat.role} would{chat.feature_id ? ` for feature ${chat.feature_id}` : ''}.
          </div>
        )}
        {chat.transcript.map((t, i) => (
          <div key={i} className={`chat-turn chat-turn--${t.role}${t.error ? ' chat-turn--error' : ''}`}>
            <div className="chat-turn__role">
              {t.error && <AlertTriangle size={11} />}{t.role}{t.error ? ' · failed' : ''}
            </div>
            <div className="chat-turn__body">{t.content}</div>
          </div>
        ))}
        {sendState.kind === 'streaming' && (
          <div className="chat-turn chat-turn--assistant chat-turn--streaming">
            <div className="chat-turn__role">
              <Loader2 size={11} className="chat-panel__spin" /> assistant
            </div>
            <div className="chat-turn__body">{sendState.partial || '…'}</div>
          </div>
        )}
        {sendState.kind === 'error' && (
          <div className="chat-panel__send-error" role="alert">
            <AlertTriangle size={12} /> {sendState.message}
            <Tooltip label="Dismiss">
              <button onClick={() => setSendState({ kind: 'idle' })}>
                <RotateCcw size={11} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      <form
        className="chat-panel__compose"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            sendState.kind === 'streaming'
              ? 'agent is responding…'
              : `Message ${chat.role}${chat.feature_id ? ` about ${chat.feature_id}` : ''}… (Shift+Enter for newline)`
          }
          disabled={sendState.kind === 'streaming'}
          rows={2}
          className="chat-panel__input"
        />
        <Tooltip label="Send (Enter)">
          <button
            type="submit"
            disabled={sendState.kind === 'streaming' || !draft.trim()}
            className="chat-panel__send"
          >
            {sendState.kind === 'streaming' ? <Loader2 size={13} className="chat-panel__spin" /> : <Send size={13} />}
          </button>
        </Tooltip>
      </form>
    </div>
  );
}
