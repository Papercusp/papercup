/**
 * Deferral-interest refit system action (self-learning-frontier-2026-06-12
 * P-042 / FB-14) — `system:deferral-interest-refit`, the cadence that
 * backfills realized deferral costs from history and re-fits the learned
 * pricing model (lib/deferral-interest/) the one queue ranker (P-040 / FB-12)
 * reads as its deferral-interest feature.
 *
 * MIGRATED (deterministic-blueprints-migration-2026-06-13 bucket A): the gates +
 * tick now live in the shared `runDeferralInterestRefitGated` orchestration
 * (lib/deferral-interest/refit-loop.ts), which the `deferral-interest:refit`
 * deterministic blueprint step ALSO calls — provably behavior-neutral (D-004):
 *
 *   - the `papercusp-deferral-interest` flag, default OFF — the frontier D-001
 *     owner-ratified arming gate (frontier loops ship built, tested, DARK).
 *   - the learning-governor preflight (D-004 / FB-01, enforcement 'governor').
 *
 * This action is retained, registered, and lint-guarded (the orphaned-action
 * retirement is a separate pass); the seed routine now fires the
 * `deferral-interest` blueprint via `system:blueprint-run`. Runs as ONE durable
 * step and never throws (the try/catch below); the tick is idempotent.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import type { GovernorVerdict } from '../../learning-governor/core';
import {
  runDeferralInterestRefitGated,
  type DeferralRefitGateDeps,
} from '../../deferral-interest/refit-loop';
import type { DeferralRefitDeps } from '../../deferral-interest/refit';

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
  const deps: DeferralRefitGateDeps = {};
  if (_governorGate) deps.governorGate = _governorGate;
  if (_deps) deps.tickDeps = _deps;
  try {
    const outcome = await runDeferralInterestRefitGated(
      { workspaceId: ctx.workspaceId, installSlug: ctx.installSlug },
      deps,
    );
    if (outcome.skipReason === 'flag-off') {
      console.log(
        '[deferral-interest-refit] flag papercusp-deferral-interest is OFF (frontier arming gate, ' +
          'self-learning-frontier P-001) — skipping',
      );
      return;
    }
    if (outcome.skipReason === 'governor-refused') {
      console.log(
        `[deferral-interest-refit] learning-governor refused (${outcome.governorReason}) — skipping ` +
          '(D-004: an unattended frontier loop runs only registered + budgeted)',
      );
      return;
    }
  } catch (e) {
    // Never throw from a durable step (replay = a second refit for nothing).
    console.warn('[deferral-interest-refit] tick FAILED:', e instanceof Error ? e.message : e);
  }
});
