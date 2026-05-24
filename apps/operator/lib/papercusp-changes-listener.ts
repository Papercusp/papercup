/**
 * Per-process listener for the `papercusp_changes` PG channel.
 *
 * One long-lived dedicated PG client subscribes to the channel; each
 * connected SSE client gets a filtered view (by their workspace_id).
 *
 * Producer side wired by:
 *   - migration 078 (libs/papercusp/libs/db/sql/078-emit-change-notify.sql)
 *   - wireDogfoodTriggers() in ensure-schema-dogfood.ts
 *
 * Consumer side wired by:
 *   - apps/operator/lib/endpoint-route/routes/sync/stream.ts (the SSE endpoint)
 *   - libs/sync's SSEAdapter on the browser side
 *
 * Modeled on `apps/operator/lib/sync-sse.ts` (the sync_invalidate
 * channel listener) — same dedicated-client pattern, same ring-buffer
 * resume semantics. Kept as a sibling rather than a refactor to
 * preserve the existing code's behavior + ship the new path cleanly.
 *
 * Per papercusp-dogfood-v5 Phase 3 P-020.
 */
// Host-only module: opens a long-lived PG LISTEN connection. Same rule
// as sync-sse.ts (never bundled into the browser).
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { getHarnessAdminUrl } from './embedded-pg-discovery';

export interface ChangeEvent {
  /** Monotonic per-process. Drives Last-Event-ID replay. */
  id: number;
  /** Date.now() at receive time. */
  ts: number;
  /** Schema-qualified table name from PG, e.g. "harness_shared.feature_queue". */
  table: string;
  /** "INSERT" | "UPDATE" | "DELETE" (matches PG TG_OP exactly). */
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  /** Workspace pinned by the trigger via current_setting('papercusp.workspace_id', true).
   *  May be null if the write happened outside a workspace-scoped session
   *  (system writes, backfills, migrations). */
  workspace_id: string | null;
}

export interface Subscriber {
  /** Workspace this subscriber cares about. `null` = receive all events. */
  workspaceId: string | null;
  send: (e: ChangeEvent) => void;
}

const HISTORY_WINDOW_MS = 60_000;
const HISTORY_MAX = 10_000; // absolute cap to prevent unbounded memory under load

let nextId = 1;
const history: ChangeEvent[] = [];
const subscribers = new Set<Subscriber>();

let listenerStarted = false;
let listenerSql: Sql | null = null;
let listenerStartingPromise: Promise<void> | null = null;

function pruneHistory(): void {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  while (history.length > 0 && history[0]!.ts < cutoff) history.shift();
  while (history.length > HISTORY_MAX) history.shift();
}

async function startListener(): Promise<void> {
  if (listenerStarted) return;
  if (listenerStartingPromise) {
    await listenerStartingPromise;
    return;
  }
  listenerStartingPromise = (async () => {
    const url = getHarnessAdminUrl();
    listenerSql = postgres(url, {
      max: 1,
      idle_timeout: 0,
      connect_timeout: 30,
    });

    await listenerSql.listen('papercusp_changes', (raw) => {
      let parsed: {
        table?: unknown;
        op?: unknown;
        workspace_id?: unknown;
        ts?: unknown;
      };
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof parsed.table !== 'string') return;
      const opRaw = parsed.op;
      if (
        opRaw !== 'INSERT' &&
        opRaw !== 'UPDATE' &&
        opRaw !== 'DELETE'
      ) {
        return;
      }
      const wsId =
        typeof parsed.workspace_id === 'string' &&
        parsed.workspace_id.length > 0
          ? parsed.workspace_id
          : null;
      const ev: ChangeEvent = {
        id: nextId++,
        ts: Date.now(),
        table: parsed.table,
        op: opRaw,
        workspace_id: wsId,
      };
      history.push(ev);
      pruneHistory();
      for (const sub of subscribers) {
        if (sub.workspaceId != null && wsId != null && sub.workspaceId !== wsId) {
          // workspace mismatch: skip
          continue;
        }
        try {
          sub.send(ev);
        } catch {
          // a noisy subscriber shouldn't break the bus
        }
      }
    });
    listenerStarted = true;
  })();
  try {
    await listenerStartingPromise;
  } finally {
    listenerStartingPromise = null;
  }
}

/**
 * Subscribe to the change stream. Returns a handle with `.close()` which
 * removes the subscriber. Starts the per-process listener lazily on the
 * first subscribe.
 */
export async function subscribe(
  workspaceId: string | null,
  onEvent: (e: ChangeEvent) => void,
): Promise<{ close: () => void }> {
  await startListener();
  const sub: Subscriber = { workspaceId, send: onEvent };
  subscribers.add(sub);
  return {
    close: () => {
      subscribers.delete(sub);
    },
  };
}

/**
 * Replay events with id > lastEventId from the 60s ring buffer. Used for
 * Last-Event-ID resume on SSE reconnect. Events outside the workspace
 * filter are dropped.
 */
export function backfillSince(
  lastEventId: number,
  workspaceId: string | null,
): ChangeEvent[] {
  return history.filter(
    (e) =>
      e.id > lastEventId &&
      (workspaceId == null || e.workspace_id == null || e.workspace_id === workspaceId),
  );
}

/** Diagnostics: how many subscribers are currently attached. */
export function activeSubscriberCount(): number {
  return subscribers.size;
}

/** Diagnostics: ring-buffer length right now. */
export function historyLength(): number {
  return history.length;
}

/**
 * Test-only: tear down the listener + reset state. Production never calls
 * this — the listener is intended to live as long as the process.
 */
export async function _testReset(): Promise<void> {
  subscribers.clear();
  history.length = 0;
  nextId = 1;
  if (listenerSql) {
    try {
      await listenerSql.end({ timeout: 1 });
    } catch {
      // ignore
    }
    listenerSql = null;
  }
  listenerStarted = false;
  listenerStartingPromise = null;
}
