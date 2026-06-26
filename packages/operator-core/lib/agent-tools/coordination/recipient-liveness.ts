/**
 * recipient-liveness.ts — FF#3: force a FRESH liveness read into a transfer result.
 *
 * The incident: an agent read another agent's presence ONCE at session start, then
 * handed it work ~13h later when it had long since ended — and the `woken:0` it got
 * back was rationalized away. The handoff/wake tools already probe liveness at the
 * transfer point (the wake fan), but they reported only a count. This forces the
 * missed addressee's CURRENT session state INTO the result, so a transfer to a
 * long-dead agent reads `ended` instead of a silent `woken:0` — the fresh read can't
 * be skipped because it's in the answer the caller is already looking at.
 *
 * Only the MISS path calls this (a wake/handoff that woke nobody), so the two extra
 * batch queries in fetchWakeability never touch the common case. Fully fail-soft: any
 * error → [] (a liveness-probe hiccup must NEVER fail an already-durable send/handoff).
 *
 * Leaf module by design: it consumes inbox-wake (NON_WAKEABLE) + recipient-resolve
 * (isSelectorOrWildcard) + presence-wakeability (fetchWakeability/deriveSessionState),
 * none of which import it — so there is no import cycle.
 */
import { NON_WAKEABLE } from './inbox-wake';
import { isSelectorOrWildcard } from './recipient-resolve';
import { fetchWakeability, deriveSessionState, type SessionState } from './presence-wakeability';

export interface MissedRecipientLiveness {
  ownerId: string;
  /** Fresh coordinator-facing state at the transfer moment. `ended` = no live
   *  inbox-wake await (a wake reaches nobody → relaunch, do NOT assume pickup).
   *  `unknown` = federated/remote or not probeable here. */
  sessionState: SessionState | 'unknown';
  /** A live `coord:inbox-wake:<id>` await exists → a wake WOULD land. false ⇒
   *  nothing is listening; the inject black-holes until the agent is relaunched. */
  wakeable: boolean;
}

/**
 * Fresh per-recipient session state for a MISS path (FF#3). `ownerIds` is the set a
 * wake/handoff just FAILED to wake. Returns one row per concrete addressee with its
 * CURRENT `sessionState` + `wakeable`, freshly read (never a cached snapshot).
 *
 * `deriveSessionState` is fed `stale:false` because `wakeable` is the authoritative
 * gate it already short-circuits on (not wakeable ⇒ `ended` regardless of heartbeat
 * warmth) — exactly the signal that matters for "is this transfer a dead drop?".
 */
export async function describeMissedRecipients(
  ownerIds: readonly string[],
): Promise<MissedRecipientLiveness[]> {
  const ids = [...new Set(ownerIds)].filter(
    (r) => !isSelectorOrWildcard(r) && !NON_WAKEABLE.has(r),
  );
  if (ids.length === 0) return [];
  try {
    const wake = await fetchWakeability(ids);
    return ids.map((ownerId) => {
      const w = wake.get(ownerId);
      if (!w) return { ownerId, sessionState: 'unknown' as const, wakeable: false };
      const sessionState = deriveSessionState({
        stale: false,
        wakeable: w.wakeable,
        liveTurn: w.liveTurn,
      });
      return { ownerId, sessionState, wakeable: w.wakeable };
    });
  } catch {
    // Fail-soft: a liveness-probe hiccup must never fail the (already-durable) send.
    return [];
  }
}
