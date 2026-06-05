/**
 * Operator wiring of the @papercusp/sync server-half invalidation bus.
 *
 * The generic mechanism (LISTEN fan-out, ring-buffer replay, source-side
 * dedupe, 32KB payload cap, PG-trigger → camelCase bridge) now lives in
 * `@papercusp/sync/server`. This module just injects the operator's
 * domain: the embedded-PG admin URL for the dedicated LISTEN connection,
 * the shared org pool for `pg_notify`, the `'sync_invalidate'` channel,
 * and the `queryNamesForTriggerEvent` bridge.
 *
 * Exports are unchanged (`subscribe`, `backfillSince`, `notifySyncInvalidate`,
 * `SyncEvent`) so every existing emitter + the SSE route keep importing
 * from here.
 *
 * Host-only module: opens a long-lived PG LISTEN connection. Only the
 * Hono host (Node) imports it — Vite bundles `apps/operator-vite/src/`
 * only, so this never reaches a browser chunk.
 */
import postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  createInvalidationBus,
  type SyncEvent as LibSyncEvent,
  type SubscribeHandle as LibSubscribeHandle,
} from '@papercusp/sync/server';
import { createPgListenSource, createPgNotifySink } from '@papercusp/sync/server/pg';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { queryNamesForTriggerEvent } from './sync-resolver/table-to-query-names';

export type SyncEvent = LibSyncEvent;
export type SubscribeHandle = LibSubscribeHandle;
export interface Subscriber {
  send: (e: SyncEvent) => void;
}

const CHANNEL = 'sync_invalidate';

const bus = createInvalidationBus({
  // Dedicated single LISTEN connection on the embedded-PG admin URL.
  listen: createPgListenSource({
    open: () =>
      postgres(getHarnessAdminUrl(), { max: 1, idle_timeout: 0, connect_timeout: 30 }),
    channel: CHANNEL,
  }),
  // pg_notify through the shared org pool — same connection budget every
  // other writer manages (opening a fresh client per notify exhausted
  // max_connections when the watcher fired).
  notify: createPgNotifySink({ getSql: () => getOrgPg().sql, channel: CHANNEL }),
  // P-067: bridge raw PG-trigger `<schema>.<table>.changed` events to the
  // camelCase query names existing useSyncQuery consumers subscribe to.
  bridge: (name) => queryNamesForTriggerEvent(name),
  log: (m) => console.log(m),
  onError: (where, e) => console.error(`[sync-sse] ${where} failed:`, e),
});

/** Register an SSE subscriber; lazily starts the LISTEN connection. */
export const subscribe: (send: (e: SyncEvent) => void) => Promise<SubscribeHandle> =
  bus.subscribe;

/** Replay events newer than `lastEventId` from the 60s ring buffer. */
export const backfillSince: (lastEventId: number) => SyncEvent[] = bus.backfillSince;

/**
 * Server-side notify helper. Mutation/watcher code calls this after writes;
 * fires `pg_notify('sync_invalidate', ...)` which the LISTEN above fans out
 * to all SSE subscribers. Dedupe + 32KB payload cap live in the bus.
 */
export const notifySyncInvalidate: (
  name: string,
  args?: Record<string, unknown>,
  data?: unknown[],
) => Promise<void> = bus.notifyInvalidate;
