/**
 * Negative-space miner system action (self-learning-frontier-2026-06-12
 * P-010 / FB-04) — `system:negative-space-mine`, the cadence that turns
 * zero-hit docs/plans/memory searches into a demand map of MISSING knowledge
 * and files the capped candidate set as kind=change improvements through the
 * shared capture core.
 *
 * Thin glue over the injectable tick (`lib/negative-space/scan.ts`; the
 * aggregation/fire-bar core is pure in miner-core.ts). SQL-only — no LLM
 * calls, no spend, so there is no budget refusal here (contrast
 * iq-battery-gen); the gates are:
 *
 *   - the `papercusp-negative-space-miner` flag, default OFF — the frontier
 *     program's D-001 owner-ratified arming gate (frontier loops ship built,
 *     tested, DARK until the plan's P-001 closes). OFF → log + return.
 *   - the routine itself is SEEDED INACTIVE
 *     (lib/negative-space/seed-negative-space-routine.ts).
 *
 * Fire bars + window tune from payload_template (minMisses, minAgents,
 * maxPerTick, windowDays — demandOptionsFromPayload); `maxPerTick: 0` is the
 * mine-only mode (map + panel update, no filing). Runs as ONE durable step
 * and never throws; the tick is idempotent (full-window recompute + filed-id
 * carry-forward + capture-core watchdogKey dedup), so a replay is a clean
 * no-op-ish re-mine.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { demandOptionsFromPayload } from '../../negative-space/miner-core';
import {
  defaultNegativeSpaceDeps,
  runNegativeSpaceTick,
  type NegativeSpaceTickDeps,
} from '../../negative-space/scan';

/** The tick-deps seam — injectable for tests (mirrors setBenchmarkBatteryRunner). */
let _deps: NegativeSpaceTickDeps | null = null;
/** Override the tick deps (tests). Pass null to restore the live PG-backed deps. */
export function setNegativeSpaceTickDeps(deps: NegativeSpaceTickDeps | null): void {
  _deps = deps;
}

registerSystemAction('negative-space-mine', async (ctx: SystemActionCtx) => {
  if (!(await getFlag(FLAGS.NEGATIVE_SPACE_MINER, `routine:${ctx.installSlug}`))) {
    console.log(
      '[negative-space-mine] flag papercusp-negative-space-miner is OFF (frontier arming gate, ' +
        'self-learning-frontier P-001) — skipping',
    );
    return;
  }
  const opts = demandOptionsFromPayload(ctx.payloadTemplate);
  const deps = _deps ?? defaultNegativeSpaceDeps(getOrgPg().sql);
  try {
    const result = await runNegativeSpaceTick(ctx.workspaceId, deps, opts);
    console.log(
      `[negative-space-mine] ${result.scanned} zero-hit search(es) → ${result.demandEntries} demand entr(ies)` +
        `, filed ${result.filed.length}${result.filed.length ? ` (${result.filed.join(', ')})` : ''}` +
        (result.declined ? `, ${result.declined} declined` : ''),
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[negative-space-mine] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
