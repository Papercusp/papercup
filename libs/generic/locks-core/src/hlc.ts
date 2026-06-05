/**
 * Hybrid Logical Clocks (HLC) — Kulkarni, Demirbas, Madappa, Avva, Leone 2014.
 * Plan: locks-correctness-hardening-2026-06-04 (D-003).
 *
 * Our TTL leases and federation LWW tie-breaks currently order events by an
 * independent WALL clock (PG `now()` / `Date.now()`). That is safe today (one
 * shared Postgres), but the moment embedded-pg-per-machine ships the winner of
 * a tie is decided by NTP skew/step rather than causality — a clock that jumps
 * backward can resurrect a stale write, and two machines' "same instant" is a
 * coin flip. An HLC is the software substitute for TrueTime: 8 bytes, no
 * hardware. It keeps a physical component (so values still track real time and
 * stay human-comparable) AND a logical counter that (a) never goes backwards
 * across an NTP correction and (b) carries happens-before causality across
 * machines when clocks are merged on receive.
 *
 * An HLC is a pair `{ ms, count }`:
 *   - `ms`    — max physical time witnessed (ms since epoch), monotone non-decreasing.
 *   - `count` — logical counter, bumped to break ties within one `ms` and to
 *               encode causal ordering when a remote HLC is merged in.
 *
 * Total order: compare `ms`, then `count`. For a tie-break that is independent
 * of any clock keep the lowest/highest pubkey (the caller supplies it) — the
 * HLC decides causality, the pubkey decides genuine concurrency deterministically.
 *
 * This module is PURE (no PG, no I/O) so it is exhaustively unit-testable and
 * can be embedded anywhere — the federation merge, the lease store, a peer log.
 */

export interface Hlc {
  /** Physical-time component, ms since epoch. Monotone non-decreasing. */
  ms: number;
  /** Logical counter within `ms` (and the causal-merge bump). 16-bit. */
  count: number;
}

/** Logical counter ceiling (16 bits). Overflow rolls `ms` forward by 1. */
export const HLC_MAX_COUNT = 0xffff;

export const HLC_ZERO: Hlc = { ms: 0, count: 0 };

/** Total order on HLCs: -1 if a<b, 1 if a>b, 0 if equal. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.count !== b.count) return a.count < b.count ? -1 : 1;
  return 0;
}

/** Bump a counter within an `ms`; roll `ms` forward on 16-bit overflow. */
function bumpCount(ms: number, count: number): Hlc {
  return count >= HLC_MAX_COUNT ? { ms: ms + 1, count: 0 } : { ms, count: count + 1 };
}

/**
 * Encode an HLC into a fixed-width, lexicographically-sortable string —
 * `"<15-digit ms>:<5-digit count>"`. String compare on the encoding equals
 * compareHlc, so it can be stored in a text column / JSON `ts` field and sorted
 * directly. 15 digits of ms covers epoch-ms well past year 30000.
 */
export function encodeHlc(h: Hlc): string {
  return `${String(h.ms).padStart(15, '0')}:${String(h.count).padStart(5, '0')}`;
}

/** Parse an `encodeHlc` string back to an Hlc. Returns HLC_ZERO on a bad input. */
export function decodeHlc(s: string | null | undefined): Hlc {
  if (!s) return { ...HLC_ZERO };
  const i = s.indexOf(':');
  if (i < 0) return { ...HLC_ZERO };
  const ms = Number(s.slice(0, i));
  const count = Number(s.slice(i + 1));
  if (!Number.isFinite(ms) || !Number.isFinite(count)) return { ...HLC_ZERO };
  return { ms, count };
}

/** Pack into a single 64-bit unsigned BigInt (48-bit ms ‖ 16-bit count) — the
 *  "8 bytes" form for a binary column. ms is masked to 48 bits (good to ~8900 AD). */
export function packHlc(h: Hlc): bigint {
  const ms = BigInt(h.ms) & ((1n << 48n) - 1n);
  const count = BigInt(h.count) & 0xffffn;
  return (ms << 16n) | count;
}

export function unpackHlc(packed: bigint): Hlc {
  return { ms: Number(packed >> 16n), count: Number(packed & 0xffffn) };
}

/**
 * A stateful HLC generator for one node. `send()`/`now()` stamp a local event;
 * `recv()` merges a remote HLC observed on receive so this node's clock advances
 * past the remote's causal frontier. Single-threaded JS makes the read-modify-
 * write of `last` atomic without locking.
 */
export class HlcClock {
  private last: Hlc;
  private readonly physical: () => number;

  constructor(opts: { physical?: () => number; seed?: Hlc } = {}) {
    this.physical = opts.physical ?? (() => Date.now());
    this.last = opts.seed ? { ...opts.seed } : { ...HLC_ZERO };
  }

  /** The clock's current value without advancing it. */
  peek(): Hlc {
    return { ...this.last };
  }

  /**
   * Stamp a LOCAL event. Returns an HLC strictly greater than every prior HLC
   * this clock produced AND ≥ the physical clock — monotone even if the
   * physical clock just stepped backward (NTP correction). `physicalNow`
   * overrides the wall clock for one call (e.g. to seed from an event's own
   * recorded ms).
   */
  send(physicalNow?: number): Hlc {
    const pt = physicalNow ?? this.physical();
    const last = this.last;
    this.last = pt > last.ms ? { ms: pt, count: 0 } : bumpCount(last.ms, last.count);
    return { ...this.last };
  }

  /** Alias for {@link send} — a local event reads as "now". */
  now(physicalNow?: number): Hlc {
    return this.send(physicalNow);
  }

  /**
   * Merge a remote HLC observed on RECEIVE and advance the local clock past it.
   * Returns the new local HLC (≥ local, ≥ remote, ≥ physical) — this is what
   * carries happens-before across machines: any event stamped after recv()
   * causally follows the received one.
   */
  recv(remote: Hlc, physicalNow?: number): Hlc {
    const pt = physicalNow ?? this.physical();
    const l = this.last;
    const ms = Math.max(l.ms, remote.ms, pt);
    let next: Hlc;
    if (ms === l.ms && ms === remote.ms) next = bumpCount(ms, Math.max(l.count, remote.count));
    else if (ms === l.ms) next = bumpCount(ms, l.count);
    else if (ms === remote.ms) next = bumpCount(ms, remote.count);
    else next = { ms, count: 0 };
    this.last = next;
    return { ...this.last };
  }
}

/**
 * Process-wide HLC clock for the federation/lease surfaces. A single shared
 * generator per process keeps every locally-stamped op + lease monotone with
 * respect to each other. Tests construct their own HlcClock for isolation.
 */
let _processClock: HlcClock | null = null;
export function processHlc(): HlcClock {
  if (!_processClock) _processClock = new HlcClock();
  return _processClock;
}

/** Test seam — reset the process clock between tests. */
export function _resetProcessHlcForTests(): void {
  _processClock = null;
}
