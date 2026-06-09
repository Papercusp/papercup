/**
 * Per-harness git-sync routine config (git-sync-auto-commit P-003). A harness's
 * git-sync schedule is a `harness_shared.routines` row with
 * target_role='system:git-sync' — these wrap db-org's routine primitives so the
 * schedule is editable as ordinary harness config (the routines:list/set tools +
 * the P-015 seed use these).
 *
 * Pass the owning `workspaceId` explicitly — `harness_shared.routines.workspace_id`
 * is NOT NULL with no column default and no fill trigger (there is no
 * `app.workspace_id` GUC trigger, despite earlier comments here that claimed one).
 */
import type { Sql } from 'postgres';
import { upsertRoutine, setRoutineActive, type RoutineRow } from '@papercusp/db-org';
import { computeNextFireAt } from '../routines/cron';

export const GIT_SYNC_ROUTINE_NAME = 'git-sync';
export const GIT_SYNC_TARGET = 'system:git-sync';
// Every 10 minutes — matches the live `papercup` cadence (trigger_config.cron); the
// superproject's branch is `staging` and lives in trigger_config, not here.
export const DEFAULT_GIT_SYNC_CRON = '0 */10 * * * *';

export interface GitSyncRoutineInput {
  /** Owning workspace_id (routines.workspace_id is NOT NULL, no default). */
  workspaceId: string;
  installSlug: string;
  cron?: string;
  push?: boolean;
  pushSubmodules?: boolean;
  /** Seeded INACTIVE by default — go-live flips this to true. */
  active?: boolean;
}

/** Create or update a harness's `system:git-sync` routine. */
export async function upsertGitSyncRoutine(sql: Sql, input: GitSyncRoutineInput): Promise<RoutineRow> {
  return upsertRoutine(
    sql,
    {
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
      name: GIT_SYNC_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: {
        cron: input.cron ?? DEFAULT_GIT_SYNC_CRON,
        push: input.push ?? true,
        push_submodules: input.pushSubmodules ?? true,
        merge_strategy: 'merge',
      },
      targetRole: GIT_SYNC_TARGET,
      active: input.active ?? false,
    },
    computeNextFireAt,
  );
}

/** Read a harness's git-sync routine, or null if none seeded. */
export async function getGitSyncRoutine(sql: Sql, installSlug: string): Promise<RoutineRow | null> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT * FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND target_role = ${GIT_SYNC_TARGET}
     LIMIT 1
  `;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id ?? ''),
    installSlug: String(r.install_slug),
    name: String(r.name),
    triggerKind: r.trigger_kind as RoutineRow['triggerKind'],
    triggerConfig: (r.trigger_config ?? {}) as RoutineRow['triggerConfig'],
    targetRole: String(r.target_role),
    payloadTemplate: (r.payload_template ?? null) as RoutineRow['payloadTemplate'],
    concurrency: r.concurrency as RoutineRow['concurrency'],
    catchup: r.catchup as RoutineRow['catchup'],
    active: Boolean(r.active),
    lastFiredAt: (r.last_fired_at ?? null) as Date | null,
    nextFireAt: (r.next_fire_at ?? null) as Date | null,
  };
}

/** Enable/disable a harness's git-sync routine (go-live = setGitSyncRoutineActive(sql, slug, true)). */
export async function setGitSyncRoutineActive(sql: Sql, installSlug: string, active: boolean): Promise<boolean> {
  return setRoutineActive(sql, installSlug, GIT_SYNC_ROUTINE_NAME, active);
}
