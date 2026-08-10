'use client';

/**
 * The wiring behind a live agent conversation, apart from any one surface that
 * renders it (goals-tab-improvement-2026-08-09 D-011).
 *
 * WHY THIS MODULE EXISTS. `SessionChatModal` grew all of this inline, so the
 * *renderer* (`LiveSessionChat` → `OperatorChat` → `ChatConversation`) was
 * reusable but the wiring around it was not: resolving the owner's session,
 * building the SSE `streamUrl`, and the send state machine. The goal popup now
 * embeds the same conversation (D-011), and copying that wiring would have
 * forked it — the exact thing D-005 ("generalize OperatorChat... never fork a
 * second chat renderer") exists to prevent, one layer down.
 *
 * The stakes are concrete rather than stylistic. `buildSessionStreamUrl`
 * carries the `ended=1` archive fallback (EI-16982) — an ended session's
 * transcript is GC'd within ~2h, and without that flag the backend's
 * rematerialize path silently never fires. `useSessionSend` carries P-002's
 * echo ordering: the message is recorded BEFORE the await so it appears the
 * instant you hit enter, and un-renders if the send fails. A second copy of
 * either would not look broken — it would just quietly lack a fix that was
 * expensive to find the first time.
 *
 * DIRECTION: this module imports nothing from `SessionChatModal`; the modal
 * imports from here. Keeping one direction is what makes the extraction safe
 * to reuse from a second surface without a cycle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { recordSentEcho, settleSentEcho } from './sent-message-echo';

export interface SessionListRow {
  source_kind: string;
  session_id: string;
  active?: boolean;
  last_ts: string | null;
}

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

/**
 * What actually happened to a sent message — P-002 (the wake-mode correctness
 * bug).
 *
 * The old banner said "Sent — the agent is woken if it's live" unconditionally,
 * which is not a claim this code was ever in a position to make. Two routine
 * states make it false:
 *   - the agent is in `coord:wake-mode` MANUAL, where wakes are STAGED for the
 *     owner to release rather than delivered. The message is real and queued,
 *     but the agent is not working on it and will not until released;
 *   - no live session picked the wake up at all (`recipient_absent`).
 * Both reported as unqualified success, which is the worst kind of wrong: the
 * human walks away believing they have asked for something.
 *
 * Rather than pre-reading wake-mode and guessing, we report what the send
 * RESPONSE says — the authority on what the platform did with it. That also
 * catches the absent case for free, which a wake-mode pre-check would not.
 */
export type SendDelivery =
  | { kind: 'woken'; count: number }
  | { kind: 'staged' }
  | { kind: 'absent' }
  | { kind: 'queued' };

/** Read the delivery outcome out of a coord:send response. PURE → unit-tested. */
export function deliveryFromSendResponse(body: unknown): SendDelivery {
  const first = (body as { results?: Array<Record<string, unknown>> } | null)?.results?.[0];
  if (!first) return { kind: 'queued' };
  const wake = first.wake as { woken?: number; staged?: number | boolean } | undefined;
  if (wake) {
    if (typeof wake.woken === 'number' && wake.woken > 0) return { kind: 'woken', count: wake.woken };
    // A staged wake is the manual-mode case: accepted, held for release.
    if (wake.staged) return { kind: 'staged' };
  }
  if (first.recipient_absent === true) return { kind: 'absent' };
  if (first.staged === true) return { kind: 'staged' };
  // Delivered to the inbox with no wake attempted/reported — it will be read at
  // the agent's next turn. Honest middle ground, not a claim of attention.
  return { kind: 'queued' };
}

/** Send a live message to the session's owner. Exported for tests. */
export async function sendToSessionOwner(ownerId: string, body: string): Promise<SendDelivery> {
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
  // A non-JSON 200 is not a failure to report to the user — the message WAS
  // accepted; we simply cannot characterise the delivery. Degrade to the
  // weakest honest claim rather than inventing a stronger one.
  try {
    return deliveryFromSendResponse(JSON.parse(text));
  } catch {
    return { kind: 'queued' };
  }
}

/** The search deep-link params. All absent on an ordinary open, which leaves
 *  the stream on its unchanged tail backfill. */
export interface SessionStreamFocus {
  /** Stream the session the MATCH is in, not the owner's latest. */
  focusSessionId?: string | null;
  focusTerm?: string | null;
  focusAnchorTs?: string | null;
}

/**
 * Build the `/api/adv/session/thinking` SSE URL. PURE → unit-tested.
 *
 * Returns null when there is nothing to stream yet, which is the signal the
 * renderer must NOT be mounted: `useAgentThinkingStream` only skips its
 * harness-run-log default URL when `streamUrl` is already truthy at call time.
 */
export function buildSessionStreamUrl(
  ownerId: string | null,
  resolved: SessionListRow | null,
  focus: SessionStreamFocus = {},
): string | null {
  if (!ownerId || !resolved) return null;
  /* A search deep-link streams the session the MATCH is in, not the owner's
     latest. When they differ the target is by definition an earlier link in the
     respawn chain and therefore ended, so it also needs `ended=1` below to
     reach the rematerialize-from-archive fallback (EI-16982);
     `resolved.active` describes the LATEST session and would say otherwise. */
  const streamSessionId = focus.focusSessionId || resolved.session_id;
  const isEarlierSession = streamSessionId !== resolved.session_id;
  const p = new URLSearchParams({ sessionId: streamSessionId, owner: ownerId });
  // EI-16982: an ended session's on-disk transcript is routinely GC'd within
  // ~2h of archiving (session-dir-gc.ts); the backend already has a
  // rematerialize-from-archive fallback (WI-3990) gated on `ended=1`, but it
  // silently never fires unless the caller passes it. `resolved.active` is the
  // server-stamped liveness we already have in hand here — reuse it rather than
  // inventing a new signal.
  if (resolved.active === false || isEarlierSession) p.set('ended', '1');
  /* `find` + `anchorTs` are the route's EXISTING contract
     (session-anchor-window.ts): it streams the whole transcript through a
     bounded collector and returns a window CENTERED on the matched entry, then
     emits an `anchor` event naming it. Without them the route backfills the
     TAIL, and a search hit is almost never in the tail. */
  if (focus.focusTerm) p.set('find', focus.focusTerm);
  if (focus.focusAnchorTs) p.set('anchorTs', focus.focusAnchorTs);
  return `/api/adv/session/thinking?${p.toString()}`;
}

export interface OwnerSessionChat {
  /** Null until the session resolves — and the gate on mounting the renderer. */
  streamUrl: string | null;
  resolved: SessionListRow | null;
  resolving: boolean;
  resolveError: string | null;
  send: (text: string) => void;
  sending: boolean;
  sendError: string | null;
  /** The DELIVERY OUTCOME of the last send, not a boolean. Null = none yet. */
  sentOk: SendDelivery | null;
}

/**
 * Everything a surface needs to host one agent's live conversation.
 *
 * Pass `ownerId: null` when there is no agent (or the host is closed) — the
 * hook resolves nothing, opens no stream, and returns a null `streamUrl`. That
 * is deliberate rather than incidental: a closed or agent-less host must not
 * hold a live query open, and D-011 requires that an agent-less goal render a
 * plain statement rather than an inert composer.
 */
export function useOwnerSessionChat(
  ownerId: string | null,
  focus: SessionStreamFocus = {},
): OwnerSessionChat {
  const [resolved, setResolved] = useState<SessionListRow | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentOk, setSentOk] = useState<SendDelivery | null>(null);

  useEffect(() => {
    setResolved(null);
    setResolveError(null);
    setSendError(null);
    setSentOk(null);
    if (!ownerId) return;
    let cancelled = false;
    setResolving(true);
    resolveOwnerClaudeSession(ownerId)
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
  }, [ownerId]);

  const { focusSessionId, focusTerm, focusAnchorTs } = focus;
  const streamUrl = useMemo(
    () => buildSessionStreamUrl(ownerId, resolved, { focusSessionId, focusTerm, focusAnchorTs }),
    [ownerId, resolved, focusSessionId, focusTerm, focusAnchorTs],
  );

  const send = useCallback(
    (text: string) => {
      if (!ownerId) return;
      setSendError(null);
      setSentOk(null);
      setSending(true);
      /* P-002: record the send BEFORE awaiting it, so the message appears in the
         transcript the instant you hit enter rather than a round-trip later. The
         optimism is settled either way below — a failed send un-renders (the
         error banner is what reports it), because a message that never left must
         not sit in the conversation looking like part of it. */
      const echoId = recordSentEcho(ownerId, text);
      sendToSessionOwner(ownerId, text)
        .then((delivery) => {
          setSentOk(delivery);
          settleSentEcho(ownerId, echoId, 'sent');
        })
        .catch((e: unknown) => {
          setSendError(e instanceof Error ? e.message : String(e));
          settleSentEcho(ownerId, echoId, 'failed');
        })
        .finally(() => setSending(false));
    },
    [ownerId],
  );

  return { streamUrl, resolved, resolving, resolveError, send, sending, sendError, sentOk };
}
