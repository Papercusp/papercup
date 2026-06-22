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
import { getOperatorCache } from './cache/instance';
import { emitSystemEvent } from './events/engine';

export type SyncEvent = LibSyncEvent;
export type SubscribeHandle = LibSubscribeHandle;
export interface Subscriber {
  send: (e: SyncEvent) => void;
}

const CHANNEL = 'sync_invalidate';

/**
 * Bridge a raw PG-trigger `<schema>.<table>.changed` event to the camelCase query names
 * existing useSyncQuery consumers subscribe to (P-006/P-067) — AND tap it into the in-process
 * reaction matcher (caching-layer-tag-eca KEYSTONE) so the `cache.bumpTags` ECA rule, and any
 * other reaction registered on a `*.changed` key, fire on REAL DB changes. The bus `bridge` is
 * the single per-event hook that carries the trigger's `args` (workspace_id, op, and the row PK
 * from mig 368), so it is the correct place to feed the change stream into the event system.
 *
 * `emitSystemEvent` never throws and the bump is flag-gated downstream (CACHE_TAG_ECA, default
 * ON; OFF ⇒ the rule's `when` is false ⇒ no-op). Non-`.changed` events are ignored. Without this
 * tap the cache layer is built but INERT — nothing invalidates on a real write.
 */
export function bridgeTriggerEvent(
  name: string,
  args?: Record<string, unknown>,
): ReturnType<typeof queryNamesForTriggerEvent> {
  if (name.endsWith('.changed')) {
    const ws = typeof args?.workspace_id === 'string' ? args.workspace_id : undefined;
    emitSystemEvent({ tool: name, args: args ?? {}, ...(ws ? { workspaceId: ws } : {}) });
  }
  return queryNamesForTriggerEvent(name, args);
}

const bus = createInvalidationBus({
  // Dedicated single LISTEN connection on the embedded-PG admin URL.
  listen: createPgListenSource({
    open: () =>
      postgres(getHarnessAdminUrl(), { max: 1, idle_timeout: 0, connect_timeout: 30 }),
    channel: CHANNEL,
    // caching-layer-tag-eca P-017 — cold-bust on (re)connect. Fires on the initial
    // LISTEN AND every reconnect (postgres-js re-issues LISTEN after a dropped
    // connection and re-invokes this `onlisten`). A fire-and-forget
    // `pg_notify('sync_invalidate', …)` → `cache.bumpTags` that fired while this
    // single LISTEN connection was down is NEVER replayed here, so an L1 entry built
    // before the gap could outlive an invalidation it missed. Clearing the entire L1
    // on reconnect makes every entry rebuild — the audit's cold-bust requirement. On
    // the very first connect the L1 is empty, so the clear is a harmless no-op.
    onListen: () => getOperatorCache().clearL1(),
  }),
  // pg_notify through the shared org pool — same connection budget every
  // other writer manages (opening a fresh client per notify exhausted
  // max_connections when the watcher fired).
  notify: createPgNotifySink({ getSql: () => getOrgPg().sql, channel: CHANNEL }),
  // P-067: bridge raw PG-trigger `<schema>.<table>.changed` events to the
  // camelCase query names existing useSyncQuery consumers subscribe to.
  // caching-layer-tag-eca P-006: pass the trigger's `args` (workspace_id, op,
  // row id from mig 368) so a per-row query can be SCOPE-invalidated by id
  // instead of full-busting; queries without a per-id scope still full-bust.
  bridge: (name, args) => bridgeTriggerEvent(name, args),
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
