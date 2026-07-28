/**
 * adv-agent-detail.ts — Tier-3 per-agent enrichment for the Sessions dossier
 * (plan adv-sessions-live-roster-2026-06-02, P-009). This is the LAZY half of
 * the roster: the cheap presence-primary list (adv-roster.ts) renders the grid;
 * opening one agent's detail pane fetches THIS, scoped to a single owner, so the
 * roster query stays one cheap read while the dossier joins across stores.
 *
 * Two cross-store reads, run concurrently:
 *   - locks  → papercusp_su agent_file_locks / agent_lock_waiters (readQueue)
 *   - coord  → harness_shared coord_event_log (messages / handoffs / escalations)
 *
 * As with adv-roster, the DB I/O is a thin wrapper; the shaping logic is pure
 * (deriveAgentLocks / deriveCoordState) so it unit-tests without PG.
 */

import { coordLog } from './agent-tools/coordination/log';
import { readAckedMsgIds } from './agent-tools/coordination/messages';
import { readWatermark, pickUnreadCursor } from './agent-tools/coordination/watermarks';
import { lastInboxReadAtBatch } from './agent-tools/coordination/inbox-read-freshness';
import { listHandoffs, type HandoffWithAcceptance } from './agent-tools/coordination/handoffs';
import { listEscalations, type EscalationRecord } from './agent-tools/coordination/escalations';
import { latestAdvSessionByCoordOwner, firstAdvSessionStartByCoordOwner } from './adv-sessions';
import {
  ensureBootstrap,
  getTxPool,
  readQueue,
  type QueueResult,
} from './agent-tools/locks/su-lock-store';
import type { CoordEnvelope } from '@papercusp/coordination/core';
// unread-count-truthfulness-2026-07-27 P-005 / D-006: the SAME default-visibility
// rules coord:inbox applies, imported from the pure module they were relocated to
// (never re-implemented here — a second copy would drift from the reader).
import {
  isAmbientBroadcast,
  excludeIntentDeclares,
  coalesceRepeatedBroadcasts,
} from './agent-tools/coordination/inbox-visibility';
import { collectRetractedIds, suppressRetracted } from './agent-tools/coordination/retraction';
import { readCodexHomeDiagnostics, type CodexHomeDiagnostics } from './role-codex-home';
import {
  nativeSessionHandleForAdvSession,
  claudeHandleAfterRematerializeAttempt,
  type NativeSessionHandle,
  type ClaudeNativeSessionHandle,
} from './native-session-handles';
// hud-first-nav-and-dossier-2026-07-26 P-005: the six "is this agent healthy and
// will it keep going?" signals, each sourced from an EXISTING roster/sync feed
// (no new query per field) — see the docstring on `getAgentSignals` below.
import { getLoopStatus } from './harness/routines/loop';
import { readHeldWorkItems } from './carry-brief';
import { getPresence } from './agent-tools/coordination/presence';
import { fetchUnansweredDirected } from './agent-tools/coordination/unanswered-directed';
import { lastToolCallAtByOwner } from './fleet/assignments';
import { activeWorkspaceId } from './workspace-registry';

// ──────────────────────────── DTOs (the endpoint JSON contract) ────────────
// Dates are ISO strings on the wire (readQueue returns Date objects; we map).

export interface LockHeld {
  path: string;
  intent: string;
  acquiredAt: string;
  expiresAt: string;
}

/** An active lock held by ANOTHER agent that overlaps a path this agent waits on. */
export interface LockBlocker {
  path: string;
  holder: string;
  holderLabel: string | null;
  intent: string;
  expiresAt: string;
}

export interface LockWaiting {
  ticketId: string;
  paths: string[];
  intent: string;
  /** Position in the global lock-waiter FIFO (0 = next to be granted). */
  aheadCount: number;
  queuedAt: string;
  waitUntil: string;
  /** Who currently holds the path(s) this ticket is blocked on. */
  blockedBy: LockBlocker[];
}

export interface AgentLocks {
  held: LockHeld[];
  waiting: LockWaiting[];
  /** Non-null when the locks read failed (store unreachable); UI shows it gracefully. */
  error: string | null;
}

export interface CoordMessageSummary {
  msgId: string;
  from: string;
  to: string[];
  kind: string;
  summary: string;
  ts: string;
  direction: 'inbound' | 'outbound';
}

export interface CoordHandoffSummary {
  msgId: string;
  from: string;
  to: string[];
  summary: string;
  ts: string;
  planSlug: string | null;
  nextAction: string | null;
  direction: 'inbound' | 'outbound';
  accepted: boolean;
}

export interface CoordEscalationSummary {
  msgId: string;
  severity: EscalationRecord['severity'];
  summary: string;
  ts: string;
  planSlug: string | null;
}

export interface AgentCoordState {
  /** Most recent message directly involving this agent (sent or addressed to it). */
  lastMessage: CoordMessageSummary | null;
  /**
   * Messages addressed to this agent (kind=message; broadcasts included,
   * self-sent excluded) that arrived AFTER its last read receipt and were
   * never explicitly acked. Null receipt (no watermark, no recorded
   * coord:inbox/orient call) ⇒ the agent genuinely has read nothing, so the
   * whole log counts — that is the honest answer, not a bug.
   */
  unreadCount: number;
  /**
   * THE MESSAGES `unreadCount` COUNTS — newest first, bounded to
   * `UNREAD_LIST_LIMIT`.
   *
   * [owner 2026-07-28, verbatim] "I looked up the conversation for
   * su-4ef7fb1d and it says in the COORD section 38 unread, but I only see 2
   * messages, why? fix it". Before this field the state carried the COUNT and
   * threw the rows away, so the dossier's coord section could only ever render
   * `lastMessage` (exactly one) plus open handoffs/escalations. A badge saying
   * 38 sat beside a section structurally incapable of showing 38 — and there
   * was no scroll, no pagination and no "show all", because the data to show
   * simply was not carried.
   *
   * Built from the SAME array whose length is `unreadCount` (never a second
   * query and never a re-derivation), so the list and the badge cannot drift
   * apart — which is exactly the failure D-006 names: a counter that disagrees
   * with its reader.
   *
   * `unreadCount` stays the TRUE total and is deliberately NOT capped to this
   * list's length (D-003: capping the badge to a page size would just be a new
   * lie). When `unreadCount > unread.length` the surface must say so — the
   * dossier renders "showing N of M".
   */
  unread: CoordMessageSummary[];
  /** Open (un-accepted) handoffs this agent sent or received. */
  openHandoffs: CoordHandoffSummary[];
  /** Open (unresolved) escalations this agent raised. */
  openEscalations: CoordEscalationSummary[];
  error: string | null;
}

/**
 * hud-first-nav-and-dossier-2026-07-26 P-005: "is this agent healthy and will
 * it keep going?" — six signals the dossier panel didn't surface before this,
 * each read from an EXISTING primitive (no new query authored for any of
 * them):
 *   1. loop            — `getLoopStatus` (harness/routines/loop.ts), the same
 *                         read `loop:status` and the leader-brief use.
 *   2. currentClaim     — `readHeldWorkItems` (carry-brief.ts), the same held-
 *                         item read the carry doc / post-compaction recovery
 *                         fold use. The panel showed PLAN but never the
 *                         work-item within it.
 *   3. contextTokens/
 *      compactionLimit  — `getPresence` (coordination/presence.ts); the HUD
 *                         board already derives its context% bar from the
 *                         same two fields (hud-board-model.ts `contextPct`).
 *   4. lastCheckpoint   — the SAME `readHeldWorkItems` row's `.checkpoint` —
 *                         the carry note a restart would resume from.
 *   5. unansweredDirectedCount — `fetchUnansweredDirected` (unanswered-
 *                         directed.ts), the same fold `fleet:assignments`'
 *                         `unanswered_directed` summary counts against.
 *   6. lastToolCallAt   — `lastToolCallAtByOwner` (fleet/assignments.ts), the
 *                         "real work" freshness signal distinct from the
 *                         60s-keepalive `heartbeatAt` already shown above (a
 *                         warm-dead session can heartbeat while doing nothing).
 */
export interface AgentDossierLoopStatus {
  active: boolean;
  intervalSec: number | null;
  nextFireAt: string | null;
  parked: boolean;
  stalled: boolean;
}

export interface AgentDossierClaim {
  id: string;
  title: string | null;
  harness: string | null;
}

export interface AgentDossierCheckpoint {
  text: string;
  updatedAtMs: number | null;
}

/**
 * EI-18694403367371331: the underlying read for each signal below is best-
 * effort (`.catch(() => <empty>)`) so ONE broken source can never crash the
 * whole dossier — but that previously collapsed "the read threw" into the
 * exact same shape as "the agent genuinely holds/has none", which reads as
 * healthy-idle when it may really mean broken-and-invisible. A key present in
 * `unavailableSignals` means ITS read threw this call — render "unavailable",
 * never the same look as a legitimate empty/none state.
 */
export type AgentSignalKey = 'loop' | 'currentClaim' | 'context' | 'unanswered' | 'lastToolCall';

export interface AgentSignals {
  /** null when the agent has no engine loop routine at all (never armed) —
   *  OR the read threw; check `unavailableSignals` to tell them apart. */
  loop: AgentDossierLoopStatus | null;
  /** The agent's most recently taken held work-item, or null if it holds none
   *  — OR the read threw; check `unavailableSignals` to tell them apart. */
  currentClaim: AgentDossierClaim | null;
  contextTokens: number | null;
  compactionLimit: number | null;
  /** null when the held claim (if any) carries no checkpoint yet. */
  lastCheckpoint: AgentDossierCheckpoint | null;
  /** Directed messages (never a broadcast) addressed to this agent that are
   *  still unanswered — "how many peers are blocked on this agent". */
  unansweredDirectedCount: number;
  /** Last recorded tool_invocations row for this owner — null if never observed. */
  lastToolCallAt: string | null;
  /** Signal keys whose underlying read THREW this call rather than returning
   *  genuinely empty data (EI-18694403367371331). Empty array = every signal
   *  resolved normally (even if some legitimately came back empty/none). */
  unavailableSignals: AgentSignalKey[];
}

/** One event this agent is currently subscribed to — an un-fired, un-cancelled
 *  row in `harness_shared.event_awaits`. */
export interface AgentSubscription {
  eventKey: string;
  policy: string;
  note: string | null;
  /** One-shot await (fires once, then auto-consumes) vs a standing watch that
   *  survives each fire. The two behave very differently for a reader deciding
   *  whether an agent will wake AGAIN, so it is surfaced rather than inferred. */
  once: boolean;
  /** A fire actually WAKES the agent (it carries a wake handle). A subscription
   *  without one is observational: it records the fire but starts no turn. */
  wakes: boolean;
  /** Bypasses the per-subscriber wake floor (human-message / escalation watch). */
  urgent: boolean;
  createdAt: string;
  expiresTs: string | null;
}

/** The agent's live event subscriptions, for the dossier's Events section. */
export interface AgentSubscriptions {
  /** Newest first, bounded by the store's own LIMIT 100. */
  items: AgentSubscription[];
  count: number;
  /** Set when the underlying read FAILED. Never collapse a failure into an
   *  empty list: "subscribed to nothing" and "we could not ask" are opposite
   *  conclusions for anyone deciding whether an agent will ever wake again
   *  (same rationale as `getAgentSignals`' unavailableSignals). */
  error?: string;
}

export interface AgentDetail {
  ownerId: string;
  locks: AgentLocks;
  coord: AgentCoordState;
  nativeSession: NativeSessionHandle | null;
  codex: CodexHomeDiagnostics | null;
  /** Optional (not required) so existing fixtures/mocks built before P-005
   *  (e.g. the chat footer's summary-chip test harness, a second reader of
   *  this SAME DTO) keep compiling without an update — `getAgentDetail`
   *  always populates it for real traffic. */
  signals?: AgentSignals;
  /** Optional for the same reason as `signals` above: this DTO has other
   *  readers whose fixtures predate the field. Always populated for real
   *  traffic by `getAgentDetail`. */
  subscriptions?: AgentSubscriptions;
}

// ──────────────────────────── pure shaping ─────────────────────────────────

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

/**
 * Split a full lock-queue snapshot into one agent's held locks + waiting
 * tickets, cross-referencing each waiting ticket to the lock(s) currently
 * blocking it. Pure → unit-tested. `queue` is the UNFILTERED readQueue result
 * (so blockers from other owners are visible and ahead_count is global).
 */
export function deriveAgentLocks(queue: QueueResult, owner: string): AgentLocks {
  const held: LockHeld[] = queue.active_locks
    .filter((l) => l.owner === owner)
    .map((l) => ({
      path: l.path,
      intent: l.intent,
      acquiredAt: iso(l.acquired_ts),
      expiresAt: iso(l.expires_ts),
    }));

  const waiting: LockWaiting[] = queue.waiting
    .filter((w) => w.owner === owner)
    .map((w) => ({
      ticketId: w.ticket_id,
      paths: w.paths,
      intent: w.intent,
      aheadCount: w.ahead_count ?? 0,
      queuedAt: iso(w.queued_ts),
      waitUntil: iso(w.wait_until),
      blockedBy: queue.active_locks
        // WI-5979: match WITHIN a lock domain. The read is now cross-domain, and
        // the same repo-relative path in two different checkouts is two different
        // physical files — cross-attributing them would invent blockers.
        .filter(
          (l) =>
            l.owner !== owner &&
            l.coordination_domain === w.coordination_domain &&
            w.paths.includes(l.path),
        )
        .map((l) => ({
          path: l.path,
          holder: l.owner,
          holderLabel: l.owner_label,
          intent: l.intent,
          expiresAt: iso(l.expires_ts),
        })),
    }));

  return { held, waiting, error: null };
}

/** Stable (ts, msg_id) ascending comparator — the canonical coord ordering. */
function byTs(a: CoordEnvelope, b: CoordEnvelope): number {
  return a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id);
}

/** Direction relative to the agent (helper keeps the literal type through .map). */
function directionFor(from: string, owner: string): 'inbound' | 'outbound' {
  return from === owner ? 'outbound' : 'inbound';
}

/**
 * Recipients of an envelope, defensively.
 *
 * `getAgentCoordState` reads the append-only coord log and CASTS the raw lines
 * to `CoordEnvelope[]` — an unchecked assertion over a historical file that
 * spans format changes and several writers, so `to` is not guaranteed to be the
 * array the type promises. It only has to be missing on ONE row: every call
 * site below is inside a `.filter`, the throw escapes to getAgentCoordState's
 * try/catch, and the whole Coord section collapses to an error string for EVERY
 * agent (owner-reported 2026-07-26: "Cannot read properties of undefined
 * (reading 'includes')" rendered in place of the panel's coord state).
 *
 * Coercing here — rather than `?? []` at each of the four call sites — keeps the
 * fix in one place and makes the degradation proportionate: a malformed row
 * simply matches no owner, instead of blinding the panel.
 */
/**
 * Max unread rows carried in `AgentCoordState.unread`.
 *
 * A BOUND ON THE LIST ONLY — never on `unreadCount`, which stays the true
 * total (D-003: a badge capped to its page size is just a different lie). 25 is
 * the reader's own default page, so the dossier shows what one `coord:inbox`
 * read would show and says "showing 25 of M" past that.
 */
export const UNREAD_LIST_LIMIT = 25;

function recipientsOf(env: { to?: unknown }): string[] {
  return Array.isArray(env.to) ? (env.to as string[]) : [];
}

/**
 * Shape one agent's coord state from the raw message log + handoff/escalation
 * folds. Pure → unit-tested. `messages` is the full `messages` surface;
 * `acked` is the set the owner has acknowledged; `handoffs`/`escalations` are
 * already folded to status=open; `readCursor` is the agent's last read
 * receipt (see `readUnreadCursor`), or null when it has none on record;
 * `bornAt` is the BIRTH FLOOR, which governs BROADCASTS ONLY (WI-6589).
 */
export function deriveCoordState(
  messages: CoordEnvelope[],
  acked: Set<string>,
  handoffs: HandoffWithAcceptance[],
  escalations: EscalationRecord[],
  owner: string,
  readCursor: string | null,
  bornAt: string | null = null,
): AgentCoordState {
  // Last message directly involving the agent — sent by it or addressed to it.
  // Pure '*' broadcasts where the agent isn't explicitly listed are excluded:
  // they aren't really "this agent's" message.
  const involving = messages
    .filter((m) => m.from === owner || recipientsOf(m).includes(owner))
    .sort(byTs);
  const last = involving.length > 0 ? involving[involving.length - 1] : null;
  const lastMessage: CoordMessageSummary | null = last
    ? {
        msgId: last.msg_id,
        from: last.from,
        to: last.to,
        kind: last.kind,
        summary: last.summary ?? last.body ?? '',
        ts: last.ts,
        direction: directionFor(last.from, owner),
      }
    : null;

  // Unread = inbox messages (to the agent or broadcast) of kind 'message', not
  // self-sent, that arrived AFTER the agent's last read receipt and were not
  // explicitly acked.
  //
  // The read-cursor leg is unread-count-truthfulness-2026-07-27 P-002. Before
  // it, this counted the WHOLE log minus explicit acks — and agents essentially
  // never send an explicit `kind:'ack'`, so the badge was an all-time total. It
  // read 19,391 for one live agent (19,390 of them broadcasts), which is the
  // ~19k the owner reported. Note the fix is to INTRODUCE a cursor, not to add
  // a fallback to a dead one: unlike the continuation gate, this path never
  // consulted `messages_since_ts` at all (D-004).
  //
  // ts values are ISO strings and compare lexicographically — the same
  // assumption `byTs` above already relies on.
  //
  // Phase 2 (P-004/P-005, D-006) then narrowed this to what the agent is
  // actually SHOWN: the count is the INTERSECTION of the predicate above and a
  // DEFAULT `coord:inbox` read, so it can only ever go down, never up. The four
  // visibility rules are REUSED from coord:inbox's own modules — never a second
  // copy, since a counter that disagrees with the reader is this plan's bug.
  //
  // Applied in coord:inbox's own order (tools/inbox.ts): retraction → ambient →
  // intent-declare → coalesce. Deliberately NOT applied: the display `limit`
  // (a badge capped at the page size would be a new lie, and D-003 forbade
  // capping) and the opt-in `from`/`unanswered_only` narrowing (caller-supplied,
  // not "what a default read shows"). The `kind:'message'` narrowing STAYS:
  // reading "agree with coord:inbox" literally would ADD acks/handoffs and
  // raise the number, which is the opposite of this plan's purpose.
  // WI-6589: the BIRTH FLOOR governs BROADCASTS ONLY.
  //
  // D-012 folded the floor into the same `pickUnreadCursor` max as the three
  // read receipts, which made it govern EVERY candidate. Its own justification
  // never reached that far: "a `to:['*']` broadcast is a fan-out to the
  // population ALIVE AT SEND TIME, so an agent born afterwards was never in that
  // population". A message that NAMES this owner is the opposite case — a peer
  // addressed this exact agent id, so it was deliverable by construction and no
  // statement about the agent's birth can make it un-addressed.
  //
  // That distinction is load-bearing because the floor is not the true birth:
  // `adv_sessions` keeps ONE row per coord owner and four paths bump its
  // `started_at = now()` in place on resume/re-anchor, so MIN(started_at) is the
  // LATEST LAUNCH for every one of the 13,797 owners on record. Measured on the
  // live log (papercusp-workspace, 7d): 8,954 targeted non-self messages to 153
  // owners, of which 6,957 (78%) across 78 owners (51%) sit BELOW their
  // recipient's computed floor. Every one of those was a peer writing to a
  // specific agent.
  //
  // Applying the floor only to broadcasts keeps WI-6496 intact (a newborn still
  // does not inherit the fleet's broadcast backlog) while making it impossible
  // for a respawn to hide mail somebody actually addressed to this agent.
  // `first_seen_at` (migration 707) makes the broadcast half honest too.
  const unreadCandidates = messages.filter((m) => {
    if (m.kind !== 'message' || m.from === owner || acked.has(m.msg_id)) return false;
    const to = recipientsOf(m);
    const addressed = to.includes(owner);
    if (!addressed && !to.includes('*')) return false;
    if (readCursor && m.ts <= readCursor) return false;
    // Broadcasts only — an explicitly-addressed message is never floored.
    if (!addressed && bornAt && m.ts <= bornAt) return false;
    return true;
  });
  // Retraction markers are collected from the FULL raw window, not the unread
  // slice — the "disregard that" notice may sit either side of the cursor.
  const visible = suppressRetracted(unreadCandidates, collectRetractedIds(messages)).filter(
    (m) => !isAmbientBroadcast(m as unknown as Record<string, unknown>),
  );
  // Intent declares are the LARGER of the two Phase-2 legs and are NOT
  // broadcasts: they fan out addressed to each @plan/@fleet subscriber, so the
  // recipient predicate above counts every one (measured 2026-07-27: up to 68%
  // of one agent's counted messages over 12h).
  const { kept: withoutIntents } = excludeIntentDeclares(
    visible as unknown as Array<Record<string, unknown>>,
    {},
  );
  // A coalesced group is ONE row in the reader, so it counts once.
  const unreadRows = coalesceRepeatedBroadcasts(withoutIntents);
  const unreadCount = unreadRows.length;
  // Carry the ROWS, not just their length. `unreadCount` used to be the only
  // thing derived from this array, which left the dossier's coord section with
  // nothing to render but `lastMessage` — one line beside a badge promising N.
  // Newest first (the same lexicographic ISO compare `byTs` uses) and bounded,
  // because this rides the agent-detail payload on every poll; `unreadCount`
  // above stays the TRUE total, so the surface can say "showing N of M".
  const unread: CoordMessageSummary[] = (unreadRows as unknown as CoordEnvelope[])
    .slice()
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, UNREAD_LIST_LIMIT)
    .map((m) => ({
      msgId: m.msg_id,
      from: m.from,
      to: recipientsOf(m),
      kind: m.kind,
      summary: m.summary ?? m.body ?? '',
      ts: m.ts,
      direction: directionFor(m.from, owner),
    }));

  const openHandoffs: CoordHandoffSummary[] = handoffs
    .filter((h) => h.record.from === owner || recipientsOf(h.record).includes(owner))
    .map((h) => ({
      msgId: h.record.msg_id,
      from: h.record.from,
      to: h.record.to,
      summary: h.record.summary ?? '',
      ts: h.record.ts,
      planSlug: h.record.plan_slug ?? null,
      nextAction: h.record.next_action ?? null,
      direction: directionFor(h.record.from, owner),
      accepted: h.accepted_by != null,
    }))
    .sort((a, b) => b.ts.localeCompare(a.ts));

  const openEscalations: CoordEscalationSummary[] = escalations
    .filter((e) => e.from === owner)
    .map((e) => ({
      msgId: e.msg_id,
      severity: e.severity,
      summary: e.summary ?? '',
      ts: e.ts,
      planSlug: e.plan_slug ?? null,
    }))
    .sort((a, b) => b.ts.localeCompare(a.ts));

  return { lastMessage, unreadCount, unread, openHandoffs, openEscalations, error: null };
}

// ──────────────────────────── thin async fetchers ──────────────────────────

const EMPTY_LOCKS: AgentLocks = { held: [], waiting: [], error: null };

/** Read one agent's held + waiting locks from the SU lock store. */
export async function getAgentLocks(owner: string): Promise<AgentLocks> {
  try {
    await ensureBootstrap();
    const sql = getTxPool();
    // Unfiltered read: we need other owners' active locks (to attribute
    // blockers) and the global ahead_count. The result is small (active edits).
    //
    // WI-5979: `coordinationDomain: null` = read across EVERY domain, deliberately
    // NOT `lockCoordinationDomain()`. That helper keys off the repo root of the
    // process that loaded it, so this dossier read matched only locks acquired
    // through an operator running from the SAME checkout. In practice the ports
    // disagree — :3070 serves from papercup-release while the Tauri desktop's
    // :3270 serves from the staging tree — so every lock (100% of live rows were
    // recorded under the release root) was invisible to the desktop dossier, and
    // invisible SILENTLY: an empty read is not an error, so "No locks held or
    // waiting." was indistinguishable from a wrong-namespace lookup.
    //
    // `owner` is a globally-unique ownerId, so the domain filter added no
    // correctness to a per-agent diagnostic — only this bug. Blocker attribution
    // stays within-domain in deriveAgentLocks.
    const queue = await readQueue(sql, { coordinationDomain: null });
    return deriveAgentLocks(queue, owner);
  } catch (e) {
    return { ...EMPTY_LOCKS, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The two bounds on this agent's unread set — kept SEPARATE (WI-6589).
 *
 * `receipts` answers "what has this agent already read" and applies to every
 * message. `bornAt` answers "what could ever have reached it" and applies to
 * BROADCASTS ONLY — see the filter in `deriveCoordState` for why, and for the
 * measured cost of conflating them. Either may be null (nothing on record).
 */
type UnreadCursors = { receipts: string | null; bornAt: string | null };

/**
 * This agent's unread bounds (ISO), each null if nothing on record sets it.
 *
 * FOUR signals. The first three are read RECEIPTS ("what has this agent already
 * read"), folded by the shared `pickUnreadCursor` rule (the LATER wins); the
 * fourth is a BIRTH FLOOR ("what could ever have reached it"), returned
 * separately because it governs only broadcasts.
 *
 * unread-count-truthfulness-2026-07-27 D-012 (owner-reported 2026-07-27: a
 * BRAND-NEW session showed 1031 unread). The three receipt legs are all empty
 * by construction for a newborn — it has no watermark row, and it has not yet
 * called coord:inbox/coord:orient — so `pickUnreadCursor` honestly returned
 * null and the count fell back to the WHOLE visible log. D-007 measured that
 * same no-cursor path but reasoned about it ONLY as a REAPED agent, where a
 * historical backlog is defensible; the newborn is the opposite end of the same
 * branch and is NOT defensible: every one of those messages predates the
 * agent's existence.
 *
 * Why this is a truthfulness fix and not the display cap D-003 forbids: a
 * `to:['*']` broadcast is a fan-out to the population ALIVE AT SEND TIME. An
 * agent born afterwards was never in that population, so the message was never
 * deliverable to it — "unread" would assert it was addressed to this agent and
 * ignored, which is false. The floor changes which messages are CANDIDATES, not
 * how a candidate count is rendered.
 *
 * It composes with the existing legs rather than replacing them, and cannot
 * raise a count above the no-floor baseline:
 *   - newborn, no receipts        → floor wins    → counts only post-birth broadcasts
 *   - live agent with receipts    → receipt wins  → unchanged (receipts are later)
 *   - reaped agent, row GC'd      → floor is null → unchanged, D-007 preserved
 *   - reaped agent, row surviving → floor wins    → counts its LIFETIME, not all time
 *
 * WI-6589 narrowed WHAT the floor governs (broadcasts, not addressed mail) —
 * not whether it applies. Every row above still holds for broadcasts.
 *
 * Deliberately folded HERE and not inside `pickUnreadCursor` itself: that
 * helper is shared with the continuation gate (loop/checkpoint.ts), and D-008 /
 * D-011 define it as a pure max over cursor legs. Pushing a birth floor into it
 * would silently change what makes a second consumer continue a turn.
 *
 * The receipt signals, unchanged:
 *   - `messages_since_ts` — the turn-END settle watermark. ATTACHED-ONLY, so a
 *     detached/headless session keeps its initial `''` forever; on its own it
 *     is a dead pointer for ~95% of rows.
 *   - `messages_shown_ts` — advanced deterministically by `coord:inbox` at
 *     injection. The authoritative "this agent was shown it" signal (D-002).
 *   - the newest `coord:inbox`/`coord:orient` row in `tool_invocations`, via
 *     the shared `lastInboxReadAtBatch` — the same list the coord-deafness
 *     derivation uses, so the two cannot drift on what counts as a read.
 *
 * Fail-soft to null: an unreadable receipt must not silently claim the agent
 * has read something it has not. Null is honest ("no receipt on record") and
 * simply restores the pre-cursor behaviour for that one agent.
 */
async function readUnreadCursor(owner: string): Promise<UnreadCursors> {
  try {
    const [wm, lastReadByOwner, bornAt] = await Promise.all([
      readWatermark(owner),
      lastInboxReadAtBatch([owner]),
      // Fail-soft on its own, so a birth-time lookup failure degrades to the
      // three-receipt behaviour rather than taking the whole cursor down.
      firstAdvSessionStartByCoordOwner(owner).catch(() => null),
    ]);
    const receipts = pickUnreadCursor(
      pickUnreadCursor(wm?.messages_since_ts, wm?.messages_shown_ts),
      lastReadByOwner.get(owner) ?? null,
    );
    return { receipts, bornAt };
  } catch {
    return { receipts: null, bornAt: null };
  }
}

/** Read one agent's coord state (last message, unread, open handoffs/escalations). */
export async function getAgentCoordState(owner: string): Promise<AgentCoordState> {
  try {
    const [messages, acked, handoffs, escalations, cursors] = await Promise.all([
      coordLog.readLines('messages') as Promise<CoordEnvelope[]>,
      readAckedMsgIds(owner),
      listHandoffs({ status: 'open' }),
      listEscalations({ status: 'open' }),
      readUnreadCursor(owner),
    ]);
    return deriveCoordState(
      messages,
      acked,
      handoffs,
      escalations,
      owner,
      cursors.receipts,
      cursors.bornAt,
    );
  } catch (e) {
    return {
      lastMessage: null,
      unreadCount: 0,
      unread: [],
      openHandoffs: [],
      openEscalations: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function getAgentCodexDiagnostics(owner: string): Promise<CodexHomeDiagnostics | null> {
  try {
    const session = await latestAdvSessionByCoordOwner(owner);
    if (session?.agent !== 'codex') return null;
    return readCodexHomeDiagnostics(session.id);
  } catch (e) {
    return {
      ...readCodexHomeDiagnostics(`unknown-${owner}`),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function getAgentNativeSession(owner: string): Promise<NativeSessionHandle | null> {
  try {
    const session = await latestAdvSessionByCoordOwner(owner);
    if (!session) return null;
    let handle: NativeSessionHandle | null;
    if (session.agent === 'codex') {
      const diagnostics = readCodexHomeDiagnostics(session.id);
      handle = nativeSessionHandleForAdvSession(session, {
        findCodexRolloutId: () => diagnostics.latestRolloutId,
      });
    } else {
      handle = nativeSessionHandleForAdvSession(session);
    }
    // WI-5226 (EI-308 gap 2): an ENDED claude session's transcript is almost
    // always already deleted (archive-at-death hook, ~15s after turn end) by
    // the time a human opens this dossier — verify + best-effort rematerialize
    // before telling the UI "exact resume: supported" with a command that would
    // otherwise ENOENT. Only for ended sessions — a live one's dir is untouched.
    if (
      handle?.backend === 'claude' &&
      handle.exactResumeSupported &&
      session.endedAt &&
      handle.sessionId &&
      handle.configDir
    ) {
      handle = await ensureClaudeResumeDirMaterialized(handle);
    }
    return handle;
  } catch {
    return null;
  }
}

/**
 * I/O wrapper for {@link claudeHandleAfterRematerializeAttempt}: checks whether
 * `handle`'s session transcript is actually present on disk under `configDir`,
 * and if not, best-effort rematerializes it from the archive (the SAME primitive
 * `/adv/sessions/rematerialize` and the wake-executor already use). Never throws
 * — a failed check/rematerialize just downgrades the handle, it never breaks the
 * dossier. Lazy import: session-archive fails LOUD at import when zstd is
 * unavailable, matching the rematerialize route's own lazy-import rationale.
 */
async function ensureClaudeResumeDirMaterialized(
  handle: ClaudeNativeSessionHandle,
): Promise<ClaudeNativeSessionHandle> {
  const sessionId = handle.sessionId;
  const configDir = handle.configDir;
  if (!sessionId || !configDir) return handle;
  try {
    const { listClaudeSessionIds, rematerializeSession } = await import('./session-archive');
    const present = (await listClaudeSessionIds(configDir)).includes(sessionId);
    if (present) {
      return claudeHandleAfterRematerializeAttempt(handle, { presentOnDisk: true, rematerialized: false });
    }
    const result = await rematerializeSession({ sourceKind: 'claude', sessionId, targetRoot: configDir });
    return claudeHandleAfterRematerializeAttempt(handle, {
      presentOnDisk: false,
      rematerialized: result.ok,
      rematReason: result.ok ? undefined : result.reason,
    });
  } catch (e) {
    return claudeHandleAfterRematerializeAttempt(handle, {
      presentOnDisk: false,
      rematerialized: false,
      rematReason: e instanceof Error ? e.message : String(e),
    });
  }
}

const ALL_AGENT_SIGNAL_KEYS: AgentSignalKey[] = [
  'loop',
  'currentClaim',
  'context',
  'unanswered',
  'lastToolCall',
];

const EMPTY_SIGNALS: AgentSignals = {
  loop: null,
  currentClaim: null,
  contextTokens: null,
  compactionLimit: null,
  lastCheckpoint: null,
  unansweredDirectedCount: 0,
  lastToolCallAt: null,
  // The outer-catch fallback below can't tell which individual read failed
  // (it fires on a synchronous bug in the shaping code, not a rejected
  // promise — every promise already carries its own per-key catch), so it
  // marks ALL of them unavailable rather than claiming a clean read.
  unavailableSignals: ALL_AGENT_SIGNAL_KEYS,
};

/** Read one agent's P-005 health signals (loop/claim/context/checkpoint/unanswered/last-tool-call). */
export async function getAgentSignals(owner: string): Promise<AgentSignals> {
  const unavailable: AgentSignalKey[] = [];
  // EI-18694403367371331: a signal's underlying read failing must be VISIBLE
  // (logged + surfaced in `unavailableSignals`), never silently collapsed
  // into the same shape as a legitimate "holds nothing" / "no loop" state —
  // a leader reading a falsely-empty CLAIM as "this agent is idle" is
  // precisely the wrong conclusion when deciding whether to reclaim work.
  const onFailure =
    (key: AgentSignalKey) =>
    <T>(fallback: T) =>
    (err: unknown): T => {
      unavailable.push(key);
      console.warn(`[adv-agent-detail] getAgentSignals(${owner}) ${key} signal threw:`, err);
      return fallback;
    };
  try {
    const workspaceId = activeWorkspaceId();
    const [loopStatus, held, presence, unanswered, lastToolCall] = await Promise.all([
      getLoopStatus(owner).catch(onFailure('loop')(null)),
      readHeldWorkItems(owner, workspaceId).catch(onFailure('currentClaim')([])),
      getPresence(owner).catch(onFailure('context')(null)),
      fetchUnansweredDirected([owner]).catch(onFailure('unanswered')(new Map())),
      lastToolCallAtByOwner([owner]).catch(onFailure('lastToolCall')(new Map())),
    ]);
    // readHeldWorkItems is ordered DESC by feature_id (most-recently-created
    // first) — the front row is the agent's most current claim, matching what
    // "current claim" means at a glance.
    const top = held[0] ?? null;
    return {
      loop: loopStatus
        ? {
            active: loopStatus.active,
            intervalSec: loopStatus.intervalSec,
            nextFireAt: loopStatus.nextFireAt,
            parked: loopStatus.parked,
            stalled: loopStatus.stalled,
          }
        : null,
      currentClaim: top ? { id: top.id, title: top.title, harness: top.harness } : null,
      contextTokens: presence?.contextTokens ?? null,
      compactionLimit: presence?.compactionLimit ?? null,
      lastCheckpoint:
        top?.checkpoint != null
          ? { text: top.checkpoint, updatedAtMs: top.checkpointUpdatedAtMs ?? null }
          : null,
      unansweredDirectedCount: unanswered.get(owner)?.count ?? 0,
      lastToolCallAt: lastToolCall.get(owner) ?? null,
      unavailableSignals: unavailable,
    };
  } catch (err) {
    console.warn(`[adv-agent-detail] getAgentSignals(${owner}) failed entirely:`, err);
    return EMPTY_SIGNALS;
  }
}

/** The full Tier-3 dossier for one agent: locks + coord + client diagnostics, fetched concurrently. */
/**
 * The events this agent is currently subscribed to — the un-fired, un-cancelled
 * `event_awaits` rows that `events:status` reports as "active awaits".
 *
 * [owner 2026-07-28, verbatim] "are the events an agent currently subscribed to
 * listed in their chat popup? If not add that". They were not: the dossier
 * carried locks, coord and signals, so a reader could see what an agent HELD
 * and what it had SAID, but not what it was WAITING FOR — which is the field
 * that explains an agent sitting apparently idle. An agent parked on an await
 * looks identical to a dead one until you can see the await.
 *
 * A read failure surfaces as `error`, never as an empty list (see the DTO).
 */
export async function getAgentSubscriptions(owner: string): Promise<AgentSubscriptions> {
  try {
    const { listActiveAwaits } = await import('./events/await/store');
    const rows = await listActiveAwaits(owner);
    return {
      items: rows.map((r) => ({
        eventKey: r.eventKey,
        policy: r.policy,
        note: r.note,
        once: r.once,
        wakes: r.wakeHandle !== null,
        urgent: r.urgency,
        createdAt: r.createdAt,
        expiresTs: r.expiresTs,
      })),
      count: rows.length,
    };
  } catch (err) {
    console.warn(`[adv-agent-detail] getAgentSubscriptions(${owner}) threw:`, err);
    return { items: [], count: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getAgentDetail(owner: string): Promise<AgentDetail> {
  const [locks, coord, nativeSession, codex, signals, subscriptions] = await Promise.all([
    getAgentLocks(owner),
    getAgentCoordState(owner),
    getAgentNativeSession(owner),
    getAgentCodexDiagnostics(owner),
    getAgentSignals(owner),
    getAgentSubscriptions(owner),
  ]);
  return { ownerId: owner, locks, coord, nativeSession, codex, signals, subscriptions };
}
