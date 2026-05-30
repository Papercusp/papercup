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

  /** Read every per-event record in a surface. */
  readEvents(surface: EventSurface): Promise<CoordEnvelope[]>;

  /** Read one per-event record by msg_id, or null. */
  getEvent(surface: EventSurface, msgId: string): Promise<CoordEnvelope | null>;
}
