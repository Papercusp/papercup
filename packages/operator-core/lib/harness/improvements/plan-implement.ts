/**
 * plan-implement.ts — the pure decision for the auto-implement loop
 * (papercusp-self-improvement-loop-2026-06-04, Phase 3 / D-004 / D-006 / D-007;
 * close-the-self-improvement-loop-2026-06-05 D-001).
 *
 * Given the captured backlog + the runtime gates (the flag, a dedicated runner
 * harness, the per-run cap), decide what — if anything — the implement routine
 * should dispatch. Pure + IO-free so every safety branch is unit-testable:
 *
 *   - `disabled`  — the master flag is OFF (the DEFAULT). Nothing is built; the
 *                   loop only captures + triages until an owner flips it on.
 *   - `noop`      — flag ON but nothing is dispatchable (no kind=bug in the safe
 *                   lane, or everything eligible is in-flight / attempts-exhausted).
 *   - `no-runner` — flag ON + work to do, but NO dedicated runner harness is
 *                   configured (D-006). We REFUSE to auto-implement in-process —
 *                   the loop must never modify the operator that runs it. Set
 *                   PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS to a separate harness/worktree.
 *   - `dispatch`  — flag ON + a runner + dispatchable items: dispatch up to the
 *                   per-run cap (D-007 anti-runaway). Each still lands via the
 *                   release gate (D-008) and the release-manager (D-005).
 *
 * The CLOSE-LOOP guards (close-the-self-improvement-loop D-001) keep an armed
 * loop from re-dispatching the same bug every cadence tick:
 *   - **in-flight** — an item claimed recently (assignee + fresh assignedAt) is a
 *     dispatch already running; skip it. A stale claim (the runner died) becomes
 *     eligible again after `staleClaimMs`.
 *   - **attempts cap** — an item already dispatched `maxAttempts` times never
 *     auto-dispatches again (improvements:resolve routes it to a human on the
 *     exhausted could-not-fix, so it also leaves the auto lane in triage).
 *   - the resolved back-edge itself (`improvements:resolve` → state=resolved)
 *     removes a FIXED bug from the open set entirely.
 */

import { buildDigest, type ScoredItem } from './digest';
import type { ImprovementCandidate, RiskTierPolicy } from './policy';
import { DEFAULT_MAX_ATTEMPTS } from './resolve-core';

/** How long a claim marks an item in-flight before it is considered stale
 *  (the runner died / never resolved). 4 cadence ticks at the 30-min default. */
export const DEFAULT_STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

export interface ImplementRunInput {
  items: ImprovementCandidate[];
  /** The master switch (FLAGS.IMPROVEMENT_AUTO_IMPLEMENT). Default OFF. */
  flagEnabled: boolean;
  /** The dedicated runner harness slug (D-006) — null/empty when unconfigured. */
  runnerHarness: string | null;
  /** Max items to dispatch per run (D-007 anti-runaway). */
  maxPerRun: number;
  /** Max dispatch attempts per item before it is human-only (close-loop D-001). */
  maxAttempts?: number;
  /** Claim freshness window for the in-flight skip (close-loop D-001). */
  staleClaimMs?: number;
  policy?: RiskTierPolicy;
  nowMs?: number;
}

export type ImplementAction = 'disabled' | 'noop' | 'no-runner' | 'dispatch';

export interface ImplementRunPlan {
  action: ImplementAction;
  /** What would be / is dispatched (auto lane, dispatchable, capped). */
  candidates: ScoredItem[];
  /** Total auto-eligible open items (pre-cap, pre-skip), for visibility. */
  autoEligibleCount: number;
  /** Auto-eligible items skipped: claimed recently — a dispatch is in flight. */
  inFlightCount: number;
  /** Auto-eligible items skipped: dispatch attempts exhausted (human-only now). */
  attemptsExhaustedCount: number;
  message: string;
}

export function planImplementRun(input: ImplementRunInput): ImplementRunPlan {
  const cap = Math.max(0, Math.floor(input.maxPerRun));
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleClaimMs = input.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const nowMs = input.nowMs ?? Date.now();
  const digest = buildDigest(input.items, { policy: input.policy, nowMs });
  const auto = digest.autoEligible;

  // Close-loop dispatch guards (D-001): skip in-flight + attempts-exhausted.
  const inFlight = (s: ScoredItem): boolean => {
    if (!s.assignee) return false;
    if (!s.assignedAt) return true; // claimed, age unknown → assume in flight
    const age = nowMs - Date.parse(s.assignedAt);
    return Number.isFinite(age) ? age < staleClaimMs : true;
  };
  const exhausted = (s: ScoredItem): boolean => (s.attempts ?? 0) >= maxAttempts;
  const dispatchable = auto.filter((s) => !inFlight(s) && !exhausted(s));
  const inFlightCount = auto.filter(inFlight).length;
  const attemptsExhaustedCount = auto.filter((s) => !inFlight(s) && exhausted(s)).length;
  const skippedNote =
    inFlightCount || attemptsExhaustedCount
      ? ` (skipped: ${inFlightCount} in-flight, ${attemptsExhaustedCount} attempts-exhausted)`
      : '';

  if (!input.flagEnabled) {
    return {
      action: 'disabled',
      candidates: [],
      autoEligibleCount: auto.length,
      inFlightCount,
      attemptsExhaustedCount,
      message:
        `auto-implement is OFF (default) — ${auto.length} auto-eligible bug(s) waiting. ` +
        `Flip the papercusp-improvement-auto-implement flag (and configure a runner harness) to enable.`,
    };
  }
  if (dispatchable.length === 0) {
    return {
      action: 'noop',
      candidates: [],
      autoEligibleCount: auto.length,
      inFlightCount,
      attemptsExhaustedCount,
      message: `nothing dispatchable to implement${skippedNote}`,
    };
  }
  if (!input.runnerHarness) {
    return {
      action: 'no-runner',
      candidates: dispatchable.slice(0, cap),
      autoEligibleCount: auto.length,
      inFlightCount,
      attemptsExhaustedCount,
      message:
        `flag ON and ${dispatchable.length} bug(s) dispatchable, but NO dedicated runner harness is configured ` +
        `(set PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS — D-006). Refusing to auto-implement in-process.`,
    };
  }
  const candidates = dispatchable.slice(0, cap);
  return {
    action: candidates.length > 0 ? 'dispatch' : 'noop',
    candidates,
    autoEligibleCount: auto.length,
    inFlightCount,
    attemptsExhaustedCount,
    message:
      candidates.length > 0
        ? `dispatching ${candidates.length}/${dispatchable.length} dispatchable bug(s) to runner '${input.runnerHarness}'${skippedNote} (lands via the release gate)`
        : `cap is 0 — nothing dispatched (${dispatchable.length} waiting)${skippedNote}`,
  };
}
