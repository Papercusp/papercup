/**
 * @papercusp/coordination/event-log — the swappable append-only channel
 * log seam (D-009). Three interchangeable backends satisfy `CoordEventLog`
 * and pass the SAME conformance suite (the P-050 gate):
 *   - `FsCoordLog`        — the portable default (detached agents, no PG).
 *   - `InMemoryCoordLog`  — the test double / detached proof.
 *   - `PgCoordLog`        — the optional single-table Postgres backend.
 */

export {
  type CoordEventLog,
  type LineSurface,
  type EventSurface,
  type ReadLinesOpts,
} from './types';
export { FsCoordLog, type FsCoordLogOptions } from './fs-log';
export { InMemoryCoordLog } from './memory-log';
export {
  PgCoordLog,
  ensureCoordEventLogTable,
  DEFAULT_COORD_WORKSPACE,
  type PgCoordLogOptions,
} from './pg-log';
// NOTE: the conformance harness imports `vitest`, so it is deliberately NOT
// re-exported here (this barrel is imported by production code). Test code
// imports it from the dedicated `@papercusp/coordination/event-log/conformance`
// subpath — mirroring `@papercusp/coordination/presence/conformance`.
