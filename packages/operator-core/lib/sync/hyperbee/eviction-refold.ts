/**
 * eviction-refold — when and how far the merge loop re-folds after a content-deferral
 * buffer evicts (p2p-join-catchup-speed P-522, WI-10002899).
 *
 * ## The problem
 * `PendingEpochContent` and `PendingMembershipContent` hold content ops that cannot apply
 * yet: the epoch key or the author's membership has not federated. Both are bounded, and
 * an evicted op is only safe to drop if the fold reads it again later. WI-3852 made every
 * eviction trip a full cursor reset on the very next pass. That livelocks a joiner. The
 * missing key sits far ahead in the log, every pass defers more than the buffer holds, and
 * the reset sends the fold back to its seed before it can reach the key. P-007 run #1 reset
 * log 5b00878b to 0 about every 2 min, 11 times in a row, while the device's epoch-key rows
 * sat near the tail.
 *
 * ## The policy
 *  - An eviction OWES a re-fold. It is paid only once the fold has SETTLED: after a pass
 *    in which no admitted log could advance any further (each is at its length, or the
 *    pass could not move it). The fold therefore always reaches the tail, where a missing
 *    key or member row lives, before it re-reads anything.
 *  - The re-fold REWINDS each log to its deferral floor instead of resetting the cursor.
 *    The floor is the log's position the last time both buffers were empty at a pass
 *    start. Every op a buffer holds or has evicted was deferred after that moment, at or
 *    above that position, so re-reading from the floor reaches all of them. The PG seed,
 *    the snapshot seed marks and the scan memo survive (see `rewindMergeCursor`).
 *  - Floors are frozen while a re-fold is owed. A log positioned since the last refresh
 *    gets its first position as its floor: nothing it defers can come from below it.
 *  - The floors describe ONE cursor. A replaced cursor (log removal, truncation, rekey)
 *    re-reads every log from its seed, which pays any owed re-fold, and its floors start
 *    over. Deferrals still buffered across that replacement came from positions no floor
 *    records, so until the buffers next drain an eviction falls back to the full reset.
 *
 * Pure bookkeeping over a `MergeCursor`: no I/O. boot.ts drives it once per merge pass.
 */
import { rewindMergeCursor, type AdmittedLog, type MergeCursor } from './read-merge';

/** What `settle` decided for this pass. */
export type EvictionReFoldAction =
  /** Nothing owed, or the fold has not settled yet. */
  | { kind: 'none' }
  /** Paid in place: these logs moved back to their floors. */
  | { kind: 'rewound'; moved: Array<{ keyHex: string; floor: number }> }
  /** No trustworthy floor: the caller must replace the cursor and drop its PG seed. */
  | { kind: 'reset' };

export class DeferralEvictionReFold {
  private owed = false;
  private settled = false;
  private floors = new Map<string, number>();
  private exact = true;
  private floorsCursor: MergeCursor | null = null;

  /** A deferral buffer evicted since the last pass: a re-fold is owed. */
  noteEviction(): void {
    this.owed = true;
  }

  /** Whether a re-fold is owed and not yet paid. */
  get isOwed(): boolean {
    return this.owed;
  }

  /**
   * Top of a pass, after any cursor replacement and before seeding: pay an owed re-fold
   * if the previous pass left the fold settled. A `rewound` result has already moved the
   * cursor. A `reset` result asks the caller to replace it.
   */
  settle(cursor: MergeCursor): EvictionReFoldAction {
    if (this.floorsCursor !== cursor) {
      // Replaced since the floors were taken: its re-read from the seeds pays the debt.
      this.owed = false;
      return { kind: 'none' };
    }
    if (!this.owed || !this.settled) return { kind: 'none' };
    this.owed = false;
    if (!this.exact) return { kind: 'reset' };
    const moved = rewindMergeCursor(cursor, this.floors).map((keyHex) => ({
      keyHex,
      floor: this.floors.get(keyHex) ?? 0,
    }));
    return { kind: 'rewound', moved };
  }

  /**
   * After seeding, before the fold: refresh the floors to where this pass's fold starts.
   * `buffersHold` is whether either deferral buffer holds anything right now.
   */
  markFloors(cursor: MergeCursor, buffersHold: boolean): void {
    if (this.floorsCursor !== cursor) {
      this.floorsCursor = cursor;
      this.floors = new Map();
      this.exact = !buffersHold;
    }
    if (!this.owed && !buffersHold) {
      this.floors = new Map(cursor.positions);
      this.exact = true;
      return;
    }
    for (const [keyHex, position] of cursor.positions) {
      if (!this.floors.has(keyHex)) this.floors.set(keyHex, position);
    }
  }

  /**
   * After the fold: settled means no admitted log can advance any further right now.
   * Each one is at its length, or this pass could not move it (a read stall or an
   * apply-failure hold, which a re-fold would only repeat). A log with no position that
   * has ops (one held for its seed scan) has not started, so it is not settled.
   */
  noteFold(logs: readonly AdmittedLog[], cursor: MergeCursor, positionsBefore: ReadonlyMap<string, number>): void {
    this.settled = logs.every((log) => {
      const position = cursor.positions.get(log.keyHex);
      if (position === undefined) return log.length === 0;
      return position >= log.length || position === positionsBefore.get(log.keyHex);
    });
  }

  /** A pass that found nothing to fold: every log is at its length. */
  noteIdle(): void {
    this.settled = true;
  }

  /** The floor recorded for `keyHex` (tests and logging). */
  floorOf(keyHex: string): number | undefined {
    return this.floors.get(keyHex);
  }
}
