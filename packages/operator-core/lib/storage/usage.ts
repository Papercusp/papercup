/**
 * Live storage usage introspection (storage-settings-page-2026-06-15 P-003,
 * D-003). Reuses the audit's introspection: PG table sizes from the catalog
 * (instant) + a bounded age-distribution count, and `du` of the on-disk stores.
 *
 * Shape per category: total size + a cumulative "older than N days" distribution
 * the page turns into per-option projected reclaim. The bucket counts run under a
 * short statement_timeout so a huge table (route_invocations is ~26M rows) can
 * never wedge a settings read — on timeout the row still returns its size with an
 * empty distribution + a note, and the UI falls back to "trim all" / a server
 * dry-run. Server-only.
 */
import {
  STORAGE_CATEGORIES,
  isTrimmable,
  type AgeColumnType,
  type StorageCategory,
  type StorageFederation,
} from './categories';
import { listDiskEntries, type DiskWalkBudget } from './disk';

/** The fixed "trim older than" thresholds (days) the page offers + projects. */
export const TRIM_THRESHOLD_DAYS = [30, 90, 365] as const;

/** Statement-timeout budget for the per-table age-distribution count (ms). */
const BUCKET_TIMEOUT_MS = 4000;

/**
 * Wall-clock budget for the whole synchronous on-disk sizing pass (EI-6045).
 * The per-table PG scans are already bounded (catalog size is instant; the
 * age-distribution count runs under BUCKET_TIMEOUT_MS), so the only unbounded
 * cost was the recursive `du`-style walk of every session dir — which blocked
 * the event loop for minutes on a large install and tripped the 300s MCP idle
 * abort. Cap the aggregate disk walk here; over-budget categories return partial
 * sizes with a note. Comfortably under the 300s idle limit even with the PG
 * phase (≤ ~6 × 4s).
 */
const DISK_BUDGET_MS = 20_000;

/** A cumulative slice: rows/entries strictly older than `olderThanDays`. A null
 *  threshold is the TOTAL (everything — the "trim all" target). */
export interface StorageAgeBucket {
  olderThanDays: number | null;
  rows: number;
  bytes: number;
}

export interface StorageUsageRow {
  id: string;
  label: string;
  kind: 'pg' | 'disk';
  federation: StorageFederation;
  /** false → read-only (federated); the page disables trim + warns. */
  trimmable: boolean;
  /** logical delete needs a VACUUM FULL to return disk (substrate_outbox). */
  bloats: boolean;
  totalBytes: number;
  /** pg row estimate / disk top-level entry count. null when unknown. */
  totalRows: number | null;
  /** cumulative older-than distribution (incl. a null=total bucket). Empty for
   *  federated categories or when the count timed out. */
  ageBuckets: StorageAgeBucket[];
  ageColumnType?: AgeColumnType;
  minOlderThanDays?: number;
  description: string;
  note?: string;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}

type Sql = {
  (strings: TemplateStringsArray, ...vals: unknown[]): Promise<Array<Record<string, unknown>>>;
  unsafe: (q: string) => Promise<Array<Record<string, unknown>>>;
  begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
};

function num(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Catalog size — instant (no row scan). Returns 0 bytes for a missing table. */
async function catalogSize(
  sql: Sql,
  schema: string,
  table: string,
): Promise<{ totalBytes: number; rowsEstimate: number }> {
  const rows = await sql`
    SELECT pg_total_relation_size(c.oid)::bigint AS total_bytes,
           GREATEST(c.reltuples, 0)::bigint       AS rows_estimate
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relname = ${table} AND c.relkind = 'r'
     LIMIT 1`;
  const r = rows[0];
  return { totalBytes: num(r?.total_bytes), rowsEstimate: num(r?.rows_estimate) };
}

/** The age-distribution SQL for one table (trusted identifiers from the taxonomy). */
function bucketSql(
  schema: string,
  table: string,
  ageColumn: string,
  ageColumnType: AgeColumnType,
  drainedGuard: boolean,
): string {
  const t = `${ident(schema)}.${ident(table)}`;
  const col = ident(ageColumn);
  const cond = (days: number): string =>
    ageColumnType === 'timestamptz'
      ? `${col} < now() - make_interval(days => ${days})`
      : `${col} < (extract(epoch from now()) * 1000)::bigint - ${days}::bigint * 86400000`;
  const where = drainedGuard ? 'WHERE drained_at IS NOT NULL' : '';
  const filters = TRIM_THRESHOLD_DAYS.map(
    (d) => `count(*) FILTER (WHERE ${cond(d)})::bigint AS d${d}`,
  ).join(',\n         ');
  return `
    SELECT count(*)::bigint AS total,
           ${filters}
      FROM ${t}
      ${where}`;
}

async function computePgUsage(
  sql: Sql,
  cat: StorageCategory & { kind: 'pg' },
  opts: { sizesOnly?: boolean } = {},
): Promise<StorageUsageRow> {
  const base: StorageUsageRow = {
    id: cat.id,
    label: cat.label,
    kind: 'pg',
    federation: cat.federation,
    trimmable: isTrimmable(cat),
    bloats: Boolean(cat.bloats),
    totalBytes: 0,
    totalRows: null,
    ageBuckets: [],
    ageColumnType: cat.ageColumnType,
    description: cat.description,
  };
  try {
    const { totalBytes, rowsEstimate } = await catalogSize(sql, cat.schema, cat.table);
    base.totalBytes = totalBytes;
    base.totalRows = rowsEstimate;
  } catch (err) {
    base.note = `size unavailable: ${(err as Error)?.message ?? 'error'}`;
    return base;
  }

  // sizesOnly (storage-growth-alarm P-017): the catalog size is all the caller
  // needs — skip the bounded age-distribution scan entirely (no per-table SQL).
  if (opts.sizesOnly) return base;

  // Federated / no age column → read-only, no distribution.
  if (!base.trimmable || !cat.ageColumn || !cat.ageColumnType) return base;

  try {
    const q = bucketSql(cat.schema, cat.table, cat.ageColumn, cat.ageColumnType, Boolean(cat.drainedGuard));
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${BUCKET_TIMEOUT_MS}`);
      return tx.unsafe(q);
    });
    const r = rows[0] ?? {};
    const total = num(r.total);
    const perRow = total > 0 ? base.totalBytes / total : 0;
    const buckets: StorageAgeBucket[] = TRIM_THRESHOLD_DAYS.map((d) => {
      const olderRows = num(r[`d${d}`]);
      return { olderThanDays: d, rows: olderRows, bytes: Math.round(perRow * olderRows) };
    });
    // The total bucket: for a drained-guarded queue the "all" target is the drained
    // subset (`total`), not the whole table — so its bytes are the proportional
    // estimate, not the full relation size.
    const totalBytes = cat.drainedGuard ? Math.round(perRow * total) : base.totalBytes;
    buckets.push({ olderThanDays: null, rows: total, bytes: totalBytes });
    base.ageBuckets = buckets;
  } catch (err) {
    base.note = `age distribution unavailable (table too large to scan in ${BUCKET_TIMEOUT_MS}ms)`;
    void err;
  }
  return base;
}

function computeDiskUsage(
  cat: StorageCategory & { kind: 'disk' },
  budget?: DiskWalkBudget,
): StorageUsageRow {
  const entries = listDiskEntries(cat, budget);
  const now = Date.now();
  const totalBytes = entries.reduce((a, e) => a + e.sizeBytes, 0);
  const buckets: StorageAgeBucket[] = TRIM_THRESHOLD_DAYS.map((d) => {
    const cutoff = now - d * 86400000;
    const older = entries.filter((e) => e.mtimeMs < cutoff);
    return {
      olderThanDays: d,
      rows: older.length,
      bytes: older.reduce((a, e) => a + e.sizeBytes, 0),
    };
  });
  buckets.push({ olderThanDays: null, rows: entries.length, bytes: totalBytes });
  return {
    id: cat.id,
    label: cat.label,
    kind: 'disk',
    federation: cat.federation,
    trimmable: true,
    bloats: false,
    totalBytes,
    totalRows: entries.length,
    ageBuckets: buckets,
    minOlderThanDays: cat.minOlderThanDays,
    description: cat.description,
    // Sizes are partial when the shared disk-walk budget was exhausted (EI-6045).
    note: budget?.truncated
      ? `disk sizes are partial (sizing budget of ${DISK_BUDGET_MS}ms exceeded on a large store)`
      : undefined,
  };
}

/** Compute usage for every category. Sequential (gentle on the DB); a failing
 *  category degrades to size-only with a note rather than failing the page. */
export async function computeStorageUsage(opts: { sizesOnly?: boolean } = {}): Promise<StorageUsageRow[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql as unknown as Sql;
  const out: StorageUsageRow[] = [];
  // One shared wall-clock budget for the whole synchronous disk-sizing pass so
  // the aggregate `du` walk can never block the event loop past DISK_BUDGET_MS
  // (EI-6045). Over-budget categories degrade to partial sizes with a note.
  const diskBudget: DiskWalkBudget = { deadlineMs: Date.now() + DISK_BUDGET_MS };
  for (const cat of STORAGE_CATEGORIES) {
    if (cat.kind === 'pg') {
      out.push(await computePgUsage(sql, cat, opts));
    } else {
      try {
        out.push(computeDiskUsage(cat, diskBudget));
      } catch (err) {
        out.push({
          id: cat.id,
          label: cat.label,
          kind: 'disk',
          federation: cat.federation,
          trimmable: true,
          bloats: false,
          totalBytes: 0,
          totalRows: null,
          ageBuckets: [],
          minOlderThanDays: cat.minOlderThanDays,
          description: cat.description,
          note: `disk scan unavailable: ${(err as Error)?.message ?? 'error'}`,
        });
      }
    }
  }
  return out;
}
