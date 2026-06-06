/**
 * liveness.ts — the 3-state agent-liveness scale, as a DEPENDENCY-FREE leaf.
 *
 * Both the server (@/lib/adv-roster, which derives liveness for the roster
 * endpoint) and the client (the presence UI's LivenessDot) need this. The
 * server module can't be imported from a client component — it pulls in the PG
 * presence store and would leak node builtins into the SPA bundle (the
 * operator-vite blank-page failure mode). So the thresholds + the pure
 * derivation live here, importing nothing.
 *
 * STALE_MS mirrors PRESENCE_STALE_MS in @papercusp/coordination/presence; a
 * unit test (adv-roster.test.ts) asserts they stay equal so this copy can't
 * drift.
 */

/** Heartbeat younger than this = "live" (a tool call within the last minute). */
export const LIVE_MS = 60_000;

/** Heartbeat older than this = "stale" (mirrors coordination's PRESENCE_STALE_MS). */
export const STALE_MS = 600_000;

// 'pending' is NOT derived from a heartbeat — it is stamped on a roster entry
// synthesized from a recorded-but-not-yet-running launch (pui-reactive-session-
// panes D-006). deriveLiveness never returns it.
export type Liveness = 'live' | 'idle' | 'stale' | 'pending';

/**
 * Derive liveness from a heartbeat ISO timestamp + a clock (ms epoch). "idle"
 * means no recent tool call (the agent may be mid-reasoning), NOT gone — the
 * heartbeat only fires on tool boundaries. live < LIVE_MS · idle < STALE_MS ·
 * else stale. A missing/unparseable timestamp is treated as stale.
 */
export function deriveLiveness(heartbeatAtIso: string, nowMs: number): Liveness {
  const t = new Date(heartbeatAtIso).getTime();
  if (!Number.isFinite(t)) return 'stale';
  const age = nowMs - t;
  if (age < LIVE_MS) return 'live';
  if (age < STALE_MS) return 'idle';
  return 'stale';
}
