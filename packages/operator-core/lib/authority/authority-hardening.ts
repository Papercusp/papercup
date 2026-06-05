/**
 * authority-hardening — fencing + anti-flap for the lowest-pubkey lock authority
 * (D-006, locks-correctness-hardening-2026-06-04).
 *
 * The authority (lock-authority.ts) is a ZK/etcd-style leader election done as a
 * deterministic argmin over the live `shared_presence` roster — elegant (no
 * round-trip), but bare argmin has three classic hazards the literature names:
 *
 *   1. SPLIT-BRAIN during a failover gap — two peers each briefly believe they
 *      are the authority and both grant. The literature-mandated fix is NOT to
 *      prevent it (impossible while fail-open) but to make it HARMLESS via a
 *      monotonic FENCING token: every grant carries the `authority_epoch` that
 *      minted it, and a downstream check rejects a grant whose epoch is below the
 *      highest it has seen. A stale ex-authority's late grant is fenced out.
 *   2. BULLY-ALGORITHM FLAP — a peer with a lower pubkey that briefly dropped and
 *      returns instantly steals the authority back, thrashing it. Fixed with
 *      NO-PREEMPTION HYSTERESIS + a re-grant COOLDOWN (Consul `lock-delay` /
 *      Chubby grace period): while the current authority is still live, a
 *      returning lower peer cannot preempt it until a cooldown elapses.
 *   3. STEALING IN-FLIGHT WORK on handover — a new authority that enforces
 *      immediately can revoke leases the old authority just granted. Fixed with
 *      an RCU GRACE PERIOD: a freshly-elected authority waits one heartbeat
 *      interval (for holders to re-assert) before it enforces.
 *
 * This module is PURE (no PG): it takes the live candidate set + the persisted
 * prior-authority record + a clock, and returns the hardened decision. The
 * persistence (an `authority_grants` row per harness, federated like presence)
 * and the wiring into `lockAuthorityFor` are thin layers on top; the existing
 * deterministic argmin stays the default so callers already riding the authority
 * (claim stores) are unaffected until they opt into the epoch.
 */

/** A persisted record of the current authority for one harness. */
export interface AuthorityRecord {
  /** The device pubkey currently holding authority. */
  pubkey: string;
  /** Monotonic fencing epoch — bumped every time `pubkey` CHANGES. */
  epoch: number;
  /** Server-clock ms when this authority was elected (the current `pubkey` took over). */
  electedAtMs: number;
}

export interface HardeningTiming {
  /** Heartbeat interval (ms). TTL/grace/cooldown are multiples of this. */
  heartbeatMs: number;
  /** Staleness window — a peer must miss this long to drop out. Default 3× heartbeat. */
  staleMs?: number;
  /** RCU grace after an election before the new authority enforces. Default 1× heartbeat. */
  graceMs?: number;
  /** Re-grant cooldown: a live authority can't be preempted by a returning lower
   *  peer until this elapses. Default 2× heartbeat. */
  cooldownMs?: number;
  /** Deterministic jitter in [0,1) applied to staleMs (anti-thundering-herd).
   *  Pass a per-peer-stable value (e.g. derived from the pubkey); default 0. */
  jitter?: number;
}

export interface AuthorityDecision {
  /** The effective authority pubkey after hysteresis/cooldown. */
  pubkey: string;
  /** The fencing epoch a grant minted under this decision must carry. */
  epoch: number;
  /** Server-clock ms this authority was (re-)elected. */
  electedAtMs: number;
  /** True when this decision changed the authority vs the prior record. */
  changed: boolean;
  /** True while still inside the RCU grace window — the authority should NOT
   *  enforce/revoke yet (let holders re-assert). */
  withinGrace: boolean;
}

/** TTL = 3× heartbeat by default (the "3–5× heartbeat" anti-flap rule). */
export function staleWindowMs(t: HardeningTiming): number {
  const base = t.staleMs ?? t.heartbeatMs * 3;
  // Additive per-peer jitter up to one heartbeat, so peers don't all expire a
  // dropped authority on the same tick.
  return base + Math.floor((t.jitter ?? 0) * t.heartbeatMs);
}

function graceWindowMs(t: HardeningTiming): number {
  return t.graceMs ?? t.heartbeatMs;
}

function cooldownWindowMs(t: HardeningTiming): number {
  return t.cooldownMs ?? t.heartbeatMs * 2;
}

/**
 * Decide the hardened authority.
 *
 * @param argminPubkey  the bare deterministic winner (lowest live pubkey), or
 *                      null when there are no live candidates.
 * @param priorLive     whether the PRIOR authority's pubkey is still a live
 *                      candidate right now (fresh heartbeat).
 * @param prior         the persisted prior-authority record, or null on first election.
 * @param nowMs         server-clock now.
 */
export function decideAuthority(
  argminPubkey: string | null,
  priorLive: boolean,
  prior: AuthorityRecord | null,
  nowMs: number,
  timing: HardeningTiming,
): AuthorityDecision | null {
  if (argminPubkey == null) return null; // no swarm — caller handles "alone"

  // First election ever.
  if (!prior) {
    return { pubkey: argminPubkey, epoch: 1, electedAtMs: nowMs, changed: true, withinGrace: true };
  }

  // The argmin agrees with the incumbent → no change, carry the epoch.
  if (argminPubkey === prior.pubkey) {
    return {
      pubkey: prior.pubkey,
      epoch: prior.epoch,
      electedAtMs: prior.electedAtMs,
      changed: false,
      withinGrace: nowMs < prior.electedAtMs + graceWindowMs(timing),
    };
  }

  // A DIFFERENT peer would win the bare argmin. Two cases:
  //  - The incumbent is STILL live AND within the cooldown → NO-PREEMPTION
  //    HYSTERESIS: keep the incumbent (a returning lower peer doesn't thrash it).
  //  - The incumbent is gone (not live) OR the cooldown elapsed → fail over:
  //    bump the epoch (fencing), reset electedAt, enter the RCU grace window.
  const cooldownActive = priorLive && nowMs < prior.electedAtMs + cooldownWindowMs(timing);
  if (cooldownActive) {
    return {
      pubkey: prior.pubkey,
      epoch: prior.epoch,
      electedAtMs: prior.electedAtMs,
      changed: false,
      withinGrace: false,
    };
  }
  return { pubkey: argminPubkey, epoch: prior.epoch + 1, electedAtMs: nowMs, changed: true, withinGrace: true };
}

/**
 * Fencing check (Kleppmann): is a grant minted at `grantEpoch` still valid given
 * the highest epoch the resource has seen? A stale ex-authority's grant carries a
 * lower epoch and is rejected — which is what makes a split-brain harmless.
 */
export function fenceValid(grantEpoch: number, highestSeenEpoch: number): boolean {
  return grantEpoch >= highestSeenEpoch;
}

/** Whether a freshly-elected authority may enforce yet (RCU grace elapsed). */
export function canEnforce(decision: AuthorityDecision, nowMs: number, timing: HardeningTiming): boolean {
  return nowMs >= decision.electedAtMs + graceWindowMs(timing);
}
