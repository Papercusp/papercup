/**
 * types.ts — the CoordEventLog seam: the ONE swappable storage interface
 * for the append-only coordination channels (D-009).
 *
 * Two storage shapes, faithful to the on-disk reality:
 *
 *   - LINE surfaces (`messages`, `plan-events`): single-writer append
 *     streams. `messages` is keyed per-writer (one outbox file per
 *     ownerId); `plan-events` is one logical stream (the host process)
 *     that an fs impl may rotate by time — so `writerKey` is meaningful
 *     for `messages` and ignored for `plan-events`.
 *   - EVENT surfaces (`handoffs`, `escalations`): one immutable record
 *     per event, addressable by msg_id.
 *
 * Watch/notify subscriptions and watermark read-cursors are NOT here:
 * subscriptions stays host-side (locks fires it as a callback), and a
 * watermark is a mutable per-agent doc, not an append-only channel.
 */

import type { CoordEnvelope } from '../core/envelope';

export type LineSurface = 'messages' | 'plan-events';
export type EventSurface = 'handoffs' | 'escalations';

export interface ReadLinesOpts {
  /**
   * `plan-events` only: read just the most-recent N rotation files.
   * A pure fs-rotation hint — impls without file rotation (in-memory,
   * a future single-table PG log) ignore it and read everything.
   */
  filesBack?: number;
}

export interface CoordEventLog {
  /**
   * Append one envelope to a single-writer line stream. For `messages`,
   * `writerKey` is the sender's ownerId (its outbox); for `plan-events`
   * it is ignored (one logical stream).
   */
  appendLine(surface: LineSurface, writerKey: string, line: CoordEnvelope): Promise<void>;

  /** Read every line across a line surface (union of all keyed files). */
  readLines(surface: LineSurface, opts?: ReadLinesOpts): Promise<CoordEnvelope[]>;

  /** Write one immutable per-event record, addressed by msg_id. */
  putEvent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<void>;

  /**
   * Write MANY immutable per-event records to ONE surface in a single batch.
   * Semantically equal to calling `putEvent` once per entry (same keying: a
   * re-put on an existing msg_id upserts), but a backend SHOULD collapse the
   * write into one operation — the PG backend does ONE multi-row INSERT, so N
   * records cost one round-trip + one transaction instead of N. This is what
   * lets a sweep drain a large backlog (e.g. the ~11k operational-escalation
   * reconcile) in one tick: with per-row `putEvent` the per-statement overhead
   * (round-trip + the AFTER-ROW coord triggers committing per statement) caps a
   * tick at a few hundred writes. An empty array is a no-op.
   */
  putEvents(
    surface: EventSurface,
    records: ReadonlyArray<{ msgId: string; record: CoordEnvelope }>,
  ): Promise<void>;

  /** Read every per-event record in a surface. */
  readEvents(surface: EventSurface): Promise<CoordEnvelope[]>;

  /**
   * Read per-event records in a surface, BOUNDED — capped at `opts.limit` rows
   * at the storage layer (so a huge surface never loads whole into memory) and
   * returned NEWEST-FIRST (descending append order). `opts.kinds`, when
   * non-empty, filters on the envelope `kind`. Use for paginated reads (e.g.
   * coord:escalations over a large backlog) where the unbounded `readEvents`
   * would return — and buffer — the entire history. (EI-1548.)
   */
  readEventsBounded(
    surface: EventSurface,
    opts: { limit: number; kinds?: string[] },
  ): Promise<CoordEnvelope[]>;

  /**
   * Read LINE-surface records (`messages` / `plan-events`), BOUNDED — the line
   * parallel of {@link readEventsBounded}. Capped at `opts.limit` rows at the
   * storage layer and returned NEWEST-FIRST (descending append order). Optional
   * pushdowns narrow the storage read: `opts.sinceTs` (ISO) keeps only lines
   * strictly LATER than it, `opts.planSlug` only one plan, `opts.kinds` only
   * those envelope kinds. The PG backend filters in SQL (riding the
   * surface-ordered index); the fs/in-memory backends filter the loaded set.
   *
   * Closes the unbounded `readLines` hole for the hot plan-events delta: orient's
   * per-turn coord:plan-events (×fleet-size) read+parsed the WHOLE ~3.5MB history
   * on the single event loop (EI-1737 / fleet-concurrency-first P-005). A
   * watermark-advancing caller now reads only its tail. Backward-compatible:
   * `readLines` (unbounded) is unchanged for callers that need the full surface.
   */
  readLinesBounded(
    surface: LineSurface,
    opts: { limit: number; sinceTs?: string; planSlug?: string; kinds?: string[] },
  ): Promise<CoordEnvelope[]>;

  /** Read one per-event record by msg_id, or null. */
  getEvent(surface: EventSurface, msgId: string): Promise<CoordEnvelope | null>;
}
