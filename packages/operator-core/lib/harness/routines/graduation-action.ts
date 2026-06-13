/**
 * Graduation tracker system action (self-learning-frontier-2026-06-12
 * P-046 / FB-19) — `system:graduation-scan`, the cadence that turns the
 * existing outcome rails (resolve evidence, decay verification, dispatch
 * ledger, gym/EKG regressions) into per-class clean-pass counters and files a
 * "class X is graduation-eligible" OWNER REPORT when a class crosses the
 * threshold. It NEVER widens autoKinds itself — the widening act stays a
 * reviewed policy.ts config edit riding the release gate (P-046, D-008).
 *
 * MIGRATED (deterministic-blueprints-migration-2026-06-13 bucket A): the gates +
 * tick now live in the shared `runGraduationScan` orchestration
 * (lib/graduation/scan-loop.ts), which the `graduation:scan` deterministic
 * blueprint step ALSO calls — provably behavior-neutral (D-004):
 *
 *   - the `papercusp-graduation-tracker` flag, default OFF — the frontier D-001
 *     arming gate.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement 'governor').
 *
 * Thresholds tune from payload_template (threshold, recurrenceWindowDays,
 * lookbackDays, maxReportsPerTick, neverGraduateClassPatterns,
 * graduationOptionsFromPayload); `mineOnly: true` is the supervised dry mode.
 * This action is retained, registered, and lint-guarded (the orphaned-action
 * retirement is a separate pass); the seed routine now fires the `graduation`
 * blueprint via `system:blueprint-run`. Runs as ONE durable step and never
 * throws (the try/catch below); the tick is idempotent (the OWNER-REPORT filing
 * dedups on a watchdogKey — never an auto-edit).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import { runGraduationScan, type GraduationScanDeps } from '../../graduation/scan-loop';
import type { GraduationTickDeps } from '../../graduation/scan';

/** The tick-deps seam — injectable for tests (mirrors setNegativeSpaceTickDeps). */
let _deps: GraduationTickDeps | null = null;
/** Override the tick deps (tests). Pass null to restore the live PG-backed deps. */
export function setGraduationTickDeps(deps: GraduationTickDeps | null): void {
  _deps = deps;
}

/** The governor-gate seam — injectable for tests. Pass null to restore the live preflight. */
export type GraduationGovernorGate = (workspaceId: string) => Promise<GovernorVerdict>;
let _governorGate: GraduationGovernorGate | null = null;
export function setGraduationGovernorGate(gate: GraduationGovernorGate | null): void {
  _governorGate = gate;
}

registerSystemAction('graduation-scan', async (ctx: SystemActionCtx) => {
  const deps: GraduationScanDeps = {};
  if (_governorGate) deps.governorGate = _governorGate;
  if (_deps) deps.tickDeps = _deps;
  try {
    const outcome = await runGraduationScan(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payload: ctx.payloadTemplate },
      deps,
    );
    if (outcome.skipReason === 'flag-off') {
      console.log(
        '[graduation-scan] flag papercusp-graduation-tracker is OFF (frontier arming gate, ' +
          'self-learning-frontier P-001) — skipping',
      );
      return;
    }
    if (outcome.skipReason === 'governor-refused') {
      console.log(
        `[graduation-scan] learning-governor refused (${outcome.governorReason}) — skipping ` +
          '(D-004: an unattended frontier loop runs only registered + budgeted)',
      );
      return;
    }
    if (outcome.result) {
      const result = outcome.result;
      console.log(
        `[graduation-scan] ${result.classes} class(es) counted, ${result.eligible.length} eligible` +
          `${result.eligible.length ? ` (${result.eligible.join(', ')})` : ''}` +
          `, filed ${result.filed.length}${result.filed.length ? ` (${result.filed.join(', ')})` : ''}` +
          (result.declined ? `, ${result.declined} deduped` : '') +
          ` — rails: gym ${result.legs.gym ? 'live' : 'inactive'}, ekg ${result.legs.ekg ? 'live' : 'inactive'}`,
      );
    }
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[graduation-scan] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
