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
import { lockCoordinationDomain } from './agent-tools/locks/coordination-domain';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { readCodexHomeDiagnostics, type CodexHomeDiagnostics } from './role-codex-home';

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

export interface AgentDetail {
  ownerId: string;
  locks: AgentLocks;
  coord: AgentCoordState;
  codex: CodexHomeDiagnostics | null;
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
        .filter((l) => l.owner !== owner && w.paths.includes(l.path))
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
    .filter((m) => m.from === owner || m.to.includes(owner))
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
      (m.to.includes(owner) || m.to.includes('*')) &&
      !acked.has(m.msg_id),
  ).length;

  const openHandoffs: CoordHandoffSummary[] = handoffs
    .filter((h) => h.record.from === owner || h.record.to.includes(owner))
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
    const queue = await readQueue(sql, { coordinationDomain: lockCoordinationDomain() });
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

/** The full Tier-3 dossier for one agent: locks + coord + client diagnostics, fetched concurrently. */
export async function getAgentDetail(owner: string): Promise<AgentDetail> {
  const [locks, coord, codex] = await Promise.all([
    getAgentLocks(owner),
    getAgentCoordState(owner),
    getAgentCodexDiagnostics(owner),
  ]);
  return { ownerId: owner, locks, coord, codex };
}
