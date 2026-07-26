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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Modal } from '../../harness/Modal';
import { OperatorChat } from '../OperatorChat';
import { useAgentThinkingStream } from '../../harness/AgentThinkingStream';
import { sessionTimelineToChatMessages } from './session-transcript-mapping';
import { effectiveTier, useInboxAttention } from '../inbox/use-inbox-pending';
import { OtherDetail } from '@/app/admin/plans/PlanOtherList';
import { isEscalationWithOptions } from '@/app/admin/plans/attention-card';
import { ChatActionBar } from './ChatActionBar';
import FleetRoleGlyph from '../FleetRoleGlyph';
import { LocalCardHost } from './LocalCardHost';
import AgentDossier from '../../adv/sessions/AgentDossier';
import type { RosterEntry } from '../../adv/sessions/SessionsRosterView';
// hud-first-nav-and-dossier-2026-07-26 P-004: the footer's liveness dot +
// its "N locks / M unread" summary-chip counts. Imported from the standalone
// use-agent-detail module (not AgentDossier.tsx, which SessionChatModal.test.tsx
// mocks wholesale) so this hook keeps working under that mock.
import { LivenessDot } from '@/app/coord/presence-ui';
import { useAgentDetail } from '../../adv/sessions/use-agent-detail';
import type { ChatActionContext } from '@/lib/chat-actions/types';
import type { ChatMessage } from './ChatConversation';
import {
  contextPct,
  deriveBadges,
  formatAge,
  HUD_DEFAULT_THRESHOLDS,
  isInfrastructureAwait,
  shortHandle,
  type HudBadge,
  type HudRosterEntry,
} from '../../adv/hud/hud-board-model';
// OtherDetail's styles (pc-items__*, pc-tier/pc-kind badges) — global CSS, so
// importing it here (as InboxPane already does) makes this modal
// self-sufficient wherever it's mounted.
import '@/app/admin/plans/plans.css';
// hud__handle / hud__chip / hud__chip--accent — reused by the identity chip
// (P-012) below, rather than re-declaring the same look under a new class.
import '../../adv/hud/hud.css';
// pc-dossier__* — hud-first-nav-and-dossier-2026-07-26 P-003: the right rail
// below reuses AgentDossier verbatim (no forked dossier), so its stylesheet
// rides along the same way hud.css/plans.css already do for their own reused
// pieces.
import '../../adv/sessions/SessionsRosterView.css';

/** The roster payload shape (advRoster.list). Inlined, never imported from the
 *  server module — same rationale as HudView.tsx's identical inline type
 *  (importing it would drag PG/node builtins into the SPA bundle). */
interface RosterPayload {
  active: HudRosterEntry[];
  pending?: HudRosterEntry[];
}

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

// hud-first-nav-and-dossier-2026-07-26 P-003: the AgentDossier right rail.
// Side-by-side on a wide window (the Modal's own contentStyle widens to make
// room, below in the component); on a narrow window it renders as an
// overlaying drawer instead, so it never crushes the transcript column.
const DOSSIER_RAIL_SIDE_STYLE: React.CSSProperties = {
  flex: '0 0 300px',
  width: 300,
  minWidth: 0,
  minHeight: 0,
  borderLeft: '1px solid var(--border)',
  overflowY: 'auto',
};

const DOSSIER_RAIL_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  right: 0,
  width: 'min(320px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  borderLeft: '1px solid var(--border)',
  boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  zIndex: 5,
};

const DOSSIER_TOGGLE_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  zIndex: 6,
  fontSize: 11,
  lineHeight: 1,
  padding: '4px 9px',
};

/** Narrow-viewport breakpoint below which the dossier rail stops sitting
 *  side-by-side and becomes a collapsible overlay drawer instead — same
 *  matchMedia + useEffect pattern BrainstormFull.tsx already uses for its own
 *  compact-layout switch. */
const DOSSIER_NARROW_MEDIA_QUERY = '(max-width: 860px)';

function useIsNarrowViewport(query: string): boolean {
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia(query);
    const sync = () => setIsNarrow(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [query]);
  return isNarrow;
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

/** Same tone→class mapping HudBoard.tsx uses for its badge chips (P-007) —
 *  duplicated rather than imported: HudBoard.tsx is a page-level component,
 *  not a shared chip-rendering module, and the mapping is 4 lines. */
const FOOTER_CHIP_TONE_CLASS: Record<HudBadge['tone'], string> = {
  neutral: '',
  accent: 'hud__chip--accent',
  good: 'hud__chip--good',
  warn: 'hud__chip--warn',
  bad: 'hud__chip--bad',
};

function footerChipClass(b: HudBadge): string {
  const tone = FOOTER_CHIP_TONE_CLASS[b.tone];
  if (b.kind !== 'mode') return `hud__chip ${tone}`;
  return `hud__chip ${tone} hud__chip--mode${b.ownerDirected ? ' hud__chip--mode-owner' : ''}`;
}

/**
 * P-007: the session status row rendered under the composer — built ENTIRELY
 * from the SAME advRoster.list entry the identity chip (P-012) already
 * fetches (no new query, no new endpoint). INFORMATIONAL only (D-002): no
 * click handlers, no write path — mode CONTROL lives in the chat action bar
 * (Lane B's P-004), not here. `objective` = the roster's declared `intent`;
 * model/effort are NOT on the roster entry and are omitted rather than
 * guessed at.
 *
 * hud-first-nav-and-dossier-2026-07-26 P-004 (D-002's glance-frequency
 * split): the footer owns exactly what CHANGES while you read the
 * conversation — liveness, context %, current claim (the claims-progress
 * badge below), mode chips, awaiting-gate. Identity/reference fields that
 * duplicated the AgentDossier panel verbatim (the short handle, the plan
 * slug, the intent line — all re-shown by the panel's own header/meta rows,
 * P-003) were REMOVED from here rather than kept in both places; they're
 * still one click away via the dossier rail (default open) or the modal
 * title bar. Fleet role/slug stay: the panel never showed them, so they are
 * not a duplicate to remove.
 */
function SessionFooter({
  entry,
  onOpenDetail,
}: {
  entry: HudRosterEntry;
  /** D-002's ONE deliberate duplicate: the footer's "⚠ N locks / M unread"
   *  chip opens (if collapsed) and scrolls the dossier rail to the named
   *  section — "the glance stays in the reading path, the detail moves." */
  onOpenDetail?: (section: 'locks' | 'coord') => void;
}) {
  // A live ticking clock so context/age readings stay current without a new
  // fetch — same pattern + tick cadence as HudView.tsx's board clock.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const pct = contextPct(entry.contextTokens, entry.compactionLimit);
  // deriveBadges' own ctx chip is threshold-gated (only once it's getting
  // full); the footer shows the number unconditionally below, so drop the
  // derived duplicate rather than double-render it. deriveBadges assumes
  // modes/claims/currentFiles are always arrays (true for a real roster
  // payload) — default them defensively so a partial/stale entry can't
  // throw mid-render (`e.claims.length` etc. on undefined).
  const badges = useMemo(() => {
    const normalized: HudRosterEntry = {
      ...entry,
      modes: entry.modes ?? [],
      claims: entry.claims ?? [],
      currentFiles: entry.currentFiles ?? [],
    };
    return deriveBadges(normalized, { nowMs, thresholds: HUD_DEFAULT_THRESHOLDS }).filter((b) => b.id !== 'ctx');
  }, [entry, nowMs]);
  const awaitText =
    entry.openAwait && !isInfrastructureAwait(entry.openAwait)
      ? entry.openAwait.note?.trim() || `Waiting on ${entry.openAwait.eventKey}`
      : null;

  // P-004: the SAME agentDetail.byOwner cache AgentDossier's own Locks/Coord
  // sections read (useSyncQuery shares its cache by {queryName, args} — a
  // second reader, not a second fetch) — just enough to size the summary
  // chip's counts, without the full dossier DTO plumbed down as a prop.
  const { detail } = useAgentDetail(entry.ownerId);
  const locksCount = (detail?.locks.held.length ?? 0) + (detail?.locks.waiting.length ?? 0);
  const unreadCount = detail?.coord.unreadCount ?? 0;
  const detailChipLabel = [
    locksCount > 0 ? `${locksCount} lock${locksCount === 1 ? '' : 's'}` : null,
    unreadCount > 0 ? `${unreadCount} unread` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="oracle-session-footer" data-testid="session-chat-footer">
      <div className="oracle-session-footer-row">
        <LivenessDot liveness={entry.liveness} />
        <span className="oracle-session-footer-liveness">{entry.liveness}</span>
        {pct != null ? (
          <span
            className="oracle-session-footer-ctx"
            title={`${entry.contextTokens ?? '?'} / ${entry.compactionLimit ?? '?'} tokens`}
          >
            ctx {pct}%
          </span>
        ) : null}
        {detailChipLabel ? (
          <button
            type="button"
            className="oracle-session-footer-detail-chip"
            onClick={() => onOpenDetail?.(locksCount > 0 ? 'locks' : 'coord')}
            title="Open the agent detail panel to this section"
            data-testid="session-chat-footer-detail-chip"
          >
            ⚠ {detailChipLabel}
          </button>
        ) : null}
      </div>
      {badges.length > 0 || awaitText ? (
        <div className="hud__chips">
          {awaitText ? (
            <span className="hud__chip hud__chip--warn" title={entry.openAwait?.eventKey}>
              ⏳ {awaitText}
            </span>
          ) : null}
          {badges.map((b) => (
            <span key={b.id} className={footerChipClass(b)} title={b.title}>
              {b.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The live half — only mounted once a streamUrl exists, so the shared
 *  useAgentThinkingStream hook never opens its harness-run-log default URL
 *  (it only skips that when `streamUrl` is already truthy at call time). */
function LiveSessionChat({
  streamUrl,
  sessionOwnerId,
  agentName,
  onSend,
  sending,
  sendError,
  onOpenDetail,
}: {
  streamUrl: string;
  /** The su agent this session belongs to — resolves its roster entry for the
   *  identity chip (P-012). */
  sessionOwnerId: string;
  agentName: string;
  onSend: (text: string) => void;
  sending: boolean;
  sendError: string | null;
  /** P-004: forwarded to SessionFooter's summary chip — see its own doc. */
  onOpenDetail?: (section: 'locks' | 'coord') => void;
}) {
  const { events, status, thinking } = useAgentThinkingStream('', '', '', streamUrl);

  // P-012: the SAME advRoster.list sync query the HUD/Sessions roster read
  // (shared cache, no new endpoint) — narrowed to this session's owner so the
  // chip can reuse fleetColor/fleetRole exactly as the HUD derives them.
  // Computed BEFORE `messages` (WI-5997): its `currentPlanSlug` is the
  // per-message `planSlug` source those messages are stamped with below.
  const roster = useSyncQuery<RosterPayload>({
    queryName: 'advRoster.list',
    args: { workspaceId: null, endedLimit: 50 },
  });
  const rosterEntry = useMemo<HudRosterEntry | null>(() => {
    const payload = roster.data?.[0];
    if (!payload) return null;
    const entries = [...(payload.active ?? []), ...(payload.pending ?? [])];
    return entries.find((e) => e.ownerId === sessionOwnerId) ?? null;
  }, [roster.data, sessionOwnerId]);

  // WI-5997: stamp every mapped message with this session's roster
  // currentPlanSlug so a P-NNN ref pill's click can resolve which plan to
  // open (D-001 PlanPopupModal) — an approximation (uniform across the whole
  // session, not truly per-message-historical) but the one available with no
  // new query. `undefined` (no roster entry / no active plan) degrades to the
  // pre-fix behavior: a P-ref pill still renders, just stays a static link
  // (ChatMessageContent/HydratedWorkRefPill's existing no-plan-context stance).
  const messages = useMemo(
    () => sessionTimelineToChatMessages(events, rosterEntry?.currentPlanSlug),
    [events, rosterEntry?.currentPlanSlug],
  );

  // D-004: the chip is READ-ONLY (no click handler) — a plain span, only for
  // the assistant's own turns (user turns keep the default 'You' avatar).
  const renderAvatar = useCallback(
    (m: ChatMessage): ReactNode | null => {
      if (m.role !== 'assistant' || !rosterEntry) return null;
      return (
        <span
          className="oracle-msg-avatar oracle-msg-avatar--identity"
          aria-hidden="true"
          style={
            rosterEntry.fleetColor
              ? ({ '--hud-fleet': rosterEntry.fleetColor } as React.CSSProperties)
              : undefined
          }
        >
          <span className="hud__handle">{shortHandle(rosterEntry.ownerId)}</span>
          {rosterEntry.fleetRole === 'leader' ? (
            <FleetRoleGlyph role="leader" className="hud__role" />
          ) : null}
        </span>
      );
    },
    [rosterEntry],
  );

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
      renderAvatar={renderAvatar}
      footer={rosterEntry ? <SessionFooter entry={rosterEntry} onOpenDetail={onOpenDetail} /> : null}
      // chat-ref-pills-2026-07-26 P-008: scopes this session's WI-/EI-/F- ref
      // pills (live hydration + the popup destination) to the harness the
      // roster attributes this agent's spawned run to — the SAME roster
      // entry the identity chip (P-012) and footer (P-007) already read, no
      // new query. Null (no matching spawned-agent run, e.g. an interactive
      // psu session) degrades to static pills, same as any other
      // unscoped conversation.
      harnessSlug={rosterEntry?.harnessSlug ?? undefined}
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
    // EI-16982: an ended session's on-disk transcript is routinely GC'd within
    // ~2h of archiving (session-dir-gc.ts); the backend already has a
    // rematerialize-from-archive fallback (WI-3990) gated on `ended=1`, but it
    // silently never fires unless the caller passes it. `resolved.active` is
    // the server-stamped liveness we already have in hand here — reuse it
    // rather than inventing a new signal.
    if (resolved.active === false) p.set('ended', '1');
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

  // gui-chat-session-controls-2026-07-25 P-002: the bottom-of-chat action
  // bar's context bag. Concrete actions (posture P-004, grade P-005, session
  // actions P-006, identity P-012) extend this via their own ctx fields —
  // this modal only owns the two fields every action can rely on.
  // P-006 (session actions): the SAME advRoster.list query LiveSessionChat
  // uses for the identity chip (P-012) — useSyncQuery shares its cache by
  // {queryName, args}, so this is a second READER of the same cached data,
  // not a second fetch. Needed here (not just in the child) because the
  // action bar's ctx is built in THIS component's scope.
  const actionRoster = useSyncQuery<RosterPayload>({
    queryName: 'advRoster.list',
    args: { workspaceId: null, endedLimit: 50 },
  });
  const actionRosterEntry = useMemo<HudRosterEntry | null>(() => {
    const payload = actionRoster.data?.[0];
    if (!payload) return null;
    const entries = [...(payload.active ?? []), ...(payload.pending ?? [])];
    return entries.find((e) => e.ownerId === sessionOwnerId) ?? null;
  }, [actionRoster.data, sessionOwnerId]);

  // hud-first-nav-and-dossier-2026-07-26 P-003: the SAME advRoster.list row
  // (actionRoster, already fetched above for the action bar — no new query)
  // re-read as a RosterEntry (AgentDossier's own prop shape) instead of
  // HudRosterEntry. Both are independently-inlined TS projections of the
  // identical server payload (same rationale as this file's own RosterPayload
  // duplicate of hud-board-model's), so the already-fetched row structurally
  // satisfies RosterEntry at runtime even though it was fetched under a
  // narrower type — cast rather than re-query.
  const dossierEntry = useMemo<RosterEntry | null>(() => {
    if (!actionRosterEntry) return null;
    return actionRosterEntry as unknown as RosterEntry;
  }, [actionRosterEntry]);

  // Open/collapsed state via nuqs (never useState) — deep-linkable + agent
  // -driveable, per the plan item's requirement. Defaults open: every
  // conversation opened from the HUD should carry the dossier unless the
  // viewer collapses it (or the viewport is too narrow to show it side-by-
  // side, handled separately by isNarrow below).
  const [dossierOpen, setDossierOpen] = useQueryState('chatDossier', parseAsBoolean.withDefault(true));
  const isNarrow = useIsNarrowViewport(DOSSIER_NARROW_MEDIA_QUERY);

  // hud-first-nav-and-dossier-2026-07-26 P-004 (D-002's one deliberate
  // duplicate): the footer's "⚠ N locks / M unread" chip opens the rail
  // (it may be collapsed) and scrolls it to the named section — a plain DOM
  // query rather than plumbing a ref down through AgentDossier, since the
  // rail and the footer are siblings under this component, not parent/child.
  const scrollToDossierSection = useCallback(
    (section: 'locks' | 'coord') => {
      void setDossierOpen(true);
      // Wait a frame so a just-opened rail has mounted before we query it.
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-testid="session-chat-dossier-rail"] #pc-dossier-${section}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    [setDossierOpen],
  );

  const actionCtx: ChatActionContext | null = useMemo(
    () =>
      sessionOwnerId
        ? {
            sessionOwnerId,
            ownerLabel,
            // P-006 (session actions): the resolved Claude session id + the
            // roster entry's agent/advSessionId/windowId.
            agent: actionRosterEntry?.agent ?? null,
            sessionId: resolved?.session_id ?? null,
            advSessionId: actionRosterEntry?.advSessionId ?? null,
            windowId: actionRosterEntry?.windowId ?? null,
          }
        : null,
    [sessionOwnerId, ownerLabel, actionRosterEntry, resolved],
  );

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
        // hud-first-nav-and-dossier-2026-07-26 P-003: widen to make room for
        // the dossier rail when it's open AND there's room to show it
        // side-by-side; on a narrow viewport the rail overlays instead
        // (DOSSIER_RAIL_OVERLAY_STYLE below), so the modal stays at its
        // original width rather than crushing the transcript.
        width: dossierOpen && !isNarrow ? 'min(1040px, 96vw)' : 'min(720px, 92vw)',
        height: 'min(80vh, 820px)',
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', position: 'relative' }}
        data-testid="session-chat-modal"
      >
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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
        ) : streamUrl && sessionOwnerId ? (
          <LiveSessionChat
            streamUrl={streamUrl}
            sessionOwnerId={sessionOwnerId}
            agentName={agentName}
            onSend={handleSend}
            sending={sending}
            sendError={sendError}
            onOpenDetail={scrollToDossierSection}
          />
        ) : null}
        {sentOk ? <div style={BANNER_STYLE}>Sent — the agent is woken if it's live.</div> : null}
        {actionCtx && (
          <>
            {/* Renders whatever askUserLocal card an action's params()/confirm
                step opens (P-002 substrate) — the SAME renderer the
                agent-initiated card path uses, mounted here so action-bar
                cards appear inline in this modal specifically. */}
            <LocalCardHost />
            <ChatActionBar ctx={actionCtx} />
          </>
        )}
      </div>
        {open && dossierOpen ? (
          <div
            data-testid="session-chat-dossier-rail"
            style={isNarrow ? DOSSIER_RAIL_OVERLAY_STYLE : DOSSIER_RAIL_SIDE_STYLE}
          >
            <AgentDossier
              ownerId={sessionOwnerId ?? ''}
              entry={dossierEntry}
              onClose={() => void setDossierOpen(false)}
            />
          </div>
        ) : null}
        {open ? (
          <button
            type="button"
            className="pc-button"
            onClick={() => void setDossierOpen(!dossierOpen)}
            aria-pressed={dossierOpen}
            aria-label={dossierOpen ? 'Hide agent detail' : 'Show agent detail'}
            data-testid="session-chat-dossier-toggle"
            style={DOSSIER_TOGGLE_STYLE}
          >
            {dossierOpen ? 'Hide detail ›' : '‹ Detail'}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
