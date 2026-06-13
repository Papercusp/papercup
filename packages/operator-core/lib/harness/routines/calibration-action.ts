/**
 * Calibration-markets system action (self-learning-frontier-2026-06-12
 * P-041 / FB-13) — `system:calibration-resolve`, the cadence that matures
 * open bets against their domain probes (lib/calibration/resolve-sweep.ts).
 *
 * MIGRATED (deterministic-blueprints-migration-2026-06-13 bucket A): the gates +
 * sweep now live in the shared `runCalibrationResolve` orchestration
 * (lib/calibration/resolve-loop.ts), which the `calibration:resolve`
 * deterministic blueprint step ALSO calls — provably behavior-neutral (D-004):
 *
 *   - the `papercusp-calibration-markets` flag, default OFF — the frontier
 *     D-001 arming gate.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement 'governor').
 *
 * payload_template tunables: { maxPerTick } (sweep batch cap, default 200).
 * This action is retained, registered, and lint-guarded (the orphaned-action
 * retirement is a separate pass); the seed routine now fires the `calibration`
 * blueprint via `system:blueprint-run`. Runs as ONE durable step and never
 * throws (the try/catch below); the sweep is idempotent.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import { runCalibrationResolve, type CalibrationResolveDeps } from '../../calibration/resolve-loop';
import type { CalibrationSweepDeps } from '../../calibration/resolve-sweep';

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

registerSystemAction('calibration-resolve', async (ctx: SystemActionCtx) => {
  const deps: CalibrationResolveDeps = {};
  if (_governorGate) deps.governorGate = _governorGate;
  if (_deps) deps.sweepDeps = _deps;
  try {
    const outcome = await runCalibrationResolve(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payload: ctx.payloadTemplate },
      deps,
    );
    if (outcome.skipReason === 'flag-off') {
      console.log(
        '[calibration-resolve] flag papercusp-calibration-markets is OFF (frontier arming gate, ' +
          'self-learning-frontier P-001) — skipping',
      );
      return;
    }
    if (outcome.skipReason === 'governor-refused') {
      console.log(
        `[calibration-resolve] learning-governor refused (${outcome.governorReason}) — skipping ` +
          '(D-004: an unattended frontier loop runs only registered + budgeted)',
      );
      return;
    }
    if (outcome.result) {
      const r = outcome.result;
      console.log(
        `[calibration-resolve] ${r.matured} matured bet(s) → ${r.resolved} resolved, ` +
          `${r.voided} voided, ${r.skipped} left open`,
      );
    }
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[calibration-resolve] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
