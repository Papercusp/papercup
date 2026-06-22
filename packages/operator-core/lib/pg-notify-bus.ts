/**
 * createNotifyBus — a thin LISTEN→fan-out bus over a single Postgres NOTIFY
 * channel (agent-tool-delta-protocol-2026-06-22, Lane D / P-010).
 *
 * Generalizes the per-channel listener pattern (agent-activity-bus, coord-inbox-bus):
 * lazy single LISTEN connection (or the shared listen-hub when PAPERCUSP_LISTEN_HUB=1),
 * fan-out the raw NOTIFY payload to every subscriber, and close the connection when the
 * last subscriber unsubscribes. Host-only — opens a long-lived PG connection, so only
 * the Hono host imports it (never a browser/Vite chunk).
 *
 * Each subscriber decides what to do with the payload (typically: drain new rows since
 * its own cursor). This is what lets the /ui|/tui/intents/stream routes drop their 250ms
 * poll: the bus wakes them on each insert instead.
 */
import postgres from "postgres";
import { getHarnessAdminUrl } from "./embedded-pg-discovery";
import { hubListen, listenHubEnabled } from "./pg-listen-hub";

export interface NotifyBus {
  /** Register a wake handler (called with the NOTIFY payload). Returns unsubscribe. */
  subscribe(handler: (payload: string) => void): () => void;
  /** Test-only: force-close the listener + drop all handlers. */
  _stopForTests(): Promise<void>;
}

export function createNotifyBus(channel: string, label: string = channel): NotifyBus {
  const handlers = new Set<(payload: string) => void>();
  let started = false;
  let listenerSql: postgres.Sql | null = null;
  let hubUnsub: (() => void) | null = null;

  const fanout = (payload: string): void => {
    for (const h of handlers) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[${label}] handler threw:`, err);
      }
    }
  };

  const ensureStarted = async (): Promise<void> => {
    if (started) return;
    started = true;
    try {
      const onNotify = (payload: string) => {
        if (handlers.size === 0) return;
        fanout(payload ?? "");
      };
      if (listenHubEnabled()) {
        hubUnsub = await hubListen(channel, onNotify);
      } else {
        listenerSql = postgres(getHarnessAdminUrl(), { onnotice: () => {}, max: 1 });
        await listenerSql.listen(channel, onNotify);
      }
    } catch (err) {
      console.error(`[${label}] failed to start:`, err);
      started = false;
      listenerSql = null;
      hubUnsub = null;
    }
  };

  const maybeClose = async (): Promise<void> => {
    if (handlers.size !== 0 || !started) return;
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
        // ignore errors during close
      }
      listenerSql = null;
      started = false;
    }
  };

  return {
    subscribe(handler) {
      handlers.add(handler);
      void ensureStarted();
      return () => {
        handlers.delete(handler);
        void maybeClose();
      };
    },
    async _stopForTests() {
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
    },
  };
}
