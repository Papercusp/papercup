/**
 * Workspace-wide Scout spend ceiling — the P-051 aggregate gate
 * (per-hive-learning-loops-2026-06-14 / D-005).
 *
 * Scout is the one learning engine that MULTIPLIES: every hive carries its own
 * `scout:<hive>` per-cycle registrant, and a per-cycle cap bounds ONE cycle —
 * it cannot see the fleet. N armed hives, each individually under its small
 * per-cycle cap, can still sum to a spend that saturates the shared Anthropic
 * rate limit / the operator daily budget. This module is the missing aggregate
 * gate, consulted by the scout cycle's governor gate (runScoutCycleTick) BEFORE
 * a tick: it sums every `scout:<hive>` registrant's ledgered spend in the
 * workspace and REFUSES a new cycle once the total crosses the ceiling.
 *
 * Layering (mirrors registrants.ts):
 *   - the pure rule (sum + compare) is checkScoutWorkspaceCeiling in core.ts;
 *   - the IO (listLearningLoops over the live admin pool) lives in store.ts;
 *   - THIS module is the flag-aware glue: governor flag OFF ⇒ the gate is a
 *     no-op (the kill-switch — scout's structural self-gates still bound it),
 *     and an IO error FAILS OPEN (allow) — the workspace ceiling is a SAFETY
 *     CAP on top of every per-hive per-cycle cap + the cadence/budget self-gates,
 *     so a broken ledger read must not silently freeze the whole fleet's scout;
 *     it logs and lets the already-bounded per-hive cycle proceed.
 *
 * The ceiling is OWNER-TUNABLE: DEFAULT_SCOUT_WORKSPACE_CEILING_USD (core.ts),
 * overridable per host via the PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD env.
 *
 * Deps are injectable so scout-ceiling.test.ts covers flag-off, under/over cap,
 * the cross-hive sum, and fail-open with zero PG.
 */
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  checkScoutWorkspaceCeiling,
  DEFAULT_SCOUT_WORKSPACE_CEILING_USD,
  type LearningLoopRegistration,
  type ScoutWorkspaceCeilingVerdict,
} from './core';
import { listLearningLoops } from './store';

/**
 * Resolve the workspace ceiling: the env override
 * (`PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD`) when it parses to a finite ≥ 0
 * number, else {@link DEFAULT_SCOUT_WORKSPACE_CEILING_USD}. (0 is an honest cap —
 * "no scout spend allowed workspace-wide.")
 */
export function resolveScoutWorkspaceCeilingUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD;
  if (raw === undefined || raw === '') return DEFAULT_SCOUT_WORKSPACE_CEILING_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SCOUT_WORKSPACE_CEILING_USD;
}

/** Injectable IO seam (tests). Defaults = the real flag + store + pool + env. */
export interface ScoutCeilingDeps {
  enabled?: () => Promise<boolean>;
  getSql?: () => Promise<Sql>;
  listLoops?: (sql: Sql, q: { workspaceId: string }) => Promise<LearningLoopRegistration[]>;
  ceilingUsd?: () => number;
  log?: (msg: string) => void;
}

const defaultDeps: Required<ScoutCeilingDeps> = {
  enabled: () => getFlag(FLAGS.LEARNING_GOVERNOR, 'learning-governor'),
  // Lazy import (registrants.ts pattern): a PG-free process must not load the
  // pool module before the flag check has a chance to short-circuit.
  getSql: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql;
  },
  listLoops: listLearningLoops,
  ceilingUsd: () => resolveScoutWorkspaceCeilingUsd(),
  log: (m) => console.log(`[scout-workspace-ceiling] ${m}`),
};

function resolve(deps?: ScoutCeilingDeps): Required<ScoutCeilingDeps> {
  return { ...defaultDeps, ...deps };
}

/**
 * The verdict a no-op (flag-off) / fail-open gate returns: allow, with a zeroed
 * sum and the resolved ceiling for observability.
 */
function allowVerdict(ceilingUsd: number): ScoutWorkspaceCeilingVerdict {
  return { allow: true, totalScoutSpentUsd: 0, ceilingUsd, remainingUsd: ceilingUsd, scoutLoopCount: 0 };
}

/**
 * THE workspace-ceiling preflight the scout cycle's gate consults before a tick.
 *
 *   - governor flag OFF ⇒ ALLOW (no-op): the kill-switch — scout's per-cycle cap
 *     + cadence/budget self-gates still bound every cycle. (Symmetric with the
 *     scout MIRROR, which also no-ops flag-off.)
 *   - ON ⇒ sum every `scout:<hive>` registrant's ledgered spend and apply the
 *     pure rule (checkScoutWorkspaceCeiling): refuse once the aggregate reaches
 *     the ceiling.
 *   - IO error ⇒ FAIL OPEN (allow), logged: a workspace SAFETY cap layered over
 *     already-bounded per-hive cycles must not freeze the whole fleet's scout on
 *     a transient ledger-read failure. (This is the deliberate inverse of the
 *     FRONTIER preflight's fail-CLOSED: those loops have NO other gate, so a
 *     broken ledger must refuse them; scout always has its structural gates.)
 */
export async function scoutWorkspaceCeilingGate(
  q: { workspaceId: string },
  deps?: ScoutCeilingDeps,
): Promise<ScoutWorkspaceCeilingVerdict> {
  const d = resolve(deps);
  const ceilingUsd = d.ceilingUsd();
  try {
    if (!(await d.enabled())) return allowVerdict(ceilingUsd);
    const sql = await d.getSql();
    const loops = await d.listLoops(sql, { workspaceId: q.workspaceId });
    const verdict = checkScoutWorkspaceCeiling(loops, ceilingUsd);
    if (!verdict.allow) {
      d.log(
        `REFUSING new scout cycle for workspace ${q.workspaceId}: aggregate scout spend ` +
          `$${verdict.totalScoutSpentUsd.toFixed(2)} across ${verdict.scoutLoopCount} hive(s) ` +
          `≥ ceiling $${ceilingUsd.toFixed(2)} (D-005 / P-051 workspace cap; ` +
          'override PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD)',
      );
    }
    return verdict;
  } catch (e) {
    // Fail OPEN — the per-hive per-cycle cap + cadence/budget gates still bound
    // this cycle; a transient ledger-read failure must not freeze the fleet.
    d.log(`ceiling read failed for ${q.workspaceId} — allowing (fail-open): ${e instanceof Error ? e.message : e}`);
    return allowVerdict(ceilingUsd);
  }
}
