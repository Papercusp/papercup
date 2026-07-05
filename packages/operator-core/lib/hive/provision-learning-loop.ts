/**
 * provisionHiveLearningLoop — lay down the hive's learning-loop records at
 * pot:create (per-hive-learning-loops-2026-06-14 P-020; D-003 + D-008).
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
 *   (b) an INACTIVE scout routine (`scout-cycle`, target system:scout-cycle).
 *       With WORKSPACE_COORDINATION off, it is the legacy per-hive routine.
 *       With WORKSPACE_COORDINATION on, it is keyed to the workspace sentinel so
 *       there is ONE Scout brain per workspace (matching blender:cycle's runtime
 *       sentinel) while hives keep their own bee execution / repo / membership.
 *       active:false ⇒ the routines engine never ticks it until armed. Its
 *       cycle budget lives in payload_template.budget.maxCostUsd
 *       (parseScoutCycleConfig reads it).
 *
 * Mirrors learning-packs/seed.ts (seedPackIntoHive): pure-ish, injectable Sql,
 * returns an `undo` that joins the create's rollback stack so a LATER create
 * step failure removes the rows we laid down — and a summary the result reports.
 *
 * The gym row remains keyed on the hive's OWN slug; the Scout routine uses the
 * workspace-brain scope helper so it follows the shared Queen/Scout/Overwatch
 * re-key. There is NO `?? operatorHomeHarnessSlug()` env default here (P-022
 * retires those env-slug seed scripts for gym/scout). The matching teardown at
 * pot:dissolve (delete the per-hive rows + the governor registrants) is P-021.
 */
import type { Sql } from 'postgres';
import { setAutoloop } from '../gym/control-plane';
import { gymLoopId, scoutLoopId } from '../learning-governor/core';
import { deleteLearningLoop } from '../learning-governor/store';
import { isWorkspaceCoordinationOn, workspaceBrainScopeKey } from '../workspace-brain-scope';

/** The scout routine name a per-hive loop fires from (under the hive install_slug). */
export const HIVE_SCOUT_ROUTINE_NAME = 'scout-cycle';
/** The routines target_role the scout routine ticks. */
export const SCOUT_CYCLE_TARGET_ROLE = 'system:scout-cycle';

/**
 * Per-hive scout cadence window: a cycle heartbeat fires twice an hour (every
 * 30 min). staggeredHiveScoutCron spreads each hive's two fires DETERMINISTICALLY
 * across this window so N hives never collide on one boundary (P-050).
 */
export const HIVE_SCOUT_CADENCE_MIN = 30;

/**
 * Legacy fixed per-hive scout cron — every 30 min at :05/:35 (OFFSET from the
 * deploy/green-checkpoint :00/:15/:30/:45 rhythm). Superseded by the deterministic
 * per-hive stagger (P-050: {@link staggeredHiveScoutCron}); kept only as the
 * documented "what the un-staggered default was" anchor. The provision default is
 * now per-hive-staggered.
 */
export const DEFAULT_HIVE_SCOUT_CRON = '0 5,35 * * * *';

/**
 * A stable 32-bit FNV-1a hash of a string. Deterministic + dependency-free — the
 * same slug always hashes to the same value (so a re-provision is idempotent),
 * and two different slugs almost never collide on BOTH the derived minute AND
 * second (P-050 only needs "distinct boundaries", not a perfect partition).
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned via the >>> 0 below.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * P-050 — DETERMINISTIC per-hive scout cron. Scout is the one engine that
 * multiplies (N hives × ~13 in-process LLM calls/cycle on ONE shared Anthropic
 * rate limit, D-005). If every hive's routine fired on the same cron boundary,
 * N hives = 13N concurrent API calls at that instant. Spreading each hive's
 * heartbeat to a STABLE per-hive minute+second within the 30-min cadence window
 * — a pure function of the hive slug — declusters those bursts without any
 * coordination: hive A fires at e.g. `:07:42 / :37:42`, hive B at `:23:11 /
 * :53:11`, deterministically and idempotently (the same slug always lands on
 * the same offset, so re-provisioning never churns the schedule).
 *
 * The minute offset ranges over [0, 30) and the second over [0, 60), giving
 * 1800 distinct slots within a half-hour — ample to scatter realistic hive
 * counts. Returns a 6-field (seconds-resolution) cron `S M,M+30 * * * *`.
 */
export function staggeredHiveScoutCron(hiveSlug: string): string {
  const h = fnv1a32(hiveSlug);
  // Two independent fields from the one hash: low bits → minute, high bits → second.
  const minute = h % HIVE_SCOUT_CADENCE_MIN; // [0, 30)
  const second = Math.floor(h / HIVE_SCOUT_CADENCE_MIN) % 60; // [0, 60)
  const minutes = `${minute},${minute + HIVE_SCOUT_CADENCE_MIN}`; // e.g. "7,37"
  return `${second} ${minutes} * * * *`;
}

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
  /** The new hive's OWN home install_slug (NOT a `?? operatorHomeHarnessSlug()` default). */
  hiveSlug: string;
  /** Override the per-cycle scout budget cap (USD). Default 0.5. */
  scoutMaxCostUsd?: number;
  /**
   * Override the scout routine cron. Default = the DETERMINISTIC per-hive stagger
   * (P-050: {@link staggeredHiveScoutCron}) — a stable per-slug minute+second
   * within the 30-min window so N hives don't burst together.
   */
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

async function scoutRoutineScope(workspaceId: string, hiveSlug: string): Promise<string> {
  return workspaceBrainScopeKey(workspaceId, hiveSlug, await isWorkspaceCoordinationOn());
}

/**
 * Provision the learning-loop records. Both writes are dark/inactive; the
 * returned undo removes the rows we created. When the Scout routine already
 * existed under the workspace sentinel, rollback preserves it for the rest of
 * the workspace.
 */
export async function provisionHiveLearningLoop(
  input: ProvisionHiveLearningLoopInput,
): Promise<ProvisionHiveLearningLoopResult> {
  const { sql, workspaceId, hiveSlug } = input;
  const now = input.now ?? Date.now();
  const maxCostUsd = input.scoutMaxCostUsd ?? DEFAULT_HIVE_SCOUT_MAX_COST_USD;
  const scoutScope = await scoutRoutineScope(workspaceId, hiveSlug);
  // P-050 legacy: OFF uses a deterministic per-hive cron offset. ON uses the
  // same deterministic function against the workspace sentinel, yielding one
  // stable workspace Scout routine instead of N per-hive routines.
  const cron = input.scoutCron ?? staggeredHiveScoutCron(scoutScope);
  const routineId = hiveScoutRoutineId(scoutScope);
  const existingScoutRows = await sql<Array<{ id: string }>>`
    SELECT id FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId} AND install_slug = ${scoutScope} AND name = ${HIVE_SCOUT_ROUTINE_NAME}
     LIMIT 1`;
  const scoutRoutineExisted = existingScoutRows.length > 0;

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

  // (b) INACTIVE scout routine under the effective Scout scope (legacy hive slug,
  //     or workspace sentinel when WORKSPACE_COORDINATION is ON).
  //     payload_template.budget.maxCostUsd is the per-hive per-cycle cap
  //     (parseScoutCycleConfig reads it). active:false ⇒ never ticks until armed.
  const payloadTemplate = JSON.stringify({ budget: { maxCostUsd } });
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${routineId}, ${scoutScope}, ${workspaceId}, ${HIVE_SCOUT_ROUTINE_NAME}, 'cron',
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
         WHERE workspace_id = ${workspaceId} AND install_slug = ${scoutScope} AND name = ${HIVE_SCOUT_ROUTINE_NAME}
           AND ${!scoutRoutineExisted}`;
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
  /** The git-sync pipeline routines (system:git-sync/green-checkpoint/release-trigger) for
   *  this install were removed (or were already absent) — git-sync-dx-hardening P-007. */
  gitSyncRoutines: boolean;
}

/**
 * teardownHiveLearningLoop — the lifecycle inverse of provisionHiveLearningLoop,
 * called from pot:dissolve (per-hive-learning-loops-2026-06-14 P-021; D-003).
 * Removes EVERYTHING the provision laid down for this hive:
 *   (a) the dark gym_autoloop_config row keyed (workspace_id, harness_slug=hiveSlug),
 *   (b) the inactive scout routine (install_slug=hiveSlug, name='scout-cycle'),
 *   (c) the learning-governor registrants `gym:<hive>` + `scout:<hive>`.
 *   (d) the git-sync pipeline routines (system:git-sync/green-checkpoint/release-trigger)
 *       seeded for this install — git-sync-dx-hardening P-007 (they leaked per benchmark
 *       run; both dissolve paths — pot:dissolve + dissolveBenchHive — flow through here).
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
    gitSyncRoutines: false,
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

  // (d) git-sync pipeline routines (git-sync-dx-hardening-2026-06-17 P-007 / F6): the
  //     system:git-sync (+ green-checkpoint / release-trigger) routines seeded per install
  //     were NEVER reaped on dissolve, so every benchmark/hive run leaked rows (135+
  //     accumulated). Scoped tightly to THIS hive's install_slug + the git-sync trio, so a
  //     live install's sync is never touched. Best-effort, like the rest.
  try {
    await sql`
      DELETE FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND install_slug = ${hiveSlug}
         AND target_role IN ('system:git-sync', 'system:green-checkpoint', 'system:release-trigger', 'system:cross-hive-outbox-drain')`;
    result.gitSyncRoutines = true;
  } catch {
    /* best-effort */
  }

  return result;
}
