/**
 * Learning-governor REGISTRANTS (self-learning-frontier-2026-06-12 P-003 /
 * FB-01) — the glue between the governor ledger and its callers:
 *
 *   - `learningGovernorPreflight` — THE gate every frontier loop (FB-04..15)
 *     calls before an unattended run. Flag-aware: with papercusp-learning-
 *     governor OFF (the kill-switch) it refuses with 'governor-dark'; with it
 *     ON, unregistered/unbudgeted/exhausted loops refuse (D-004) — so a
 *     frontier loop cannot run unattended before its P-001 arming act (owner
 *     sets its budget) even if its own flag were flipped early.
 *
 *   - `recordGymTickToGovernor` / `recordScoutTickToGovernor` — the mirrors
 *     the existing gym + scout routine actions call after each tick. ZERO
 *     behavior change by construction: flag-gated, best-effort (never throw —
 *     governor bookkeeping must never fail or replay a host tick), and purely
 *     additive (gym_autoloop_config / scout's per-cycle budget stay the
 *     authoritative gates; their budgets surface here as sub-budgets).
 *
 * Deps are injectable (the codebase's seam pattern) so registrants.test.ts
 * covers flag-off no-ops, mirror mapping, and error swallowing with no PG.
 */
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  gymLoopId,
  gymRegistrationInput,
  scoutLoopId,
  scoutRegistrationInput,
  type GovernorVerdict,
  type GymAutoloopLike,
} from './core';
import {
  governorCheck,
  recordLearningSpend,
  registerLearningLoop,
  type RecordLearningSpendInput,
  type RegisterLearningLoopInput,
} from './store';

/** Injectable IO seam (tests). Defaults = the real flag + store + pool. */
export interface GovernorGlueDeps {
  enabled?: () => Promise<boolean>;
  getSql?: () => Promise<Sql>;
  register?: (sql: Sql, input: RegisterLearningLoopInput) => Promise<unknown>;
  recordSpend?: (sql: Sql, input: RecordLearningSpendInput) => Promise<unknown>;
  check?: (sql: Sql, q: { workspaceId: string; loopId: string; floorUsd?: number }) => Promise<GovernorVerdict>;
  log?: (msg: string) => void;
}

const defaultDeps: Required<GovernorGlueDeps> = {
  enabled: () => getFlag(FLAGS.LEARNING_GOVERNOR, 'learning-governor'),
  // Lazy import: unit tests of the host actions run the flag-off path with no
  // PG env; the pool module must not load (or throw) before the flag check.
  getSql: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql;
  },
  register: registerLearningLoop,
  recordSpend: recordLearningSpend,
  check: governorCheck,
  log: (m) => console.log(`[learning-governor] ${m}`),
};

function resolve(deps?: GovernorGlueDeps): Required<GovernorGlueDeps> {
  return { ...defaultDeps, ...deps };
}

export interface GovernorGlueOutcome {
  applied: boolean;
  reason?: 'flag-off' | 'error';
  error?: string;
}

// ---------------------------------------------------------------------------
// The frontier preflight (FB-04..FB-15 call this before any unattended run)
// ---------------------------------------------------------------------------

/**
 * Flag-aware unattended-refusal gate: governor flag OFF ⇒ 'governor-dark';
 * otherwise the registration verdict (unregistered / disabled / unbudgeted /
 * exhausted ⇒ refuse). Fail-CLOSED: an IO error refuses rather than allows —
 * an unattended learning loop must never spend on a broken ledger.
 */
export async function learningGovernorPreflight(
  q: { workspaceId: string; loopId: string; floorUsd?: number },
  deps?: GovernorGlueDeps,
): Promise<GovernorVerdict> {
  const d = resolve(deps);
  try {
    if (!(await d.enabled())) return { allow: false, reason: 'governor-dark', remainingUsd: null };
    const sql = await d.getSql();
    return await d.check(sql, q);
  } catch (e) {
    d.log(`preflight failed for ${q.loopId} — refusing (fail-closed): ${e instanceof Error ? e.message : e}`);
    return { allow: false, reason: 'governor-error', remainingUsd: null };
  }
}

// ---------------------------------------------------------------------------
// Gym mirror (system:gym-cycle calls this after every tick)
// ---------------------------------------------------------------------------

export interface GymTickGovernorInput {
  workspaceId: string;
  /** The tick's already-open admin pool (gym-actions holds one) — avoids a second pool resolve. */
  sql: Sql;
  /** Lazy mirror source (listAutoloopsForWorkspace) — only read once the flag check passes. */
  listAutoloops: () => Promise<readonly GymAutoloopLike[]>;
  /** The tick outcome's spend, when a cycle ran. */
  ran?: { harnessSlug: string; spentUsd: number; runRef?: string } | null;
}

/**
 * Mirror every gym autoloop row onto the governor registry (budget AND spent
 * overwritten — gym_autoloop_config stays authoritative) and, when a cycle
 * ran, ledger one spend EVENT (accumulate:false — the row's spent comes from
 * the mirror; accumulating would double-count). Never throws.
 */
export async function recordGymTickToGovernor(
  input: GymTickGovernorInput,
  deps?: GovernorGlueDeps,
): Promise<GovernorGlueOutcome> {
  const d = resolve(deps);
  try {
    if (!(await d.enabled())) return { applied: false, reason: 'flag-off' };
    for (const cfg of await input.listAutoloops()) {
      await d.register(input.sql, gymRegistrationInput({ ...cfg, workspaceId: input.workspaceId }));
    }
    if (input.ran && input.ran.spentUsd > 0) {
      await d.recordSpend(input.sql, {
        workspaceId: input.workspaceId,
        loopId: gymLoopId(input.ran.harnessSlug),
        costUsd: input.ran.spentUsd,
        runRef: input.ran.runRef ?? null,
        note: 'gym autoloop cycle',
        accumulate: false,
      });
    }
    return { applied: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    d.log(`gym mirror failed (tick unaffected): ${error}`);
    return { applied: false, reason: 'error', error };
  }
}

// ---------------------------------------------------------------------------
// Scout mirror (system:scout-cycle calls this after every tick)
// ---------------------------------------------------------------------------

export interface ScoutTickGovernorInput {
  workspaceId: string;
  harnessSlug: string;
  /** The tick's resolved per-cycle cap (budget.ts maxCostUsd) — mirrored as the sub-budget. */
  perCycleBudgetUsd: number;
  /** Spend when the tick fired a cycle that reported cost. */
  fired?: { costUsd: number; cycleId?: string } | null;
}

/**
 * Mirror the scout registration (per-cycle sub-budget; spent preserved) and,
 * when a cycle fired with reported cost, ACCUMULATE it (the governor is
 * scout's only loop-level spend store). Never throws.
 */
export async function recordScoutTickToGovernor(
  input: ScoutTickGovernorInput,
  deps?: GovernorGlueDeps,
): Promise<GovernorGlueOutcome> {
  const d = resolve(deps);
  try {
    if (!(await d.enabled())) return { applied: false, reason: 'flag-off' };
    const sql = await d.getSql();
    await d.register(
      sql,
      scoutRegistrationInput({
        workspaceId: input.workspaceId,
        harnessSlug: input.harnessSlug,
        perCycleBudgetUsd: input.perCycleBudgetUsd,
      }),
    );
    if (input.fired && input.fired.costUsd > 0) {
      await d.recordSpend(sql, {
        workspaceId: input.workspaceId,
        loopId: scoutLoopId(input.harnessSlug),
        costUsd: input.fired.costUsd,
        runRef: input.fired.cycleId ?? null,
        note: 'scout ideation cycle',
        accumulate: true,
      });
    }
    return { applied: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    d.log(`scout mirror failed (tick unaffected): ${error}`);
    return { applied: false, reason: 'error', error };
  }
}
