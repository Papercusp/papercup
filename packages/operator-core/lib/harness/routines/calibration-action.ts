/**
 * Calibration-markets system action (self-learning-frontier-2026-06-12
 * P-041 / FB-13) — `system:calibration-resolve`, the cadence that matures
 * open bets against their domain probes (lib/calibration/resolve-sweep.ts).
 *
 * SQL-only — no LLM calls, zero spend (so no spend events are ledgered); the
 * gates mirror system:negative-space-mine:
 *
 *   - the `papercusp-calibration-markets` flag, default OFF — the frontier
 *     D-001 arming gate (it also gates the capture seams, so a dark loop has
 *     nothing accumulating either). OFF → log + return.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement
 *     'governor') — lib/calibration/governor.ts. Arming at P-001 therefore
 *     takes the flag flip AND an owner-set budget on loop
 *     `calibration-markets` (per-cycle; 0 is honest for a zero-spend loop).
 *   - the routine itself is SEEDED INACTIVE
 *     (lib/calibration/seed-calibration-routine.ts).
 *
 * payload_template tunables: { maxPerTick } (sweep batch cap, default 200).
 * Runs as ONE durable step and never throws; the sweep is idempotent
 * (resolution only flips OPEN rows), so a replay is a clean no-op-ish pass.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import { calibrationGovernorGate } from '../../calibration/governor';
import {
  defaultOutcomeProbes,
  runCalibrationResolveTick,
  type CalibrationSweepDeps,
} from '../../calibration/resolve-sweep';

/** The sweep-deps seam — injectable for tests (mirrors setNegativeSpaceTickDeps). */
let _deps: CalibrationSweepDeps | null = null;
/** Override the sweep deps (tests). Pass null to restore the live PG-backed deps. */
export function setCalibrationSweepDeps(deps: CalibrationSweepDeps | null): void {
  _deps = deps;
}

/** The governor-gate seam — injectable for tests. Pass null to restore the live preflight. */
export type CalibrationGovernorGate = (workspaceId: string) => Promise<GovernorVerdict>;
let _governorGate: CalibrationGovernorGate | null = null;
export function setCalibrationGovernorGate(gate: CalibrationGovernorGate | null): void {
  _governorGate = gate;
}

function maxPerTickFromPayload(payload: unknown): number | undefined {
  if (payload && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>).maxPerTick;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return undefined;
}

registerSystemAction('calibration-resolve', async (ctx: SystemActionCtx) => {
  if (!(await getFlag(FLAGS.CALIBRATION_MARKETS, `routine:${ctx.installSlug}`))) {
    console.log(
      '[calibration-resolve] flag papercusp-calibration-markets is OFF (frontier arming gate, ' +
        'self-learning-frontier P-001) — skipping',
    );
    return;
  }
  const verdict = await (_governorGate ?? calibrationGovernorGate)(ctx.workspaceId);
  if (!verdict.allow) {
    console.log(
      `[calibration-resolve] learning-governor refused (${verdict.reason}) — skipping ` +
        '(D-004: an unattended frontier loop runs only registered + budgeted)',
    );
    return;
  }
  const deps =
    _deps ??
    (() => {
      const { sql } = getOrgPg();
      return { sql, probes: defaultOutcomeProbes(sql) } satisfies CalibrationSweepDeps;
    })();
  try {
    const result = await runCalibrationResolveTick(ctx.workspaceId, deps, {
      limit: maxPerTickFromPayload(ctx.payloadTemplate),
    });
    console.log(
      `[calibration-resolve] ${result.matured} matured bet(s) → ${result.resolved} resolved, ` +
        `${result.voided} voided, ${result.skipped} left open`,
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[calibration-resolve] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
