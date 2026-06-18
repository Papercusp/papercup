/**
 * agent_activity observer — the push side of the cross-CLI activity bridge
 * (papercusp-worker-integration-2026-06-04, D-003).
 *
 * Migration 143 fires `NOTIFY agent_activity` for every
 * `harness_shared.agent_activity` insert (the per-CLI hooks → activity:report write),
 * payload `"<workspace_id>::<owner_id>"`. Unlike coord_inbox there is no
 * human-relevance filter: EVERY activity row is a wake (the fleet view wants the full
 * native tool stream). So this bus is a thin LISTEN→fan-out: on each notification it
 * calls every registered handler with the notified owner_id, and each handler (the
 * /api/activity/stream SSE route) decides — by its own cursor + owner filter — what to
 * push.
 *
 * Mirrors `coord-inbox-bus.ts` / `pending-events-listener.ts`: one dedicated LISTEN
 * connection, lazy start, max 1 connection on the embedded-PG admin URL. Host-only —
 * opens a long-lived PG connection, so only the Hono host imports it (never a
 * browser/Vite chunk).
 */
import postgres from "postgres";
import { getHarnessAdminUrl } from "./embedded-pg-discovery";
import { hubListen, listenHubEnabled } from "./pg-listen-hub";

/** A wake handler — invoked once per notification with the notified owner_id (may be
 *  empty). The handler queries new rows itself (by its own cursor + filter). */
type Handler = (ownerId: string) => void;

const handlers = new Set<Handler>();
let started = false;
let listenerSql: postgres.Sql | null = null;
/** Hub unsubscribe (set only when PAPERCUSP_LISTEN_HUB=1 routes us onto the shared connection). */
let hubUnsub: (() => void) | null = null;

/** Register a wake handler; lazily starts the single LISTEN. Returns unsubscribe. */
export function onAgentActivity(handler: Handler): () => void {
  handlers.add(handler);
  void ensureStarted();
  return () => {
    handlers.delete(handler);
    void maybeCloseListener();
  };
}

/** Close the listener if there are no handlers left (cleanup to avoid listener leak). */
async function maybeCloseListener(): Promise<void> {
  if (handlers.size === 0 && started) {
    if (hubUnsub) {
      hubUnsub();
      hubUnsub = null;
      started = false;
      return;
    }
    if (listenerSql) {
      try {
        await listenerSql.end({ timeout: 5 }).catch(() => {});
      } catch {
        // Ignore errors during close
      }
      listenerSql = null;
      started = false;
    }
  }
}

/** Parse the NOTIFY payload "<workspace_id>::<owner_id>" → owner_id (best-effort). */
export function ownerFromPayload(payload: string | undefined): string {
  if (!payload) return "";
  const idx = payload.indexOf("::");
  return idx >= 0 ? payload.slice(idx + 2) : "";
}

function fanout(ownerId: string): void {
  for (const h of handlers) {
    try {
      h(ownerId);
    } catch (err) {
      console.error("[agent-activity-bus] handler threw:", err);
    }
  }
}

async function ensureStarted(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const onNotify = (payload: string) => {
      if (handlers.size === 0) return;
      fanout(ownerFromPayload(payload));
    };
    if (listenHubEnabled()) {
      hubUnsub = await hubListen("agent_activity", onNotify);
    } else {
      listenerSql = postgres(getHarnessAdminUrl(), {
        onnotice: () => {},
        max: 1,
      });
      await listenerSql.listen("agent_activity", onNotify);
    }
  } catch (err) {
    console.error("[agent-activity-bus] failed to start:", err);
    started = false;
    listenerSql = null;
    hubUnsub = null;
  }
}

export async function _stopForTests(): Promise<void> {
  if (hubUnsub) {
    hubUnsub();
    hubUnsub = null;
  }
  if (listenerSql) {
    await listenerSql.end({ timeout: 5 }).catch(() => {});
  }
  listenerSql = null;
  started = false;
  handlers.clear();
}
