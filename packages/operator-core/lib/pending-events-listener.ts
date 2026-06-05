/**
 * pending_events observer.
 *
 * Per spec/workspace-scoping, concierge agents (Operator, Oracle, pi)
 * observe `pending_events` via LISTEN/NOTIFY — NEVER consume rows.
 * The orchestrator owns the queue's `consumed_at`/`consumed_by` columns.
 *
 * This listener subscribes once per operator process to
 * `pending_events_inserted`, parses the payload, and fans out to
 * registered handlers. Operator's auto-rescan and the top-bar icon-state
 * machine are wired via this fan-out.
 *
 * The trigger that fires NOTIFY lives in libs/db/sql/009-workspace-scoping.sql.
 */

import postgres from 'postgres';
import { getHarnessAdminUrl } from './embedded-pg-discovery';

export interface PendingEventNotification {
  id: string;
  kind: string;
  target_role: string;
  workspace_id: string;
  due_at: string | null;
  created_at: string;
}

type Handler = (event: PendingEventNotification) => void;

const handlers = new Set<Handler>();
let started = false;
let listenerSql: postgres.Sql | null = null;

function adminUrl(): string {
  return getHarnessAdminUrl();
}

export function onPendingEventInserted(handler: Handler): () => void {
  handlers.add(handler);
  void ensureStarted();
  return () => {
    handlers.delete(handler);
  };
}

async function ensureStarted(): Promise<void> {
  if (started) return;
  started = true;
  try {
    listenerSql = postgres(adminUrl(), {
      onnotice: () => {},
      max: 1,
    });
    await listenerSql.listen('pending_events_inserted', (payload) => {
      try {
        const evt = JSON.parse(payload) as PendingEventNotification;
        for (const h of handlers) {
          try {
            h(evt);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[pending_events_listener] handler threw:', err);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[pending_events_listener] bad payload:', err);
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pending_events_listener] failed to start:', err);
    started = false;
    listenerSql = null;
  }
}

export async function _stopForTests(): Promise<void> {
  if (listenerSql) {
    await listenerSql.end({ timeout: 5 }).catch(() => {});
  }
  listenerSql = null;
  started = false;
  handlers.clear();
}
