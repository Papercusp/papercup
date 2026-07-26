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
import { listHandoffs, type HandoffWithAcceptance } from './agent-tools/coordination/handoffs';
import { listEscalations, type EscalationRecord } from './agent-tools/coordination/escalations';
import { latestAdvSessionByCoordOwner } from './adv-sessions';
import {
  ensureBootstrap,
  getTxPool,
  readQueue,
  type QueueResult,
} from './agent-tools/locks/su-lock-store';
import type { CoordEnvelope } from '@papercusp/coordination/core';
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
  /** Unacked messages addressed to this agent (kind=message; broadcasts included, self-sent excluded). */
  unreadCount: number;
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
function recipientsOf(env: { to?: unknown }): string[] {
  return Array.isArray(env.to) ? (env.to as string[]) : [];
}

/**
 * Shape one agent's coord state from the raw message log + handoff/escalation
 * folds. Pure → unit-tested. `messages` is the full `messages` surface;
 * `acked` is the set the owner has acknowledged; `handoffs`/`escalations` are
 * already folded to status=open.
 */
export function deriveCoordState(
  messages: CoordEnvelope[],
  acked: Set<string>,
  handoffs: HandoffWithAcceptance[],
  escalations: EscalationRecord[],
  owner: string,
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

  // Unread = inbox messages (to the agent or broadcast) of kind 'message',
  // not self-sent, not yet acked by the agent. Mirrors coord:inbox semantics.
  const unreadCount = messages.filter(
    (m) =>
      m.kind === 'message' &&
      m.from !== owner &&
      (recipientsOf(m).includes(owner) || recipientsOf(m).includes('*')) &&
      !acked.has(m.msg_id),
  ).length;

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

  return { lastMessage, unreadCount, openHandoffs, openEscalations, error: null };
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

/** Read one agent's coord state (last message, unread, open handoffs/escalations). */
export async function getAgentCoordState(owner: string): Promise<AgentCoordState> {
  try {
    const [messages, acked, handoffs, escalations] = await Promise.all([
      coordLog.readLines('messages') as Promise<CoordEnvelope[]>,
      readAckedMsgIds(owner),
      listHandoffs({ status: 'open' }),
      listEscalations({ status: 'open' }),
    ]);
    return deriveCoordState(messages, acked, handoffs, escalations, owner);
  } catch (e) {
    return {
      lastMessage: null,
      unreadCount: 0,
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
export async function getAgentDetail(owner: string): Promise<AgentDetail> {
  const [locks, coord, nativeSession, codex, signals] = await Promise.all([
    getAgentLocks(owner),
    getAgentCoordState(owner),
    getAgentNativeSession(owner),
    getAgentCodexDiagnostics(owner),
    getAgentSignals(owner),
  ]);
  return { ownerId: owner, locks, coord, nativeSession, codex, signals };
}
