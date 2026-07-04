/**
 * pending-membership-content — the CONTENT-BEFORE-MEMBERSHIP ordering buffer for the
 * WI-259 membership-aware cross-member content federation (plan shared-hive-member-content-
 * federation-2026-06-20, P-004).
 *
 * ## The invariant (the membership analog of pending-epoch-content's key-before-content)
 * A shared-hive member B applies a cross-member content op (a feature/plan/issue authored by
 * member A) iff A's VERIFIED source-log device pubkey ∈ B's CURRENT hive-member device set
 * (the P-002 per-projection guard, member-content-guard.ts). A's membership (a `hive_members`
 * row) and A's CONTENT are SEPARATE federated ops on the SAME peer-log stream, and the merge
 * applies ops by log POSITION, not by a global cross-table sort. So a content op can reach the
 * apply seam BEFORE the `hive_members` op that adds its author — at which point the guard sees
 * A ∉ members and DROPS it, and the merge cursor advances past it → lost.
 *
 * This buffer is the fail-safe for that brief race: a dropped cross-member op (author KNOWN —
 * its source-log device resolved — but not YET in the member set) is DEFERRED here instead of
 * lost, keyed on the author's device pubkey, and re-applied when that member's `hive_members`
 * row applies (the onMemberApplied hook in projections/hive-members.ts → `drainForDevices`).
 *
 * ## Why this is BOUNDED (the opposite of pending-epoch-content — D-007 point 2)
 * pending-epoch-content defers FOREVER by design: a removed member's epoch key never arrives,
 * so its content stays undecryptable = the C-001 read cut. P-004's guard, by contrast, CANNOT
 * distinguish "genuine non-member (never joins)" from "member-not-yet-federated (joins in a
 * moment)" — so a naive buffer would hold a genuine non-member's content FOREVER and grow
 * unbounded. This buffer is therefore bounded TWO ways:
 *   - a TTL: the race is brief (membership federates at join, ~seconds around the content), so
 *     an entry that isn't drained within `ttlMs` is evicted (genuine non-member content expires
 *     while the real race is still caught). Eviction loses nothing durable: the op's bytes stay
 *     in the peer log, so a later re-fold re-encounters (and, for a real member, re-defers) it.
 *   - a hard size cap: oldest-first eviction so a flood can't grow memory without limit.
 *
 * Pure (no DB, no I/O, no clock of its own — `now` is injected, mirroring hive-member-identity-
 * set's TTL seam): one instance per booted harness apply loop (single-threaded JS, same as the
 * merge cursor). The defer call site is each content projection's writeToPg (per-projection
 * defer — D-007 option a, forced by the guard being per-projection per D-006); the drain call
 * site is the hive_members projection apply (the SAME onMemberApplied point P-003's cache
 * invalidation hangs off).
 */

/** One deferred cross-member content op + the author device it is waiting to see ∈ members. */
export interface DeferredMemberContentOp {
  /** The author's VERIFIED source-log device pubkey (base64) — the membership grain this op
   *  is waiting on, and the bucket key (a member-join with this device drains it). */
  authorDevice: string;
  /** The projection tag (observability) + half the dedup identity. */
  tableTag: string;
  /** The projection composeKey(row) — the other half of the dedup identity. */
  rowKey: string;
  /** LWW ordering keys — part of the op identity so a re-defer (re-fold / re-drain) of the SAME
   *  row version is idempotent, while a strictly-newer op for the same key is a NEW deferral. */
  fedHlc: string | null;
  fedTs: number | null;
  /** Re-apply the deferred content op: re-runs the projection's writeToPg, which re-checks
   *  membership (now fresh) and applies it — or, if still not a member, re-defers idempotently. */
  reapply: () => Promise<void>;
  /** Monotone insertion order — deterministic FIFO drain + oldest-first eviction. */
  seq: number;
  /** TTL deadline (ms). Evicted once `now >= expiresAt`. */
  expiresAt: number;
}

/** One deferred cross-member content op whose source-log identity has not resolved yet. */
export interface DeferredSourceLogContentOp {
  /** The immutable receiver-stamped source log key. Re-resolved when admission catches up. */
  sourceLogKey: string;
  tableTag: string;
  rowKey: string;
  fedHlc: string | null;
  fedTs: number | null;
  reapply: () => Promise<void>;
  seq: number;
  expiresAt: number;
}

/** Default hard cap on total deferred ops. The race is rare + brief, so this is a safety
 *  backstop, not a working size — a real workload keeps this near 0. */
export const DEFAULT_MAX_PENDING_MEMBER_CONTENT = 5_000;

/** Default TTL (ms). The membership-federation race is seconds; 5 min is a generous margin
 *  after which an un-drained deferral is treated as genuine non-member content + evicted. */
export const DEFAULT_MEMBER_CONTENT_TTL_MS = 5 * 60_000;

/** The caller-supplied shape of a deferral (the buffer assigns seq + expiresAt). */
export interface DeferMemberContentInput {
  authorDevice: string;
  tableTag: string;
  rowKey: string;
  fedHlc?: string | null;
  fedTs?: number | null;
  reapply: () => Promise<void>;
}

/** Deferral shape for content whose `sourceLogKeyHex -> device` identity is not available yet. */
export interface DeferSourceLogContentInput {
  sourceLogKey: string;
  tableTag: string;
  rowKey: string;
  fedHlc?: string | null;
  fedTs?: number | null;
  reapply: () => Promise<void>;
}

/**
 * A bounded, TTL-evicting, per-author-device FIFO buffer of content ops deferred because their
 * author's hive-membership has not yet federated. NOT thread-shared — one per booted harness
 * apply loop (single-threaded JS, same as the merge cursor).
 */
export class PendingMembershipContent {
  /** authorDevice → ordered deferred ops (insertion order). */
  private readonly buckets = new Map<string, DeferredMemberContentOp[]>();
  /** sourceLogKey → ordered deferred ops waiting for admission identity resolution. */
  private readonly sourceLogBuckets = new Map<string, DeferredSourceLogContentOp[]>();
  /** Monotone insertion counter (deterministic ordering; never wall-clock). */
  private seqCounter = 0;
  /** Total deferred ops across all buckets (kept in sync for O(1) bound checks). */
  private total = 0;

  constructor(
    private readonly maxPending: number = DEFAULT_MAX_PENDING_MEMBER_CONTENT,
    private readonly ttlMs: number = DEFAULT_MEMBER_CONTENT_TTL_MS,
  ) {}

  /**
   * Defer a cross-member content op whose author is not yet a known member. Idempotent per op
   * IDENTITY within a bucket (re-deferring the SAME row version — a re-fold or a re-drain that
   * still misses — does not duplicate it). Sweeps expired entries first, then enforces the hard
   * size cap by evicting the GLOBALLY-oldest deferral. Returns true if stored, false if it was
   * already pending.
   */
  defer(input: DeferMemberContentInput, now: number): boolean {
    this.sweepExpired(now);
    let list = this.buckets.get(input.authorDevice);
    if (!list) {
      list = [];
      this.buckets.set(input.authorDevice, list);
    }
    if (list.some((d) => sameOp(d, input))) return false; // already pending (re-fold / re-drain)
    list.push({
      authorDevice: input.authorDevice,
      tableTag: input.tableTag,
      rowKey: input.rowKey,
      fedHlc: input.fedHlc ?? null,
      fedTs: input.fedTs ?? null,
      reapply: input.reapply,
      seq: this.seqCounter++,
      expiresAt: now + this.ttlMs,
    });
    this.total++;
    if (this.total > this.maxPending) this.evictOldest();
    return true;
  }

  /**
   * Defer a cross-member content op whose source-log key is known but has no resolved admission
   * identity yet. This catches the log-identity-before-content race: once admission records the
   * log->device mapping, drainForSourceLogKeys re-applies the op and the normal member-device
   * guard either applies it or moves it into the device-membership buffer above.
   */
  deferUnresolvedSourceLog(input: DeferSourceLogContentInput, now: number): boolean {
    this.sweepExpired(now);
    let list = this.sourceLogBuckets.get(input.sourceLogKey);
    if (!list) {
      list = [];
      this.sourceLogBuckets.set(input.sourceLogKey, list);
    }
    if (list.some((d) => sameOp(d, input))) return false;
    list.push({
      sourceLogKey: input.sourceLogKey,
      tableTag: input.tableTag,
      rowKey: input.rowKey,
      fedHlc: input.fedHlc ?? null,
      fedTs: input.fedTs ?? null,
      reapply: input.reapply,
      seq: this.seqCounter++,
      expiresAt: now + this.ttlMs,
    });
    this.total++;
    if (this.total > this.maxPending) this.evictOldest();
    return true;
  }

  /**
   * A member just federated (a `hive_members` row applied). Remove + return — in FIFO order —
   * the deferred ops waiting on ANY of that member's device pubkeys, so the caller can re-apply
   * them (their membership is now known). Sweeps expired entries first. Returns [] if none.
   */
  drainForDevices(devices: Iterable<string>, now: number): DeferredMemberContentOp[] {
    this.sweepExpired(now);
    const out: DeferredMemberContentOp[] = [];
    for (const device of devices) {
      const list = this.buckets.get(device);
      if (!list || list.length === 0) continue;
      this.buckets.delete(device);
      this.total -= list.length;
      out.push(...list);
    }
    // FIFO across the (possibly multiple) drained buckets.
    return out.sort((a, b) => a.seq - b.seq);
  }

  /**
   * A source log identity just became known at admission. Remove + return the deferred ops waiting
   * on that log key so the caller can re-apply them against the now-populated resolver.
   */
  drainForSourceLogKeys(sourceLogKeys: Iterable<string>, now: number): DeferredSourceLogContentOp[] {
    this.sweepExpired(now);
    const out: DeferredSourceLogContentOp[] = [];
    for (const sourceLogKey of sourceLogKeys) {
      const list = this.sourceLogBuckets.get(sourceLogKey);
      if (!list || list.length === 0) continue;
      this.sourceLogBuckets.delete(sourceLogKey);
      this.total -= list.length;
      out.push(...list);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** Drop every entry whose TTL has passed. Called on the defer + drain hot paths (cheap when
   *  empty) so genuine non-member content expires even if no member ever joins to drain it.
   *  Returns the count evicted. */
  sweepExpired(now: number): number {
    let removed = 0;
    for (const [device, list] of this.buckets) {
      const live = list.filter((d) => d.expiresAt > now);
      if (live.length === list.length) continue;
      removed += list.length - live.length;
      if (live.length === 0) this.buckets.delete(device);
      else this.buckets.set(device, live);
    }
    for (const [sourceLogKey, list] of this.sourceLogBuckets) {
      const live = list.filter((d) => d.expiresAt > now);
      if (live.length === list.length) continue;
      removed += list.length - live.length;
      if (live.length === 0) this.sourceLogBuckets.delete(sourceLogKey);
      else this.sourceLogBuckets.set(sourceLogKey, live);
    }
    this.total -= removed;
    return removed;
  }

  /** Total deferred ops (observability / tests). */
  size(): number {
    return this.total;
  }

  /** Distinct author-device buckets currently holding deferrals. */
  bucketCount(): number {
    return this.buckets.size + this.sourceLogBuckets.size;
  }

  /** Drop the globally-oldest deferral to honour `maxPending`. The op's bytes remain in the peer
   *  log, so a later re-fold re-defers it (for a real member) — back-pressure, not data loss. */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestKind: 'device' | 'sourceLog' | null = null;
    let oldestSeq = Infinity;
    for (const [device, list] of this.buckets) {
      const head = list[0]; // each bucket is seq-ascending (push order)
      if (head && head.seq < oldestSeq) {
        oldestSeq = head.seq;
        oldestKey = device;
        oldestKind = 'device';
      }
    }
    for (const [sourceLogKey, list] of this.sourceLogBuckets) {
      const head = list[0];
      if (head && head.seq < oldestSeq) {
        oldestSeq = head.seq;
        oldestKey = sourceLogKey;
        oldestKind = 'sourceLog';
      }
    }
    if (oldestKey === null || oldestKind === null) return;
    const buckets = oldestKind === 'device' ? this.buckets : this.sourceLogBuckets;
    const list = buckets.get(oldestKey)!;
    list.shift();
    this.total--;
    if (list.length === 0) buckets.delete(oldestKey);
  }
}

/**
 * Re-apply a drained batch best-effort: a single re-apply throw (or a still-not-a-member
 * re-defer) must NOT abort the member-apply that triggered the drain. Returns the count that
 * re-applied without throwing. Mirrors drainQueuedEpochContent's best-effort loop.
 */
export async function reapplyDrainedMemberContent(
  entries: readonly (DeferredMemberContentOp | DeferredSourceLogContentOp)[],
): Promise<number> {
  let reapplied = 0;
  for (const entry of entries) {
    try {
      await entry.reapply();
      reapplied++;
    } catch {
      // best-effort — the op's bytes stay in the peer log; a later fold/drain re-defers it.
    }
  }
  return reapplied;
}

/** Two deferrals are the SAME iff they project the same row version: same projection + key +
 *  LWW ordering keys. A strictly-newer op for the same key is a DIFFERENT deferral (the apply
 *  path's LWW guard supersedes the stale one on re-apply). */
function sameOp(
  d: Pick<DeferredMemberContentOp | DeferredSourceLogContentOp, 'tableTag' | 'rowKey' | 'fedHlc' | 'fedTs'>,
  input: Pick<DeferMemberContentInput | DeferSourceLogContentInput, 'tableTag' | 'rowKey' | 'fedHlc' | 'fedTs'>,
): boolean {
  return (
    d.tableTag === input.tableTag &&
    d.rowKey === input.rowKey &&
    d.fedHlc === (input.fedHlc ?? null) &&
    d.fedTs === (input.fedTs ?? null)
  );
}
