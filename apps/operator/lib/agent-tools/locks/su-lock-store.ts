/**
 * SU agent file-lock coordination — storage layer.
 *
 * Owns:
 *   - Connection pools to the `papercusp_su` side-database (tx pool +
 *     listener pool, see §8 of su-agent-coordination-v3-2026-05-14.md).
 *   - Bootstrap of `papercusp_su` against the main `papercusp` database
 *     on first call.
 *   - Migration runner (idempotent; SHARE UPDATE EXCLUSIVE on su_meta
 *     to serialize concurrent runners — audit 3 #6).
 *   - Low-level acquire/release/heartbeat/cancel/queue helpers.
 *
 * Tools (acquire.ts, release.ts, …) call these helpers; they don't
 * touch postgres-js directly.
 */

// Note: no `import 'server-only'` — the store is exercised by smoke
// scripts and unit tests that run outside the Next bundle. Server-only
// gating happens at the tool-registration boundary in agent-tools/index.ts
// (only loaded by the Next route handler).
import * as fs from 'node:fs';
import * as path from 'node:path';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';

/**
 * Tx type re-export. Store helpers take `Sql`; callers inside
 * `inWorkspaceTxn` pass a `TransactionSql` (assignable via a single
 * cast at the wrapper boundary — see in-workspace-txn.ts).
 */
export type SuSqlTxn = Sql;
export type SuTransactionSql = TransactionSql<Record<string, unknown>>;

// ───────── Connection pools ─────────

/**
 * Resolve the URL for the SU side-database. Same host/port/role as the
 * main papercusp DB, different database name.
 *
 * The plan calls for a separate `papercusp_su` role, but operationally
 * that requires password-file management for embedded PG where there
 * is no external network surface — marginal value, real complexity.
 * We reuse `harness_admin` (the existing role with full access to the
 * embedded PG instance) and keep ONLY the database separate. Workload
 * isolation, drop-and-recreate, and per-database backup retention are
 * preserved; the grant-isolation goal is dropped as YAGNI.
 */
function suUrl(): string {
  const main = getHarnessAdminUrl();
  // Replace the path component (the database name) with `papercusp_su`.
  // URLs look like: postgresql://user:pass@host:port/dbname?params
  return main.replace(/\/[^/?]+(\?|$)/, '/papercusp_su$1');
}

function mainUrl(): string {
  // For bootstrap (CREATE DATABASE) we must NOT be connected to the
  // db we're creating. The main fallback URL targets `papercusp`.
  return getHarnessAdminUrl();
}

let txPool: Sql | null = null;
let listenerPool: Sql | null = null;
let bootstrapped = false;

export function getTxPool(): Sql {
  if (!txPool) {
    txPool = postgres(suUrl(), {
      max: 10,
      prepare: false,
      // Run our SET LOCAL inside each txn; don't let postgres-js auto-prepare
      // statements across connections (the SET LOCAL won't carry).
    });
  }
  return txPool;
}

export function getListenerPool(): Sql {
  if (!listenerPool) {
    listenerPool = postgres(suUrl(), {
      max: 20, // Cap on concurrent workspace listeners — audit reviewer #3
      prepare: false,
    });
  }
  return listenerPool;
}

/**
 * Test-only — close pools and reset state. Used by vitest hooks to
 * recycle the connection set between disposable PG instances.
 */
export async function _resetForTests(): Promise<void> {
  if (txPool) {
    await txPool.end({ timeout: 1 });
    txPool = null;
  }
  if (listenerPool) {
    await listenerPool.end({ timeout: 1 });
    listenerPool = null;
  }
  bootstrapped = false;
}

// ───────── Bootstrap + migrations ─────────

// Next.js mangles __dirname in bundled server code. We follow the
// same convention as docs:outline / resource-section — anchor at
// process.cwd() which is the operator app root in dev and in the
// next-standalone bundle.
const SQL_DIR = path.join(
  process.cwd(),
  'lib',
  'agent-tools',
  'locks',
  'sql',
);

/**
 * Ensures `papercusp_su` exists and migrations are applied. Idempotent.
 * Called lazily on the first locks:* invocation per process.
 *
 * Steps:
 *   1. Probe `papercusp_su` existence via the main db. If missing, run
 *      `001-bootstrap.sql` (CREATE DATABASE — outside any txn).
 *   2. Connect to papercusp_su; take SHARE UPDATE EXCLUSIVE on su_meta
 *      (creating it first if needed); apply every NNN-*.sql whose
 *      number isn't in su_meta yet.
 *   3. Stamp the schema_version key in su_meta.
 */
export async function ensureBootstrap(): Promise<void> {
  if (bootstrapped) return;

  // Step 1: probe the side db, create if absent.
  const main = postgres(mainUrl(), { max: 1, prepare: false });
  try {
    const rows = await main<Array<{ exists: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM pg_database WHERE datname = 'papercusp_su'
      ) AS exists
    `;
    if (!rows[0]?.exists) {
      // CREATE DATABASE can't run inside any transaction. postgres-js
      // wraps `.unsafe()` in an implicit txn by default; `.simple()`
      // disables that. We also split the bootstrap into separate calls
      // because PG won't accept other statements in the same simple
      // batch as CREATE DATABASE (each must stand alone).
      await main.unsafe('CREATE DATABASE papercusp_su').simple();
      await main.unsafe(
        "ALTER DATABASE papercusp_su SET idle_in_transaction_session_timeout = '30s'",
      ).simple();
      await main.unsafe(
        "ALTER DATABASE papercusp_su SET application_name = 'papercusp-su'",
      ).simple();
    }
  } finally {
    await main.end({ timeout: 1 });
  }

  // Step 2 + 3: connect to papercusp_su and apply migrations.
  const sql = getTxPool();

  // su_meta must exist before we can take SHARE UPDATE EXCLUSIVE on it.
  // Bootstrap it outside the lock — CREATE TABLE IF NOT EXISTS is safe
  // concurrently (the loser just no-ops).
  await sql`
    CREATE TABLE IF NOT EXISTS su_meta (
      key   text PRIMARY KEY,
      value text NOT NULL
    )
  `;

  // Now serialize the migration runner across processes.
  await sql.begin(async (tx) => {
    await tx`LOCK TABLE su_meta IN SHARE UPDATE EXCLUSIVE MODE`;

    const appliedRows = await tx<Array<{ key: string }>>`
      SELECT key FROM su_meta WHERE key LIKE 'migration:%'
    `;
    const applied = new Set(appliedRows.map((r) => r.key));

    const files = fs
      .readdirSync(SQL_DIR)
      .filter((f) => /^\d{3}-.*\.sql$/.test(f))
      .filter((f) => !f.endsWith('-bootstrap.sql'))
      .sort();

    for (const file of files) {
      const key = `migration:${file}`;
      if (applied.has(key)) continue;

      const sqlText = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
      // postgres-js `unsafe` runs as a single multi-statement script.
      // We're inside a txn so any failure rolls back the whole file.
      await tx.unsafe(sqlText);

      await tx`
        INSERT INTO su_meta (key, value) VALUES (${key}, ${new Date().toISOString()})
        ON CONFLICT (key) DO NOTHING
      `;
    }
  });

  bootstrapped = true;
}

// ───────── Path validation (app-side; trigger is belt-and-suspenders) ─────────

export class InvalidPathError extends Error {
  constructor(p: string, reason: string) {
    super(`InvalidPathError: ${reason}: ${p}`);
    this.name = 'InvalidPathError';
  }
}

const MAX_PATH_LEN = 4096;

export function validatePath(p: string): void {
  if (!p || p === '') throw new InvalidPathError(p, 'empty');
  if (p.startsWith('/')) throw new InvalidPathError(p, 'absolute');
  if (p === '..' || p.startsWith('../') || p.endsWith('/..') || p.includes('/../')) {
    throw new InvalidPathError(p, 'traversal');
  }
  // POSIX forward slashes only — a backslash is either a Windows path
  // separator (wrong repo-relative form) or a literal in a filename we
  // refuse to reason about. Reject rather than guess (file-locking #1).
  if (p.includes('\\')) throw new InvalidPathError(p, 'backslash');
  if (p.length > MAX_PATH_LEN) throw new InvalidPathError(p, 'too long');
  // PG's text type rejects NULL bytes; catch them client-side so the
  // caller gets a clean InvalidPathError instead of a raw
  // PostgresError on insert (bug #15).
  if (p.includes('\0')) throw new InvalidPathError(p, 'null byte');
}

/**
 * Canonicalize a path to the repo-relative POSIX form the lock key
 * hashes on (file-locking #1). Splitting on '/' and dropping empty +
 * '.' segments collapses every accepted non-canonical spelling —
 * `./apps/foo`, `apps//foo`, `apps/./foo`, `apps/foo/` — onto one
 * string, so two agents naming the same file the same way always
 * contend. '..' segments are NOT dropped: they survive so the raw-path
 * validatePath check rejects them.
 *
 * Canonicalization runs AFTER validatePath, on the already-validated
 * raw path — so it can never rewrite an absolute path into a relative
 * one and thereby slip past the absolute-path rejection.
 */
export function canonicalizePath(p: string): string {
  return p
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

export function normalizePaths(paths: string[]): string[] {
  // Validate the RAW path first — absolute / '..' / backslash / null
  // byte must be caught before canonicalization could mask them.
  for (const p of paths) validatePath(p);
  const canon = paths.map((p, i) => {
    const c = canonicalizePath(p);
    // A path that canonicalizes to nothing ('.', './', '/') was never
    // a real repo-relative file path.
    if (c === '') throw new InvalidPathError(paths[i], 'empty after canonicalization');
    return c;
  });
  // Sort + dedupe. Sort is for FIFO determinism and stable indexing;
  // dedupe now also collapses paths that were distinct strings but
  // canonicalize to the same key.
  return Array.from(new Set(canon)).sort();
}

// ───────── Janitor ─────────

/**
 * Plan §7.7 janitor: clear expired locks + terminal waiters older
 * than 24h. Returns the workspace_ids that had expired locks swept,
 * so the caller can fire grant_cascade for those workspaces — without
 * this, a waiter queued on a path whose holder lapses (TTL expiry,
 * no explicit release) would silently sit in 'waiting' until its
 * max_sec runs out, even though the path is free.
 *
 * Cheap; bounded by partial indexes.
 */
async function janitorAndCollectExpiredWorkspaces(
  tx: Sql,
  hintWorkspaceId: string,
): Promise<Set<string>> {
  const swept = await tx<Array<{ workspace_id: string }>>`
    DELETE FROM agent_file_locks
     WHERE expires_ts <= clock_timestamp()
     RETURNING workspace_id
  `;
  // Bug-#19: sweep ORPHANED 'waiting' waiters whose wait_until has
  // passed but no one marked them expired (agent process crashed
  // mid-wait). Without this, a single crashed waiter permanently
  // blocks the path via the head-waiter rule.
  const orphanWaiters = await tx<Array<{ workspace_id: string }>>`
    UPDATE agent_lock_waiters
       SET status = 'expired'
     WHERE status = 'waiting'
       AND wait_until <= clock_timestamp()
     RETURNING workspace_id
  `;
  await tx`
    DELETE FROM agent_lock_waiters
     WHERE status IN ('granted','expired','cancelled')
       AND queued_ts < clock_timestamp() - interval '24 hours'
  `;
  const sweptWorkspaces = new Set<string>();
  for (const r of swept) sweptWorkspaces.add(r.workspace_id);
  for (const r of orphanWaiters) sweptWorkspaces.add(r.workspace_id);
  return sweptWorkspaces;
}

/**
 * Fire the grant cascade for the calling workspace ONLY IF the
 * janitor swept any expired lock rows for it. Cross-workspace cascade
 * is intentionally NOT fired because each workspace has its own
 * advisory lock — we'd be running cascades against workspaces whose
 * lock we don't hold.
 */
async function maybeFireCascadeForOwnWorkspace(
  tx: Sql,
  workspaceId: string,
  swept: Set<string>,
): Promise<void> {
  if (swept.has(workspaceId)) {
    await tx`SELECT grant_cascade(${workspaceId}, clock_timestamp())`;
  }
}

/**
 * Reactive nudge: run the janitor + cascade for one workspace.
 *
 * Used by the wait loop on each ceiling tick so a waiter on a path
 * whose holder lapsed (TTL expiry, no explicit release) doesn't sit
 * idle forever. Without this nudge, the cascade only fires when
 * SOMEONE explicitly calls release/acquire/heartbeat — if the workspace
 * is quiet, the waiter waits its full max_sec on an already-free path.
 *
 * Cheap: runs inside inWorkspaceTxn; the janitor's two DELETEs are
 * bounded by partial indexes (typically 0 rows in the steady state).
 */
export async function pokeWorkspace(tx: Sql, workspaceId: string): Promise<void> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  const swept = await janitorAndCollectExpiredWorkspaces(tx, workspaceId);
  await maybeFireCascadeForOwnWorkspace(tx, workspaceId, swept);
}

// ───────── Acquire (no wait) ─────────

export interface AcquireParams {
  workspaceId: string;
  owner: string;
  ownerLabel: string;
  paths: string[]; // already normalized
  intent: string;
  ttlSec: number;
}

export interface AcquireBusy {
  path: string;
  /** Canonical owner id of the holder (#5 — unredacted; SU is admin-tier). */
  owner: string;
  owner_label: string | null;
  intent: string;
  expires_ts: Date;
}

export type AcquireResult =
  | {
      ok: true;
      lock_id: string;
      expires_ts: Date;
      held: string[];
    }
  | {
      ok: false;
      busy: AcquireBusy[];
    };

/**
 * Atomic multi-path acquire. Inside the calling `inWorkspaceTxn`.
 *
 * Strategy:
 *   1. Head-waiter check — if any older waiter overlaps our paths, return busy.
 *   2. Upsert all paths; ON CONFLICT only overwrites expired rows.
 *   3. Verify our lock_id won every path. Mismatch → busy.
 *
 * Per audit 4 #1: success path short-circuits the busy SELECT.
 */
export async function tryAcquire(
  tx: Sql,
  params: AcquireParams,
): Promise<AcquireResult> {
  const { workspaceId, owner, ownerLabel, paths, intent, ttlSec } = params;

  if (paths.length === 0) {
    return { ok: true, lock_id: crypto.randomUUID(), expires_ts: new Date(), held: [] };
  }

  await tx`SET LOCAL statement_timeout = '500ms'`;

  // Step 1: janitor (cheap; bounded by partial indexes)
  const swept = await janitorAndCollectExpiredWorkspaces(tx, workspaceId);
  await maybeFireCascadeForOwnWorkspace(tx, workspaceId, swept);

  // Step 2: head-waiter check.
  // Skip paths the calling owner already holds — a same-owner refresh
  // shouldn't be blocked by a waiter queued behind that owner. Subtract
  // the owner's currently-held paths from the set we head-waiter-check.
  const ownedRows = await tx<Array<{ path: string; lock_id: string }>>`
    SELECT path, lock_id::text AS lock_id FROM agent_file_locks
     WHERE workspace_id = ${workspaceId}
       AND owner = ${owner}
       AND path = ANY(${paths}::text[])
       AND expires_ts > clock_timestamp()
  `;
  const ownedSet = new Set(ownedRows.map((r) => r.path));
  const newPaths = paths.filter((p) => !ownedSet.has(p));
  // If the owner already holds at least one of the requested paths,
  // reuse that lock_id for the new path inserts so the entire returned
  // set shares ONE lock_id. Otherwise mixed lock_ids would mean
  // release(lock_id) only frees a subset.
  const existingLockIds = Array.from(new Set(ownedRows.map((r) => r.lock_id)));
  // If owner happens to hold multiple existing lock_ids on the
  // requested paths (acquired via separate calls), we can't unify
  // them in one upsert — pick the first and document the constraint
  // for callers.
  const reusableLockId = existingLockIds[0];
  // If every requested path is already owned by us, skip the head-waiter
  // check entirely — pure refresh.
  const blocked = newPaths.length === 0
    ? []
    : await tx<Array<{ blocked: true }>>`
        SELECT TRUE AS blocked FROM agent_lock_waiters
         WHERE workspace_id = ${workspaceId}
           AND status = 'waiting'
           AND paths && ${newPaths}::text[]
           AND queued_ts < clock_timestamp()
         LIMIT 1
      `;
  if (blocked.length > 0) {
    const busy = await readBusySnapshot(tx, workspaceId, paths, owner);
    return { ok: false, busy };
  }

  // Step 2b: pre-check that every NEW path (not already ours) is
  // either free or expired. Otherwise an upsert that partially fails
  // would still refresh our existing rows as a side effect (extending
  // their TTL and clobbering their intent). We deliberately mutate
  // ONLY on full success.
  if (newPaths.length > 0) {
    const blockedRows = await tx<Array<{ path: string }>>`
      SELECT path FROM agent_file_locks
       WHERE workspace_id = ${workspaceId}
         AND path = ANY(${newPaths}::text[])
         AND expires_ts > clock_timestamp()
         AND owner != ${owner}
    `;
    if (blockedRows.length > 0) {
      const busy = await readBusySnapshot(tx, workspaceId, paths, owner);
      return { ok: false, busy };
    }
  }

  // Step 3: atomic upsert.
  // Use the reusable lock_id from any same-owner row we're refreshing,
  // so the returned lock_id matches every row this call creates or
  // refreshes. Without this, new paths in an extending acquire get a
  // fresh lock_id while refreshed paths keep their old one — caller
  // sees one lock_id but DB has two, and release-by-id leaks the
  // mismatched subset.
  const lockId = reusableLockId ?? crypto.randomUUID();
  const ttlText = `${ttlSec} seconds`;

  // `xmax = 0` distinguishes freshly-INSERTed rows (xmax is zero) from
  // ON-CONFLICT-UPDATE rows (xmax is the current xid). We track which
  // are new so that on partial failure we can roll back ONLY new
  // inserts — not pre-existing same-owner refreshes that the caller
  // already owned.
  const upserted = await tx<Array<{ path: string; lock_id: string; is_new: boolean }>>`
    WITH wanted AS (SELECT unnest(${paths}::text[]) AS path)
    INSERT INTO agent_file_locks
      (workspace_id, path, owner, owner_label, intent, lock_id, acquired_ts, expires_ts)
    SELECT
      ${workspaceId}, w.path, ${owner}, ${ownerLabel}, ${intent},
      ${lockId}::uuid, clock_timestamp(), clock_timestamp() + ${ttlText}::interval
    FROM wanted w
    ON CONFLICT (workspace_id, path) DO UPDATE
      SET owner       = EXCLUDED.owner,
          owner_label = EXCLUDED.owner_label,
          intent      = EXCLUDED.intent,
          -- Always take EXCLUDED.lock_id. The call's lockId already
          -- equals the reusable lock_id when the caller has any
          -- existing same-owner row, so every row this call touches
          -- ends up sharing one lock_id, and the returned lock_id
          -- covers all of them on release.
          lock_id     = EXCLUDED.lock_id,
          acquired_ts = clock_timestamp(),
          expires_ts  = EXCLUDED.expires_ts
      -- Refresh on two conditions:
      --   1. Expired locks (anyone can steal a stale row).
      --   2. Same-owner re-acquire (Claude Code hooks fire Pre on
      --      every Edit; consecutive edits to the same file must not
      --      lock the agent out of itself).
      WHERE agent_file_locks.expires_ts <= clock_timestamp()
         OR agent_file_locks.owner = EXCLUDED.owner
    RETURNING path, lock_id, (xmax = 0) AS is_new
  `;

  if (upserted.length === paths.length) {
    // All paths held by us. The effective lock_id may differ from the
    // one we generated if this was a same-owner re-acquire (CASE
    // expression in the upsert preserves the prior lock_id to keep
    // hook caches valid). All rows for one call share the same id;
    // pick from the first returned row.
    const effectiveLockId = upserted[0].lock_id;
    return {
      ok: true,
      lock_id: effectiveLockId,
      expires_ts: new Date(Date.now() + ttlSec * 1000),
      held: paths,
    };
  }

  // Some paths weren't taken (held by someone else with a live lock).
  // Roll back ONLY rows we freshly INSERTed (xmax=0). Refreshes of
  // pre-existing same-owner locks must NOT be deleted — the caller
  // already owned them before this call.
  const newPathsTaken = upserted.filter((r) => r.is_new).map((r) => r.path);
  if (newPathsTaken.length > 0) {
    await tx`
      DELETE FROM agent_file_locks
       WHERE workspace_id = ${workspaceId}
         AND path = ANY(${newPathsTaken}::text[])
    `;
  }

  const busy = await readBusySnapshot(tx, workspaceId, paths, owner);
  return { ok: false, busy };
}

async function readBusySnapshot(
  tx: Sql,
  workspaceId: string,
  paths: string[],
  excludeOwner?: string,
): Promise<AcquireBusy[]> {
  const ownerFilter = excludeOwner
    ? tx`AND owner != ${excludeOwner}`
    : tx``;
  const rows = await tx<
    Array<{
      path: string;
      owner: string;
      owner_label: string | null;
      intent: string;
      expires_ts: Date;
    }>
  >`
    SELECT path, owner, owner_label, intent, expires_ts
      FROM agent_file_locks
     WHERE workspace_id = ${workspaceId}
       AND path = ANY(${paths}::text[])
       AND expires_ts > clock_timestamp()
       ${ownerFilter}
  `;
  return rows;
}

// ───────── Release ─────────

export interface ReleaseParams {
  workspaceId: string;
  owner: string;
  lockId?: string;
  paths?: string[];
  allMine?: boolean;
}

export async function tryRelease(
  tx: Sql,
  params: ReleaseParams,
): Promise<{ released: string[] }> {
  const { workspaceId, owner, lockId, paths, allMine } = params;

  await tx`SET LOCAL statement_timeout = '5s'`;

  // Janitor runs but does NOT fire cascade here — release fires its
  // own cascade unconditionally at the end of the function, so a
  // janitor-driven cascade would be redundant.
  await janitorAndCollectExpiredWorkspaces(tx, workspaceId);

  let released: Array<{ path: string }>;

  if (allMine) {
    released = await tx<Array<{ path: string }>>`
      DELETE FROM agent_file_locks
       WHERE workspace_id = ${workspaceId}
         AND owner = ${owner}
      RETURNING path
    `;
  } else if (lockId && paths && paths.length > 0) {
    // Owner check (bug #16): lock_id alone is unguessable but it's
    // persisted in tool_invocations.result_json (audit:read can read
    // it). Require owner match so a leaked lock_id can't be used by
    // another agent to release someone else's lock.
    released = await tx<Array<{ path: string }>>`
      DELETE FROM agent_file_locks
       WHERE workspace_id = ${workspaceId}
         AND lock_id = ${lockId}::uuid
         AND owner = ${owner}
         AND path = ANY(${paths}::text[])
      RETURNING path
    `;
  } else if (lockId) {
    released = await tx<Array<{ path: string }>>`
      DELETE FROM agent_file_locks
       WHERE workspace_id = ${workspaceId}
         AND lock_id = ${lockId}::uuid
         AND owner = ${owner}
      RETURNING path
    `;
  } else {
    throw new Error('locks:release requires lock_id or all_mine');
  }

  // Run the cascade. NOTIFY fires inside; we don't need the result set.
  await tx`SELECT grant_cascade(${workspaceId}, clock_timestamp())`;

  return { released: released.map((r) => r.path) };
}

// ───────── Heartbeat ─────────

export interface HeartbeatResult {
  expires_ts: Date | null;
  extended: boolean;
}

export async function tryHeartbeat(
  tx: Sql,
  workspaceId: string,
  owner: string,
  lockId: string,
  ttlSec: number,
): Promise<HeartbeatResult> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  // Plan §7.7 janitor; fire cascade if expired locks were swept.
  const swept = await janitorAndCollectExpiredWorkspaces(tx, workspaceId);
  await maybeFireCascadeForOwnWorkspace(tx, workspaceId, swept);
  const ttlText = `${ttlSec} seconds`;
  // Owner check (bug #17): like release, require owner match so a
  // leaked lock_id can't be used to extend someone else's TTL.
  const rows = await tx<Array<{ expires_ts: Date }>>`
    UPDATE agent_file_locks
       SET expires_ts = clock_timestamp() + ${ttlText}::interval
     WHERE workspace_id = ${workspaceId}
       AND lock_id = ${lockId}::uuid
       AND owner = ${owner}
       AND expires_ts > clock_timestamp()
     RETURNING expires_ts
  `;
  if (rows.length === 0) return { expires_ts: null, extended: false };
  return { expires_ts: rows[0].expires_ts, extended: true };
}

// ───────── Queue (read-only — no advisory lock) ─────────

export interface QueueParams {
  workspaceId: string;
  paths?: string[];
  owner?: string;
  includeCompleted?: boolean;
}

export interface ActiveLockRow {
  path: string;
  owner: string;
  owner_label: string | null;
  intent: string;
  acquired_ts: Date;
  expires_ts: Date;
}

export interface WaiterRow {
  ticket_id: string;
  owner: string;
  owner_label: string | null;
  paths: string[];
  intent: string;
  queued_ts: Date;
  wait_until: Date;
  status: 'waiting' | 'granted' | 'expired' | 'cancelled';
  ahead_count?: number;
}

export interface QueueResult {
  active_locks: ActiveLockRow[];
  waiting: WaiterRow[];
  completed?: WaiterRow[];
}

export async function readQueue(
  sqlIn: Sql,
  params: QueueParams,
): Promise<QueueResult> {
  // Wrap in a transaction so SET LOCAL statement_timeout is scoped to
  // this read (plan §6.1: queue = 1000ms). Without a transaction,
  // SET LOCAL is a no-op; SET (without LOCAL) would leak across the
  // pool. The transaction is read-only — no advisory lock needed.
  return sqlIn.begin(async (sql) => {
    await sql`SET LOCAL statement_timeout = '1s'`;
    return readQueueInner(sql as unknown as Sql, params);
  }) as Promise<QueueResult>;
}

async function readQueueInner(
  sql: Sql,
  params: QueueParams,
): Promise<QueueResult> {
  const { workspaceId, paths, owner, includeCompleted } = params;

  const lockFilter = paths && paths.length > 0
    ? sql`AND path = ANY(${paths}::text[])`
    : sql``;
  const ownerFilter = owner ? sql`AND owner = ${owner}` : sql``;

  const active = await sql<Array<ActiveLockRow>>`
    SELECT path, owner, owner_label, intent, acquired_ts, expires_ts
      FROM agent_file_locks
     WHERE workspace_id = ${workspaceId}
       AND expires_ts > clock_timestamp()
       ${lockFilter}
       ${ownerFilter}
     ORDER BY acquired_ts ASC
  `;

  const pathOverlap = paths && paths.length > 0
    ? sql`AND paths && ${paths}::text[]`
    : sql``;

  const waiting = await sql<Array<WaiterRow & { ahead_count: number }>>`
    SELECT ticket_id, owner, owner_label, paths, intent, queued_ts, wait_until,
           status::text AS status,
           (ROW_NUMBER() OVER (ORDER BY queued_ts ASC, ticket_id ASC) - 1)::int AS ahead_count
      FROM agent_lock_waiters
     WHERE workspace_id = ${workspaceId}
       AND status = 'waiting'
       ${pathOverlap}
       ${ownerFilter}
     ORDER BY queued_ts ASC, ticket_id ASC
  `;

  const result: QueueResult = { active_locks: active, waiting };

  if (includeCompleted) {
    result.completed = await sql<Array<WaiterRow>>`
      SELECT ticket_id, owner, owner_label, paths, intent, queued_ts, wait_until,
             status::text AS status
        FROM agent_lock_waiters
       WHERE workspace_id = ${workspaceId}
         AND status IN ('granted','expired','cancelled')
         AND queued_ts > clock_timestamp() - interval '24 hours'
         ${pathOverlap}
         ${ownerFilter}
       ORDER BY queued_ts DESC
       LIMIT 50
    `;
  }

  return result;
}

// ───────── Waiter insert (Phase 2 — wait path) ─────────

export const MAX_WAITERS_PER_OWNER = 10;

export interface InsertWaiterParams {
  workspaceId: string;
  owner: string;
  ownerLabel: string;
  paths: string[];
  intent: string;
  ttlSec: number;
  maxWaitSec: number;
}

export type InsertWaiterResult =
  | { ok: true; ticket_id: string; wait_until: Date }
  // Self-grant — the path freed up between the caller's last
  // try-acquire and this insert call (race between busy-return and
  // INSERT). The waiter was NOT inserted; the caller already holds
  // the lock and should treat this like a direct acquire success.
  | {
      ok: true;
      self_granted: true;
      lock_id: string;
      expires_ts: Date;
      held: string[];
    }
  | { ok: false; reason: 'waiter_cap_exceeded' };

/**
 * Insert a row into agent_lock_waiters. Capped at MAX_WAITERS_PER_OWNER
 * per owner (per-workspace would let one runaway agent jam other
 * agents' queues; per-owner fails loudly for the misbehaving caller
 * only — reviewer #8).
 *
 * Before inserting, attempts a fresh acquire under the workspace
 * advisory lock. Closes the race between the caller's earlier
 * try-acquire-returning-busy and this INSERT — if the holder released
 * in that window, the cascade ran without our row, and our waiter
 * would sit idle on a now-free file.
 */
export async function tryInsertWaiter(
  tx: Sql,
  params: InsertWaiterParams,
): Promise<InsertWaiterResult> {
  // Self-grant attempt first.
  const acquired = await tryAcquire(tx, {
    workspaceId: params.workspaceId,
    owner: params.owner,
    ownerLabel: params.ownerLabel,
    paths: params.paths,
    intent: params.intent,
    ttlSec: params.ttlSec,
  });
  if (acquired.ok) {
    return {
      ok: true,
      self_granted: true,
      lock_id: acquired.lock_id,
      expires_ts: acquired.expires_ts,
      held: acquired.held,
    };
  }

  await tx`SET LOCAL statement_timeout = '500ms'`;

  // Per-owner cap. NOTE: this counts across all workspaces; runaway
  // loops anywhere stop the owner cold.
  const capRows = await tx<Array<{ at_cap: boolean }>>`
    SELECT count(*) >= ${MAX_WAITERS_PER_OWNER} AS at_cap
      FROM agent_lock_waiters
     WHERE owner = ${params.owner}
       AND status = 'waiting'
  `;
  if (capRows[0]?.at_cap) {
    return { ok: false, reason: 'waiter_cap_exceeded' };
  }

  const waitText = `${params.maxWaitSec} seconds`;
  const rows = await tx<Array<{ ticket_id: string; wait_until: Date }>>`
    INSERT INTO agent_lock_waiters
      (workspace_id, owner, owner_label, paths, intent, ttl_sec, wait_until)
    VALUES
      (${params.workspaceId}, ${params.owner}, ${params.ownerLabel},
       ${params.paths}, ${params.intent}, ${params.ttlSec},
       clock_timestamp() + ${waitText}::interval)
    RETURNING ticket_id, wait_until
  `;
  return { ok: true, ticket_id: rows[0].ticket_id, wait_until: rows[0].wait_until };
}

// ───────── Waiter status read ─────────

export interface WaiterStatus {
  status: 'waiting' | 'granted' | 'expired' | 'cancelled' | 'missing';
  granted_lock_id?: string;
  granted_expires_ts?: Date;
  paths?: string[];
}

export async function readWaiterStatus(
  sql: Sql,
  ticketId: string,
): Promise<WaiterStatus> {
  const rows = await sql<
    Array<{
      status: string;
      granted_lock_id: string | null;
      granted_expires_ts: Date | null;
      paths: string[];
    }>
  >`
    SELECT status::text AS status, granted_lock_id, granted_expires_ts, paths
      FROM agent_lock_waiters
     WHERE ticket_id = ${ticketId}::uuid
     LIMIT 1
  `;
  if (rows.length === 0) return { status: 'missing' };
  const r = rows[0];
  return {
    status: r.status as WaiterStatus['status'],
    granted_lock_id: r.granted_lock_id ?? undefined,
    granted_expires_ts: r.granted_expires_ts ?? undefined,
    paths: r.paths,
  };
}

/**
 * Force a waiter row to 'expired' if it's still 'waiting'. Used when
 * the wait timeout fires. Idempotent — no-op if already terminal.
 */
export async function expireWaiter(
  tx: Sql,
  ticketId: string,
): Promise<void> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  await tx`
    UPDATE agent_lock_waiters
       SET status = 'expired'
     WHERE ticket_id = ${ticketId}::uuid
       AND status = 'waiting'
  `;
}

// ───────── Cancel waiter ─────────

export async function tryCancelWait(
  tx: Sql,
  ticketId: string,
  owner: string,
): Promise<{ cancelled: boolean }> {
  await tx`SET LOCAL statement_timeout = '500ms'`;
  // Owner check prevents one agent from cancelling another's waiter.
  const rows = await tx<Array<{ ticket_id: string }>>`
    UPDATE agent_lock_waiters
       SET status = 'cancelled'
     WHERE ticket_id = ${ticketId}::uuid
       AND owner = ${owner}
       AND status = 'waiting'
     RETURNING ticket_id
  `;
  return { cancelled: rows.length > 0 };
}
