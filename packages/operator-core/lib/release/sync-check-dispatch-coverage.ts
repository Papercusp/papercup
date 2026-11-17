/** Source-check slots must remain visible while their action is held or in flight.
 * Dispatch and completion serialize only the routine row they both annotate. */
import type { Sql } from 'postgres';
import { boundedOrgTxn } from '../pg-bounded-txn';
import {
  COVERAGE_EXPECTED_INTERVAL_MS as INTERVAL,
  COVERAGE_RETENTION_MS,
  type CoverageTick,
  type SyncDeltaCoverage,
} from './sync-batch-delta-check';

type StateKey = 'sync_delta' | 'sync_lint_guards';
type CheckState = { coverage?: SyncDeltaCoverage; [key: string]: unknown };
type RoutineScope = { workspaceId: string; installSlug: string | null; name: string };
export type DispatchCoverageRoutine = RoutineScope & { id: string; targetRole: string };

/** Keep completion evidence over an older pending observation of the same instant.
 * A completion owns alarm transitions; an intermediate cursor write has no such
 * transition and must preserve the coverage already recorded by dispatch. */
export function mergeSyncCheckCoverage(
  current: SyncDeltaCoverage | undefined,
  next: SyncDeltaCoverage | undefined,
): SyncDeltaCoverage | undefined {
  if (!next) return current;
  const byTime = new Map<number, CoverageTick>();
  for (const tick of [...(current?.ticks ?? []), ...next.ticks]) {
    const existing = byTime.get(tick.atMs);
    if (existing && (existing.evaluated && !tick.evaluated
      || existing.status !== 'pending' && tick.status === 'pending')) continue;
    byTime.set(tick.atMs, tick);
  }
  const ticks = [...byTime.values()].sort((a, b) => a.atMs - b.atMs);
  const cutoff = Math.floor((ticks.at(-1)?.atMs ?? 0) / INTERVAL) * INTERVAL - COVERAGE_RETENTION_MS;
  return { ...next, ticks: ticks.filter(tick => tick.atMs >= cutoff) };
}

/** Observe the current bucket before it closes, without claiming it was judged.
 * Completed gaps carry missed-opportunity; the still-open bucket carries pending.
 * A delayed routine needs no successful future fire to make these slots visible. */
export function observeSyncCheckDispatch(
  prior: SyncDeltaCoverage | undefined,
  nowMs: number,
): SyncDeltaCoverage {
  const currentSlot = Math.floor(nowMs / INTERVAL);
  const cutoff = currentSlot * INTERVAL - COVERAGE_RETENTION_MS;
  const ticks = (prior?.ticks ?? []).filter(tick => tick.atMs >= cutoff);
  const slots = new Set(ticks.map(tick => Math.floor(tick.atMs / INTERVAL)));
  const latest = (prior?.ticks ?? []).reduce((slot, tick) =>
    Number.isFinite(tick.atMs) && tick.atMs <= nowMs ? Math.max(slot, Math.floor(tick.atMs / INTERVAL)) : slot, -Infinity);
  const first = Math.max(Number.isFinite(latest) ? latest + 1 : currentSlot, Math.ceil(cutoff / INTERVAL));
  let changed = ticks.length !== (prior?.ticks.length ?? 0);
  const next = ticks.map(tick => {
    if (tick.status !== 'pending' || tick.evaluated || tick.atMs >= currentSlot * INTERVAL) return tick;
    changed = true;
    return { ...tick, status: 'missed-opportunity' as const,
      reason: 'scheduler observed this due routine without a completed check for the closed slot' };
  });
  for (let slot = first; slot <= currentSlot; slot += 1) {
    if (slots.has(slot)) continue;
    changed = true;
    next.push({ atMs: slot * INTERVAL, evaluated: false,
      status: slot === currentSlot ? 'pending' : 'missed-opportunity',
      reason: slot === currentSlot
        ? 'scheduler observed the due routine; its action outcome is not yet recorded'
        : 'scheduler observed this due routine without a completed check for the closed slot' });
  }
  return prior && !changed ? prior : { ...prior, ticks: next };
}

const stateKey = (name: string): StateKey | undefined => name === 'sync-batch-delta-check'
  ? 'sync_delta' : name === 'sync-batch-lint-guards' ? 'sync_lint_guards' : undefined;

async function updateState(
  sql: Sql,
  scope: RoutineScope,
  key: StateKey,
  update: (current: CheckState | undefined) => CheckState | undefined,
): Promise<void> {
  await boundedOrgTxn(async tx => {
    const [row] = await tx<{ id: string; state: CheckState | null }[]>`
      SELECT id, metadata->${key} AS state FROM harness_shared.routines
       WHERE workspace_id = ${scope.workspaceId}
         AND install_slug IS NOT DISTINCT FROM ${scope.installSlug}
         AND name = ${scope.name}
       FOR UPDATE`;
    if (!row) return;
    const current = row.state ?? undefined;
    const next = update(current);
    if (!next || next === current) return;
    await tx`UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
         || jsonb_build_object(${key}::text, ${JSON.stringify(next)}::text::jsonb)
       WHERE id = ${row.id} AND workspace_id = ${scope.workspaceId}`;
  }, { client: sql, acquirePool: 'org-admin', acquireTimeoutMs: 1_000, acquireRetries: 0,
    connectionSetupRetries: 0, statementTimeoutMs: 1_000, lockTimeoutMs: 300,
    signal: AbortSignal.timeout(1_500), phase: 'sync-check-coverage' });
}

/** Completion and cursor writes retain dispatch observations made since their read. */
export async function writeSyncCheckState<T extends object>(
  sql: Sql,
  scope: RoutineScope,
  key: StateKey,
  next: T & { coverage?: SyncDeltaCoverage },
): Promise<void> {
  await updateState(sql, scope, key, current => {
    const coverage = mergeSyncCheckCoverage(current?.coverage, next.coverage);
    return { ...next, ...(coverage ? { coverage } : {}) };
  });
}

/** Called before pool/credit holds and workflow dedup, not from the action body.
 * Failure is visible but cannot stop unrelated dispatch. No state is fabricated
 * before a check has bootstrapped its own cursor. */
export async function recordSyncCheckDispatchCoverage(
  sql: Sql,
  due: readonly DispatchCoverageRoutine[],
  nowMs: number,
): Promise<void> {
  await Promise.all(due.filter(routine => stateKey(routine.name)
    && routine.targetRole === `system:${routine.name}`).map(async routine => {
    try {
      await updateState(sql, routine, stateKey(routine.name)!, current => {
        if (typeof current?.sha !== 'string' || !current.sha) return current;
        const coverage = observeSyncCheckDispatch(current.coverage, nowMs);
        return coverage === current.coverage ? current : { ...current, coverage };
      });
    } catch (error) {
      console.warn(`[sync-check-coverage] dispatch observation failed for ${routine.id}: ${String(error)}`);
    }
  }));
}
