/**
 * lock-set-reconstructor — the HANDOVER state machine (D-005 of
 * distributed-coordination-shared-harness-2026-06-04).
 *
 * When the lock authority for a harness fails over (the previous authority's
 * presence went stale → the next-lowest live peer is now the authority,
 * automatically, per the deterministic selection), the new authority starts with
 * NO lock state. Holders re-assert their locks to it via TTL heartbeats; within
 * one heartbeat interval the authority has heard from every live holder and its
 * lock set is rebuilt. The brief gap before that is FAIL-OPEN (D-004 — git is the
 * data backstop), never a block.
 *
 * This is that reconstruction, as a pure, injected-clock state machine:
 *  - `assert(path, owner, ttlMs)` — a holder re-asserts a lock (a heartbeat).
 *  - `current()` — the active (non-expired) lock set.
 *  - `isRebuilt()` — true once a full heartbeat interval has elapsed since the
 *    authority took over (so every live holder has had a chance to re-assert).
 *  - `shouldFailOpen()` — true during the rebuild gap; the authority grants
 *    optimistically (fail-open) until rebuilt, so a contended acquire mid-handover
 *    never blocks on incomplete state.
 *
 * The transport that carries the heartbeats (holder → authority RPC) is the same
 * PeerRpcTransport seam; this state machine is the authority-side accumulation it
 * feeds, and is fully testable without a live mesh.
 */

export interface HeldLock {
  path: string;
  owner: string;
  /** epoch ms after which this assertion is stale (the holder must re-heartbeat). */
  expiresAtMs: number;
}

export interface LockSetReconstructorOpts {
  /** epoch ms when this peer became the authority (the handover start). */
  becameAuthorityAtMs: number;
  /** One heartbeat interval — the window within which holders re-assert. The set
   *  is considered rebuilt once this has elapsed. */
  heartbeatMs: number;
}

export class LockSetReconstructor {
  private readonly locks = new Map<string, HeldLock>();
  private readonly startMs: number;
  private readonly heartbeatMs: number;

  constructor(opts: LockSetReconstructorOpts) {
    this.startMs = opts.becameAuthorityAtMs;
    this.heartbeatMs = opts.heartbeatMs;
  }

  /** A holder re-asserts its lock (a heartbeat RPC). Last assertion per path wins
   *  (a holder owns the path; a re-assert refreshes the TTL). */
  assert(path: string, owner: string, ttlMs: number, nowMs: number): void {
    if (!path || !owner) return;
    this.locks.set(path, { path, owner, expiresAtMs: nowMs + ttlMs });
  }

  /** Drop assertions that have aged out (the holder stopped re-asserting). */
  prune(nowMs: number): void {
    for (const [path, lock] of this.locks) {
      if (lock.expiresAtMs <= nowMs) this.locks.delete(path);
    }
  }

  /** The active reconstructed lock set (non-expired). */
  current(nowMs: number): HeldLock[] {
    return [...this.locks.values()].filter((l) => l.expiresAtMs > nowMs);
  }

  /** Is `path` held by someone OTHER than `owner` right now? (the contended check
   *  the authority uses once rebuilt). */
  isHeldByOther(path: string, owner: string, nowMs: number): boolean {
    const l = this.locks.get(path);
    return !!l && l.expiresAtMs > nowMs && l.owner !== owner;
  }

  /** True once a full heartbeat interval has elapsed since takeover — every live
   *  holder has had the chance to re-assert, so the set is authoritative. */
  isRebuilt(nowMs: number): boolean {
    return nowMs - this.startMs >= this.heartbeatMs;
  }

  /** True during the rebuild gap: the authority should grant optimistically
   *  (fail-open, D-004) rather than block on a not-yet-complete lock set. */
  shouldFailOpen(nowMs: number): boolean {
    return !this.isRebuilt(nowMs);
  }
}
