'use client';

/**
 * SessionChatModal (owner-inbox-single-pane-2026-07-17 P-007) — the "chat-grade"
 * popup: click an inbox item whose `ownerAgentId` names a live/recent su agent
 * and see that agent's session as a friendly, Papercup-style conversation —
 * not AgentInspectorModal's raw technical timeline (tool JSON, cost, tokens),
 * which stays the debugging surface it always was. Composer sends a real
 * message to the agent (D-007's live-asker path).
 *
 * Data layer — entirely REUSED, nothing new invented (D-005 "generalize
 * OperatorChat... never fork a second chat renderer" + reuse-first):
 *   - owner → session id: POST /api/admin/coordination/sessions/list, the
 *     existing generic coordination admin proxy (sessions:list). Cross-client
 *     under the hood, but this view resolves a CLAUDE session specifically —
 *     matching P-002's "Claude transcripts first" scoping decision; OMP/codex
 *     support is a disclosed follow-up (the live-stream endpoint already
 *     accepts ompThreadId/codexSessionKey, so extending is additive later).
 *   - session id → live transcript: the SAME `/api/adv/session/thinking` SSE
 *     stream + `useAgentThinkingStream` hook that already backs
 *     AgentInspectorModal (apps/operator/app/harness/AgentThinkingStream.tsx)
 *     — no new transcript-reading/parsing code.
 *   - transcript → ChatMessage[]: session-transcript-mapping.ts (this plan
 *     item's actual new logic — the tool-noise-filtering mapping layer).
 *   - rendering: <OperatorChat>, passive (read + reply; no auto-brain).
 *
 * Composer send: a plain coord:send via the existing /api/admin/coord/send
 * proxy — the SAME endpoint AssignDialog's `assignToUser` already POSTs to.
 * `wake:'required'` per D-007 (this is a live two-way chat action, distinct
 * from P-006's inbox "answer this ask" action, which owns actions/provenance).
 *
 * Cards in the popup (P-008): when this owner has a pending `coord-escalation`
 * with named options, it renders inline above the chat as the SAME
 * `OtherDetail` card the Queue and InboxPane already use (REUSE, not a second
 * card renderer) — sourced from the SAME `useInboxAttention` feed (shared sync
 * cache entry, no new query) InboxPane reads. Answering it here goes through
 * `OtherDetail`'s own action path unmodified, so it is byte-identical to
 * answering from the inbox (P-006's resolve/reply routing + provenance stamp).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Modal } from '../../harness/Modal';
import { OperatorChat } from '../OperatorChat';
import { useAgentThinkingStream } from '../../harness/AgentThinkingStream';
import { sessionTimelineToChatMessages } from './session-transcript-mapping';
import { effectiveTier, useInboxAttention } from '../inbox/use-inbox-pending';
import { OtherDetail } from '@/app/admin/plans/PlanOtherList';
import { isEscalationWithOptions } from '@/app/admin/plans/attention-card';
// OtherDetail's styles (pc-items__*, pc-tier/pc-kind badges) — global CSS, so
// importing it here (as InboxPane already does) makes this modal
// self-sufficient wherever it's mounted.
import '@/app/admin/plans/plans.css';

interface SessionListRow {
  source_kind: string;
  session_id: string;
  active?: boolean;
  last_ts: string | null;
}

const BANNER_STYLE: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  color: 'var(--fg-mute)',
  borderBottom: '1px solid var(--border)',
};

const ERROR_BANNER_STYLE: React.CSSProperties = { ...BANNER_STYLE, color: 'var(--bad, #f87171)' };

/** Resolve the most relevant CLAUDE session for this owner via the existing
 *  sessions:list admin proxy. Exported for tests. */
export async function resolveOwnerClaudeSession(ownerId: string): Promise<SessionListRow | null> {
  const r = await fetch('/api/admin/coordination/sessions/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: ownerId, limit: 10 }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`sessions:list → ${r.status}: ${text.slice(0, 200)}`);
  let body: { sessions?: SessionListRow[] };
  try {
    body = JSON.parse(text) as { sessions?: SessionListRow[] };
  } catch {
    throw new Error('sessions:list returned a non-JSON response');
  }
  const sessions = body.sessions ?? [];
  // Prefer the live/active fallback row (EI-11403), else the newest indexed
  // claude session — sessions:list is already newest-first.
  return (
    sessions.find((s) => s.source_kind === 'claude' && s.active) ??
    sessions.find((s) => s.source_kind === 'claude') ??
    null
  );
}

/** Send a live message to the session's owner. Exported for tests. */
export async function sendToSessionOwner(ownerId: string, body: string): Promise<void> {
  const r = await fetch('/api/admin/coord/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      to: [ownerId],
      summary: body.length > 80 ? `${body.slice(0, 77)}…` : body,
      body,
      wake: 'required',
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`coord:send → ${r.status}: ${text.slice(0, 200)}`);
}

/** The live half — only mounted once a streamUrl exists, so the shared
 *  useAgentThinkingStream hook never opens its harness-run-log default URL
 *  (it only skips that when `streamUrl` is already truthy at call time). */
function LiveSessionChat({
  streamUrl,
  agentName,
  onSend,
  sending,
  sendError,
}: {
  streamUrl: string;
  agentName: string;
  onSend: (text: string) => void;
  sending: boolean;
  sendError: string | null;
}) {
  const { events, status, thinking } = useAgentThinkingStream('', '', '', streamUrl);
  const messages = useMemo(() => sessionTimelineToChatMessages(events), [events]);

  let banner: ReactNode = null;
  if (status === 'connecting' && events.length === 0) {
    banner = <div style={BANNER_STYLE}>Connecting to the live session…</div>;
  } else if (status === 'error') {
    banner = <div style={ERROR_BANNER_STYLE}>Lost the live connection — retrying…</div>;
  } else if (status === 'live' && messages.length === 0) {
    banner = <div style={BANNER_STYLE}>No conversation text in this session yet.</div>;
  }

  return (
    <OperatorChat
      messages={messages}
      busy={sending}
      peerBusy={thinking}
      passive
      onSend={onSend}
      banner={banner}
      error={sendError}
      agentName={agentName}
    />
  );
}

export default function SessionChatModal({
  sessionOwnerId,
  ownerLabel,
  onClose,
}: {
  /** The inbox item's ownerAgentId — null hides the modal. */
  sessionOwnerId: string | null;
  /** Friendly display label, when the caller has one (falls back to the raw id). */
  ownerLabel?: string | null;
  onClose: () => void;
}) {
  const [resolved, setResolved] = useState<SessionListRow | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentOk, setSentOk] = useState(false);

  const open = sessionOwnerId !== null;
  // P-008: this owner's pending coord-escalation(s) with named options — the
  // SAME shared `plans.attention` feed InboxPane/the Queue read (no new
  // query), filtered to what's actionable for THIS agent right now. Disabled
  // while closed so a hidden modal never holds an extra live query open.
  const { items: attentionItems, refresh: refreshAttention } = useInboxAttention(open);
  const pendingEscalations = useMemo(
    () =>
      attentionItems.filter(
        (i) =>
          i.ownerAgentId === sessionOwnerId &&
          i.kind === 'coord-escalation' &&
          effectiveTier(i) !== 'handled' &&
          isEscalationWithOptions(i),
      ),
    [attentionItems, sessionOwnerId],
  );

  useEffect(() => {
    setResolved(null);
    setResolveError(null);
    setSendError(null);
    setSentOk(false);
    if (!sessionOwnerId) return;
    let cancelled = false;
    setResolving(true);
    resolveOwnerClaudeSession(sessionOwnerId)
      .then((s) => {
        if (!cancelled) setResolved(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setResolveError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionOwnerId]);

  const streamUrl = useMemo(() => {
    if (!sessionOwnerId || !resolved) return null;
    const p = new URLSearchParams({ sessionId: resolved.session_id, owner: sessionOwnerId });
    return `/api/adv/session/thinking?${p.toString()}`;
  }, [sessionOwnerId, resolved]);

  const handleSend = (text: string) => {
    if (!sessionOwnerId) return;
    setSendError(null);
    setSentOk(false);
    setSending(true);
    sendToSessionOwner(sessionOwnerId, text)
      .then(() => setSentOk(true))
      .catch((e: unknown) => setSendError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSending(false));
  };

  const agentName = ownerLabel || sessionOwnerId || 'agent session';
  const title = `Chat — ${agentName}`;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      contentStyle={{
        width: 'min(720px, 92vw)',
        height: 'min(80vh, 820px)',
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }} data-testid="session-chat-modal">
        {pendingEscalations.length > 0 ? (
          <div
            style={{ flex: '0 0 auto', maxHeight: '45%', overflowY: 'auto', borderBottom: '1px solid var(--border)' }}
            data-testid="session-chat-pending-escalations"
          >
            {pendingEscalations.map((i) => (
              // key remounts per item so its local card state (answered/discuss)
              // resets on selection change — same contract as OtherDetail's other
              // hosts (InboxPane, the Queue's PlansClient).
              <OtherDetail key={i.id} item={i} onResolved={refreshAttention} />
            ))}
          </div>
        ) : null}
        {resolving ? (
          <div style={BANNER_STYLE}>Finding this agent's session…</div>
        ) : resolveError ? (
          // WI-5364: friendly headline first — the raw transport error (status
          // codes, JSON) is real diagnostic signal but not owner-facing copy,
          // so it rides below in small muted mono instead of leading.
          <div style={ERROR_BANNER_STYLE} data-testid="session-chat-resolve-error">
            <div>Couldn't load this agent's conversation right now — try reopening the popup.</div>
            <div style={{ marginTop: 4, fontSize: 10, fontFamily: 'var(--font-mono, monospace)', color: 'var(--fg-mute)', overflowWrap: 'anywhere' }}>
              {resolveError}
            </div>
          </div>
        ) : !resolved ? (
          <div style={BANNER_STYLE}>No recent Claude session found for this agent.</div>
        ) : streamUrl ? (
          <LiveSessionChat
            streamUrl={streamUrl}
            agentName={agentName}
            onSend={handleSend}
            sending={sending}
            sendError={sendError}
          />
        ) : null}
        {sentOk ? <div style={BANNER_STYLE}>Sent — the agent is woken if it's live.</div> : null}
      </div>
    </Modal>
  );
}
