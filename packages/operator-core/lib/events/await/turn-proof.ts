/**
 * Wake-delivery turn-start proof (parked-agent-census-resumption-and-root-cause-2026-10-09
 * P-006 / WI-10008157, decision D-004).
 *
 * `event_wake_deliveries.status = 'delivered'` only says the delivery reached its channel: an
 * inbox write, a pty write, a spawned resume process. Measured 2026-10-10 over 24h, 13,131 of
 * 21,970 inbox deliveries and 259 of 1,119 psu-socket-inject deliveries were followed by no
 * tool_use from the recipient within 10 minutes, yet every one read back as a clean success.
 * `turn_proof` answers the separate question "did a turn actually start", and this module is
 * the one definition of its states that the store, the pump's pickup sweep and the coord
 * wake/send/dispatch results all share.
 */

import { WAKE_TURN_CHANNELS } from './types';

/** Every value `event_wake_deliveries.turn_proof` may hold (migration 1441 CHECK). */
export const TURN_PROOF_STATES = [
  'host-attested',
  'observed',
  'awaiting',
  'not-picked-up',
  'superseded',
] as const;
export type TurnProof = (typeof TURN_PROOF_STATES)[number];

/** The states that prove a turn started. Everything else is NOT pickup. */
export const TURN_PROOF_CONFIRMED: ReadonlySet<TurnProof> = new Set<TurnProof>(['host-attested', 'observed']);

export function isTurnProof(value: unknown): value is TurnProof {
  return typeof value === 'string' && (TURN_PROOF_STATES as readonly string[]).includes(value);
}

/**
 * Channels whose content rides ANOTHER delivery (or was already seen through another read), so
 * the row itself never owes a turn: `coalesced` siblings fold into a headline wake, and
 * `suppressed-redundant` was cancelled because an earlier delivery already carries it.
 */
const SUPERSEDED_CHANNELS: ReadonlySet<string> = new Set(['coalesced', 'suppressed-redundant']);

/**
 * The proof a delivery is booked with at the moment the pump marks it delivered. Only the
 * executor's own attestation is trusted at booking time; every other turn-capable delivery
 * (including the inbox fallback) starts `awaiting` and is resolved later from real-time signals.
 */
export function initialTurnProof(channel: string, attested: 'host-attested' | undefined): TurnProof {
  if (attested === 'host-attested') return 'host-attested';
  if (SUPERSEDED_CHANNELS.has(channel)) return 'superseded';
  return 'awaiting';
}

/** Default pickup window. Basis (D-004): delivery-to-first-tool-use p95 is 200s for
 *  resume-headless and p90 160s for psu-socket-inject, measured 2026-10-10 over 24h. */
export const DEFAULT_PICKUP_WINDOW_SEC = 600;
const MIN_PICKUP_WINDOW_SEC = 30;
const MAX_PICKUP_WINDOW_SEC = 86_400;

/** `PAPERCUSP_WAKE_PICKUP_WINDOW_SEC`, clamped to [30s, 24h]; unset or unparsable ⇒ 600. */
export function pickupWindowSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCUSP_WAKE_PICKUP_WINDOW_SEC;
  if (raw == null || raw.trim() === '') return DEFAULT_PICKUP_WINDOW_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PICKUP_WINDOW_SEC;
  return Math.min(MAX_PICKUP_WINDOW_SEC, Math.max(MIN_PICKUP_WINDOW_SEC, Math.floor(n)));
}

// ── Real-time turn evidence (slice 2) ──────────────────────────────────────────────────────
//
// `tool_invocations` rows by the subscriber after `delivered_at` are the primary turn signal,
// but not every row there is a turn. Measured 2026-10-10 over 3h:
//   • `session:request-compaction` with empty args was called 418× for 17 owners, 280 of them
//     authorization_denied and ~120 no_live_pty_host: a retry stream against sessions with a
//     dead host or a stale identity — it carries no evidence that a turn ran.
//   • hook-origin `activity:report` with kind='lifecycle' ("session started" / "session ended")
//     and display-only `coord:glance` (status line) fire without any turn.
// So an agent-origin call counts unless its tool is excluded below, and a hook-origin call
// counts only for hooks that fire INSIDE a turn (tool-use hooks and the turn journal).

/** Agent-origin tools whose call is NOT evidence that a turn started. */
export const TURN_EVIDENCE_EXCLUDED_AGENT_TOOLS: readonly string[] = ['session:request-compaction'];

/** Hook-origin tools that only fire inside a running turn (Pre/PostToolUse, Stop). */
export const TURN_EVIDENCE_HOOK_TOOLS: readonly string[] = [
  'journal:record-turn',
  'locks:acquire',
  'locks:check_command',
  'locks:release',
];

/** `activity:report` hook phases that are tool-use hooks (lifecycle reports are excluded). */
export const TURN_EVIDENCE_HOOK_ACTIVITY_PHASES: readonly string[] = ['pre', 'post'];

// ── Pickup escalation (D-004 (4)) ──────────────────────────────────────────────────────────

/** `event_wake_deliveries.source` of the ONE re-queue a not-picked-up delivery may get. */
export const PICKUP_ESCALATION_SOURCE = 'pickup-escalation';

/**
 * Channels that tried to START a turn — derived from the floor's own registry, so a new turn
 * channel can never be silently excluded. Only these may escalate: an `inbox` delivery never
 * tried to start one (it is the fallback for an unwakeable session), and D-002 forbids
 * re-waking those rows en masse — they are reported, and P-012 remediates the population.
 */
const ESCALATABLE_CHANNELS: ReadonlySet<string> = new Set<string>(WAKE_TURN_CHANNELS);

/** The slice of the psu host's discovery record and event tail the judge reads. */
export interface PickupHostView {
  execution?: { phase?: string; turnStartedAt?: number | null } | null;
  authBlocked?: boolean;
  quotaBlocked?: boolean;
  /** Newest binding event kind in the host's lifecycle tail, if any. */
  latestBindingEvent?: string | null;
}

/** Host lifecycle events that mean the current child has no confirmed native identity (P-005). */
export const UNBOUND_BINDING_EVENTS: ReadonlySet<string> = new Set([
  'respawn-binding-unconfirmed',
  'respawn-carry-dropped',
]);

/** Host lifecycle events that bracket a carry-respawn's binding outcome, newest wins. */
export const BINDING_EVENTS: ReadonlySet<string> = new Set([
  ...UNBOUND_BINDING_EVENTS,
  'respawn-binding-confirmed',
  'respawn-carry-delivered',
]);

export type PickupRecoverable = 'auth-blocked' | 'quota-blocked' | 'unbound-successor';

export type ExpiredPickupVerdict =
  | { proof: 'observed'; turnStartedAtMs: number; via: 'host-turn-start' }
  | { proof: 'not-picked-up'; escalate: boolean; reason: string; recoverable: PickupRecoverable | null };

/** The P-004/P-005 condition the host reports, if any. Auth first: it is the one a turn cannot outlive. */
export function hostRecoverableCondition(host: PickupHostView | null): PickupRecoverable | null {
  if (!host) return null;
  if (host.authBlocked === true) return 'auth-blocked';
  if (host.quotaBlocked === true) return 'quota-blocked';
  if (host.latestBindingEvent && UNBOUND_BINDING_EVENTS.has(host.latestBindingEvent)) return 'unbound-successor';
  return null;
}

/**
 * Decide an expired `awaiting` delivery (D-004). The tool-call evidence was already checked in
 * SQL; this adds the psu host's own turn-start observation, then decides escalation.
 *
 * A host turn start counts only when it happened after delivery, did not fail, and the host is
 * not blocked: a codex child whose login cannot refresh starts a turn that fails at once, and
 * calling that a pickup would hide exactly the stranded agents this exists to surface.
 */
export function judgeExpiredPickup(
  row: { deliveredAtMs: number; channel: string | null; source: string | null },
  host: PickupHostView | null,
): ExpiredPickupVerdict {
  const recoverable = hostRecoverableCondition(host);
  const started = host?.execution?.turnStartedAt;
  if (
    host &&
    recoverable === null &&
    typeof started === 'number' &&
    Number.isFinite(started) &&
    started > row.deliveredAtMs &&
    host.execution?.phase !== 'failed'
  ) {
    return { proof: 'observed', turnStartedAtMs: started, via: 'host-turn-start' };
  }
  if (row.source === PICKUP_ESCALATION_SOURCE) {
    return { proof: 'not-picked-up', escalate: false, reason: 'already a pickup escalation', recoverable };
  }
  if (!row.channel || !ESCALATABLE_CHANNELS.has(row.channel)) {
    return {
      proof: 'not-picked-up',
      escalate: false,
      reason: `channel ${row.channel ?? 'unknown'} does not start a turn; reported only (D-002)`,
      recoverable,
    };
  }
  if (!host) {
    return { proof: 'not-picked-up', escalate: false, reason: 'no live psu host to recover', recoverable: null };
  }
  if (recoverable === null) {
    return {
      proof: 'not-picked-up',
      escalate: false,
      reason: 'host reports no recoverable condition (P-004/P-005)',
      recoverable: null,
    };
  }
  return { proof: 'not-picked-up', escalate: true, reason: `host ${recoverable}; one re-queue`, recoverable };
}
