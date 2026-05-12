/**
 * Per-client SSE wrapper around PG `sync_invalidate` LISTEN.
 *
 * One long-lived dedicated PG client subscribes to the channel; each connected
 * client gets every event (no per-subscriber filter — query args carry the
 * scoping; the client adapter decides what to keep).
 *
 * Reconnect resume: clients send Last-Event-ID; we replay from a 60s ring
 * buffer (in-memory, per process). Bounded but enough for tab-switch /
 * laptop-lid-close / brief network blips.
 *
 * Event shape (matches the SSE adapter's documented contract):
 *   {
 *     id: <monotonic int>,
 *     ts: <Date.now()>,
 *     name: <queryName>,        e.g. "harnessArchives.byHarness"
 *     args?: <object>,          e.g. {harnessSlug: "sheets"}
 *     data?: <row[]>,           full result set (Phase 1 payload-on-invalidate)
 *   }
 *
 * Modeled on `mobile-sync-sse.ts` — same dedicated-client pattern, same
 * ring-buffer, same `Last-Event-ID` resume semantics.
 */
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { getOrgPg } from '@restart/db-org';
import { getHarnessAdminUrl } from './embedded-pg-discovery';

export interface SyncEvent {
  id: number;
  ts: number;
  name: string;
  args?: Record<string, unknown>;
  /** Optional full payload. Absent when oversized (>32KB serialized) or
   *  unknown — client falls back to invalidate-then-refetch in that case. */
  data?: unknown[];
}

export interface Subscriber {
  send: (e: SyncEvent) => void;
}

const HISTORY_WINDOW_MS = 60_000;
const PAYLOAD_SIZE_LIMIT = 32 * 1024; // 32KB; over → strip data, send invalidate
let nextId = 1;
const history: SyncEvent[] = [];
const subscribers = new Set<Subscriber>();
let listenerStarted = false;
let listenerSql: Sql | null = null;

function pruneHistory(): void {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  while (history.length > 0 && history[0].ts < cutoff) history.shift();
}

async function startListener(): Promise<void> {
  if (listenerStarted) return;
  listenerStarted = true;

  const url = getHarnessAdminUrl();
  listenerSql = postgres(url, { max: 1, idle_timeout: 0, connect_timeout: 30 });

  listenerSql.listen('sync_invalidate', (raw) => {
    let parsed: { name?: unknown; args?: unknown; data?: unknown };
    try { parsed = JSON.parse(raw); } catch { return; }
    if (typeof parsed.name !== 'string') return;
    const ev: SyncEvent = {
      id: nextId++,
      ts: Date.now(),
      name: parsed.name,
      args: (parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args))
        ? parsed.args as Record<string, unknown>
        : undefined,
      data: Array.isArray(parsed.data) ? parsed.data : undefined,
    };
    history.push(ev);
    pruneHistory();
    for (const s of subscribers) {
      try { s.send(ev); } catch { /* best-effort */ }
    }
  }).then(() => {
    console.log('[sync-sse] LISTEN sync_invalidate ready');
  }).catch((e) => {
    console.error('[sync-sse] LISTEN failed:', e);
    listenerStarted = false;
  });
}

export interface SubscribeHandle {
  send: (e: SyncEvent) => void;
  close: () => void;
}

export async function subscribe(send: (e: SyncEvent) => void): Promise<SubscribeHandle> {
  await startListener();
  const sub: Subscriber = { send };
  subscribers.add(sub);
  return { send, close: () => subscribers.delete(sub) };
}

export function backfillSince(lastEventId: number): SyncEvent[] {
  pruneHistory();
  return history.filter((e) => e.id > lastEventId);
}

/**
 * Server-side notify helper. Watcher / mutation routes call this after writes.
 * Fires `pg_notify('sync_invalidate', ...)` which the LISTEN above receives
 * and fans out to all SSE subscribers. Goes through PG so multi-process
 * deployments still see all events; same connection pattern other notifies
 * use across the codebase.
 *
 * If the payload (data) serializes to >32KB, the data is stripped and only
 * (name, args) is emitted — clients refetch via REST in that case.
 *
 * Dedupe: identical (name, args) notifies fired within DEDUPE_WINDOW_MS
 * are suppressed at the source. The 60-second harness-fs-watcher reconcile
 * sweep upserts every (slug, panel) pair every minute even when nothing
 * changed; without this guard the operator emits 80+ no-op notifies per
 * minute and the dashboard's panels refetch in lockstep, which renders
 * as constant flicker. The window is sized just over the reconcile
 * interval so a *real* per-minute change still gets through (the
 * preceding no-op notify falls out of the dedupe map by then). Notifies
 * with a `data` payload are never dedupe'd — they carry actual content
 * and the receiver acts on them, not just refetches.
 */
const DEDUPE_WINDOW_MS = 90_000;
// Pin to globalThis so Turbopack HMR doesn't drop the Map on each
// module reload. ensure-schema.ts uses the same pattern for the same
// reason — without this, every dev-mode code edit resets the dedupe
// table and the next reconcile pass fires every notify again.
type _G = { __syncNotifyDedupe?: Map<string, number> };
const _g = globalThis as unknown as _G;
const recentNotifies: Map<string, number> = _g.__syncNotifyDedupe ?? (_g.__syncNotifyDedupe = new Map());
function pruneNotifyCache(now: number): void {
  // Cheap GC: prune expired entries when the cache exceeds 200. The
  // bound is ~one notify per (panel, slug, phase) across registered
  // harnesses; keeping it small avoids unbounded growth on long-lived
  // processes.
  if (recentNotifies.size < 200) return;
  for (const [k, ts] of recentNotifies) {
    if (now - ts > DEDUPE_WINDOW_MS) recentNotifies.delete(k);
  }
}

export async function notifySyncInvalidate(
  name: string,
  args?: Record<string, unknown>,
  data?: unknown[],
): Promise<void> {
  let payload: Record<string, unknown> = { name };
  if (args !== undefined) payload.args = args;
  if (data !== undefined) {
    payload.data = data;
    const serialized = JSON.stringify(payload);
    if (serialized.length > PAYLOAD_SIZE_LIMIT) {
      // Drop the data; client invalidates and refetches.
      payload = { name };
      if (args !== undefined) payload.args = args;
    }
  }

  // Source-side dedupe. Identical notify payloads fired within
  // DEDUPE_WINDOW_MS are suppressed — the 60s reconcile sweep upserts
  // every (slug, panel) row every minute even when nothing changed,
  // and without this each sweep produces the same notify cascade.
  // Data-bearing notifies (push with rows) hash the data into the
  // dedupe key so a NEW row set still gets through.
  {
    const dataKey = data === undefined ? '' : JSON.stringify(data);
    const key = name + '|' + (args ? JSON.stringify(args) : '') + '|' + dataKey;
    const now = Date.now();
    const last = recentNotifies.get(key);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
      return;
    }
    recentNotifies.set(key, now);
    pruneNotifyCache(now);
  }

  // Use the shared org pool — same connection budget every other writer
  // in the operator already manages. Opening a fresh postgres() per notify
  // exhausted max_connections (100) the moment the watcher started firing.
  const { sql } = getOrgPg();
  try {
    await sql`SELECT pg_notify('sync_invalidate', ${JSON.stringify(payload)})`;
  } catch (e) {
    // best-effort — sync layer is degraded if this fails, but app keeps working
    console.error('[sync-sse] pg_notify failed:', e);
  }
}
