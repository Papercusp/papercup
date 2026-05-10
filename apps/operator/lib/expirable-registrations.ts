/**
 * Centralized registration of every TTL-based expirable table.
 *
 * Imported once from the API entrypoint (alongside the other `ensure*`
 * boot calls). Each registration declares: the table, what `expires_at`
 * column to look at, and what to do when a row is expired (delete vs.
 * mark a status field).
 *
 * Adding a new ephemeral table is one entry here + an `expires_at`
 * column in the schema + setting `expires_at = now() + interval` on
 * every write. No new sweeper code, no new constants scattered around.
 */

import { registerExpirable, ensureExpirableRegistry } from './expirable-registry';

let _registered = false;

export function registerAllExpirables(): void {
  if (_registered) return;
  _registered = true;

  // Operator scan locks — 60s TTL per LOCK_TTL_MS in operator-scan-lock.ts.
  // Lazy-deletion happened on lock-acquire; the registry now sweeps actively.
  registerExpirable({
    table: 'harness_shared.operator_scan_locks',
  });

  // Provision claims — 90s TTL with refresh, set per CLAIM_TTL_SEC in
  // provision/operator-claims.ts. Previously had no sweeper at all —
  // expired rows accumulated until manually overwritten.
  registerExpirable({
    table: 'harness_shared.operator_claims',
  });

  // Harness status — 5min lease via expires_at (unix-ms), refreshed on
  // each pg_write_status. Don't delete; mark 'running' rows as 'stalled'
  // instead so the dashboard can surface "harness died" explicitly
  // rather than the row simply disappearing. Other statuses (paused,
  // error, idle, stalled) are explicit user/orchestrator choices and
  // not touched.
  registerExpirable({
    table: 'harness_shared.harness_status',
    expiresAtColumn: 'expires_at',
    columnType: 'unix-ms',
    onExpire: {
      kind: 'mark-status',
      column: 'status',
      from: 'running',
      to: 'stalled',
      timestampColumn: 'updated_at',
    },
  });

  // Auth magic-link requests — short TTL via expires_ts (unix-ms).
  // Lazy-checked on consume; sweep accumulated rows so they don't grow.
  registerExpirable({
    table: 'papercusp_auth.magic_link_requests',
    expiresAtColumn: 'expires_ts',
    columnType: 'unix-ms',
  });

  // Auth sessions — 30-day TTL via expires_ts (unix-ms). Lazy-checked on
  // use; hourly sweep so stale sessions don't pile up forever.
  registerExpirable({
    table: 'papercusp_auth.sessions',
    expiresAtColumn: 'expires_ts',
    columnType: 'unix-ms',
    intervalMs: 60 * 60_000, // 1 hour
  });

  ensureExpirableRegistry();
}
