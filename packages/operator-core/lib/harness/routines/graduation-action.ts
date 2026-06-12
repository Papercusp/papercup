/**
 * Graduation tracker system action (self-learning-frontier-2026-06-12
 * P-046 / FB-19) — `system:graduation-scan`, the cadence that turns the
 * existing outcome rails (resolve evidence, decay verification, dispatch
 * ledger, gym/EKG regressions) into per-class clean-pass counters and files a
 * "class X is graduation-eligible" OWNER REPORT when a class crosses the
 * threshold. It NEVER widens autoKinds itself — the widening act stays a
 * reviewed policy.ts config edit riding the release gate (P-046, D-008).
 *
 * Thin glue over the injectable tick (`lib/graduation/scan.ts`; the counting
 * core is pure in core.ts). SQL-only — no LLM calls, zero spend (no spend
 * events are ledgered); the gates are:
 *
 *   - the `papercusp-graduation-tracker` flag, default OFF — the frontier
 *     program's D-001 owner-ratified arming gate. OFF → log + return.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement
 *     'governor'): governor dark / unregistered / unbudgeted / exhausted ⇒
 *     refuse — `lib/graduation/governor.ts`. Arming at P-001 therefore takes
 *     BOTH the flag flip AND an owner-set budget on loop `graduation-tracker`
 *     (per-cycle; 0 is an honest cap for a zero-spend loop).
 *   - the routine itself is SEEDED INACTIVE
 *     (lib/graduation/seed-graduation-routine.ts).
 *
 * Thresholds tune from payload_template (threshold, recurrenceWindowDays,
 * lookbackDays, maxReportsPerTick, neverGraduateClassPatterns —
 * graduationOptionsFromPayload); `mineOnly: true` is the supervised dry mode
 * (standings only, no filing). Runs as ONE durable step and never throws; the
 * tick is idempotent (full recompute + watchdogKey dedup), so a replay is a
 * clean no-op.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import { graduationGovernorGate } from '../../graduation/governor';
import {
  defaultGraduationTickDeps,
  graduationOptionsFromPayload,
  runGraduationTick,
  type GraduationTickDeps,
} from '../../graduation/scan';

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
  if (!(await getFlag(FLAGS.GRADUATION_TRACKER, `routine:${ctx.installSlug}`))) {
    console.log(
      '[graduation-scan] flag papercusp-graduation-tracker is OFF (frontier arming gate, ' +
        'self-learning-frontier P-001) — skipping',
    );
    return;
  }
  const verdict = await (_governorGate ?? graduationGovernorGate)(ctx.workspaceId);
  if (!verdict.allow) {
    console.log(
      `[graduation-scan] learning-governor refused (${verdict.reason}) — skipping ` +
        '(D-004: an unattended frontier loop runs only registered + budgeted)',
    );
    return;
  }
  const opts = graduationOptionsFromPayload(ctx.payloadTemplate);
  const deps =
    _deps ?? defaultGraduationTickDeps((await import('@papercusp/db-org')).getOrgPg().sql, ctx.workspaceId);
  try {
    const result = await runGraduationTick(deps, opts);
    console.log(
      `[graduation-scan] ${result.classes} class(es) counted, ${result.eligible.length} eligible` +
        `${result.eligible.length ? ` (${result.eligible.join(', ')})` : ''}` +
        `, filed ${result.filed.length}${result.filed.length ? ` (${result.filed.join(', ')})` : ''}` +
        (result.declined ? `, ${result.declined} deduped` : '') +
        ` — rails: gym ${result.legs.gym ? 'live' : 'inactive'}, ekg ${result.legs.ekg ? 'live' : 'inactive'}`,
    );
  } catch (e) {
    // Never throw from a durable step (replay = a second tick for nothing).
    console.warn('[graduation-scan] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
