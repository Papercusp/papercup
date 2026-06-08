/**
 * cadence-signals.ts — Scout P-008: the live signal readers the cadence gate
 * ({@link shouldRunScoutCycle}) consumes — idle capacity + accumulated friction.
 *
 * These are the production sources behind {@link ScoutCadenceState}:
 *  - **idle capacity** — derived from the running fleet vs a configured capacity:
 *    idleRatio = clamp(1 - running/capacity, 0, 1). Mirrors the fleet spawn
 *    governor's running-count query (fleet/operator-spawn countRunning).
 *  - **friction** — the OPEN idea-queue backlog (the self-improvement loop's
 *    captured-but-unaddressed items). A growing backlog IS the colony's
 *    accumulated friction (the plan's "what keeps being deferred"); reusing
 *    {@link readImprovementItems} keeps this schema-correct + scope-aware (P-010).
 *
 * The DB queries mirror already-tested code; the only non-trivial LOGIC (the idle
 * ratio) takes injected deps so it's unit-tested without PG.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { readImprovementItems } from '../harness/improvements/read-items';

/** Default fleet capacity for the idle ratio (override: PAPERCUSP_SCOUT_FLEET_CAPACITY). */
export function scoutFleetCapacity(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_FLEET_CAPACITY ?? 12);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

/** Count currently-running fleet agents (running|restarting) for the workspace. */
export async function countRunningAgents(workspaceId: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId} AND status IN ('running', 'restarting')`;
  return Number(rows[0]?.n ?? 0);
}

export interface IdleRatioDeps {
  countRunning: (workspaceId: string) => Promise<number>;
}

/**
 * Fleet idle ratio in [0,1]: 1 = fully idle (no agents running), 0 = at/over the
 * configured capacity. Pure math over the injected running-count (production uses
 * {@link countRunningAgents}).
 */
export async function readHiveIdleRatio(
  opts: { workspaceId?: string; capacity?: number } = {},
  deps: IdleRatioDeps = { countRunning: countRunningAgents },
): Promise<number> {
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const capacity = opts.capacity && opts.capacity > 0 ? opts.capacity : scoutFleetCapacity();
  const running = await deps.countRunning(ws);
  return clamp01(1 - running / capacity);
}

export interface FrictionDeps {
  readOpenImprovements: (harnessSlug?: string) => Promise<{ length: number }>;
}

const defaultFrictionDeps: FrictionDeps = {
  readOpenImprovements: (harnessSlug) =>
    readImprovementItems({ state: 'open', ...(harnessSlug ? { harnessSlug } : {}) }),
};

/**
 * The friction-signal count = the OPEN idea-queue backlog for the harness scope
 * (omit harnessSlug for all scopes). A high count means accumulated, unaddressed
 * friction → the cadence gate's friction trigger.
 */
export async function readFrictionSignalCount(
  opts: { harnessSlug?: string } = {},
  deps: FrictionDeps = defaultFrictionDeps,
): Promise<number> {
  const items = await deps.readOpenImprovements(opts.harnessSlug);
  return items.length;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
