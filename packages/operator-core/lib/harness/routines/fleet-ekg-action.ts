/**
 * Fleet EKG system action (self-learning-frontier-2026-06-12 P-030 / FB-10)
 * — `system:fleet-ekg-scan`, the cadence that embeds recent agent sessions
 * into behavioral vectors, detects fleet-wide distribution shifts against the
 * trailing baseline, attributes them to the behavior-change ledger (D-003),
 * and alarms the attention rail on unattributable MAJOR shifts.
 *
 * Thin glue over the injectable tick (`lib/fleet-ekg/scan.ts`; embedding and
 * drift math are pure in features.ts/drift.ts). SQL-only — no LLM calls,
 * zero spend (so no spend events are ledgered); the gates are:
 *
 *   - the `papercusp-fleet-ekg` flag, default OFF — the frontier program's
 *     D-001 owner-ratified arming gate (frontier loops ship built, tested,
 *     DARK until the plan's P-001 closes). OFF → log + return.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement
 *     'governor'): governor dark / unregistered / unbudgeted / exhausted ⇒
 *     refuse — `lib/fleet-ekg/governor.ts`. Arming at P-001 therefore takes
 *     BOTH the flag flip AND an owner-set budget on loop `fleet-ekg`
 *     (per-cycle; 0 is an honest cap for a zero-spend loop).
 *   - the routine itself is SEEDED INACTIVE
 *     (lib/fleet-ekg/seed-fleet-ekg-routine.ts).
 *
 * Detection thresholds + windows tune from payload_template (windowHours,
 * baselineDays, psiMajor, … — ekgOptionsFromPayload). Runs as ONE durable
 * step and never throws; the tick is idempotent (vector upsert + per-(feature,
 * window-day) shift upsert + notified_at alarm dedup), so a replay is a clean
 * re-scan.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import type { FleetEkgTickDeps } from '../../fleet-ekg/scan';
import { runFleetEkgScan } from '../../fleet-ekg/run';

/**
 * The flag → governor → tick orchestration this action runs is SHARED with the
 * `fleet-ekg:scan` deterministic blueprint step via `runFleetEkgScan`
 * (deterministic-blueprints-migration-2026-06-13 P-030 / P-120 / D-004 — provably
 * behavior-neutral: one gated tick, two callers). This action keeps its own
 * injectable seams (the test pins them) and passes them into the shared core.
 */

/** The tick-deps seam — injectable for tests (mirrors setNegativeSpaceTickDeps). */
let _deps: FleetEkgTickDeps | null = null;
/** Override the tick deps (tests). Pass null to restore the live PG-backed deps. */
export function setFleetEkgTickDeps(deps: FleetEkgTickDeps | null): void {
  _deps = deps;
}

/** The governor-gate seam — injectable for tests. Pass null to restore the live preflight. */
export type FleetEkgGovernorGate = (workspaceId: string) => Promise<GovernorVerdict>;
let _governorGate: FleetEkgGovernorGate | null = null;
export function setFleetEkgGovernorGate(gate: FleetEkgGovernorGate | null): void {
  _governorGate = gate;
}

registerSystemAction('fleet-ekg-scan', async (ctx: SystemActionCtx) => {
  try {
    const outcome = await runFleetEkgScan(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payload: ctx.payloadTemplate },
      { governorGate: _governorGate ?? undefined, tickDeps: _deps ?? undefined },
    );
    if (!outcome.ran) {
      if (outcome.skipReason === 'flag-off') {
        console.log(
          '[fleet-ekg-scan] flag papercusp-fleet-ekg is OFF (frontier arming gate, ' +
            'self-learning-frontier P-001) — skipping',
        );
      } else {
        console.log(
          `[fleet-ekg-scan] learning-governor refused (${outcome.governorReason}) — skipping ` +
            '(D-004: an unattended frontier loop runs only registered + budgeted)',
        );
      }
      return;
    }
    const result = outcome.result!;
    console.log(
      `[fleet-ekg-scan] embedded ${result.embedded}, status ${result.status}: ` +
        `${result.findings} shift(s) (${result.unattributable} unattributable, ${result.alarmed} alarmed)`,
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[fleet-ekg-scan] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
