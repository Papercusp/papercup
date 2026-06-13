/**
 * Red Queen system action (self-learning-frontier-2026-06-12 P-031 / FB-20)
 * — `system:red-queen-drill`, the vaccination cadence: per tick, expire stale
 * drills and run ONE drill cycle for the least-recently drilled class —
 * plant a known synthetic friction in the SANDBOX workspace, detect it with a
 * real watchdog tick, route it through the real triage path (drill-opted-in),
 * heal it with the class's known remedy, and record MTTSH + the zero-leak
 * assertion on the drill row (lib/red-queen).
 *
 * Thin glue over the injectable cycle (`lib/red-queen/sandbox.ts`). SQL-only —
 * no LLM calls, zero spend (so no spend events are ledgered); the gates are:
 *
 *   - the `papercusp-red-queen` flag, default OFF — the frontier program's
 *     D-001 owner-ratified arming gate. OFF → log + return.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement
 *     'governor'): governor dark / unregistered / unbudgeted / exhausted ⇒
 *     refuse — `lib/red-queen/governor.ts`. Arming at P-001 therefore takes
 *     BOTH the flag flip AND an owner-set budget on loop `red-queen`
 *     (per-cycle; 0 is an honest cap for a zero-spend loop).
 *   - the routine itself is SEEDED INACTIVE
 *     (lib/red-queen/seed-red-queen-routine.ts).
 *
 * payload_template tunables: `classId` pins the rotation to one drill class
 * (default: least-recently drilled). Runs as ONE durable step and never
 * throws; a replay re-runs at most one cycle, and the one-open-drill-per-class
 * index makes that a clean skip.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import type { DrillCycleDeps } from '../../red-queen/sandbox';
import { runRedQueenDrill } from '../../red-queen/run';

/**
 * The flag → governor → drill-cycle orchestration this action runs is SHARED with
 * the `red-queen:drill` deterministic blueprint step via `runRedQueenDrill`
 * (deterministic-blueprints-migration-2026-06-13 P-122 / D-004 — provably
 * behavior-neutral: one gated cycle, two callers). This action keeps its own
 * injectable seams (the test pins them) and passes them into the shared core.
 */

/** The cycle-deps seam — injectable for tests (mirrors setFleetEkgTickDeps). */
let _deps: DrillCycleDeps | null = null;
/** Override the cycle deps (tests). Pass null to restore the live PG-backed deps. */
export function setRedQueenCycleDeps(deps: DrillCycleDeps | null): void {
  _deps = deps;
}

/** The governor-gate seam — injectable for tests. Pass null to restore the live preflight. */
export type RedQueenGovernorGate = (workspaceId: string) => Promise<GovernorVerdict>;
let _governorGate: RedQueenGovernorGate | null = null;
export function setRedQueenGovernorGate(gate: RedQueenGovernorGate | null): void {
  _governorGate = gate;
}

registerSystemAction('red-queen-drill', async (ctx: SystemActionCtx) => {
  try {
    const outcome = await runRedQueenDrill(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payload: ctx.payloadTemplate },
      { governorGate: _governorGate ?? undefined, cycleDeps: _deps ?? undefined },
    );
    if (!outcome.ran) {
      if (outcome.skipReason === 'flag-off') {
        console.log(
          '[red-queen-drill] flag papercusp-red-queen is OFF (frontier arming gate, ' +
            'self-learning-frontier P-001) — skipping',
        );
      } else {
        console.log(
          `[red-queen-drill] learning-governor refused (${outcome.governorReason}) — skipping ` +
            '(D-004: an unattended frontier loop runs only registered + budgeted)',
        );
      }
      return;
    }
    const result = outcome.result!;
    console.log(
      `[red-queen-drill] status ${result.status}: class ${result.drillClass ?? '(none)'} → ` +
        `${result.cycle?.status ?? 'n/a'}${result.cycle?.mttsh ? ` (MTTSH ${result.cycle.mttsh.totalMs}ms)` : ''}` +
        `${result.cycle?.leakCheck && !result.cycle.leakCheck.passed ? ' ⚠ LEAK CHECK FAILED' : ''}; ` +
        `expired ${result.expired}`,
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[red-queen-drill] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
