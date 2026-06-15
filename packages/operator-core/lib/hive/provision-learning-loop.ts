/**
 * provisionHiveLearningLoop — lay down a per-HIVE learning loop, keyed to the
 * hive's OWN install_slug, at hive:create (per-hive-learning-loops-2026-06-14
 * P-020; D-003 + D-008).
 *
 * The Hive (kind:'hive') is the tenant of ONE learning loop (D-008). This
 * provisions its two execution surfaces, both SHIPPED INERT so a fresh hive is
 * never spending until the owner arms it:
 *
 *   (a) a DARK gym_autoloop_config row (enabled:false, budget:null) — the
 *       gym-cycle tick doubly refuses a disabled AND unbudgeted row (the D-004
 *       governor rule), so the row exists for the gym UI to surface + arm but
 *       never fires. ARMING = the owner enabling the row + setting a budget via
 *       the gym control plane.
 *   (b) an INACTIVE scout routine (`scout-cycle`, target system:scout-cycle)
 *       under the hive's OWN install_slug — NOT @singleton, which is reserved
 *       for the workspace-singleton frontier loops (D-008). active:false ⇒ the
 *       routines engine never ticks it; its per-hive cycle budget lives in
 *       payload_template.budget.maxCostUsd (parseScoutCycleConfig reads it).
 *       ARMING = the owner flipping it active via the routines admin AFTER the
 *       cost-control prerequisites (D-005 / Phase 5) are in place.
 *
 * Mirrors learning-packs/seed.ts (seedPackIntoHive): pure-ish, injectable Sql,
 * returns an `undo` that joins the create's rollback stack so a LATER create
 * step failure removes the rows we laid down — and a summary the result reports.
 *
 * Keyed on the hive's OWN slug throughout — there is NO `?? 'papercup'` env
 * default here (P-022 retires those env-slug seed scripts for gym/scout). The
 * matching teardown at hive:dissolve (delete both rows + the governor
 * registrants) is P-021.
 */
import type { Sql } from 'postgres';
import { setAutoloop } from '../gym/control-plane';
import { gymLoopId, scoutLoopId } from '../learning-governor/core';
import { deleteLearningLoop } from '../learning-governor/store';

/** The scout routine name a per-hive loop fires from (under the hive install_slug). */
export const HIVE_SCOUT_ROUTINE_NAME = 'scout-cycle';
/** The routines target_role the scout routine ticks. */
export const SCOUT_CYCLE_TARGET_ROLE = 'system:scout-cycle';

/**
 * Default per-hive scout cron — ticks every 30 min at :05/:35 (deliberately
 * OFFSET from the deploy/green-checkpoint :00/:15/:30/:45 rhythm, like the
 * gym-cycle :10/:40 offset). The routine is seeded INACTIVE; staggered per-hive
 * crons that scale the offset by N (P-050) are a later cost-control lane — this
 * is the inert default until then.
 */
export const DEFAULT_HIVE_SCOUT_CRON = '0 5,35 * * * *';

/**
 * Default per-cycle scout budget for a fresh per-hive loop (USD). Conservative —
 * scout is the one engine that multiplies across N hives (D-005), so a new hive
 * starts cheap; the owner raises it when arming. parseScoutCycleConfig reads
 * this from payload_template.budget.maxCostUsd.
 */
export const DEFAULT_HIVE_SCOUT_MAX_COST_USD = 0.5;

export interface ProvisionHiveLearningLoopInput {
  sql: Sql;
  workspaceId: string;
  /** The new hive's OWN home install_slug (NOT a `?? 'papercup'` default). */
  hiveSlug: string;
  /** Override the per-cycle scout budget cap (USD). Default 0.5. */
  scoutMaxCostUsd?: number;
  /** Override the scout routine cron. Default :05/:35 every 30 min. */
  scoutCron?: string;
  now?: number;
}

export interface ProvisionHiveLearningLoopResult {
  ok: boolean;
  hiveSlug: string;
  /** The dark gym autoloop row was written. */
  gymAutoloop: boolean;
  /** The inactive scout routine row was written. */
  scoutRoutine: boolean;
  /** The scout routine id (install_slug + name, sanitized). */
  scoutRoutineId?: string;
  /** Per-cycle scout budget the routine carries. */
  scoutMaxCostUsd?: number;
  /** Removes both rows — joins the create's undo stack (best-effort). */
  undo: () => Promise<void>;
  /** Present on a partial/failed provision; the create reports + warns, never fails. */
  error?: string;
}

/** Sanitize an install_slug + routine name into a routines.id (mirrors the seed scripts). */
export function hiveScoutRoutineId(hiveSlug: string): string {
  return `rt_${hiveSlug}_${HIVE_SCOUT_ROUTINE_NAME}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * Provision the per-hive loop. Both writes are dark/inactive; the returned undo
 * removes exactly the rows we created (the gym row only ever exists for a fresh
 * hive, so undo deletes it outright — a fresh hive has no prior owner state to
 * preserve).
 */
export async function provisionHiveLearningLoop(
  input: ProvisionHiveLearningLoopInput,
): Promise<ProvisionHiveLearningLoopResult> {
  const { sql, workspaceId, hiveSlug } = input;
  const now = input.now ?? Date.now();
  const maxCostUsd = input.scoutMaxCostUsd ?? DEFAULT_HIVE_SCOUT_MAX_COST_USD;
  const cron = input.scoutCron ?? DEFAULT_HIVE_SCOUT_CRON;
  const routineId = hiveScoutRoutineId(hiveSlug);

  // (a) DARK gym autoloop row — enabled:false + budget:null. setAutoloop upserts;
  //     for a fresh hive this is a pure INSERT, so the undo can delete the row.
  await setAutoloop(sql, {
    workspaceId,
    harnessSlug: hiveSlug,
    enabled: false,
    budgetUsd: null,
    now,
  });
  const gymAutoloop = true;

  // (b) INACTIVE scout routine under the hive's OWN install_slug (NOT @singleton).
  //     payload_template.budget.maxCostUsd is the per-hive per-cycle cap
  //     (parseScoutCycleConfig reads it). active:false ⇒ never ticks until armed.
  const payloadTemplate = JSON.stringify({ budget: { maxCostUsd } });
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${routineId}, ${hiveSlug}, ${workspaceId}, ${HIVE_SCOUT_ROUTINE_NAME}, 'cron',
            ${JSON.stringify({ cron })}::text::jsonb, ${SCOUT_CYCLE_TARGET_ROLE},
            ${payloadTemplate}::text::jsonb, 'skip', 'skip-old', false, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template = EXCLUDED.payload_template,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()`;
  const scoutRoutine = true;

  const undo = async (): Promise<void> => {
    // Best-effort: a create-rollback must never throw. Remove exactly what we laid down.
    try {
      await sql`
        DELETE FROM harness_shared.gym_autoloop_config
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${hiveSlug}`;
    } catch {
      /* ignore */
    }
    try {
      await sql`
        DELETE FROM harness_shared.routines
         WHERE workspace_id = ${workspaceId} AND install_slug = ${hiveSlug} AND name = ${HIVE_SCOUT_ROUTINE_NAME}`;
    } catch {
      /* ignore */
    }
  };

  return {
    ok: true,
    hiveSlug,
    gymAutoloop,
    scoutRoutine,
    scoutRoutineId: routineId,
    scoutMaxCostUsd: maxCostUsd,
    undo,
  };
}

export interface TeardownHiveLearningLoopInput {
  sql: Sql;
  workspaceId: string;
  /** The dissolving hive's OWN home install_slug — same key provisionHiveLearningLoop used. */
  hiveSlug: string;
}

export interface TeardownHiveLearningLoopResult {
  hiveSlug: string;
  /** The dark gym autoloop row was removed (or was already absent). */
  gymAutoloop: boolean;
  /** The inactive scout routine row was removed (or was already absent). */
  scoutRoutine: boolean;
  /** The `gym:<hive>` / `scout:<hive>` learning-governor registrants were removed (or absent). */
  governorRegistrants: boolean;
}

/**
 * teardownHiveLearningLoop — the lifecycle inverse of provisionHiveLearningLoop,
 * called from hive:dissolve (per-hive-learning-loops-2026-06-14 P-021; D-003).
 * Removes EVERYTHING the provision laid down for this hive:
 *   (a) the dark gym_autoloop_config row keyed (workspace_id, harness_slug=hiveSlug),
 *   (b) the inactive scout routine (install_slug=hiveSlug, name='scout-cycle'),
 *   (c) the learning-governor registrants `gym:<hive>` + `scout:<hive>`.
 *
 * Mirrors the provision's `undo` (which removes a+b), extended with the governor
 * registrants the provision NEVER writes (the gym/scout tick mirrors write those
 * lazily on first armed contact). Idempotent + best-effort throughout: each
 * removal is independently try/caught so a missing row — or one removal failing —
 * never blocks the others, and the caller WARNS rather than failing the dissolve.
 */
export async function teardownHiveLearningLoop(
  input: TeardownHiveLearningLoopInput,
): Promise<TeardownHiveLearningLoopResult> {
  const { sql, workspaceId, hiveSlug } = input;
  const result: TeardownHiveLearningLoopResult = {
    hiveSlug,
    gymAutoloop: false,
    scoutRoutine: false,
    governorRegistrants: false,
  };

  // (a) dark gym autoloop row.
  try {
    await sql`
      DELETE FROM harness_shared.gym_autoloop_config
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${hiveSlug}`;
    result.gymAutoloop = true;
  } catch {
    /* best-effort — a failure WARNS in the caller, never fails the dissolve */
  }

  // (b) inactive scout routine (reuse the provision's keying).
  try {
    await sql`
      DELETE FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND install_slug = ${hiveSlug} AND name = ${HIVE_SCOUT_ROUTINE_NAME}`;
    result.scoutRoutine = true;
  } catch {
    /* best-effort */
  }

  // (c) learning-governor registrants gym:<hive> + scout:<hive>.
  try {
    await deleteLearningLoop(sql, { workspaceId, loopId: gymLoopId(hiveSlug) });
    await deleteLearningLoop(sql, { workspaceId, loopId: scoutLoopId(hiveSlug) });
    result.governorRegistrants = true;
  } catch {
    /* best-effort */
  }

  return result;
}
