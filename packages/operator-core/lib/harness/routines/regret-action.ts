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
 * (payload may LOWER it, never raise it); realized replay spend is ledgered
 * via recordLearningSpend with signal origin 'replay' (D-002). Detection is
 * SQL+parse only — with the replay runner unwired (pre-`frontier:
 * replay-landed`) a tick spends $0 and ledgers nothing.
 *
 * Tune via payload_template: windowDays, minScore, maxSessions,
 * maxReplaysPerTick, replayBudgetUsd, maxFilePerTick (0 = mine-only),
 * minFileScore. Runs as ONE durable step and never throws; the tick is
 * idempotent (known-run skip + carry-forward upsert + watchdogKey dedup).
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import { regretGovernorGate, REGRET_LOOP_ID } from '../../replay/regret/governor';
import { regretOptionsFromPayload, runRegretTick, type RegretTickDeps } from '../../replay/regret/mine';
import { defaultRegretDeps } from '../../replay/regret/store';

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
  if (!(await getFlag(FLAGS.REGRET_MINING, `routine:${ctx.installSlug}`))) {
    console.log(
      '[regret-mine] flag papercusp-regret-mining is OFF (frontier arming gate, ' +
        'self-learning-frontier P-001) — skipping',
    );
    return;
  }
  const verdict = await (_governorGate ?? regretGovernorGate)(ctx.workspaceId);
  if (!verdict.allow) {
    console.log(
      `[regret-mine] learning-governor refused (${verdict.reason}) — skipping ` +
        '(D-004: an unattended frontier loop runs only registered + budgeted)',
    );
    return;
  }
  const opts = regretOptionsFromPayload(ctx.payloadTemplate);
  // The governor's per-cycle cap bounds replay spend; the payload may lower it.
  const governorCapUsd = verdict.remainingUsd ?? 0;
  opts.replayBudgetUsd = Math.min(opts.replayBudgetUsd ?? governorCapUsd, governorCapUsd);
  const deps = _deps ?? defaultRegretDeps(getOrgPg().sql);
  try {
    const result = await runRegretTick(ctx.workspaceId, deps, opts);
    console.log(
      `[regret-mine] ${result.scanned} terminal spawn(s) → ${result.candidates} bad-session candidate(s), ` +
        `${result.mined} mined (${result.skippedKnown} known), ${result.replayed} replayed ` +
        `($${result.replayCostUsd.toFixed(2)}), filed ${result.filed.length}` +
        `${result.filed.length ? ` (${result.filed.join(', ')})` : ''}` +
        (result.declined ? `, ${result.declined} declined` : ''),
    );
    if (result.replayCostUsd > 0) {
      // Ledger realized replay spend (gym/scout precedent: only positive spend lands).
      try {
        const { recordLearningSpend } = await import('../../learning-governor/store');
        await recordLearningSpend(getOrgPg().sql, {
          workspaceId: ctx.workspaceId,
          loopId: REGRET_LOOP_ID,
          costUsd: result.replayCostUsd,
          accumulate: true,
          note: `regret-mine tick: ${result.replayed} finding(s) replayed`,
        });
      } catch (e) {
        console.warn('[regret-mine] spend ledgering FAILED:', e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[regret-mine] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
