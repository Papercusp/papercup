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
 * Workspace-SINGLETON triggers (`singleton: true`, deterministic-blueprints-migration D-018):
 * a schedule entry can declare itself workspace-global — EXACTLY ONE routine per workspace,
 * shared across every install of the blueprint, seeded INACTIVE/dark, under the reserved
 * synthetic host-slug `SINGLETON_TRIGGER_HOST_SLUG` (not a real harness install). This solves
 * the D-010/D-012(b) objection: a learning loop (regret-mine, gym-cycle, …) can carry its own
 * cadence into another hive WITHOUT a naive per-install materialization minting N redundant
 * ACTIVE pulses for N installs. Because all singletons share one reserved host-slug, the
 * routine name embeds the blueprint id (`bp-singleton-<blueprintId>-<i>`) so it is
 * blueprint-unique under the `(install_slug, name)` uniqueness key; re-installing the blueprint
 * upserts the same one row. (Per-install triggers keep keying on the real install slug, seeded
 * ACTIVE — unchanged.) Uniqueness is per-workspace by the existing routines invariant: one
 * workspace per routines namespace (the same single-namespace assumption per-install relies on;
 * the row also carries `workspace_id`). Folding the bespoke `seed-*-routine` scripts' governor
 * registration onto this capability is the per-loop follow-on (D-018 step 2), NOT this step.
 *
 * Each entry delegates to db-org's `upsertRoutine` (the single routine-upsert primitive),
 * passing the owning `workspaceId` explicitly — `harness_shared.routines.workspace_id` is
 * NOT NULL with no default and no fill trigger, and upsertRoutine binds its jsonb via the
 * canonical `${JSON.stringify}::text::jsonb` form (EI-2).
 */
import type { Sql } from 'postgres';
import { getOrgPg, upsertRoutine } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { computeNextFireAt } from '../harness/routines/cron';

/** The action a schedule entry dispatches when it declares none (the schema default). */
export const DEFAULT_SCHEDULE_ACTION = 'system:blueprint-run';

/**
 * The blueprint-ish input the spec-deriver accepts. A parsed `Blueprint` is assignable (its
 * schedule entries carry the `action`/`singleton` defaults already), as is a blueprint-shaped
 * literal — `action` and `singleton` are optional here because this module applies the same
 * defaults the schema does, so callers (and tests) need not pre-fill them. `id` is required
 * only when a schedule entry sets `singleton: true` (the routine name must embed it).
 */
export interface BlueprintTriggerInput {
  id?: string;
  triggers?: { schedule?: Array<{ cron: string; action?: string; singleton?: boolean; singletonActive?: boolean }> };
}

/**
 * The reserved synthetic host-slug a workspace-singleton trigger materializes under
 * (deterministic-blueprints-migration D-018). A workspace-global routine isn't owned by any
 * real harness install, so it gets this slug instead of an install slug — cleaner than pinning
 * it to (and orphaning it on the teardown of) a real harness. The leading `@` cannot appear in
 * a real harness slug, so the singleton routine namespace is disjoint from per-install routines
 * on the shared `(install_slug, name)` key.
 */
export const SINGLETON_TRIGGER_HOST_SLUG = '@singleton';

export interface TriggerRoutineSpec {
  /** Stable routine name = the upsert key (with the resolved host slug). Per-install:
   *  `bp-schedule-<i>`. Singleton: `bp-singleton-<blueprintId>-<i>` (blueprint-unique under
   *  the shared reserved host-slug). */
  name: string;
  /** 6- or 5-field crontab. */
  cron: string;
  /** target_role — `system:<action>` routes to a registered system action; a bare role spawns it. */
  targetRole: string;
  /** Workspace-singleton (D-018): one dark routine per workspace under the reserved host-slug,
   *  vs. a per-install ACTIVE routine keyed on the install slug. */
  singleton: boolean;
  /** Seed the singleton ACTIVE on first creation (an always-on workspace loop) vs dark
   *  (a frontier loop armed later). Re-materialize always preserves the live active state. */
  singletonActive: boolean;
}

export interface MaterializedRoutine extends TriggerRoutineSpec {
  /** The routines.id primary key (`rt_<slug>_<name>`, sanitized). */
  id: string;
  /** The install_slug the row was written under — the real install slug, or
   *  `SINGLETON_TRIGGER_HOST_SLUG` for a singleton. */
  hostSlug: string;
}

/**
 * PURE: derive the routine specs a blueprint's `triggers.schedule` implies (exported for
 * unit testing — no PG). One spec per schedule entry. A per-install entry is named
 * `bp-schedule-<i>` (stable for create-time materialization); a `singleton: true` entry is
 * named `bp-singleton-<blueprintId>-<i>` so it is blueprint-unique under the reserved
 * host-slug the singletons share (a singleton entry therefore REQUIRES `blueprint.id`).
 * (`entry.action` is already defaulted to `system:blueprint-run` by `TriggersSchema`; the
 * `||` guards a loose/unparsed input.)
 */
export function triggerRoutineSpecs(blueprint: BlueprintTriggerInput): TriggerRoutineSpec[] {
  const schedule = blueprint.triggers?.schedule ?? [];
  return schedule.map((entry, i) => {
    const singleton = entry.singleton ?? false;
    if (singleton && !blueprint.id) {
      throw new Error(
        'materializeBlueprintTriggers: a `singleton: true` schedule trigger requires the ' +
          'blueprint id (the routine name must be blueprint-unique under the shared reserved ' +
          'host-slug). Pass the full blueprint, not just its triggers.',
      );
    }
    return {
      name: singleton ? `bp-singleton-${blueprint.id}-${i}` : `bp-schedule-${i}`,
      cron: entry.cron,
      targetRole: entry.action || DEFAULT_SCHEDULE_ACTION,
      singleton,
      singletonActive: singleton ? (entry.singletonActive ?? false) : false,
    };
  });
}

/**
 * Upsert a workspace-singleton routine — RE-RUN-SAFE (deterministic-blueprints-migration D-023).
 *
 * On FIRST creation it seeds the row DARK (`active = false`) with concurrency `skip` (matching
 * the bespoke `seed-*-routine` scripts it replaces — a slow learning tick must not pile up).
 * On CONFLICT (a re-materialize / re-install) it PRESERVES the existing `active` (NEVER darkens
 * an armed loop), `next_fire_at` (never resets the cadence), and `concurrency`, and MERGES the
 * payload (ensures `blueprintId`, keeps any owner tuning the row accumulated). This is exactly
 * the ON CONFLICT discipline the bespoke seeds use; the generic `upsertRoutine` overwrites those
 * fields (which is why a naive re-run would darken an armed loop), so singletons get this upsert.
 * A singleton row has NO harness to resolve the blueprint from, so it carries the blueprint in
 * `payload_template.blueprintId` — `system:blueprint-run` reads that and runs the program inline.
 */
async function upsertSingletonRoutine(
  sql: Sql,
  input: { workspaceId: string; name: string; cron: string; targetRole: string; blueprintId: string; seedActive: boolean },
): Promise<{ id: string }> {
  const installSlug = SINGLETON_TRIGGER_HOST_SLUG;
  const id = `rt_${installSlug}_${input.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const nextFireAt = computeNextFireAt(input.cron, new Date());
  const triggerConfig = JSON.stringify({ cron: input.cron });
  const payload = JSON.stringify({ blueprintId: input.blueprintId });
  const rows = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at, workspace_id)
    VALUES (
      ${id}, ${installSlug}, ${input.name}, 'cron',
      ${triggerConfig}::text::jsonb, ${input.targetRole},
      ${payload}::text::jsonb, 'skip', 'skip-old', ${input.seedActive},
      ${nextFireAt ? nextFireAt.toISOString() : null}::timestamptz, ${input.workspaceId}
    )
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_kind     = EXCLUDED.trigger_kind,
      trigger_config   = EXCLUDED.trigger_config,
      target_role      = EXCLUDED.target_role,
      payload_template = ${payload}::text::jsonb
        || COALESCE(harness_shared.routines.payload_template - 'blueprintId', '{}'::jsonb),
      catchup          = EXCLUDED.catchup,
      updated_at       = now()
    RETURNING id
  `;
  return { id: rows[0].id };
}

/**
 * Upsert a blueprint's schedule triggers as `harness_shared.routines` rows.
 * Returns the materialized routines ([] when the blueprint declares no schedule).
 *
 * Per-install triggers are written under `installSlug` and seeded ACTIVE — the blueprint
 * author explicitly declared the schedule. Workspace-singleton triggers (`singleton: true`,
 * D-018) are written under `SINGLETON_TRIGGER_HOST_SLUG` via the re-run-safe `upsertSingletonRoutine`
 * (seeded INACTIVE/dark on first creation; a re-run preserves an armed loop's active state +
 * tuning — D-023). Either way the routines engine itself is opt-in (`PAPERCUSP_DBOS_ROUTINES`),
 * so nothing fires until the operator enables it. `opts.sql` / `opts.workspaceId` are test seams;
 * production resolves the admin pool + active workspace.
 */
export async function materializeBlueprintTriggers(
  installSlug: string,
  blueprint: BlueprintTriggerInput,
  opts: { sql?: Sql; workspaceId?: string } = {},
): Promise<MaterializedRoutine[]> {
  const specs = triggerRoutineSpecs(blueprint);
  if (specs.length === 0) return [];
  const sql = opts.sql ?? getOrgPg().sql;
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();

  const out: MaterializedRoutine[] = [];
  for (const spec of specs) {
    if (spec.singleton) {
      // blueprint.id is guaranteed here (triggerRoutineSpecs throws for a singleton without it).
      const row = await upsertSingletonRoutine(sql, {
        workspaceId,
        name: spec.name,
        cron: spec.cron,
        targetRole: spec.targetRole,
        blueprintId: blueprint.id as string,
        seedActive: spec.singletonActive,
      });
      out.push({ ...spec, id: row.id, hostSlug: SINGLETON_TRIGGER_HOST_SLUG });
      continue;
    }
    // Per-install: real install slug, seeded ACTIVE, resolves the blueprint from its harness.
    const row = await upsertRoutine(
      sql,
      {
        workspaceId,
        installSlug,
        name: spec.name,
        triggerKind: 'cron',
        triggerConfig: { cron: spec.cron },
        targetRole: spec.targetRole,
        active: true,
      },
      computeNextFireAt,
    );
    out.push({ ...spec, id: row.id, hostSlug: installSlug });
  }
  return out;
}
