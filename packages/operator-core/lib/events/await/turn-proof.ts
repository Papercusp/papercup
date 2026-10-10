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
