/**
 * Deferral-interest refit system action (self-learning-frontier-2026-06-12
 * P-042 / FB-14) — `system:deferral-interest-refit`, the cadence that
 * backfills realized deferral costs from history and re-fits the learned
 * pricing model (lib/deferral-interest/) the one queue ranker (P-040 / FB-12)
 * reads as its deferral-interest feature.
 *
 * Thin glue over the injectable tick (`lib/deferral-interest/refit.ts`; the
 * backfill + fit cores are pure). SQL-only — no LLM calls, zero spend (so no
 * spend events are ledgered); the gates are:
 *
 *   - the `papercusp-deferral-interest` flag, default OFF — the frontier
 *     program's D-001 owner-ratified arming gate (frontier loops ship built,
 *     tested, DARK until the plan's P-001 closes). OFF → log + return.
 *   - the learning-governor preflight (D-004 / FB-01, enforcement
 *     'governor'): governor dark / unregistered / unbudgeted / exhausted ⇒
 *     refuse — `lib/deferral-interest/governor.ts`. Arming at P-001 therefore
 *     takes BOTH the flag flip AND an owner-set budget on loop
 *     `deferral-interest-refit` (per-cycle; 0 is honest for a zero-spend loop).
 *   - the routine itself is SEEDED INACTIVE
 *     (lib/deferral-interest/seed-deferral-interest-routine.ts).
 *
 * Runs as ONE durable step and never throws; the tick is idempotent in effect
 * (full-corpus recompute; a replay just appends another model version trained
 * on the same data).
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import { deferralInterestGovernorGate } from '../../deferral-interest/governor';
import {
  defaultDeferralRefitDeps,
  runDeferralInterestRefit,
  type DeferralRefitDeps,
} from '../../deferral-interest/refit';

/** The tick-deps seam — injectable for tests (mirrors setNegativeSpaceTickDeps). */
let _deps: DeferralRefitDeps | null = null;
/** Override the tick deps (tests). Pass null to restore the live PG-backed deps. */
export function setDeferralRefitDeps(deps: DeferralRefitDeps | null): void {
  _deps = deps;
}

/** The governor-gate seam — injectable for tests. Pass null to restore the live preflight. */
export type DeferralGovernorGate = (workspaceId: string) => Promise<GovernorVerdict>;
let _governorGate: DeferralGovernorGate | null = null;
export function setDeferralGovernorGate(gate: DeferralGovernorGate | null): void {
  _governorGate = gate;
}

registerSystemAction('deferral-interest-refit', async (ctx: SystemActionCtx) => {
  if (!(await getFlag(FLAGS.DEFERRAL_INTEREST, `routine:${ctx.installSlug}`))) {
    console.log(
      '[deferral-interest-refit] flag papercusp-deferral-interest is OFF (frontier arming gate, ' +
        'self-learning-frontier P-001) — skipping',
    );
    return;
  }
  const verdict = await (_governorGate ?? deferralInterestGovernorGate)(ctx.workspaceId);
  if (!verdict.allow) {
    console.log(
      `[deferral-interest-refit] learning-governor refused (${verdict.reason}) — skipping ` +
        '(D-004: an unattended frontier loop runs only registered + budgeted)',
    );
    return;
  }
  const deps = _deps ?? defaultDeferralRefitDeps(getOrgPg().sql, ctx.workspaceId);
  try {
    await runDeferralInterestRefit(deps);
  } catch (e) {
    // Never throw from a durable step (replay = a second refit for nothing).
    console.warn('[deferral-interest-refit] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
