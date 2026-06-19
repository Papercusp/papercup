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
 *     `route-invocations`@7d + `tool-invocations`@14d (the two largest diagnostic
 *     tables, request- vs tool-call telemetry).
 *   - `dry_run` — plan + log but delete nothing (preview a first run).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { pruneStorageCategory } from '../../storage/prune';

interface RetentionTarget {
  category: string;
  retention_days: number;
}

/** The two largest unbounded diagnostic tables (infra audit R2). route_invocations
 *  is request-level noise dominated by polling → 7d; tool_invocations is the more
 *  analysis-useful MCP telemetry → 14d. */
export const DEFAULT_RETENTION_TARGETS: readonly RetentionTarget[] = [
  { category: 'route-invocations', retention_days: 7 },
  { category: 'tool-invocations', retention_days: 14 },
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
});
