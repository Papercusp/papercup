/**
 * @papercusp/coordination/event-log — the swappable append-only channel
 * log seam (D-009). `FsCoordLog` is the portable default; `InMemoryCoordLog`
 * is the test double / detached proof. A future PG-backed log satisfies
 * the same `CoordEventLog` interface.
 */

export {
  type CoordEventLog,
  type LineSurface,
  type EventSurface,
  type ReadLinesOpts,
} from './types';
export { FsCoordLog, type FsCoordLogOptions } from './fs-log';
export { InMemoryCoordLog } from './memory-log';
