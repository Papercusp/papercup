/**
 * plan-implement.ts — the pure decision for the auto-implement loop
 * (papercusp-self-improvement-loop-2026-06-04, Phase 3 / D-004 / D-006 / D-007).
 *
 * Given the captured backlog + the runtime gates (the flag, a dedicated runner
 * harness, the per-run cap), decide what — if anything — the implement routine
 * should dispatch. Pure + IO-free so every safety branch is unit-testable:
 *
 *   - `disabled`  — the master flag is OFF (the DEFAULT). Nothing is built; the
 *                   loop only captures + triages until an owner flips it on.
 *   - `noop`      — flag ON but nothing is auto-eligible (no kind=bug in the safe lane).
 *   - `no-runner` — flag ON + work to do, but NO dedicated runner harness is
 *                   configured (D-006). We REFUSE to auto-implement in-process —
 *                   the loop must never modify the operator that runs it. Set
 *                   PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS to a separate harness/worktree.
 *   - `dispatch`  — flag ON + a runner + auto-eligible items: dispatch up to the
 *                   per-run cap (D-007 anti-runaway). Each still lands via the
 *                   release gate (D-008) and the release-manager (D-005).
 */

import { buildDigest, type ScoredItem } from './digest';
import type { ImprovementCandidate, RiskTierPolicy } from './policy';

export interface ImplementRunInput {
  items: ImprovementCandidate[];
  /** The master switch (FLAGS.IMPROVEMENT_AUTO_IMPLEMENT). Default OFF. */
  flagEnabled: boolean;
  /** The dedicated runner harness slug (D-006) — null/empty when unconfigured. */
  runnerHarness: string | null;
  /** Max items to dispatch per run (D-007 anti-runaway). */
  maxPerRun: number;
  policy?: RiskTierPolicy;
  nowMs?: number;
}

export type ImplementAction = 'disabled' | 'noop' | 'no-runner' | 'dispatch';

export interface ImplementRunPlan {
  action: ImplementAction;
  /** What would be / is dispatched (auto lane, capped). */
  candidates: ScoredItem[];
  /** Total auto-eligible open items (pre-cap), for visibility. */
  autoEligibleCount: number;
  message: string;
}

export function planImplementRun(input: ImplementRunInput): ImplementRunPlan {
  const cap = Math.max(0, Math.floor(input.maxPerRun));
  const digest = buildDigest(input.items, { policy: input.policy, nowMs: input.nowMs });
  const auto = digest.autoEligible;

  if (!input.flagEnabled) {
    return {
      action: 'disabled',
      candidates: [],
      autoEligibleCount: auto.length,
      message:
        `auto-implement is OFF (default) — ${auto.length} auto-eligible bug(s) waiting. ` +
        `Flip the papercusp-improvement-auto-implement flag (and configure a runner harness) to enable.`,
    };
  }
  if (auto.length === 0) {
    return { action: 'noop', candidates: [], autoEligibleCount: 0, message: 'nothing auto-eligible to implement' };
  }
  if (!input.runnerHarness) {
    return {
      action: 'no-runner',
      candidates: auto.slice(0, cap),
      autoEligibleCount: auto.length,
      message:
        `flag ON and ${auto.length} bug(s) auto-eligible, but NO dedicated runner harness is configured ` +
        `(set PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS — D-006). Refusing to auto-implement in-process.`,
    };
  }
  const candidates = auto.slice(0, cap);
  return {
    action: candidates.length > 0 ? 'dispatch' : 'noop',
    candidates,
    autoEligibleCount: auto.length,
    message:
      candidates.length > 0
        ? `dispatching ${candidates.length}/${auto.length} auto-eligible bug(s) to runner '${input.runnerHarness}' (lands via the release gate)`
        : `cap is 0 — nothing dispatched (${auto.length} waiting)`,
  };
}
