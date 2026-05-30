/**
 * @papercusp/coordination/presence — the live-presence seam (PG by
 * default, in-memory double). Separate from the event log by design
 * (D-009): presence is mutable single-row-per-owner state, not an
 * append-only channel.
 */

export {
  PRESENCE_STALE_MS,
  type PresenceIdentity,
  type PresenceInput,
  type PresenceRecord,
  type PresenceStore,
} from './types';
export { PgPresenceStore, type PgPresenceStoreOptions } from './pg-store';
export { InMemoryPresenceStore, type InMemoryPresenceStoreOptions } from './memory-store';
