/**
 * Materialize a blueprint's `triggers.schedule` defaults into `harness_shared.routines`
 * (harness-blueprint-orchestration-2026-06-03 P-021 / D-018).
 *
 * A blueprint declares scheduler defaults:
 *
 *   triggers:
 *     schedule:
 *       - { cron: "0 0 9 * * *", action: "system:blueprint-run" }
 *
 * `harness:create` calls `materializeBlueprintTriggers` after provisioning the harness so
 * each entry becomes a cron `routines` row whose `target_role` is the entry's `action`
 * (default `system:blueprint-run`). The shipped DBOS `routinesTick` then dispatches a due
 * row to the registered system action INLINE as one durable step (`system-actions.ts`) —
 * there is deliberately NO `pending_events` consumer (that hop is retired,
 * `git-sync-auto-commit` D-006; `pending_events` the table stays live for the operator
 * scanner's LISTEN/NOTIFY, we just don't add a consumer). Blueprint ⟂ scheduler: one
 * declarative seam onto the EXISTING engine, not a second scheduler (D-018).
 *
 * Routines are runtime-editable after creation — pause / retime via the routines:* surface.
 * Re-running materialize is idempotent on (install_slug, name). The live-edit "re-author the
 * schedule" path is P-016, not here.
 *
 * Each entry delegates to db-org's `upsertRoutine` (the single routine-upsert primitive),
 * passing the owning `workspaceId` explicitly — `harness_shared.routines.workspace_id` is
 * NOT NULL with no default and no fill trigger, and upsertRoutine binds its jsonb via the
 * canonical `${JSON.stringify}::text::jsonb` form (EI-2).
 */
import type { Sql } from 'postgres';
import { getOrgPg, upsertRoutine } from '@papercusp/db-org';
import type { Blueprint } from '@papercusp/orchestrator/blueprint';
import { activeWorkspaceId } from '../workspace-registry';
import { computeNextFireAt } from '../harness/routines/cron';

/** The action a schedule entry dispatches when it declares none (the schema default). */
export const DEFAULT_SCHEDULE_ACTION = 'system:blueprint-run';

export interface TriggerRoutineSpec {
  /** Stable per-harness routine name (the upsert key, with install_slug). */
  name: string;
  /** 6- or 5-field crontab. */
  cron: string;
  /** target_role — `system:<action>` routes to a registered system action; a bare role spawns it. */
  targetRole: string;
}

export interface MaterializedRoutine extends TriggerRoutineSpec {
  /** The routines.id primary key (`rt_<slug>_<name>`, sanitized). */
  id: string;
}

/**
 * PURE: derive the routine specs a blueprint's `triggers.schedule` implies (exported for
 * unit testing — no PG). One spec per schedule entry; the name is `bp-schedule-<i>`, stable
 * for the create-time materialization. (`entry.action` is already defaulted to
 * `system:blueprint-run` by `TriggersSchema`; the `||` guards a loose/unparsed input.)
 */
export function triggerRoutineSpecs(blueprint: Pick<Blueprint, 'triggers'>): TriggerRoutineSpec[] {
  const schedule = blueprint.triggers?.schedule ?? [];
  return schedule.map((entry, i) => ({
    name: `bp-schedule-${i}`,
    cron: entry.cron,
    targetRole: entry.action || DEFAULT_SCHEDULE_ACTION,
  }));
}

/**
 * Upsert a blueprint's schedule triggers as `harness_shared.routines` rows for `installSlug`.
 * Returns the materialized routines ([] when the blueprint declares no schedule).
 *
 * Seeded ACTIVE — the blueprint author explicitly declared the schedule — but the routines
 * engine itself is opt-in (`PAPERCUSP_DBOS_ROUTINES`), so nothing fires until the operator
 * enables it. `opts.sql` / `opts.workspaceId` are test seams; production resolves the admin
 * pool + active workspace.
 */
export async function materializeBlueprintTriggers(
  installSlug: string,
  blueprint: Pick<Blueprint, 'triggers'>,
  opts: { sql?: Sql; workspaceId?: string } = {},
): Promise<MaterializedRoutine[]> {
  const specs = triggerRoutineSpecs(blueprint);
  if (specs.length === 0) return [];
  const sql = opts.sql ?? getOrgPg().sql;
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();

  const out: MaterializedRoutine[] = [];
  for (const spec of specs) {
    const row = await upsertRoutine(
      sql,
      {
        workspaceId,
        installSlug,
        name: spec.name,
        triggerKind: 'cron',
        triggerConfig: { cron: spec.cron },
        targetRole: spec.targetRole,
        active: true, // blueprint author explicitly declared the schedule
      },
      computeNextFireAt,
    );
    out.push({ ...spec, id: row.id });
  }
  return out;
}
