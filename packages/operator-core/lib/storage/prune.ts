/**
 * Safe prune-by-category-and-age executor (storage-settings-page-2026-06-15
 * P-003, D-003). Default keep-all: nothing here ever auto-fires — only an
 * explicit user (or agent) trim runs it.
 *
 * Invariants:
 *   • Federated categories are REFUSED (fail-safe — trimming changes what peers
 *     see; D-002/D-003). Only `sync:'none'` PG + local disk stores trim.
 *   • PG deletes are CHUNKED (ctid batches) so a multi-million-row trim never
 *     takes a long lock; a bloat-queue table (substrate_outbox) then gets a
 *     VACUUM FULL to actually return disk, coordinated via the `db:migrate`
 *     exclusive resource lock with drain (the plan's lock requirement).
 *   • Disk session-dir trims reuse the audited session-dir-gc planner with a
 *     FAIL-CLOSED protected set (a live/resumable session is never collected),
 *     floored at the category's minOlderThanDays. Plain stores exclude entries
 *     written in the last minute.
 *
 * Server-only.
 */
import { rmSync } from 'node:fs';
import {
  getStorageCategory,
  isTrimmable,
  type PgStorageCategory,
  type DiskStorageCategory,
} from './categories';
import { dirSizeBytes, gatherProtectedSessionIdentity, listDiskEntries } from './disk';
import {
  defaultSessionDirRoots,
  discoverSessionDirCandidates,
  planSessionDirGc,
} from '../session-dir-gc';

export interface PruneRequest {
  categoryId: string;
  /** delete rows/entries strictly older than this many days; null = ALL. */
  olderThanDays: number | null;
  /** preview only — count + estimate, no deletion. */
  dryRun: boolean;
  /** workspace for the VACUUM resource-lock coordination domain. */
  workspaceId: string;
  signal?: AbortSignal;
}

export interface PruneResult {
  ok: boolean;
  categoryId: string;
  dryRun: boolean;
  /** rows deleted (pg) or paths removed (disk). */
  removed: number;
  /** reclaimed bytes — measured for bloat (VACUUM FULL) / disk; estimated for
   *  ordinary PG (logical delete returns space for reuse, not to the OS). */
  reclaimedBytes: number;
  reclaimEstimated: boolean;
  vacuumed: boolean;
  reason?: string;
  note?: string;
  /** PG: a per-call row ceiling was hit; run again to continue. */
  partial?: boolean;
}

/** chunked-delete batch size + per-call ceiling (rerun to continue past it). */
const CHUNK = 10_000;
const MAX_ROWS_PER_CALL = 20_000_000;
/** plain-disk-store guard: never remove an entry touched within this window. */
const PLAIN_DISK_FLOOR_MS = 60_000;

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}
function num(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

type Sql = {
  (strings: TemplateStringsArray, ...vals: unknown[]): Promise<Array<Record<string, unknown>>>;
  unsafe: (q: string) => Promise<Array<Record<string, unknown>>>;
};

function validDays(d: number | null): boolean {
  return d === null || (Number.isInteger(d) && d >= 0);
}

/** The WHERE clause for a PG trim (trusted identifiers + integer days). */
function pgWhere(cat: PgStorageCategory, olderThanDays: number | null): string {
  const conds: string[] = [];
  if (cat.drainedGuard) conds.push('drained_at IS NOT NULL');
  if (olderThanDays != null && cat.ageColumn && cat.ageColumnType) {
    const col = ident(cat.ageColumn);
    conds.push(
      cat.ageColumnType === 'timestamptz'
        ? `${col} < now() - make_interval(days => ${olderThanDays})`
        : `${col} < (extract(epoch from now()) * 1000)::bigint - ${olderThanDays}::bigint * 86400000`,
    );
  }
  return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
}

async function relationStats(sql: Sql, schema: string, table: string): Promise<{ bytes: number; rows: number }> {
  const rows = await sql`
    SELECT pg_total_relation_size(c.oid)::bigint AS b,
           GREATEST(c.reltuples, 0)::bigint      AS r
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relname = ${table} AND c.relkind = 'r' LIMIT 1`;
  return { bytes: num(rows[0]?.b), rows: num(rows[0]?.r) };
}

async function prunePg(sql: Sql, cat: PgStorageCategory, req: PruneRequest): Promise<PruneResult> {
  const result: PruneResult = {
    ok: true,
    categoryId: cat.id,
    dryRun: req.dryRun,
    removed: 0,
    reclaimedBytes: 0,
    reclaimEstimated: true,
    vacuumed: false,
  };
  const t = `${ident(cat.schema)}.${ident(cat.table)}`;
  const where = pgWhere(cat, req.olderThanDays);
  const { bytes: sizeBefore, rows: rowsBefore } = await relationStats(sql, cat.schema, cat.table);
  const perRow = rowsBefore > 0 ? sizeBefore / rowsBefore : 0;

  if (req.dryRun) {
    const rows = await sql.unsafe(`SELECT count(*)::bigint AS n FROM ${t} ${where}`);
    const matched = num(rows[0]?.n);
    result.removed = matched;
    result.reclaimedBytes = Math.round(perRow * matched);
    result.reclaimEstimated = true;
    return result;
  }

  // Execute — chunked deletes so no single statement takes a long lock.
  let removed = 0;
  for (;;) {
    if (req.signal?.aborted) {
      result.partial = true;
      break;
    }
    const rows = await sql.unsafe(`
      WITH del AS (
        DELETE FROM ${t}
         WHERE ctid IN (SELECT ctid FROM ${t} ${where} LIMIT ${CHUNK})
        RETURNING 1
      ) SELECT count(*)::int AS n FROM del`);
    const n = num(rows[0]?.n);
    removed += n;
    if (n < CHUNK) break;
    if (removed >= MAX_ROWS_PER_CALL) {
      result.partial = true;
      break;
    }
  }
  result.removed = removed;

  // Bloat-queue: logical delete does not return disk → VACUUM FULL under the
  // db:migrate exclusive lock with drain (the plan's coordination requirement).
  if (cat.bloats && removed > 0) {
    try {
      const { guardResource } = await import('../agent-tools/locks/resource-lock-guard');
      const outcome = await guardResource(
        {
          coordinationDomain: req.workspaceId,
          ownerId: 'storage-prune',
          ownerLabel: 'storage:prune',
          coordIdentity: {
            ownerId: 'storage-prune',
            ownerLabel: 'storage:prune',
            source: 'static-client',
            workspaceId: req.workspaceId,
            userId: null,
          },
          resource: 'db:migrate',
          mode: 'exclusive',
          maxDrainSec: 30,
          reason: `VACUUM FULL ${cat.table} (storage trim)`,
        },
        async () => {
          // VACUUM cannot run in a txn block; postgres-js sends a bare query (no
          // implicit BEGIN), so this is safe outside .begin().
          await sql.unsafe(`VACUUM (FULL, ANALYZE) ${t}`);
          return true;
        },
      );
      result.vacuumed = outcome.acquired === true;
      if (!result.vacuumed) {
        result.note = `rows deleted; VACUUM FULL skipped (db:migrate ${outcome.acquired === false ? outcome.reason : 'busy'}) — autovacuum will reclaim`;
      }
    } catch (err) {
      result.note = `rows deleted; VACUUM FULL failed: ${(err as Error)?.message ?? 'error'}`;
    }
  }

  if (result.vacuumed) {
    const { bytes: sizeAfter } = await relationStats(sql, cat.schema, cat.table);
    result.reclaimedBytes = Math.max(0, sizeBefore - sizeAfter);
    result.reclaimEstimated = false;
  } else {
    // Logical delete: space is freed for REUSE (autovacuum returns it to the OS
    // over time), so report the proportional estimate, not an OS-measured shrink.
    result.reclaimedBytes = Math.round(perRow * removed);
    result.reclaimEstimated = true;
    result.note =
      result.note ?? `${removed} rows deleted; space freed for reuse (autovacuum returns it to the OS over time)`;
  }
  return result;
}

async function pruneDiskSessions(
  sql: Sql,
  cat: DiskStorageCategory,
  req: PruneRequest,
): Promise<PruneResult> {
  const result: PruneResult = {
    ok: true,
    categoryId: cat.id,
    dryRun: req.dryRun,
    removed: 0,
    reclaimedBytes: 0,
    reclaimEstimated: false,
    vacuumed: false,
  };
  const gather = await gatherProtectedSessionIdentity(sql);
  if (!gather.ok) {
    return { ...result, ok: false, reason: 'protected_set_unavailable' };
  }
  const days = Math.max(req.olderThanDays ?? 0, cat.minOlderThanDays ?? 0);
  const candidates = discoverSessionDirCandidates(defaultSessionDirRoots());
  const plan = planSessionDirGc({
    candidates,
    protectedIdentity: gather.identity,
    nowMs: Date.now(),
    retentionMs: days * 86400000,
  });
  for (const c of plan.remove) {
    const size = dirSizeBytes(c.path);
    if (!req.dryRun) {
      try {
        rmSync(c.path, { recursive: true, force: true });
      } catch {
        continue; // best-effort per dir
      }
    }
    result.removed += 1;
    result.reclaimedBytes += size;
  }
  if (days > (req.olderThanDays ?? 0)) {
    result.note = `floored to ${days}d (live/resumable sessions are always protected)`;
  }
  return result;
}

function pruneDiskPlain(cat: DiskStorageCategory, req: PruneRequest): PruneResult {
  const result: PruneResult = {
    ok: true,
    categoryId: cat.id,
    dryRun: req.dryRun,
    removed: 0,
    reclaimedBytes: 0,
    reclaimEstimated: false,
    vacuumed: false,
  };
  const now = Date.now();
  // 'all' still excludes entries written in the last minute (likely in-flight).
  const cutoff = req.olderThanDays == null ? now - PLAIN_DISK_FLOOR_MS : now - req.olderThanDays * 86400000;
  for (const e of listDiskEntries(cat)) {
    if (e.mtimeMs >= cutoff) continue;
    if (!req.dryRun) {
      try {
        rmSync(e.path, { recursive: true, force: true });
      } catch {
        continue;
      }
    }
    result.removed += 1;
    result.reclaimedBytes += e.sizeBytes;
  }
  return result;
}

/**
 * Prune one category by age (or all). Refuses federated categories and invalid
 * day values; never auto-fires (only an explicit call runs it).
 */
export async function pruneStorageCategory(req: PruneRequest): Promise<PruneResult> {
  const base = (reason: string): PruneResult => ({
    ok: false,
    categoryId: req.categoryId,
    dryRun: req.dryRun,
    removed: 0,
    reclaimedBytes: 0,
    reclaimEstimated: true,
    vacuumed: false,
    reason,
  });

  const cat = getStorageCategory(req.categoryId);
  if (!cat) return base('unknown_category');
  if (!isTrimmable(cat)) return base('federated_not_trimmable');
  if (!validDays(req.olderThanDays)) return base('invalid_older_than_days');

  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql as unknown as Sql;

  try {
    if (cat.kind === 'pg') return await prunePg(sql, cat, req);
    if (cat.store === 'session-dirs') return await pruneDiskSessions(sql, cat, req);
    return pruneDiskPlain(cat, req);
  } catch (err) {
    return base(`prune_failed: ${(err as Error)?.message ?? 'error'}`);
  }
}
