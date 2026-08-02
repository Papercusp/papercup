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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryState, parseAsBoolean, parseAsStringLiteral } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { Modal } from '../../harness/Modal';
import { Tooltip } from '../../harness/Tooltip';
import { OperatorChat } from '../OperatorChat';
import { useAgentThinkingStream } from '../../harness/AgentThinkingStream';
import { sessionTimelineToChatMessages } from './session-transcript-mapping';
import { effectiveTier, useInboxAttention } from '../inbox/use-inbox-pending';
import { OtherDetail } from '@/app/admin/plans/PlanOtherList';
import { isEscalationWithOptions } from '@/app/admin/plans/attention-card';
import { ChatActionBar } from './ChatActionBar';
import FleetRoleGlyph from '../FleetRoleGlyph';
import FleetLaunchRow from './FleetLaunchRow';
import { LocalCardHost } from './LocalCardHost';
import AgentDossier from '../../adv/sessions/AgentDossier';
// P-015: the ORDERS panel — what the agent was TOLD (mission/authority,
// modes + who set them, owner directives, standing facts, walls, carry brief).
// Sibling of the dossier, opposite edge; see ORDERS_RAIL_SIDE_STYLE below.
import AgentOrders from '../../adv/sessions/AgentOrders';
import type { RosterEntry } from '../../adv/sessions/SessionsRosterView';
// hud-first-nav-and-dossier-2026-07-26 P-004: the footer's liveness dot +
// its "N locks / M unread" summary-chip counts. Imported from the standalone
// use-agent-detail module (not AgentDossier.tsx, which SessionChatModal.test.tsx
// mocks wholesale) so this hook keeps working under that mock.
import { LivenessDot } from '@/app/coord/presence-ui';
import { useAgentDetail } from '../../adv/sessions/use-agent-detail';
import type { ChatActionContext } from '@/lib/chat-actions/types';
import { Maximize, Maximize2, Minimize, Minimize2, Terminal, X } from 'lucide-react';
import { AGENT_MARKS, type ChatMessage } from './ChatConversation';
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
// P-003: the control VOCABULARY (pc-ctl-*) — the five shapes that make a label,
// a button and a mode tell themselves apart. Loaded here because this modal is
// the surface Direction D restyles; see chat-controls.css's own header for the
// grammar and the two repo rails (letter-spacing:0, no flex on a <button>).
import './chat-controls.css';
import { advRosterArgs } from '@/lib/adv-roster-args';
// P-001 full-screen: in the desktop shell the DOM Fullscreen API cannot leave
// the webview, so "fill the display" has to drive the WINDOW. See that module's
// header for why the two mechanisms are not interchangeable.
import {
  enterDesktopWindowFullscreen,
  exitDesktopWindowFullscreen,
  isDesktopShell,
} from '@/lib/desktop-window-fullscreen';

/** The roster payload shape (advRoster.list). Inlined, never imported from the
 *  server module — same rationale as HudView.tsx's identical inline type
 *  (importing it would drag PG/node builtins into the SPA bundle). */
interface RosterPayload {
  active: HudRosterEntry[];
  pending?: HudRosterEntry[];
  /** WI-6376's launch-record tier: sessions whose launch is durably recorded but
   *  which have not registered in the roster yet. WI-6440 reads it here so the
   *  boot window survives a reload — see `startingEntry` below. Deduped against
   *  `active` server-side, so a row here is authoritatively still booting. */
  starting?: HudRosterEntry[];
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

/** WI-6367: how long a just-launched session may take to register before the
 *  modal stops saying "starting up" and admits it did not come online. Sized
 *  well past a normal psu boot (a few seconds) so a slow-but-fine launch is
 *  never mislabelled as failed. */
const STARTUP_GRACE_MS = 60_000;

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

/* DOSSIER_TOGGLE_STYLE was here. The detail toggle moved into the shared
   maximize toolbar (CHAT_TOOLBAR_STYLE below) so the popup has ONE cluster of
   window controls rather than a lone button in the corner and two more beside
   it — session-chat-popup-direction-d-2026-08-02 P-001. */

/** Narrow-viewport breakpoint below which the dossier rail stops sitting
 *  side-by-side and becomes a collapsible overlay drawer instead — same
 *  matchMedia + useEffect pattern BrainstormFull.tsx already uses for its own
 *  compact-layout switch. */
const DOSSIER_NARROW_MEDIA_QUERY = '(max-width: 860px)';

/* ── session-chat-popup-direction-d-2026-08-02 P-015: the ORDERS panel ───────
   The second panel [owner 2026-08-02: "Two panels: told on the left, did on
   the right"]. It sits on the LEFT so the three columns read in causal order —
   what the agent was TOLD → the conversation → what the agent DID.

   It is a SIBLING of the conversation region, exactly like the dossier rail, so
   P-001's D-002 keeps holding without a second rule: maximize paints the
   conversation element's subtree, and both panels are outside it. Do NOT move a
   panel inside that element to make it visible in fullscreen — that silently
   breaks the scoping invariant and nothing in the tree would catch it. */
const ORDERS_RAIL_SIDE_STYLE: React.CSSProperties = {
  flex: '0 0 272px',
  width: 272,
  minWidth: 0,
  minHeight: 0,
  borderRight: '1px solid var(--border)',
  overflowY: 'auto',
};

/* Orders collapses at a WIDER breakpoint than the dossier (860px) on purpose:
   when space runs out the left panel goes first. It is the more static of the
   two — orders change when a mode flips or a fact is asserted, activity changes
   every turn — so losing it costs the reader least. */
const ORDERS_NARROW_MEDIA_QUERY = '(max-width: 1180px)';

/* Below that breakpoint Orders overlays instead of taking a column — the same
   trade the dossier already makes. Overlaying rather than simply not rendering
   matters: a toggle that silently does nothing on a narrow window reads as a
   broken button, not as a layout decision. */
const ORDERS_RAIL_OVERLAY_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: 0,
  width: 'min(300px, 88vw)',
  background: 'var(--bg-popover, #0d1829)',
  borderRight: '1px solid var(--border)',
  boxShadow: '8px 0 24px rgba(0,0,0,0.35)',
  overflowY: 'auto',
  zIndex: 5,
};

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

/* ── Maximize (session-chat-popup-direction-d-2026-08-02 P-001) ─────────────
 *
 * [owner 2026-08-01 22:29, verbatim] "add 2 buttons. a full window button
 * that makes it take up the full size of the window and a full screen button
 * that makes it take up the full screen. Both options above should be for the
 * actual conversation not the panes to the left and belo, but it should also
 * include the chatbox for the user to enter in messages"
 *
 * Two modes, one rule. `window` grows the modal to the whole app WINDOW;
 * `screen` puts the conversation on the whole DISPLAY. In BOTH, what you see
 * is the transcript, the composer and the one-line status footer — the dossier
 * rail, the control band and the fleet row are out.
 *
 * D-003 (2026-08-02): `screen` needs TWO mechanisms.
 * [owner 2026-08-02, verbatim] "both fullscreen buttons do the same thing. one
 * of them is supposed to full screen on the full desktop display not just the
 * window."
 *   - BROWSER — `requestFullscreen()` on the conversation region. The UA takes
 *     the OS window fullscreen and paints that element on it.
 *   - DESKTOP (Tauri) — drive the WINDOW (`setFullscreen`) and let the same
 *     maximized layout fill it.
 * The desktop split is NOT because the webview swallows a DOM request — it was
 * measured doing the opposite (see desktop-window-fullscreen.ts's header for the
 * numbers). It is because that call is conditional on transient activation, and
 * EVERY way it can fail lands on `setChatMax('window')` — the other button's
 * behavior. A control that degrades into its neighbour reads as a duplicate,
 * which is what was reported. The window path has no gesture requirement, so a
 * deep link and an agent-driven `ui:dispatch` reach the display too.
 *
 * D-002: the excluded set is defined STRUCTURALLY, by the DOM, and never as a
 * list of things to hide. `screen` calls requestFullscreen() on the
 * conversation REGION element, so the browser itself decides what fills the
 * screen: everything inside that element, nothing outside it. `window` mirrors
 * the same boundary in layout. The payoff is the deck's deferred Phase-2 left
 * Orders panel — the "panes to the left" of the ask — which will mount as a
 * sibling of that region and is therefore already excluded, with no edit here
 * and no chance of someone forgetting to add it to a hide-list.
 */
const CHAT_MAX_MODES = ['window', 'screen'] as const;
type ChatMaxMode = (typeof CHAT_MAX_MODES)[number];

/** The toolbar lives INSIDE the conversation region, not beside it. It has to:
 *  in real fullscreen only that element is painted, so a toolbar mounted as its
 *  sibling would be invisible at exactly the moment the user needs the control
 *  that gets them back out. */
const CHAT_TOOLBAR_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  zIndex: 6,
  display: 'flex',
  gap: 4,
  alignItems: 'center',
};

const CHAT_TOOLBAR_BUTTON_STYLE: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1,
  padding: '4px 7px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

/**
 * Is `el` the element currently painted fullscreen?
 *
 * Deliberately reads the DOM rather than trusting our own "I asked for
 * fullscreen" flag: the user can leave fullscreen by pressing Esc or F11,
 * which fires no click of ours. `document.fullscreenElement` is the only
 * source that is right in every one of those exits.
 */
function isFullscreenElement(el: Element | null): boolean {
  if (!el || typeof document === 'undefined') return false;
  return document.fullscreenElement === el;
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

/**
 * Badge tone → the P-003 vocabulary's State-pill tone class.
 *
 * Replaces the old `hud__chip--*` mapping: Direction D renders these as the
 * vocabulary's STATE shape (full-round, borderless, tinted) so a fact can never
 * be mistaken for a control. `accent` collapses to the neutral pill on purpose —
 * accent was carrying the MODE chips, and modes are no longer facts on this
 * surface: they are controls in the band below (P-005).
 */
const STATE_TONE_CLASS: Record<HudBadge['tone'], string> = {
  neutral: '',
  accent: '',
  good: 'pc-ctl-state--good',
  warn: 'pc-ctl-state--warn',
  bad: 'pc-ctl-state--bad',
};

function stateChipClass(b: HudBadge): string {
  const tone = STATE_TONE_CLASS[b.tone];
  return tone ? `pc-ctl-state ${tone}` : 'pc-ctl-state';
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
function SessionStateHeader({
  entry,
  onOpenDetail,
}: {
  entry: HudRosterEntry;
  /** D-002's ONE deliberate duplicate: the "⚠ N locks / M unread" alert
   *  opens (if collapsed) and scrolls the dossier rail to the named
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
    return deriveBadges(normalized, { nowMs, thresholds: HUD_DEFAULT_THRESHOLDS }).filter(
      // 'ctx' and 'claims' are rendered as their own pills below (unconditionally,
      // and with the claim's identity rather than a bare done/total), so the
      // derived duplicates are dropped rather than double-rendered.
      //
      // kind:'mode' is dropped for a DIFFERENT and more important reason: a mode
      // is no longer a fact on this surface. Direction D makes it a control in
      // the band below (P-005), and that is precisely what kills the duplicate
      // pairs the owner reported — an `AUTO` chip up here beside an `Autonomy`
      // button down there was the same concept wearing two costumes.
      (b) => b.kind !== 'mode' && b.id !== 'ctx' && b.id !== 'claims',
    );
  }, [entry, nowMs]);

  /** Seconds since this session last did anything. `lastActiveAt` is the only
   *  timestamp the roster row carries for it; an absent/unparseable one yields
   *  null and the pill simply omits the age rather than inventing one. */
  const ageSec = useMemo(() => {
    if (!entry.lastActiveAt) return null;
    const t = Date.parse(entry.lastActiveAt);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((nowMs - t) / 1000));
  }, [entry.lastActiveAt, nowMs]);

  /**
   * The held claim — deck change #2 calls it "the single most useful thing about
   * a working agent", and today it lives only in the rail.
   *
   * The deck drew it as `WI-6747 · 18m`. The AGE is deliberately absent: the
   * roster row's claims are `{ id, planSlug, status }` with NO timestamp on
   * them, and the nearest available field (`intentDeclaredAt`) dates the
   * INTENT, not the claim. Rendering that as "claimed 18m ago" would put a
   * confident, wrong number in the most-read pill on the surface. The id alone
   * is honest and still the useful half.
   */
  const claimIds = useMemo(
    () => (entry.claims ?? []).map((c) => c.id).filter((id): id is string => Boolean(id)),
    [entry.claims],
  );
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
  // WI-6504 (owner-reported): this counts COORD messages addressed to the agent
  // — a DIFFERENT corpus from the conversation rendered directly above it. That
  // is why "32 unread" sat beside a single visible message and read as a
  // contradiction: two truthful numbers about different things, presented as if
  // they described the same pane. D-003 forbids clamping or hiding the count, so
  // the fix is to NAME what it counts rather than shrink it.
  const detailChipTitle =
    unreadCount > 0
      ? `${unreadCount} unread coord message${unreadCount === 1 ? '' : 's'} addressed to this agent — a separate list from the conversation shown here. Opens the agent detail panel.`
      : 'Open the agent detail panel to this section';

  return (
    <div className="pc-ctl-band pc-ctl-band--status" data-testid="session-chat-state-header">
      <span className="pc-ctl-state" title={`Liveness: ${entry.liveness}`}>
        {/* The shared presence dot, not a local one — liveness colour stays
            single-sourced with /coord and the HUD board. */}
        <LivenessDot liveness={entry.liveness} size={6} />
        {entry.liveness}
        {ageSec != null ? ` · ${formatAge(ageSec)}` : ''}
      </span>
      {pct != null ? (
        <span
          className="pc-ctl-state"
          title={`${entry.contextTokens ?? '?'} / ${entry.compactionLimit ?? '?'} tokens`}
        >
          ctx {pct}%
        </span>
      ) : null}
      {claimIds.length > 0 ? (
        <span
          className="pc-ctl-state"
          data-testid="session-chat-state-claim"
          title={
            claimIds.length === 1
              ? `Holds ${claimIds[0]}`
              : `Holds ${claimIds.length} items: ${claimIds.join(', ')}`
          }
        >
          {claimIds[0]}
          {claimIds.length > 1 ? ` +${claimIds.length - 1}` : ''}
        </span>
      ) : null}
      {awaitText ? (
        <span className="pc-ctl-state pc-ctl-state--warn" title={entry.openAwait?.eventKey}>
          ⏳ {awaitText}
        </span>
      ) : null}
      {badges.map((b) => (
        <span key={b.id} className={stateChipClass(b)} title={b.title}>
          {b.label}
        </span>
      ))}
      {/* Alerts sit at the FAR edge, away from the plain facts: they are the
          only things in this band you can click, and the one-way trip they make
          (band → rail) is easier to learn when it always starts in one place. */}
      <span className="pc-ctl-band__spacer" />
      {locksCount > 0 ? (
        <Tooltip label="Open the agent detail panel to its Locks section" side="bottom">
          <button
            type="button"
            className="pc-ctl-alert"
            onClick={() => onOpenDetail?.('locks')}
            data-testid="session-chat-alert-locks"
            aria-label={`${locksCount} lock${locksCount === 1 ? '' : 's'} — open the detail panel`}
          >
            <span className="pc-ctl-alert__inner">
              ⚠ {locksCount} lock{locksCount === 1 ? '' : 's'}
              <span className="pc-ctl-alert__chevron" aria-hidden="true">
                ›
              </span>
            </span>
          </button>
        </Tooltip>
      ) : null}
      {unreadCount > 0 ? (
        <Tooltip label={detailChipTitle} side="bottom">
          <button
            type="button"
            className="pc-ctl-alert"
            onClick={() => onOpenDetail?.('coord')}
            data-testid="session-chat-alert-coord"
            /* WI-6504: the count must NAME its corpus. A bare "3 unread" beside
               a transcript reads as "this conversation has 3 unread", but it
               counts COORD messages — the owner reported "32 unread" next to a
               single rendered message. The visible label carries the qualifier
               and this carries the full distinction, so the explanation is
               announced to a screen reader rather than hidden in a hover. */
            aria-label={`${unreadCount} unread coord message${unreadCount === 1 ? '' : 's'} addressed to this agent — a separate list from the conversation shown here. Opens the agent detail panel.`}
          >
            <span className="pc-ctl-alert__inner">
              {unreadCount} coord unread
              <span className="pc-ctl-alert__chevron" aria-hidden="true">
                ›
              </span>
            </span>
          </button>
        </Tooltip>
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
}: {
  streamUrl: string;
  /** The su agent this session belongs to — resolves its roster entry for the
   *  identity chip (P-012). */
  sessionOwnerId: string;
  agentName: string;
  onSend: (text: string) => void;
  sending: boolean;
  sendError: string | null;
}) {
  const { events, status, thinking } = useAgentThinkingStream('', '', '', streamUrl);

  // P-012: the SAME advRoster.list sync query the HUD/Sessions roster read
  // (shared cache, no new endpoint) — narrowed to this session's owner so the
  // chip can reuse fleetColor/fleetRole exactly as the HUD derives them.
  // Computed BEFORE `messages` (WI-5997): its `currentPlanSlug` is the
  // per-message `planSlug` source those messages are stamped with below.
  const roster = useSyncQuery<RosterPayload>({
    queryName: 'advRoster.list',
    args: advRosterArgs(null),
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
  // the assistant's own turns. Declining (null) on a USER turn is what hands
  // it to OperatorChat's own user-profile-icon fallback (WI-6503) — the owner's
  // own messages must wear the OWNER's icon, never this session's agent mark.
  // So this early return is load-bearing, not just an optimisation.
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

  // WI-6503 [owner 2026-07-27, verbatim] "remove the papercup icon from the
  // chatbox for the chatboces where the conversation isnt with papercup."
  // OperatorChat's pane mark defaults to the Papercup logo, which is right for
  // the Papercup sidebar and wrong here: this modal's counterparty is whichever
  // agent the roster says it is. Resolved from the COUNTERPARTY's own agent
  // kind (never a title/label match, per the item) — so a session that really
  // IS papercup still gets the cup, via the same AGENT_MARKS table WI-4731
  // established for per-message stamps. Unknown/absent kind (a plain su
  // session) falls back to a neutral terminal mark rather than someone else's
  // branding.
  const paneIcon = (rosterEntry?.agent ? AGENT_MARKS[rosterEntry.agent] : undefined) ?? Terminal;

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
      paneIcon={paneIcon}
      // P-004: no footer. Everything it held was READ-ONLY state, and Direction
      // D's spatial rule is that description sits ABOVE the transcript and
      // operation below it — so those facts now render as the status band at
      // the top of the conversation region (SessionStateHeader), and the space
      // under the composer belongs entirely to controls.
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
  pendingLaunch = null,
}: {
  /** The inbox item's ownerAgentId — null hides the modal. */
  sessionOwnerId: string | null;
  /** Friendly display label, when the caller has one (falls back to the raw id). */
  ownerLabel?: string | null;
  onClose: () => void;
  /** WI-6367: the session this modal was opened for was JUST LAUNCHED by the
   *  caller and has not booted yet. Without this, a brand-new session is
   *  indistinguishable from a long-gone one — both simply have no roster row —
   *  so the modal greeted a session that had not started with the past-tense
   *  "no longer in the live roster" / "no recent Claude session" copy, which
   *  reads as "it died". Passing the launch moment lets the boot window render
   *  as "starting up" instead. Self-clears: as soon as the session registers
   *  (roster row) or its transcript resolves, the normal branches take over. */
  pendingLaunch?: { ownerId: string; startedAtMs: number } | null;
}) {
  const [resolved, setResolved] = useState<SessionListRow | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // P-002: the DELIVERY OUTCOME, not a boolean. `null` = nothing sent yet.
  const [sentOk, setSentOk] = useState<SendDelivery | null>(null);

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
    setSentOk(null);
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
    setSentOk(null);
    setSending(true);
    sendToSessionOwner(sessionOwnerId, text)
      .then((delivery) => setSentOk(delivery))
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
    args: advRosterArgs(null),
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

  // WI-6440: the DURABLE half of the same signal. `pendingLaunch` below is
  // client-local state that dies with the page, so before this a reload during
  // the boot window dropped the modal back onto the gone-away copy for a session
  // the board was concurrently rendering as "starting" — two surfaces
  // contradicting each other about one session. This is the same `starting` tier
  // the board reads (HudView's `entries`), so they cannot disagree.
  //
  // NOT folded into `actionRosterEntry` on purpose: that row drives the dossier,
  // the footer and the action bar, and a session that has not registered has
  // nothing to put in them — leaving it null is what routes AgentDossier to its
  // "Starting up" note rather than a dossier full of blanks.
  const startingEntry = useMemo<HudRosterEntry | null>(() => {
    const payload = actionRoster.data?.[0];
    if (!payload || !sessionOwnerId) return null;
    return (payload.starting ?? []).find((e) => e.ownerId === sessionOwnerId) ?? null;
  }, [actionRoster.data, sessionOwnerId]);

  // ── WI-6367: the "starting up" window ──────────────────────────────────────
  // True while THIS modal is showing a session that has neither registered in
  // the roster nor produced a transcript yet, and that we have positive evidence
  // was launched rather than lost: either the caller just launched it
  // (`pendingLaunch`, zero-latency, fires before any roster refetch) or the
  // server still lists it as starting (WI-6440, survives a reload). Both inputs
  // are reactive (advRoster.list pushes; the resolve effect re-runs), so this
  // flips off on its own the moment the session comes online — no clearing
  // handshake with the caller.
  const launchedByThisView =
    pendingLaunch != null && sessionOwnerId != null && pendingLaunch.ownerId === sessionOwnerId;
  const startingUp = !resolved && !actionRosterEntry && (launchedByThisView || startingEntry != null);

  // WI-6821: the server OBSERVED this launch die (terminal process gone, never
  // registered) rather than inferring it from elapsed time. Server-derived on
  // purpose — `launchedByThisView` alone can be true for a launch this client
  // fired seconds ago, and only the operator can see the process. It therefore
  // stays false until the roster says otherwise, so the honest "starting up"
  // copy still leads for a launch that is genuinely still booting.
  const launchFailed = startingEntry?.launchFailed === true;

  // When the boot window started, for the did-not-come-online fallback below.
  // The caller's launch moment wins when we have it (it is the earlier and more
  // precise of the two); otherwise fall back to the launch record's own
  // timestamp, which is what makes the fallback work after a reload. An
  // unparseable/absent `startedAt` yields null — we then never time out, matching
  // the board's own `ageSec(...) == null` fallthrough rather than inventing a
  // failure we cannot date.
  const startedAtMs = useMemo<number | null>(() => {
    if (launchedByThisView) return pendingLaunch!.startedAtMs;
    if (!startingEntry?.startedAt) return null;
    const t = Date.parse(startingEntry.startedAt);
    return Number.isNaN(t) ? null : t;
  }, [launchedByThisView, pendingLaunch?.startedAtMs, startingEntry?.startedAt]);

  // A launch that never comes online (psu exits at boot — e.g. no usable
  // display) would otherwise sit on "starting up" forever, which is the same
  // class of lie as the copy this fixes, just in the hopeful direction. After
  // the grace window we say plainly that it did not come up. One-shot timeout,
  // not an interval — nothing here needs a ticking clock.
  // ⚠ …but "it did not come up" is only honest if we could SEE the roster.
  //
  // [owner 2026-08-01, verbatim] "in the hud tab I tried launching a new
  // session and the conversation window came up but I got that error." The
  // launch was fine. `~/.papercusp/embedded-pg.json` pointed at a dead Postgres
  // port, so every DB-backed read failed, the session could never register, the
  // grace window expired, and this banner told the owner to relaunch — advice
  // that could not possibly work, and which pointed them at their own action
  // instead of the broken backend. (`:3070/api/health` answered 200 in 1.6ms
  // throughout, so nothing else contradicted the banner either.)
  //
  // The roster IS our evidence that a session came online. When we cannot read
  // it we have no evidence in EITHER direction, so blaming the launch is a
  // fabricated diagnosis — the same class of lie as the past-tense "gone away"
  // copy WI-6367 removed, just pointed at the user's action instead of the
  // session's age. Report the thing we actually observed: we cannot reach the
  // operator.
  const rosterUnreadable = actionRoster.error != null || actionRoster.data?.[0] == null;

  const [startupTimedOut, setStartupTimedOut] = useState(false);
  useEffect(() => {
    setStartupTimedOut(false);
    if (!startingUp || startedAtMs == null) return;
    const elapsed = Date.now() - startedAtMs;
    if (elapsed >= STARTUP_GRACE_MS) {
      setStartupTimedOut(true);
      return;
    }
    const t = setTimeout(() => setStartupTimedOut(true), STARTUP_GRACE_MS - elapsed);
    return () => clearTimeout(t);
  }, [startingUp, startedAtMs]);

  // Open/collapsed state via nuqs (never useState) — deep-linkable + agent
  // -driveable, per the plan item's requirement. Defaults open: every
  // conversation opened from the HUD should carry the dossier unless the
  // viewer collapses it (or the viewport is too narrow to show it side-by-
  // side, handled separately by isNarrow below).
  const [dossierOpen, setDossierOpen] = useQueryState('chatDossier', parseAsBoolean.withDefault(true));
  const isNarrow = useIsNarrowViewport(DOSSIER_NARROW_MEDIA_QUERY);

  /* P-015: the Orders panel's own toggle, nuqs like every other bit of this
     popup's state. Defaults CLOSED, unlike the dossier: it is the newer and
     denser of the two, and its fetch is a separate heavier query
     (`agentOrders.byOwner` runs the carry-brief gather), so it is opt-in rather
     than something every popup pays for. `ordersEnabled` below is what actually
     gates that fetch. */
  const [ordersOpen, setOrdersOpen] = useQueryState('chatOrders', parseAsBoolean.withDefault(false));
  const isOrdersNarrow = useIsNarrowViewport(ORDERS_NARROW_MEDIA_QUERY);

  /* ── P-001 maximize ──────────────────────────────────────────────────────
     Which maximize mode is on, in the URL like every other bit of this
     popup's state (nuqs-by-default) so it is deep-linkable and reachable from
     ui:get_state / ui:dispatch. Absent ⇒ the normal centred popup. */
  const [chatMax, setChatMax] = useQueryState('chatMax', parseAsStringLiteral(CHAT_MAX_MODES));
  const conversationRef = useRef<HTMLDivElement | null>(null);

  /* Whether something is ACTUALLY painting our region on the whole display,
     which is not the same question as `chatMax === 'screen'` and must not be
     inferred from it. Two ways they diverge, both routine:
       - a shared/reloaded URL carrying `chatMax=screen` cannot enter
         fullscreen on load, because the DOM API requires a user gesture. The
         page renders maximized and the button still offers to go fullscreen;
       - Esc / F11 leaves fullscreen without any click of ours.
     So the host is the authority and this mirrors it. */
  const [screenActive, setScreenActive] = useState(false);

  /* D-003 — the DESKTOP half of `screen`, and the only state that says whether
     we may put the window back:
       'owned'   we fullscreened the window, so exiting is ours to do;
       'adopted' it was ALREADY fullscreen (the user's own F11, another
                 surface) — we ride it and must NOT take it away on the way out;
       null      the desktop path is not engaged (browser, or refused).
     A ref rather than state: it is read inside the document listener below,
     where a stale closure over a state value would make the listener act on
     the mode we were in one render ago. */
  const windowScreen = useRef<'owned' | 'adopted' | null>(null);

  /** Give the window back. Idempotent, and safe to fire from an unmount. */
  const releaseWindowScreen = useCallback(async () => {
    const held = windowScreen.current;
    windowScreen.current = null;
    setScreenActive(false);
    if (held === 'owned') await exitDesktopWindowFullscreen();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => {
      // Desktop path: the DOCUMENT never enters fullscreen there, so a
      // fullscreenchange raised by anything else (a video player, an embedded
      // frame) would read as "the user left fullscreen" and cancel a mode they
      // are still in. The window state is authoritative while it is engaged.
      if (windowScreen.current) return;
      const active = isFullscreenElement(conversationRef.current);
      setScreenActive(active);
      // Left fullscreen by a route we did not drive (Esc, F11, the browser
      // dropping it on tab switch) — drop the mode with it, or the popup sits
      // in a maximized layout the user just asked to leave.
      if (!active) setChatMax((prev) => (prev === 'screen' ? null : prev));
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [setChatMax]);

  /** Layout-maximized: true for BOTH modes. `screen` still needs the
   *  full-window layout underneath it — if the webview refuses fullscreen (or
   *  a deep link arrives before a gesture can grant it) the user gets the
   *  maximized popup rather than nothing happening. */
  const maximized = chatMax != null;

  /* P-015: whether the Orders panel is actually on screen. Maximize excludes it
     for the same structural reason it excludes the dossier — both are siblings
     of the conversation region (D-002), and the layout half of that rule lives
     here. This also GATES THE FETCH: `agentOrders.byOwner` runs the carry-brief
     gather, so a closed panel must cost nothing. */
  const ordersVisible = open && ordersOpen && !maximized;

  const exitScreen = useCallback(async () => {
    // Desktop first: if the window is carrying the mode, the document is not.
    if (windowScreen.current) {
      await releaseWindowScreen();
      return;
    }
    if (typeof document === 'undefined') return;
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Already gone, or the UA refused — `fullscreenchange`/the next sync
        // settles the real state either way. Nothing to report to the user.
      }
    }
  }, [releaseWindowScreen]);

  /* Never strand the display. Closing the popup while `screen` is engaged would
     leave the whole app filling the screen with the control that undoes it no
     longer rendered — so release on close AND on unmount, not only in
     `closeChat` (which a route change or a cleared session skips). `exitScreen`
     rather than `releaseWindowScreen` so this covers the browser's DOM
     fullscreen too; the unmount case cannot wait for an event to correct it. */
  useEffect(() => {
    if (!open) void exitScreen();
  }, [open, exitScreen]);
  useEffect(
    () => () => {
      void exitScreen();
    },
    [exitScreen],
  );

  const toggleWindow = useCallback(() => {
    if (chatMax === 'window') {
      void setChatMax(null);
      return;
    }
    if (screenActive) {
      // Coming from `screen`: give the display back FIRST (whichever mechanism
      // is holding it), then land in window mode. The set has to come after: the
      // fullscreenchange handler above clears the mode on the way out — without
      // it this click would read as "exit maximize" rather than "switch to
      // full window".
      void exitScreen().then(() => setChatMax('window'));
      return;
    }
    // The ordinary path stays SYNCHRONOUS. Routing it through the same promise
    // as the fullscreen exit cost a microtask for nothing and made the mode
    // land a tick after the click — a visible flash of the old layout, and a
    // click whose effect a caller could not observe in the same turn.
    void setChatMax('window');
  }, [chatMax, screenActive, exitScreen, setChatMax]);

  const toggleScreen = useCallback(() => {
    if (screenActive) {
      void exitScreen().then(() => setChatMax(null));
      return;
    }
    /* D-003 — DESKTOP: drive the WINDOW, not the document. The DOM request
       below needs transient activation, and every way it can fail falls through
       to `window` — the other button's mode, which is the reported bug. Moving
       the OS window is unconditional, and readable back afterwards. */
    if (isDesktopShell()) {
      void enterDesktopWindowFullscreen().then(({ active, owned }) => {
        windowScreen.current = active ? (owned ? 'owned' : 'adopted') : null;
        setScreenActive(active);
        // Refused — an older desktop binary whose baked capabilities predate
        // `core:window:allow-set-fullscreen`. Same rule as the browser fallback
        // below: the user asked for bigger, so give the bigger we still have.
        void setChatMax(active ? 'screen' : 'window');
      });
      return;
    }
    const el = conversationRef.current;
    // No element, or a webview with the Fullscreen API switched off: fall back
    // to full-window rather than doing nothing. A dead button is the worse
    // failure — the user asked for "bigger" and there IS a bigger we can give.
    if (!el || typeof el.requestFullscreen !== 'function') {
      void setChatMax('window');
      return;
    }
    void Promise.resolve(el.requestFullscreen())
      .then(() => setChatMax('screen'))
      .catch(() => setChatMax('window'));
  }, [screenActive, exitScreen, setChatMax]);

  /* D-003 — Esc leaves DESKTOP full screen.
     In the browser the UA owns Esc while it paints a fullscreen element, which
     is why `closeOnEscape` is disarmed below. On the desktop path nothing
     consumes it, so with the dialog's own handler disarmed Esc would simply be
     dead — leaving a fullscreen window whose only exit is one small icon in a
     corner. Restore the gesture people already expect. */
  useEffect(() => {
    if (!screenActive || typeof document === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !windowScreen.current) return;
      e.preventDefault();
      e.stopPropagation();
      void exitScreen().then(() => setChatMax(null));
    };
    // Capture: the dialog's own layers see the key first otherwise.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [screenActive, exitScreen, setChatMax]);

  /* Leaving the popup must not leave the browser in fullscreen or the mode in
     the URL — reopening any session would otherwise inherit a maximize the
     user never asked for on it. */
  const closeChat = useCallback(() => {
    void exitScreen();
    void setChatMax(null);
    onClose();
  }, [exitScreen, setChatMax, onClose]);

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
            // P-005: the mode pills read their CURRENT value from here. Same
            // roster row the status band renders, so the pill and the rest of
            // the surface cannot disagree about what is set — and it costs no
            // fetch, which is what lets `current()` stay pure and synchronous.
            modes: actionRosterEntry?.modes ?? [],
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
        if (!next) closeChat();
      }}
      title={title}
      /* P-001: while the browser is painting the conversation fullscreen, Esc
         is the user's way OUT of fullscreen — the UA consumes it and never
         dispatches the keydown. Leaving the dialog's own Esc handler armed
         means the one press both drops fullscreen and closes the chat, so the
         conversation the user was reading disappears when they only asked for
         a smaller window. */
      closeOnEscape={!screenActive}
      /* Send the dialog's initial focus to the CONVERSATION, not to a window
         control. Radix otherwise focuses the first tabbable descendant, which
         since P-001 is the full-window button — and that button is a tooltip
         trigger, so focusing it OPENS the tooltip, which mounts its own
         dismissable layer and eats the first Escape. The chat then ignored the
         first Escape press entirely (caught by the pre-existing "calls onClose
         when the dialog is dismissed" test, which is why it is a test worth
         having). Focusing the transcript is also the better landing spot: it is
         what the reader opened the popup for, and it is scrollable by keyboard. */
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        conversationRef.current?.focus();
      }}
      wrapStyle={maximized ? { padding: 0 } : undefined}
      contentStyle={
        maximized
          ? {
              // Fill the app window edge to edge. `100dvh` rather than `100vh`
              // so a mobile/overlay browser chrome bar cannot push the
              // composer below the fold — the composer is the half of this the
              // owner explicitly asked to keep.
              width: '100vw',
              maxWidth: 'none',
              height: '100dvh',
              maxHeight: '100dvh',
              borderRadius: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
            }
          : {
              // hud-first-nav-and-dossier-2026-07-26 P-003: widen to make room for
              // the dossier rail when it's open AND there's room to show it
              // side-by-side; on a narrow viewport the rail overlays instead
              // (DOSSIER_RAIL_OVERLAY_STYLE below), so the modal stays at its
              // original width rather than crushing the transcript.
              // P-015: three columns need ~1240px (272 orders + ~560
              // conversation + 300 dossier + chrome). The ladder is
              // both-open → dossier-only → bare, so opening Orders widens the
              // popup rather than crushing the transcript between two panels.
              width:
                ordersVisible && dossierOpen && !isNarrow
                  ? 'min(1320px, 97vw)'
                  : ordersVisible
                    ? 'min(1040px, 96vw)'
                    : dossierOpen && !isNarrow
                      ? 'min(1040px, 96vw)'
                      : 'min(720px, 92vw)',
              height: 'min(80vh, 820px)',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
            }
      }
    >
      <div
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', position: 'relative' }}
        data-testid="session-chat-modal"
      >
        {/* ── ORDERS (P-015) — the LEFT panel, and deliberately the FIRST child
            so the DOM order matches the reading order the layout promises:
            told → conversation → did. A screen reader and a sighted user get
            the same causal sequence.

            A SIBLING of the conversation region, never a child: P-001's D-002
            makes that element's subtree the literal definition of what
            maximize paints, so this is excluded structurally and there is no
            hide-list to keep in sync. ── */}
        {ordersVisible ? (
          <div
            data-testid="session-chat-orders-rail"
            style={isOrdersNarrow ? ORDERS_RAIL_OVERLAY_STYLE : ORDERS_RAIL_SIDE_STYLE}
          >
            <AgentOrders
              ownerId={sessionOwnerId ?? ''}
              enabled={ordersVisible}
              onClose={() => void setOrdersOpen(false)}
            />
          </div>
        ) : null}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* P-001 / D-002 — THE conversation region. Its DOM boundary is the
            whole definition of what "maximize the conversation" means: this
            element is what requestFullscreen() is called on, so the browser
            paints exactly its subtree and nothing else. Everything the owner
            asked to keep (transcript, composer, the one-line status footer,
            and the escalation cards that are part of the conversation) is
            INSIDE; everything they asked to leave out is a sibling BELOW or
            the rail beside it. Adding a pane later means putting it outside
            this element — there is no hide-list to remember to update. */}
        <div
          ref={conversationRef}
          data-testid="session-chat-conversation"
          /* -1: focusable so `onOpenAutoFocus` can land here, but NOT tabbable,
             so it never becomes a stop in the Tab order itself. */
          tabIndex={-1}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            // A DOM-fullscreened element is transparent by default (the UA only
            // paints ::backdrop black), so without this the transcript renders
            // on bare black instead of the popup's own surface. Scoped to that
            // mechanism: on the desktop path (D-003) nothing is lifted out of
            // the page, so the modal's own surface is already behind us and an
            // extra background here would just double-paint it.
            ...(screenActive && windowScreen.current === null
              ? { background: 'var(--bg-popover, #0d1829)' }
              : null),
          }}
        >
        {open ? (
          <div style={CHAT_TOOLBAR_STYLE} data-testid="session-chat-toolbar">
            {/* Tooltip, not a `title=` attribute: these are ICON-ONLY buttons, so
                the hover text is the only place their meaning is written for a
                sighted user — and a native title is unreachable by keyboard and
                on touch. `lint:design-primitives` fails a title on a <button>
                for exactly this reason. */}
            <Tooltip
              label={chatMax === 'window' ? 'Exit full window' : 'Fill the app window with the conversation'}
              side="bottom"
              align="end"
            >
              <button
                type="button"
                className="pc-button"
                onClick={toggleWindow}
                aria-pressed={chatMax === 'window'}
                aria-label={chatMax === 'window' ? 'Exit full window' : 'Full window'}
                data-testid="session-chat-full-window"
                style={CHAT_TOOLBAR_BUTTON_STYLE}
              >
                {chatMax === 'window' ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />}
              </button>
            </Tooltip>
            <Tooltip
              label={screenActive ? 'Exit full screen' : 'Fill the whole screen with the conversation'}
              side="bottom"
              align="end"
            >
              <button
                type="button"
                className="pc-button"
                onClick={toggleScreen}
                aria-pressed={screenActive}
                aria-label={screenActive ? 'Exit full screen' : 'Full screen'}
                data-testid="session-chat-full-screen"
                style={CHAT_TOOLBAR_BUTTON_STYLE}
              >
                {screenActive ? <Minimize size={12} aria-hidden="true" /> : <Maximize size={12} aria-hidden="true" />}
              </button>
            </Tooltip>
            {/* P-015: same gate as the detail toggle below, same reason — both
                panels are siblings of the conversation region, so neither can
                be shown while it is maximized. Ordered LEFT-toggle first to
                match the panels' own left-to-right order. */}
            {!maximized ? (
              <button
                type="button"
                className="pc-button"
                onClick={() => void setOrdersOpen(!ordersOpen)}
                aria-pressed={ordersOpen}
                aria-label={ordersOpen ? 'Hide agent orders' : 'Show agent orders'}
                data-testid="session-chat-orders-toggle"
                style={CHAT_TOOLBAR_BUTTON_STYLE}
              >
                {ordersOpen ? '‹ Orders' : 'Orders ›'}
              </button>
            ) : null}
            {/* The detail toggle only makes sense while the rail can be shown;
                maximized deliberately has no rail (D-002). */}
            {!maximized ? (
              <button
                type="button"
                className="pc-button"
                onClick={() => void setDossierOpen(!dossierOpen)}
                aria-pressed={dossierOpen}
                aria-label={dossierOpen ? 'Hide agent detail' : 'Show agent detail'}
                data-testid="session-chat-dossier-toggle"
                style={CHAT_TOOLBAR_BUTTON_STYLE}
              >
                {dossierOpen ? 'Hide detail ›' : '‹ Detail'}
              </button>
            ) : null}
            {/* Maximized covers the backdrop, and in fullscreen Esc is spoken
                for — so without an explicit ✕ there is no way out but the
                maximize toggles. */}
            {maximized ? (
              <Tooltip label="Close conversation" side="bottom" align="end">
                <button
                  type="button"
                  className="pc-button"
                  onClick={closeChat}
                  aria-label="Close conversation"
                  data-testid="session-chat-close"
                  style={CHAT_TOOLBAR_BUTTON_STYLE}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
        {/* ── P-004: Direction D's STATUS BAND. Above the transcript, because
            C's spatial rule is that description sits above and operation below;
            inside the conversation region, because these facts are what the
            transcript means — a maximized conversation that no longer says
            whether the agent is alive has lost the more useful half. ── */}
        {actionRosterEntry ? (
          <SessionStateHeader entry={actionRosterEntry} onOpenDetail={scrollToDossierSection} />
        ) : null}
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
        ) : startingUp ? (
          // WI-6367: a session launched seconds ago has no roster row and no
          // transcript yet — the same shape as one that ended long ago. Say
          // which it is, in the present tense, instead of the gone-away copy.
          <div style={BANNER_STYLE} data-testid="session-chat-starting-up">
            {launchFailed
              ? // WI-6821: not a timeout — the operator OBSERVED this launch die
                // (its terminal process is gone and it never registered). That is
                // evidence, so this is stated flatly and immediately, with no
                // "may have" hedge and no 60s wait for a timer to guess it.
                'This session’s launch failed — its terminal closed before the session came online. Try launching it again.'
              : startupTimedOut
                ? rosterUnreadable
                  ? "Can't reach the operator to check on this session — this looks like a connection problem, not a failed launch. Relaunching won't help until it's back."
                  : "This session hasn't come online. The launch may have failed — try launching it again."
                : 'Starting up — waiting for this session to come online…'}
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
          />
        ) : null}
        {/* P-002: say what ACTUALLY happened. "Staged" is the case this fixes —
            a manual-wake-mode agent has the message held for you to release, so
            reporting a bare "Sent" sends the human away believing they have
            asked for something that is not yet in front of anyone. */}
        {sentOk ? (
          <div
            style={sentOk.kind === 'woken' ? BANNER_STYLE : { ...BANNER_STYLE, color: 'var(--warn, #fbbf24)' }}
            data-testid="session-chat-send-outcome"
            data-delivery={sentOk.kind}
          >
            {sentOk.kind === 'woken'
              ? 'Sent — the agent was woken and is working on it.'
              : sentOk.kind === 'staged'
                ? 'Staged — this agent has manual wakes, so the message is held until you release it. It is not working on this yet.'
                : sentOk.kind === 'absent'
                  ? 'Delivered to the inbox, but no live session picked it up — the agent may need respawning.'
                  : 'Delivered to the agent’s inbox — it will be read at its next turn.'}
          </div>
        ) : null}
        </div>
        {/* ── Below the conversation region, therefore excluded from maximize
            (P-001 / D-002). These are the "panes below" of the owner's ask. ── */}
        {!maximized && actionCtx && (
          <>
            {/* Renders whatever askUserLocal card an action's params()/confirm
                step opens (P-002 substrate) — the SAME renderer the
                agent-initiated card path uses, mounted here so action-bar
                cards appear inline in this modal specifically. */}
            <LocalCardHost />
            <ChatActionBar ctx={actionCtx} />
          </>
        )}
        {/* WI-6505 (owner ask 2026-07-27): the fleet-launch row is ALWAYS
            visible — deliberately OUTSIDE the `actionCtx` gate above. The action
            bar needs a resolved live session to act ON; launching a fleet does
            not, and the moment a human most wants a fleet is often exactly when
            this session is dead, still starting, or failed to resolve — the
            states where `actionCtx` is null and the bar is absent.

            Maximize is the ONE thing that hides it, and that does not weaken
            WI-6505's reason: maximize is a mode the user just switched on by
            hand and can switch off in one click on a button that is on screen
            in both modes — unlike the `actionCtx` gate, which hid the row
            based on session state the user did not choose and could not undo.
            (Deck item 5 proposes moving this row to the Sessions board
            entirely; that is P-007 and is owner-gated — see D-003.) */}
        {!maximized ? <FleetLaunchRow /> : null}
      </div>
        {/* The rail is a SIBLING of the conversation region, so maximize
            excludes it structurally (D-002) — this `!maximized` is the layout
            half of the same rule, not a second hide-list. */}
        {open && dossierOpen && !maximized ? (
          <div
            data-testid="session-chat-dossier-rail"
            style={isNarrow ? DOSSIER_RAIL_OVERLAY_STYLE : DOSSIER_RAIL_SIDE_STYLE}
          >
            <AgentDossier
              ownerId={sessionOwnerId ?? ''}
              entry={dossierEntry}
              // WI-6367: same never-started-vs-ended distinction as the banner
              // above — without it the rail says "no longer in the live roster"
              // about a session that has not started yet.
              startingUp={startingUp}
              // WI-6821: and the rail must not keep saying "starting up" about a
              // launch the banner beside it already reports as dead.
              launchFailed={launchFailed}
              onClose={() => void setDossierOpen(false)}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
