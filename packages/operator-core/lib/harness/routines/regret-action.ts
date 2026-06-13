/**
 * Regret-mining system action (self-learning-frontier-2026-06-12 P-021 /
 * FB-07) — `system:regret-mine`, the cadence that selects bad historical
 * sessions, locates their divergence turn, counterfactually prices candidate
 * rule changes (once FB-06's replay harness is wired), and files scored
 * what-would-have-helped reports origin=replay through the capture core.
 *
 * Thin glue over the injectable tick (`lib/replay/regret/mine.ts`; the
 * selection/divergence cores are pure). The gates, in order:
 *
 *   - the `papercusp-regret-mining` flag, default OFF — the frontier
 *     program's D-001 owner-ratified arming gate. OFF → log + return.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement
 *     'governor'): governor dark / unregistered / unbudgeted / exhausted ⇒
 *     refuse — `lib/replay/regret/governor.ts`. Arming at P-001 therefore
 *     takes BOTH the flag flip AND an owner-set per-cycle budget on loop
 *     `regret-mining` (the budget caps the tick's replay spend).
 *   - the routine itself is SEEDED INACTIVE
 *     (lib/replay/regret/seed-regret-routine.ts).
 *
 * The governor's per-cycle cap flows into the tick as replayBudgetUsd
 * (payload may LOWER it, never raise it). The replay leg rides FB-06's
 * runGovernedReplay (replay-adapter.ts), which preflights the SUBSTRATE's
 * own D-001 gates (flag papercusp-replay-harness + loop
 * frontier:replay-harness) and ledgers the spend itself (origin='replay',
 * runRef `regret:<runId>`) — so arming the replay leg at P-001 takes BOTH
 * loops budgeted + both flags on, and this action never double-ledgers.
 * Detection alone is SQL+parse only — $0.
 *
 * Tune via payload_template: windowDays, minScore, maxSessions,
 * maxReplaysPerTick, replayBudgetUsd, maxFilePerTick (0 = mine-only),
 * minFileScore. Runs as ONE durable step and never throws; the tick is
 * idempotent (known-run skip + carry-forward upsert + watchdogKey dedup).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import type { RegretTickDeps } from '../../replay/regret/mine';
import { runRegretMine } from '../../replay/regret/run-mine';

/**
 * The flag → governor → cap → tick orchestration this action runs is SHARED with
 * the `regret:mine` deterministic blueprint step via `runRegretMine`
 * (deterministic-blueprints-migration-2026-06-13 P-111 / D-004 — provably
 * behavior-neutral: one gated tick, two callers). This action keeps its own
 * injectable seams (the test pins them) and passes them into the shared core.
 * (D-009: regret's replay is a governed `llmCall`, not a fleet spawn — so this is
 * a behavior-neutral migration, not a re-route onto the fleet launch chokepoint.)
 */

/** The tick-deps seam — injectable for tests (mirrors setNegativeSpaceTickDeps). */
let _deps: RegretTickDeps | null = null;
/** Override the tick deps (tests). Pass null to restore the live PG-backed deps. */
export function setRegretTickDeps(deps: RegretTickDeps | null): void {
  _deps = deps;
}

/** The governor-gate seam — injectable for tests. Pass null to restore the live preflight. */
export type RegretGovernorGate = (workspaceId: string) => Promise<GovernorVerdict>;
let _governorGate: RegretGovernorGate | null = null;
export function setRegretGovernorGate(gate: RegretGovernorGate | null): void {
  _governorGate = gate;
}

registerSystemAction('regret-mine', async (ctx: SystemActionCtx) => {
  try {
    const outcome = await runRegretMine(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, payload: ctx.payloadTemplate },
      { governorGate: _governorGate ?? undefined, tickDeps: _deps ?? undefined },
    );
    if (!outcome.ran) {
      if (outcome.skipReason === 'flag-off') {
        console.log(
          '[regret-mine] flag papercusp-regret-mining is OFF (frontier arming gate, ' +
            'self-learning-frontier P-001) — skipping',
        );
      } else {
        console.log(
          `[regret-mine] learning-governor refused (${outcome.governorReason}) — skipping ` +
            '(D-004: an unattended frontier loop runs only registered + budgeted)',
        );
      }
      return;
    }
    const result = outcome.result!;
    console.log(
      `[regret-mine] ${result.scanned} terminal spawn(s) → ${result.candidates} bad-session candidate(s), ` +
        `${result.mined} mined (${result.skippedKnown} known), ${result.replayed} replayed ` +
        `($${result.replayCostUsd.toFixed(2)}), filed ${result.filed.length}` +
        `${result.filed.length ? ` (${result.filed.join(', ')})` : ''}` +
        (result.declined ? `, ${result.declined} declined` : ''),
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[regret-mine] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
