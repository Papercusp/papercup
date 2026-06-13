/**
 * Negative-space miner system action (self-learning-frontier-2026-06-12
 * P-010 / FB-04) — `system:negative-space-mine`, the cadence that turns
 * zero-hit docs/plans/memory searches into a demand map of MISSING knowledge
 * and files the capped candidate set as kind=change improvements through the
 * shared capture core.
 *
 * Thin glue over the injectable tick (`lib/negative-space/scan.ts`; the
 * aggregation/fire-bar core is pure in miner-core.ts). SQL-only — no LLM
 * calls, zero spend (so no spend events are ledgered); the gates are:
 *
 *   - the `papercusp-negative-space-miner` flag, default OFF — the frontier
 *     program's D-001 owner-ratified arming gate (frontier loops ship built,
 *     tested, DARK until the plan's P-001 closes). OFF → log + return.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement
 *     'governor'): governor dark / unregistered / unbudgeted / exhausted ⇒
 *     refuse — `lib/negative-space/governor.ts`. Arming at P-001 therefore
 *     takes BOTH the flag flip AND an owner-set budget on loop
 *     `negative-space-miner` (per-cycle; 0 is an honest cap for a zero-spend
 *     loop).
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
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import type { NegativeSpaceTickDeps } from '../../negative-space/scan';
import { runNegativeSpaceMine } from '../../negative-space/mine';

/**
 * The flag → governor → tick orchestration this action runs is SHARED with the
 * `negative-space:scan` deterministic blueprint step via `runNegativeSpaceMine`
 * (deterministic-blueprints-migration-2026-06-13 P-010 / D-004 — provably
 * behavior-neutral: one gated tick, two callers). This action keeps its own
 * injectable seams (the test pins them) and passes them into the shared core.
 */

/** The tick-deps seam — injectable for tests (mirrors setBenchmarkBatteryRunner). */
let _deps: NegativeSpaceTickDeps | null = null;
/** Override the tick deps (tests). Pass null to restore the live PG-backed deps. */
export function setNegativeSpaceTickDeps(deps: NegativeSpaceTickDeps | null): void {
  _deps = deps;
}

/** The governor-gate seam — injectable for tests. Pass null to restore the live preflight. */
export type NegativeSpaceGovernorGate = (workspaceId: string) => Promise<GovernorVerdict>;
let _governorGate: NegativeSpaceGovernorGate | null = null;
export function setNegativeSpaceGovernorGate(gate: NegativeSpaceGovernorGate | null): void {
  _governorGate = gate;
}

registerSystemAction('negative-space-mine', async (ctx: SystemActionCtx) => {
  try {
    const outcome = await runNegativeSpaceMine(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payload: ctx.payloadTemplate },
      { governorGate: _governorGate ?? undefined, tickDeps: _deps ?? undefined },
    );
    if (!outcome.ran) {
      if (outcome.skipReason === 'flag-off') {
        console.log(
          '[negative-space-mine] flag papercusp-negative-space-miner is OFF (frontier arming gate, ' +
            'self-learning-frontier P-001) — skipping',
        );
      } else {
        console.log(
          `[negative-space-mine] learning-governor refused (${outcome.governorReason}) — skipping ` +
            '(D-004: an unattended frontier loop runs only registered + budgeted)',
        );
      }
      return;
    }
    const result = outcome.result!;
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
