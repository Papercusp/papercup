/**
 * learning-hive-throughput-read.ts — the read behind the Learning tab's
 * "Throughput" sub-view (queen-autonomous-execution-2026-06-13, B-11 / P-050).
 *
 * Reads `harness_shared.hive_throughput_ticks` (migration 261), grouped by hive:
 * the latest tick (the live metric cards) + a recent trend window (sparkline)
 * + the operating-well verdict (the health tone). Pure SQL over an injected
 * `Sql` (mirrors learning-scout-read.ts) so the resolver test stubs the seam.
 *
 * Best-effort: the migration may not be applied yet on a given substrate, so an
 * undefined-table (42P01) degrades to the EMPTY snapshot — the tab renders
 * "no throughput recorded yet", never a 500.
 */
import type { Sql } from 'postgres';
import {
  isOperatingWell,
  normalizeThroughputRow,
  type HiveThroughputTickRow,
  type RawThroughputTickRow,
} from '../hive/throughput';

/** One hive's throughput view: latest metrics + recent trend + health verdict. */
export interface HiveThroughputView {
  hiveSlug: string;
  /** The newest tick (the live cards), or null when none recorded. */
  latest: HiveThroughputTickRow | null;
  /** Recent ticks, newest-first, for the trend sparkline. */
  recent: HiveThroughputTickRow[];
  /** The operating-well yardstick over the latest tick (false when none yet). */
  operatingWell: boolean;
}

export interface HiveThroughputSnapshot {
  hives: HiveThroughputView[];
}

const UNDEFINED_TABLE = '42P01';

/** True when a PG error means "the relation doesn't exist" (pre-migration). */
export function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

/** Group recent throughput ticks into per-hive views (newest-first per hive). */
export async function readHiveThroughputSnapshot(
  sql: Sql,
  workspaceId: string,
  opts: { hiveSlug?: string; recentLimit?: number } = {},
): Promise<HiveThroughputSnapshot> {
  const recentLimit = Math.min(Math.max(opts.recentLimit ?? 60, 1), 500);
  let rows: RawThroughputTickRow[] = [];
  try {
    // Cap the scan generously; per-hive trend slicing happens in memory below.
    rows = (await sql`
      SELECT hive_slug, tick_at, frontier_depth, placements, bees_busy, bees_cap,
             stuck_count, completed, mttc_ms, question_rungs, detail
        FROM harness_shared.hive_throughput_ticks
       WHERE workspace_id = ${workspaceId}
         ${opts.hiveSlug ? sql`AND hive_slug = ${opts.hiveSlug}` : sql``}
       ORDER BY tick_at DESC
       LIMIT 2000
    `) as RawThroughputTickRow[];
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn('[learning.hiveThroughput] tick read failed:', err instanceof Error ? err.message : err);
    }
    return { hives: [] };
  }

  // Group newest-first; the query is already DESC so insertion order is preserved.
  const byHive = new Map<string, HiveThroughputTickRow[]>();
  for (const raw of rows) {
    const row = normalizeThroughputRow(raw);
    const list = byHive.get(row.hiveSlug);
    if (list) list.push(row);
    else byHive.set(row.hiveSlug, [row]);
  }

  const hives: HiveThroughputView[] = [...byHive.entries()].map(([hiveSlug, ticks]) => {
    const latest = ticks[0] ?? null;
    return {
      hiveSlug,
      latest,
      recent: ticks.slice(0, recentLimit),
      operatingWell: latest ? isOperatingWell(latest) : false,
    };
  });
  // Stable order: hives with a stuck/starved latest tick first (attention), then alphabetical.
  hives.sort((a, b) => Number(a.operatingWell) - Number(b.operatingWell) || a.hiveSlug.localeCompare(b.hiveSlug));
  return { hives };
}
