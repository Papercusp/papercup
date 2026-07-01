/**
 * federated-wake-rate — per-author budget for the federated wake fans
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-003).
 *
 * A federated wake re-invokes a LOCAL agent — a billable turn — and the EI-279 /
 * P-002 fans fire it for any admitted hive member's remote-origin row. Without a
 * cap, one admitted-then-compromised (or merely runaway) peer device can spend
 * this machine's token budget at will by streaming wake:true messages. This
 * module is the receiving machine's defense: a sliding one-hour window of wake
 * tokens per AUTHOR DEVICE (the op's provenance authorPubkey — the verified
 * source-log identity; never the spoofable body.from).
 *
 * Semantics:
 *   - tryConsumeFederatedWake(author, n) — spend n tokens (one per agent the fan
 *     would re-invoke); false = over budget → the caller SUPPRESSES the wake but
 *     still applies/persists the message (the recipient sees it next natural
 *     turn — delivery is never dropped, only the re-invoke).
 *   - Process-local by design: each machine defends its OWN spend; no
 *     cross-machine state. State resets on restart (a restart already costs more
 *     than it grants).
 *   - Cap: PAPERCUSP_FED_WAKE_MAX_PER_HOUR (default 30/hour/device — generous
 *     for legitimate cross-machine steering, cheap insurance against a stream).
 *   - Warn once per author per window when the cap first trips (no log spam).
 *
 * The local (send-side) fan is NOT gated here — a local sender is this owner's
 * own agent under its own governance; this is specifically the federation
 * boundary. Fail-open on internal error: a budget bug must never break a wake,
 * and the projection already guards the whole fan best-effort.
 */

const WINDOW_MS = 60 * 60 * 1000;

/** Default hourly wake budget per author device (env-tunable at call time). */
export const DEFAULT_FED_WAKE_MAX_PER_HOUR = 30;

interface AuthorWindow {
  /** Epoch-ms of each consumed token, pruned to the sliding window. */
  spent: number[];
  /** Window-start of the last cap warn, to warn once per window. */
  warnedAt: number;
}

const windows = new Map<string, AuthorWindow>();

function capPerHour(): number {
  const raw = Number(process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FED_WAKE_MAX_PER_HOUR;
}

/**
 * Spend `n` wake tokens from `author`'s sliding-hour budget. Returns true when
 * the whole spend fits (tokens recorded); false when it would exceed the cap
 * (nothing recorded — an over-budget fan is suppressed atomically, not partially).
 */
export function tryConsumeFederatedWake(
  author: string,
  n: number,
  now: number = Date.now(),
): boolean {
  const cap = capPerHour();
  const key = author || 'unknown';
  let w = windows.get(key);
  if (!w) {
    w = { spent: [], warnedAt: 0 };
    windows.set(key, w);
  }
  const floor = now - WINDOW_MS;
  w.spent = w.spent.filter((t) => t > floor);
  const want = Math.max(1, Math.floor(n));
  if (w.spent.length + want > cap) {
    if (now - w.warnedAt > WINDOW_MS) {
      w.warnedAt = now;
      // eslint-disable-next-line no-console
      console.warn(
        `[federated-wake-rate] author device ${key.slice(0, 12)}… exceeded ${cap} federated wakes/hour — ` +
          'further wakes suppressed this window (messages still delivered; recipients see them next turn).',
      );
    }
    return false;
  }
  for (let i = 0; i < want; i++) w.spent.push(now);
  return true;
}

/** Test seam: drop all per-author windows. */
export function resetFederatedWakeRate(): void {
  windows.clear();
}
