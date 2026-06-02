/**
 * subscriptions.ts — watch / notify (L3 #5).
 *
 * Backend: `PgSubscriptionStore` over the org embedded-pg handle —
 * `harness_shared.coord_subscriptions`, workspace-scoped like the sibling
 * coord tables. A watch is a mutable row: `addWatch` inserts, `removeWatch`
 * sets `cancelled_at`, `listWatches` reads the active rows (not cancelled,
 * not past expires_ts) — replacing the fs append-and-fold of
 * subscribe/unsubscribe JSONL lines (coord-channels-pg-port P-007 / Q-2).
 *
 * Notifications fire when something matches a pattern. `fireNotifications`
 * appends a typed `notify` envelope to each matching watcher's inbox via the
 * SAME CoordEventLog (`coordLog`) that holds messages — so a notify lands
 * exactly where `readInbox` looks (coord-channels-pg-port P-008). Any
 * callsite can invoke it (the locks:acquire / plans:* bolt-ons do).
 *
 * v1 pattern syntax (deliberate simplification — note in plan §18):
 *   `**` matches anything including `/`
 *   `*`  matches anything except `/`
 *   everything else literal
 * No brace expansion, no `?`. Good enough for common path globs.
 */

import { getOrgPg } from '@papercusp/db-org';
import { PgSubscriptionStore } from '@papercusp/coordination/subscription-store';
import {
  newMsgId,
  patternToRegex,
  matchesPattern,
  type CoordEnvelope,
  type CoordKind,
  type WatchTrigger,
} from '@papercusp/coordination/core';
import { coordLog } from './log';
import type { AgentIdentity } from './identity';

// The v1 path-glob matcher + WatchTrigger live in coord-core; re-exported so
// existing importers of this module stay unchanged.
export { patternToRegex, matchesPattern };
export type { WatchTrigger };

const store = new PgSubscriptionStore({
  getSql: () => getOrgPg().sql,
  // Tables are defined by the migration baseline now; the host seam is a no-op.
  ensureSchema: async () => {},
});

export interface WatchInput {
  pattern: string;
  trigger?: WatchTrigger;
  ttl_sec?: number;
}

export interface WatchEntry {
  msg_id: string;
  owner: string;
  pattern: string;
  trigger: WatchTrigger;
  ts: string;
  expires_ts: string | null;
}

/** Add a new watch — inserts a subscription row for the watcher. */
export async function addWatch(
  identity: AgentIdentity,
  input: WatchInput,
): Promise<WatchEntry> {
  const ts = new Date().toISOString();
  const msg_id = newMsgId();
  const trigger = (input.trigger ?? 'any') as WatchTrigger;
  const expires_ts =
    input.ttl_sec != null ? new Date(Date.now() + input.ttl_sec * 1000).toISOString() : null;
  await store.add({
    msg_id,
    owner_id: identity.ownerId,
    pattern: input.pattern,
    trigger,
    created_ts: ts,
    expires_ts,
  });
  return { msg_id, owner: identity.ownerId, pattern: input.pattern, trigger, ts, expires_ts };
}

/** Cancel a watch — sets cancelled_at on the watcher's own subscription row. */
export async function removeWatch(
  identity: AgentIdentity,
  subscribeMsgId: string,
): Promise<void> {
  await store.cancel(identity.ownerId, subscribeMsgId);
}

/**
 * List active watches (not cancelled, not past expires_ts), optionally one
 * owner. Sorted by (ts, msg_id) — the store already orders by
 * (created_ts, msg_id).
 */
export async function listWatches(
  opts: { owner?: string } = {},
): Promise<WatchEntry[]> {
  const recs = await store.listActive({ owner: opts.owner });
  return recs.map((r) => ({
    msg_id: r.msg_id,
    owner: r.owner_id,
    pattern: r.pattern,
    trigger: r.trigger as WatchTrigger,
    ts: r.created_ts,
    expires_ts: r.expires_ts,
  }));
}

export interface WatchMatch {
  watcher: string;
  watch_msg_id: string;
  pattern: string;
  trigger: WatchTrigger;
  matched_path: string;
}

/**
 * Find all (watcher, path) pairs whose active watch matches any of the
 * given paths and accepts the trigger. A watch with trigger='any' is
 * always accepted; otherwise the trigger must match.
 */
export async function findMatchingWatchers(
  paths: string[],
  trigger: WatchTrigger,
): Promise<WatchMatch[]> {
  if (paths.length === 0) return [];
  const watches = await listWatches();
  const out: WatchMatch[] = [];
  for (const w of watches) {
    if (w.trigger !== 'any' && w.trigger !== trigger) continue;
    const re = patternToRegex(w.pattern);
    for (const p of paths) {
      if (re.test(p)) {
        out.push({
          watcher: w.owner,
          watch_msg_id: w.msg_id,
          pattern: w.pattern,
          trigger: w.trigger,
          matched_path: p,
        });
      }
    }
  }
  return out;
}

/**
 * Best-effort: fire `notify` entries into each matching watcher's inbox.
 * The notify is appended to the messages surface via `coordLog` — the same
 * store `readInbox` reads — addressed `to: [watcher]`. Returns the number
 * written. Each write try/catches so one failure cannot drop the rest.
 */
export async function fireNotifications(
  source: AgentIdentity,
  paths: string[],
  trigger: WatchTrigger,
): Promise<number> {
  const matches = await findMatchingWatchers(paths, trigger);
  // Dedup per (watcher, matched_path): a watcher with two overlapping
  // patterns both matching one path would otherwise receive two identical
  // notifies. One notify per path is what the watcher needs; the first
  // matching watch wins (its pattern lands in the envelope).
  const seen = new Set<string>();
  let written = 0;
  for (const m of matches) {
    const key = JSON.stringify([m.watcher, m.matched_path]);
    if (seen.has(key)) continue;
    seen.add(key);
    const env: CoordEnvelope = {
      ts: new Date().toISOString(),
      msg_id: newMsgId(),
      from: source.ownerId,
      to: [m.watcher],
      kind: 'notify',
      pattern: m.pattern,
      trigger: m.trigger,
      matched_path: m.matched_path,
      watch_msg_id: m.watch_msg_id,
      summary: `notify: ${trigger} matched ${m.matched_path}`,
    };
    try {
      // The watcher is the recipient; the writerKey is the watcher's own
      // outbox key (one notify row per watcher), so it surfaces in the
      // watcher's `readInbox` exactly like a directly-sent message.
      await coordLog.appendLine('messages', m.watcher, env);
      written += 1;
    } catch {
      // best-effort
    }
  }
  return written;
}

/**
 * Best-effort fire-for-caller used by `plans:*` and `locks:*` bolt-ons.
 * Resolves the caller's identity (falls back to `'system'` if
 * unresolvable) and swallows every error — a notify-fan-out failure
 * must NEVER break the calling write.
 */
export async function fireNotificationsForCaller(
  ctx: import('./identity').ResolveIdentityCtx,
  paths: string[],
  trigger: WatchTrigger,
): Promise<number> {
  try {
    let identity: AgentIdentity;
    try {
      identity = (await import('./identity')).resolveAgentIdentity(ctx);
    } catch {
      identity = {
        ownerId: 'system',
        ownerLabel: 'system',
        source: 'static-client',
        workspaceId: null,
        userId: null,
      };
    }
    return await fireNotifications(identity, paths, trigger);
  } catch {
    return 0;
  }
}

/**
 * GC the `notify` firehose from the coord event log — delete notify rows
 * older than `retentionDays`. Notify is opt-in + low-value (D-002,
 * fleet-coordination-painpoints), so it must not accumulate unbounded; a
 * daily DBOS scheduled tick (periodic-workflows) drives this. Returns the
 * number deleted. Best-effort caller (the tick) tolerates errors.
 */
export async function gcOldNotifies(retentionDays = 3): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    WITH d AS (
      DELETE FROM harness_shared.coord_event_log
       WHERE surface = 'messages'
         AND body->>'kind' = 'notify'
         AND ts < now() - make_interval(days => ${retentionDays})
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}

/**
 * Coord kinds reachable from this module — for callers that want to
 * narrow `CoordKind` further.
 */
export const SUBSCRIPTION_KINDS: ReadonlyArray<CoordKind> = [
  'subscribe',
  'unsubscribe',
  'notify',
] as const;
