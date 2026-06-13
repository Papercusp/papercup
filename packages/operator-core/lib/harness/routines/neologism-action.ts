/**
 * Neologism miner system action (self-learning-frontier-2026-06-12
 * P-011 / FB-05) — `system:neologism-mine`, the cadence that mines coord
 * traffic + the insights corpus for emergent recurring vocabulary with no
 * corresponding primitive (tool/table/verb/routine/flag) and routes the
 * capped candidate set into Scout's improvement rail as abstraction
 * proposals through the shared capture core.
 *
 * Thin glue over the injectable tick (`lib/neologism/scan.ts`; the
 * extraction/growth/fire-bar core is pure in miner-core.ts). SQL/fs-only —
 * no LLM calls, zero spend (so no spend events are ledgered); the gates are:
 *
 *   - the `papercusp-neologism-miner` flag, default OFF — the frontier
 *     program's D-001 owner-ratified arming gate (frontier loops ship
 *     built, tested, DARK until the plan's P-001 closes). OFF → log + return.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement
 *     'governor'): governor dark / unregistered / unbudgeted / exhausted ⇒
 *     refuse — `lib/neologism/governor.ts`. Arming at P-001 therefore takes
 *     BOTH the flag flip AND an owner-set budget on loop `neologism-miner`
 *     (per-cycle; 0 is an honest cap for a zero-spend loop).
 *   - the routine itself is SEEDED INACTIVE
 *     (lib/neologism/seed-neologism-routine.ts).
 *
 * Fire bars + windows tune from payload_template (windowDays, recentDays,
 * minRecentMentions, minSpeakers, growthFactor, maxPerTick —
 * neologismOptionsFromPayload); `maxPerTick: 0` is the mine-only mode.
 * Runs as ONE durable step and never throws; the tick is idempotent
 * (full-window recompute + capture-core watchdogKey dedup), so a replay is
 * a clean no-op-ish re-mine.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import type { NeologismTickDeps } from '../../neologism/scan';
import { runNeologismMine } from '../../neologism/mine';

/**
 * The flag → governor → tick orchestration this action runs is SHARED with the
 * `neologism:mine` deterministic blueprint step via `runNeologismMine`
 * (deterministic-blueprints-migration-2026-06-13 P-011 / P-120 / D-004 — provably
 * behavior-neutral: one gated tick, two callers). This action keeps its own
 * injectable seams (the test pins them) and passes them into the shared core.
 */

/** The tick-deps seam — injectable for tests (mirrors setNegativeSpaceTickDeps). */
let _deps: NeologismTickDeps | null = null;
/** Override the tick deps (tests). Pass null to restore the live PG/fs-backed deps. */
export function setNeologismTickDeps(deps: NeologismTickDeps | null): void {
  _deps = deps;
}

/** The governor-gate seam — injectable for tests. Pass null to restore the live preflight. */
export type NeologismGovernorGate = (workspaceId: string) => Promise<GovernorVerdict>;
let _governorGate: NeologismGovernorGate | null = null;
export function setNeologismGovernorGate(gate: NeologismGovernorGate | null): void {
  _governorGate = gate;
}

registerSystemAction('neologism-mine', async (ctx: SystemActionCtx) => {
  try {
    const outcome = await runNeologismMine(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payload: ctx.payloadTemplate },
      { governorGate: _governorGate ?? undefined, tickDeps: _deps ?? undefined },
    );
    if (!outcome.ran) {
      if (outcome.skipReason === 'flag-off') {
        console.log(
          '[neologism-mine] flag papercusp-neologism-miner is OFF (frontier arming gate, ' +
            'self-learning-frontier P-001) — skipping',
        );
      } else {
        console.log(
          `[neologism-mine] learning-governor refused (${outcome.governorReason}) — skipping ` +
            '(D-004: an unattended frontier loop runs only registered + budgeted)',
        );
      }
      return;
    }
    const result = outcome.result!;
    console.log(
      `[neologism-mine] ${result.scannedRows} coord row(s) + ${result.insightDocs} insight doc(s) → ` +
        `${result.terms} term(s), ${result.overBars} over bars` +
        `, filed ${result.filed.length}${result.filed.length ? ` (${result.filed.join(', ')})` : ''}` +
        (result.declined ? `, ${result.declined} declined` : ''),
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[neologism-mine] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
