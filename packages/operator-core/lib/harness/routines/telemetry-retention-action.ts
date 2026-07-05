/**
 * `system:telemetry-retention` — the periodic janitor for the unbounded
 * high-volume diagnostic tables (`route_invocations`, `tool_invocations`, …) the
 * 2026-06-18 infra audit found growing without bound: `route_invocations` was
 * 6.3 GB / 28.8M rows and climbing ~3M rows/day, with NO retention layer (the
 * audit's R2 finding). Unbounded growth bloats the working set (dragging the PG
 * heap cache-hit ratio down to 82.8% — R3/P3) and feeds the conn + event-loop
 * load the psu single-loop incident exposed. This caps the tables so the one-off
 * audit prune (plan P-001) doesn't re-accumulate.
 *
 * Composes the existing storage prune (`pruneStorageCategory`) — the same
 * category taxonomy + chunked, VACUUMing delete the Settings → Storage page uses,
 * so retention and the manual trim share one code path.
 *
 * Runs as ONE durable step; idempotent + safe to re-run from the top: the prune
 * is chunked and returns `partial` when its per-call row ceiling is hit, so we
 * loop until the category is drained (bounded by a loop cap so one tick can never
 * run away).
 *
 * Config (routine `trigger_config`, all optional):
 *   - `targets` — `Array<{ category: string; retention_days: number }>`; default
 *     `route-invocations`@7d + `tool-invocations`@14d + `harness-run-output`@14d
 *     (the largest diagnostic tables: request-, tool-call, and per-agent-run
 *     transcript telemetry).
 *   - `dry_run` — plan + log but delete nothing (preview a first run).
 *   - `reindex_indexes` — `Array<{ schema: string; index: string }>`; default the
 *     two heavily-bloated indexes the 2026-07-05 infra audit found (EI-7482).
 *   - `reindex_day_of_week` — 0 (Sunday, default) .. 6 (Saturday), UTC.
 *   - `reindex_enabled` — set `false` to disable the reindex step entirely.
 *   - `reindex_now` — force an immediate one-off reindex regardless of cadence.
 *
 * ## Index-bloat maintenance (EI-7482)
 * VACUUM (run inside `pruneStorageCategory`) reclaims heap dead-tuples but never
 * shrinks/defragments btree indexes. High-volume append (~2.8M route rows/day)
 * plus the daily retention-DELETE churn above bloats the indexes UNBOUNDED even
 * though retention bounds the row count: the 2026-07-05 infra audit measured
 * `route_invocations_ws_time_idx` at 4.1 GB / 19.8M rows (~217 B/row, a healthy
 * such index runs ~55-70 B/row) — ~3.5x bloated, ~3 GB reclaimable — after
 * retention had already CUT the row count 31%. Only `REINDEX` reclaims that; this
 * extends the same janitor tick to run it on a weekly cadence (default Sunday
 * UTC — infrequent enough that this disk/CPU-heavy op never competes with
 * weekday load) rather than adding a second routine (reuse-first).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { pruneStorageCategory } from '../../storage/prune';

/** Minimal shape of the postgres.js tagged-template client this module needs —
 *  mirrors `storage/prune.ts`'s local `Sql` type (not exported there either). */
type Sql = {
  (strings: TemplateStringsArray, ...vals: unknown[]): Promise<Array<Record<string, unknown>>>;
  unsafe: (q: string) => Promise<Array<Record<string, unknown>>>;
};

const IDENT = /^[a-z_][a-z0-9_]*$/;
function safeIdent(name: unknown): string | null {
  return typeof name === 'string' && IDENT.test(name) ? name : null;
}

export interface ReindexTarget {
  schema: string;
  index: string;
}

/** The two indexes the 2026-07-05 infra audit (EI-7482) measured as heavily
 *  bloated: `route_invocations_ws_time_idx` (~3.5x bloated, ~3 GB reclaimable)
 *  and `tool_invocations_quota_idx` (1.16 GB for only 761 scans). */
export const DEFAULT_REINDEX_TARGETS: readonly ReindexTarget[] = [
  { schema: 'harness_shared', index: 'route_invocations_ws_time_idx' },
  { schema: 'harness_shared', index: 'tool_invocations_quota_idx' },
];

const DEFAULT_REINDEX_DAY_OF_WEEK = 0; // Sunday, UTC.

export function resolveReindexTargets(cfg: Record<string, unknown>): ReindexTarget[] {
  const raw = cfg.reindex_indexes;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .map((t) => t as ReindexTarget)
      .filter((t) => t && typeof t.schema === 'string' && typeof t.index === 'string');
  }
  return [...DEFAULT_REINDEX_TARGETS];
}

/** Weekly-by-default cadence gate computed from wall-clock — no persisted
 *  last-run state needed. `reindex_now:true` forces an immediate one-off run
 *  (the ticket's "optional one-off immediate reclaim"); `reindex_enabled:false`
 *  disables the step outright. */
export function shouldRunReindex(cfg: Record<string, unknown>, now: Date): boolean {
  if (cfg.reindex_enabled === false) return false;
  if (cfg.reindex_now === true) return true;
  const configuredDay = cfg.reindex_day_of_week;
  const day = Number.isInteger(configuredDay) ? (configuredDay as number) : DEFAULT_REINDEX_DAY_OF_WEEK;
  return now.getUTCDay() === day;
}

/**
 * REINDEX each target CONCURRENTLY, one at a time, best-effort (a failure on
 * one index is logged and never blocks the others or the retention prune).
 * Exported so a unit test can inject a fake `sql` + `guard` and assert the
 * exact statements without a live PG.
 */
export async function reindexBloatedIndexes(
  targets: readonly ReindexTarget[],
  sql: Sql,
  guard: <T>(reason: string, run: () => Promise<T>) => Promise<{ acquired: boolean; reason?: string }>,
): Promise<void> {
  for (const t of targets) {
    const schema = safeIdent(t.schema);
    const index = safeIdent(t.index);
    if (!schema || !index) {
      console.warn(`[telemetry-retention] reindex: skipping invalid target ${JSON.stringify(t)}`);
      continue;
    }
    const qualified = `${schema}.${index}`;
    try {
      const outcome = await guard(`REINDEX CONCURRENTLY ${qualified} (index-bloat maintenance)`, async () => {
        // Clean up a leftover INVALID index from a previously-interrupted
        // CONCURRENTLY build before retrying — REINDEX/CREATE INDEX CONCURRENTLY
        // leaves a `<index>_ccnew`/`_ccold` behind (indisvalid=false) on failure.
        const stale = await sql`
          SELECT c.relname AS name
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = ${schema}
             AND c.relname LIKE ${index + '\\_cc%'}
             AND i.indisvalid = false`;
        for (const row of stale) {
          const staleName = safeIdent(row.name);
          if (!staleName) continue; // paranoia — never interpolate an unvalidated name
          console.warn(`[telemetry-retention] reindex: dropping leftover invalid index ${schema}.${staleName}`);
          await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${schema}.${staleName}`);
        }
        // REINDEX CONCURRENTLY cannot run inside a transaction block; postgres-js
        // sends a bare (non-BEGIN-wrapped) query for a single .unsafe() call —
        // same precedent as the VACUUM-outside-.begin() call in storage/prune.ts.
        await sql.unsafe(`REINDEX INDEX CONCURRENTLY ${qualified}`);
        return true;
      });
      if (outcome.acquired) {
        console.log(`[telemetry-retention] reindex: rebuilt ${qualified}`);
      } else {
        console.warn(
          `[telemetry-retention] reindex: skipped ${qualified} (db:migrate ${outcome.reason ?? 'busy'}) — will retry next cadence`,
        );
      }
    } catch (err) {
      console.warn(
        `[telemetry-retention] reindex: ${qualified} failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

interface RetentionTarget {
  category: string;
  retention_days: number;
}

/** The largest unbounded diagnostic tables (infra audit R2 + EI-7491).
 *  route_invocations is request-level noise dominated by polling → 7d;
 *  tool_invocations is the more analysis-useful MCP telemetry → 14d;
 *  harness_run_output (EI-7491) stores four uncompressed full-transcript TEXT
 *  blobs per agent run (~228 KB/row, the largest per-row table in the DB) and
 *  was a fully-registered storage category never wired into this default
 *  target list, so it grew unbounded (56d+ of history, ~334 rows/day) — 14d
 *  matches tool-invocations and keeps ~2 weeks of run transcripts for debugging. */
export const DEFAULT_RETENTION_TARGETS: readonly RetentionTarget[] = [
  { category: 'route-invocations', retention_days: 7 },
  { category: 'tool-invocations', retention_days: 14 },
  { category: 'harness-run-output', retention_days: 14 },
];

/** Bound the per-tick prune loop so a backlog can never run a tick away; the
 *  chunked prune deletes up to 20M rows/call, so 50 calls is a hard ceiling far
 *  above any real daily delta and the next tick continues anyway. */
const MAX_CALLS_PER_TARGET = 50;

export function resolveTargets(cfg: Record<string, unknown>): RetentionTarget[] {
  const raw = cfg.targets;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .map((t) => t as RetentionTarget)
      .filter((t) => t && typeof t.category === 'string');
  }
  return [...DEFAULT_RETENTION_TARGETS];
}

registerSystemAction('telemetry-retention', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;
  const targets = resolveTargets(cfg);

  for (const t of targets) {
    const days = Number(t.retention_days);
    if (!Number.isFinite(days) || days < 0) {
      console.warn(
        `[telemetry-retention] skipping "${t.category}": invalid retention_days ${t.retention_days}`,
      );
      continue;
    }

    let totalRemoved = 0;
    let calls = 0;
    let vacuumed = false;
    let failed: string | undefined;

    // Drain the category — the prune is chunked + returns `partial` past its
    // per-call ceiling. Bounded by MAX_CALLS_PER_TARGET; the next tick continues.
    for (;;) {
      const r = await pruneStorageCategory({
        categoryId: t.category,
        olderThanDays: days,
        dryRun,
        workspaceId: ctx.workspaceId,
      });
      if (!r.ok) {
        failed = r.reason ?? 'unknown';
        break;
      }
      totalRemoved += r.removed;
      calls += 1;
      vacuumed = vacuumed || r.vacuumed;
      if (!r.partial || dryRun || calls >= MAX_CALLS_PER_TARGET) break;
    }

    if (failed) {
      console.warn(`[telemetry-retention] "${t.category}" prune failed — ${failed}`);
    } else {
      console.log(
        `[telemetry-retention] "${t.category}": ${dryRun ? 'WOULD remove' : 'removed'} ` +
          `${totalRemoved} row(s) over ${calls} call(s) (retention ${days}d` +
          `${vacuumed ? ', vacuumed' : ''})`,
      );
    }
  }

  // ── Periodic index-bloat maintenance (EI-7482) ──────────────────────────
  const reindexTargets = resolveReindexTargets(cfg);
  if (reindexTargets.length > 0 && shouldRunReindex(cfg, new Date())) {
    if (dryRun) {
      for (const t of reindexTargets) {
        console.log(`[telemetry-retention] reindex: WOULD REINDEX INDEX CONCURRENTLY ${t.schema}.${t.index}`);
      }
    } else {
      const { getOrgPg } = await import('@papercusp/db-org');
      const sql = getOrgPg().sql as unknown as Sql;
      const { guardResource } = await import('../../agent-tools/locks/resource-lock-guard');
      // Static synthetic identity for a system-action caller — mirrors the
      // VACUUM-FULL guardResource call in storage/prune.ts (same 'static-client'
      // source; there is no live agent session behind this routine tick).
      await reindexBloatedIndexes(reindexTargets, sql, (reason, run) =>
        guardResource(
          {
            coordinationDomain: ctx.workspaceId,
            ownerId: 'telemetry-retention',
            ownerLabel: 'telemetry-retention:reindex',
            coordIdentity: {
              ownerId: 'telemetry-retention',
              ownerLabel: 'telemetry-retention:reindex',
              source: 'static-client',
              workspaceId: ctx.workspaceId,
              userId: null,
            },
            resource: 'db:migrate',
            mode: 'exclusive',
            maxDrainSec: 30,
            reason,
          },
          run,
        ),
      );
    }
  }
});
