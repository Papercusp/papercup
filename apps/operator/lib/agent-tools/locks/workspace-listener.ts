/**
 * Refcounted shared LISTEN connection per workspace.
 *
 * One LISTEN subscription per workspace channel `ch_coord_<wsId>`,
 * shared across every waiter on that workspace. Each subscriber gets
 * every payload and filters by its own ticket_id — the listener is a
 * bare wake-bus, not a router.
 *
 * postgres-js's `sql.listen()` handles reconnects automatically; on
 * resume it re-sends LISTEN. Audit 4 #3 wanted explicit re-issue; the
 * library does it for us. The 30s ceiling on each await iteration in
 * acquire.ts is the second-layer safety net for any silent drop the
 * library misses.
 *
 * Listener-pool cap (reviewer #3): MAX_ACTIVE_WORKSPACES = 20.
 * 21st workspace's subscribeWorkspace throws TooManyActiveWorkspacesError
 * so the caller can return a clean `too_many_active_workspaces` rather
 * than hanging on a full connection pool.
 */

import { getListenerPool } from './su-lock-store';

const MAX_ACTIVE_WORKSPACES = 20;

type Listener = (ticketId: string, kind: string) => void;

interface WorkspaceState {
  unlisten: () => Promise<void>;
  listeners: Set<Listener>;
}

const STATE = new Map<string, WorkspaceState>();

export class TooManyActiveWorkspacesError extends Error {
  constructor() {
    super('too_many_active_workspaces');
    this.name = 'TooManyActiveWorkspacesError';
  }
}

/**
 * Subscribe to grant notifications on a workspace. The callback fires
 * for EVERY payload on the channel — the caller filters by its own
 * ticket_id. Returns an unsubscribe fn the caller MUST invoke when the
 * wait completes.
 */
export async function subscribeWorkspace(
  workspaceId: string,
  listener: Listener,
): Promise<() => Promise<void>> {
  let state = STATE.get(workspaceId);

  if (!state) {
    if (STATE.size >= MAX_ACTIVE_WORKSPACES) {
      throw new TooManyActiveWorkspacesError();
    }
    const sql = getListenerPool();
    const channel = `ch_coord_${workspaceId}`;
    const listeners = new Set<Listener>();

    const req = sql.listen(channel, (payload) => {
      // Payload format: "<ticket_id>" or "<ticket_id>:<kind>".
      // grant_cascade.sql sends just ticket_id; ":kind" is reserved.
      const colon = payload.indexOf(':');
      const tid = colon >= 0 ? payload.slice(0, colon) : payload;
      const kind = colon >= 0 ? payload.slice(colon + 1) : 'granted';
      // Iterate defensively: one subscriber's callback throwing must
      // not prevent siblings from waking. Subscribers should never
      // throw (the wake-resolver is trivial code) but defense-in-depth
      // is cheap.
      for (const cb of listeners) {
        try {
          cb(tid, kind);
        } catch {
          /* swallow — listener bus must stay alive */
        }
      }
    });
    const result = await req;

    state = { unlisten: result.unlisten, listeners };
    STATE.set(workspaceId, state);
  }

  state.listeners.add(listener);

  return async () => {
    const cur = STATE.get(workspaceId);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size === 0) {
      STATE.delete(workspaceId);
      try {
        await cur.unlisten();
      } catch {
        // Best-effort — pool may already be torn down.
      }
    }
  };
}

/** Test-only — drop all subscriptions. */
export async function _resetListenersForTests(): Promise<void> {
  const states = Array.from(STATE.values());
  STATE.clear();
  await Promise.allSettled(states.map((s) => s.unlisten()));
}

export function _activeWorkspaceCount(): number {
  return STATE.size;
}
