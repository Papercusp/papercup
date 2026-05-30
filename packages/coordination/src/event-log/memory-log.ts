/**
 * memory-log.ts — InMemoryCoordLog: the test double + the proof that
 * CoordEventLog is genuinely swappable. Passes the same conformance
 * suite as FsCoordLog (the P-050 gate).
 *
 * It does not model per-writer files or time rotation — those are
 * fs-specific concerns. It just stores lines per line-surface and
 * records per (event-surface, msg_id), which is all the contract
 * requires.
 */

import type { CoordEnvelope } from '../core/envelope';
import type {
  CoordEventLog,
  EventSurface,
  LineSurface,
} from './types';

export class InMemoryCoordLog implements CoordEventLog {
  private lines = new Map<LineSurface, CoordEnvelope[]>();
  private events = new Map<EventSurface, Map<string, CoordEnvelope>>();

  async appendLine(surface: LineSurface, _writerKey: string, line: CoordEnvelope): Promise<void> {
    const arr = this.lines.get(surface) ?? [];
    arr.push(line);
    this.lines.set(surface, arr);
  }

  async readLines(surface: LineSurface): Promise<CoordEnvelope[]> {
    return [...(this.lines.get(surface) ?? [])];
  }

  async putEvent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<void> {
    const m = this.events.get(surface) ?? new Map<string, CoordEnvelope>();
    m.set(msgId, record);
    this.events.set(surface, m);
  }

  async readEvents(surface: EventSurface): Promise<CoordEnvelope[]> {
    return [...(this.events.get(surface)?.values() ?? [])];
  }

  async getEvent(surface: EventSurface, msgId: string): Promise<CoordEnvelope | null> {
    return this.events.get(surface)?.get(msgId) ?? null;
  }
}
