/**
 * Gym autoloop TICK core (learning-system-audit-improvements-2026-06-09
 * P-031 + P-032) — the pure, injected-deps decision + orchestration behind the
 * `system:gym-cycle` routine action (harness/routines/gym-actions.ts).
 *
 * Today gym cycles only ran via the manual CLI (`gym-loop-run.ts`);
 * `harness_shared.gym_autoloop_config` had enabled/budget/status but NOTHING
 * fired cycles. This tick gives the gym a pulse:
 *
 *   per tick: list autoloops → keep enabled=true + status='idle' + an EXPLICIT
 *   budget with remaining > the floor (~$0.50) → order by least-recently-run →
 *   take the FIRST whose autoloop fire-gate (error backoff / circuit, D-009)
 *   allows → run ONE bounded gym cycle for that harness via the injected
 *   `runCycle` (live wiring: runOneAutoloopCycle, in-process), with the
 *   triage-routed gym ideas (P-032) as proposer candidate directions →
 *   settle status + ACCUMULATE spend on the autoloop row.
 *
 * HARD COST GUARDS (all enforced here or inside the cycle machinery):
 *   - disabled / non-idle / no-explicit-budget / remaining ≤ floor ⇒ NOT eligible.
 *     A null budget is deliberately INELIGIBLE for the unattended path — continuous
 *     operation requires an explicit cap (set one via the gym UI's autoloop config).
 *   - ONE harness per tick (round-robin by least-recently-run lastCycleAt).
 *   - the cycle's own budget cap = the row's REMAINING budget (runOptimizationLoop
 *     hard-stops there), plus the in-loop rate-pause + arithmetic circuit breaker.
 *   - autoPromote stays FALSE — proposals remain human-decided (D-020).
 *
 * Status transitions: idle → running → idle (success), → 'paused' when the
 * loop's circuit breaker tripped, → 'exhausted' when the remaining budget fell
 * to ≤ the floor, → back to idle EVEN ON ERROR (the fire-gate's error backoff
 * is the retry brake, not a stuck 'running' status). Resuming a paused/
 * exhausted autoloop is a human act (gym UI), matching the human-gated design.
 *
 * Everything is injected (GymTickDeps), so selection, round-robin, budget
 * floors, routed-ideas assembly, and the status transitions are unit-tested
 * with zero PG / zero LLM / no docker (autoloop-tick.test.ts).
 */
import type { GymAutoloopConfig, SetAutoloopInput } from './control-plane';

/** Below this remaining budget an autoloop is not worth (or safe) firing. */
export const GYM_AUTOLOOP_BUDGET_FLOOR_USD = 0.5;

// ---------------------------------------------------------------------------
// P-032: triage-routed gym ideas → proposer candidate directions
// ---------------------------------------------------------------------------

/** The slice of an improvement candidate the gym cares about (structural — matches ImprovementCandidate). */
export interface RoutedIdeaSource {
  id: string;
  title: string;
  body?: string;
  ideaLifecycle?: { triageDecision?: string };
}

export interface RoutedGymIdea {
  id: string;
  title: string;
  body?: string;
}

/** Keep only items the triage pass routed to the gym (payload.ideaLifecycle.triageDecision='gym'). */
export function selectRoutedGymIdeas(items: readonly RoutedIdeaSource[]): RoutedGymIdea[] {
  return items
    .filter((it) => it.ideaLifecycle?.triageDecision === 'gym')
    .map((it) => ({ id: it.id, title: it.title, ...(it.body ? { body: it.body } : {}) }));
}

export interface FormatDirectionsOptions {
  /** Cap on ideas surfaced per cycle (prompt-size bound). */
  maxIdeas?: number;
  /** Per-idea character cap (title+body line). */
  maxCharsPerIdea?: number;
}

/**
 * Format routed ideas into the proposer's candidate-direction lines:
 * `<title> — <single-line body>` truncated per idea, capped in count.
 * Zero ideas ⇒ [] ⇒ the proposer prompt is unchanged (additive by construction).
 */
export function formatCandidateDirections(
  ideas: readonly RoutedGymIdea[],
  opts: FormatDirectionsOptions = {},
): string[] {
  const maxIdeas = Math.max(0, opts.maxIdeas ?? 8);
  const maxChars = Math.max(16, opts.maxCharsPerIdea ?? 400);
  return ideas.slice(0, maxIdeas).map((idea) => {
    const body = idea.body ? idea.body.replace(/\s+/g, ' ').trim() : '';
    const line = body ? `${idea.title} — ${body}` : idea.title;
    return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
  });
}

// ---------------------------------------------------------------------------
// Eligibility + round-robin selection
// ---------------------------------------------------------------------------

/** Remaining budget for an autoloop row; null when no explicit cap is set. */
export function remainingBudgetUsd(cfg: Pick<GymAutoloopConfig, 'budgetUsd' | 'spentUsd'>): number | null {
  return cfg.budgetUsd === null ? null : cfg.budgetUsd - cfg.spentUsd;
}

/**
 * Tick eligibility: enabled AND idle AND an EXPLICIT budget with remaining
 * above the floor. (Null budget = ineligible: the unattended path refuses to
 * spend without a cap — the hard cost guard.)
 */
export function isEligibleAutoloop(cfg: GymAutoloopConfig, budgetFloorUsd: number): boolean {
  if (!cfg.enabled) return false;
  if (cfg.status !== 'idle') return false;
  const remaining = remainingBudgetUsd(cfg);
  return remaining !== null && remaining > budgetFloorUsd;
}

/** Least-recently-run first (never-run rows lead), slug as the stable tiebreak. */
export function orderByLeastRecentlyRun(cfgs: readonly GymAutoloopConfig[]): GymAutoloopConfig[] {
  return [...cfgs].sort((a, b) => {
    const aT = a.lastCycleAt ?? -Infinity;
    const bT = b.lastCycleAt ?? -Infinity;
    if (aT !== bT) return aT - bT;
    return a.harnessSlug.localeCompare(b.harnessSlug);
  });
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface GymCycleRequest {
  harnessSlug: string;
  workspaceId: string;
  /** The row's REMAINING budget — the cycle's hard spend cap. */
  budgetUsd: number;
  /** P-032: formatted routed-idea lines for the proposer ([] = none). */
  candidateDirections: string[];
}

export interface GymCycleResult {
  spentUsd: number;
  breakerTripped: boolean;
  cycles: number;
  accepts: number;
  skipped: number;
}

/** Mirrors the autoloop fire-gate verdict (lib/autoloop.ts) structurally. */
export interface TickFireGateVerdict {
  allow: boolean;
  reason?: string;
  retryAfterSec?: number;
}

export interface GymTickDeps {
  /** All autoloop rows for the workspace (listAutoloopsForWorkspace). */
  listAutoloops(): Promise<GymAutoloopConfig[]>;
  /** The shared autoloop fire-gate (error backoff / circuit, D-009) for role 'gym-cycle'. */
  checkFireGate(harnessSlug: string): Promise<TickFireGateVerdict>;
  /** Record a fire-path event ('attempt' preserves, 'ok' resets, 'error' increments the counter). */
  recordFire(harnessSlug: string, status: string, outcome: 'attempt' | 'ok' | 'error'): Promise<void>;
  /** Upsert the autoloop row (control-plane setAutoloop; omitted fields preserved). */
  setAutoloop(input: SetAutoloopInput): Promise<unknown>;
  /** Open improvements routed to the gym by triage (P-032). */
  readRoutedIdeas(): Promise<RoutedGymIdea[]>;
  /** Run ONE bounded gym cycle (live wiring: runOneAutoloopCycle, in-process). */
  runCycle(req: GymCycleRequest): Promise<GymCycleResult>;
  now?(): number;
  log?(msg: string): void;
}

export interface GymTickOutcome {
  action: 'idle' | 'ran' | 'error';
  /** Why an idle tick did nothing. */
  reason?: 'no-eligible-autoloop' | 'fire-gate-backoff';
  harnessSlug?: string;
  /** How many autoloops were eligible this tick (before the fire-gate walk). */
  eligibleCount: number;
  /** Eligible slugs withheld by the fire-gate (in LRU order, up to the chosen one). */
  gateBlocked: string[];
  /** The routed-idea directions handed to the cycle (observability). */
  candidateDirections?: string[];
  result?: GymCycleResult;
  /** The status the autoloop row settled at ('idle' | 'paused' | 'exhausted'). */
  settledStatus?: string;
  error?: string;
}

export interface GymTickOptions {
  budgetFloorUsd?: number;
}

/**
 * One tick of the gym autoloop routine. Runs AT MOST one cycle for at most one
 * harness; every skip reason is explicit in the outcome. Safe to re-run from
 * the top (the system-actions durable-step contract): a replayed tick sees the
 * previous attempt's row status ('running' rows are not idle ⇒ not re-picked).
 */
export async function runGymAutoloopTick(deps: GymTickDeps, opts: GymTickOptions = {}): Promise<GymTickOutcome> {
  const floor = opts.budgetFloorUsd ?? GYM_AUTOLOOP_BUDGET_FLOOR_USD;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  const all = await deps.listAutoloops();
  const eligible = orderByLeastRecentlyRun(all.filter((c) => isEligibleAutoloop(c, floor)));
  if (eligible.length === 0) {
    return { action: 'idle', reason: 'no-eligible-autoloop', eligibleCount: 0, gateBlocked: [] };
  }

  // Round-robin walk: the first LRU-ordered autoloop whose fire-gate allows. A
  // harness in error backoff must not starve its peers, so blocked ones are
  // skipped (not retried) within the tick.
  const gateBlocked: string[] = [];
  let chosen: GymAutoloopConfig | null = null;
  for (const cfg of eligible) {
    let verdict: TickFireGateVerdict;
    try {
      verdict = await deps.checkFireGate(cfg.harnessSlug);
    } catch (e) {
      // The gate is a protection, not a dependency — fail OPEN (mirrors checkFireGate).
      log(`fire-gate check failed for ${cfg.harnessSlug} — allowing: ${e instanceof Error ? e.message : e}`);
      verdict = { allow: true };
    }
    if (verdict.allow) {
      chosen = cfg;
      break;
    }
    gateBlocked.push(cfg.harnessSlug);
    log(
      `fire-gate withheld ${cfg.harnessSlug} (${verdict.reason ?? 'backoff'}` +
        (verdict.retryAfterSec ? `, retry in ~${verdict.retryAfterSec}s` : '') +
        ')',
    );
  }
  if (!chosen) {
    return { action: 'idle', reason: 'fire-gate-backoff', eligibleCount: eligible.length, gateBlocked };
  }

  const remaining = remainingBudgetUsd(chosen);
  if (remaining === null) {
    // Unreachable per isEligibleAutoloop; belt-and-braces for the cost guard.
    return { action: 'idle', reason: 'no-eligible-autoloop', eligibleCount: eligible.length, gateBlocked };
  }

  // P-032 (additive): triage-routed gym ideas → proposer candidate directions.
  // Best-effort — a backlog read failure must never block the cycle.
  let directions: string[] = [];
  try {
    directions = formatCandidateDirections(await deps.readRoutedIdeas());
  } catch (e) {
    log(`routed-ideas read failed — running the cycle without directions: ${e instanceof Error ? e.message : e}`);
  }

  // Bookkeeping first: the fire attempt (counter preserved) + status running, so
  // a crash mid-cycle leaves an honest row (and the durable-step replay skips it).
  try {
    await deps.recordFire(chosen.harnessSlug, 'gym-cycle:dispatch', 'attempt');
  } catch (e) {
    log(`recordFire(attempt) failed (continuing): ${e instanceof Error ? e.message : e}`);
  }
  await deps.setAutoloop({
    workspaceId: chosen.workspaceId,
    harnessSlug: chosen.harnessSlug,
    status: 'running',
    now: now(),
  });

  try {
    const result = await deps.runCycle({
      harnessSlug: chosen.harnessSlug,
      workspaceId: chosen.workspaceId,
      budgetUsd: remaining,
      candidateDirections: directions,
    });

    // Settle: ACCUMULATE spend; breaker → paused; budget floor crossed → exhausted.
    const spentTotal = chosen.spentUsd + result.spentUsd;
    const left = chosen.budgetUsd! - spentTotal;
    const settledStatus = result.breakerTripped ? 'paused' : left > floor ? 'idle' : 'exhausted';
    const doneTs = now();
    await deps.setAutoloop({
      workspaceId: chosen.workspaceId,
      harnessSlug: chosen.harnessSlug,
      status: settledStatus,
      spentUsd: spentTotal,
      lastCycleAt: doneTs,
      now: doneTs,
    });
    try {
      await deps.recordFire(chosen.harnessSlug, `gym-cycle:${settledStatus}`, 'ok');
    } catch (e) {
      log(`recordFire(ok) failed: ${e instanceof Error ? e.message : e}`);
    }
    return {
      action: 'ran',
      harnessSlug: chosen.harnessSlug,
      eligibleCount: eligible.length,
      gateBlocked,
      candidateDirections: directions,
      result,
      settledStatus,
    };
  } catch (err) {
    // running → idle even on a cycle error: the fire-gate's error backoff is the
    // retry brake; a stuck 'running' status would dead-lock the autoloop instead.
    try {
      await deps.setAutoloop({
        workspaceId: chosen.workspaceId,
        harnessSlug: chosen.harnessSlug,
        status: 'idle',
        now: now(),
      });
    } catch (e) {
      log(`failed to settle status back to idle for ${chosen.harnessSlug}: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await deps.recordFire(chosen.harnessSlug, 'gym-cycle:error', 'error');
    } catch (e) {
      log(`recordFire(error) failed: ${e instanceof Error ? e.message : e}`);
    }
    return {
      action: 'error',
      harnessSlug: chosen.harnessSlug,
      eligibleCount: eligible.length,
      gateBlocked,
      candidateDirections: directions,
      settledStatus: 'idle',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
