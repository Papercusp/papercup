/**
 * @papercusp/coordination/watermark-store — the per-agent "last-read"
 * cursor seam (PG by default, in-memory double). Separate from the event
 * log by design (D-009): a watermark is mutable single-row-per-owner state,
 * not an append-only channel. The value shape + pure merge live in
 * `@papercusp/coordination/core`; this is only the persistence.
 */

export type { WatermarkStore } from './types';
export { InMemoryWatermarkStore } from './memory-store';
export {
  PgWatermarkStore,
  ensureCoordWatermarksTable,
  type PgWatermarkStoreOptions,
} from './pg-store';
// NOTE: conformance imports `vitest`, so it is NOT re-exported here (this
// barrel is imported by production code). Test code imports it from the
// dedicated `@papercusp/coordination/watermark-store/conformance` subpath.
