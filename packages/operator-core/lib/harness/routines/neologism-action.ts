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
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import { neologismGovernorGate } from '../../neologism/governor';
import { neologismOptionsFromPayload } from '../../neologism/miner-core';
import {
  defaultNeologismDeps,
  runNeologismTick,
  type NeologismTickDeps,
} from '../../neologism/scan';

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
  if (!(await getFlag(FLAGS.NEOLOGISM_MINER, `routine:${ctx.installSlug}`))) {
    console.log(
      '[neologism-mine] flag papercusp-neologism-miner is OFF (frontier arming gate, ' +
        'self-learning-frontier P-001) — skipping',
    );
    return;
  }
  const verdict = await (_governorGate ?? neologismGovernorGate)(ctx.workspaceId);
  if (!verdict.allow) {
    console.log(
      `[neologism-mine] learning-governor refused (${verdict.reason}) — skipping ` +
        '(D-004: an unattended frontier loop runs only registered + budgeted)',
    );
    return;
  }
  const opts = neologismOptionsFromPayload(ctx.payloadTemplate);
  const deps = _deps ?? defaultNeologismDeps(getOrgPg().sql);
  try {
    const result = await runNeologismTick(ctx.workspaceId, deps, opts);
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
