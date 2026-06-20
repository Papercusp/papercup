/**
 * Watchdog-tunables config helper (live-configurability-audit-2026-06-20 P-004 — the CANARY).
 *
 * The `improvement-watchdog` routine already reads its numeric tick bars/caps from its
 * `payload_template` at fire time (`watchdogOptionsFromPayload` + `PAYLOAD_TUNABLE_KEYS`),
 * so tuning them needs NO new schema — the override IS the routine row's payload column.
 * This module is the thin read/merge/restore layer over that one column; the
 * `improvements:set-watchdog-tunables` tool composes it through `runControlMutation`
 * (dryRun + verify/auto-revert + audit + one-call revert).
 *
 * REUSE-FIRST: no new operator-state table — we read+write `harness_shared.routines`
 * directly (the same admin-connection + explicit-workspace_id pattern the routine
 * seeder uses), targeting the one watchdog row by (workspace_id, install_slug, name).
 *
 * NOTE the env override: `PAPERCUSP_IMPROVEMENT_WATCHDOG_MAX_PER_TICK` still wins over the
 * payload for `maxPerTick` at tick time (the emergency override). This module reads/writes
 * the PAYLOAD layer only — `tunables` here is the standing config, not the tick-effective value.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { PAYLOAD_TUNABLE_KEYS, watchdogOptionsFromPayload } from './watchdog';

/** The routine whose payload_template carries the watchdog tunables (see seed-improvement-routines). */
const ROUTINE_NAME = 'improvement-watchdog';

/** Same slug resolution the seeder uses, so we target the row it created. */
function routineSlug(): string {
  return process.env.IMPROVEMENT_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
}

export type WatchdogTunableKey = (typeof PAYLOAD_TUNABLE_KEYS)[number];
export type WatchdogTunablePatch = Partial<Record<WatchdogTunableKey, number>>;

export interface WatchdogTunablesSnapshot {
  /** The full `payload_template` jsonb, preserved verbatim so a revert restores it exactly
   *  (including any non-tunable keys we never touch). `null` = the routine has no payload yet. */
  payload: Record<string, unknown> | null;
  /** The recognized numeric tunables currently in effect at the PAYLOAD layer. */
  tunables: WatchdogTunablePatch;
}

function snapshot(payload: Record<string, unknown> | null): WatchdogTunablesSnapshot {
  return { payload, tunables: watchdogOptionsFromPayload(payload) as WatchdogTunablePatch };
}

/** Read the watchdog routine's current payload tunables (the `capturePrev` for the control tool). */
export async function readWatchdogTunables(): Promise<WatchdogTunablesSnapshot> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const slug = routineSlug();
  const rows = await sql<{ payload_template: Record<string, unknown> | null }[]>`
    SELECT payload_template
      FROM harness_shared.routines
     WHERE workspace_id = ${ws} AND install_slug = ${slug} AND name = ${ROUTINE_NAME}
     LIMIT 1`;
  return snapshot(rows[0]?.payload_template ?? null);
}

/** Merge a validated numeric patch into the routine's payload_template; returns the new snapshot.
 *  jsonb `||` overrides only the patched keys, preserving everything else in the payload. */
export async function applyWatchdogTunables(patch: WatchdogTunablePatch): Promise<WatchdogTunablesSnapshot> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const slug = routineSlug();
  const rows = await sql<{ payload_template: Record<string, unknown> | null }[]>`
    UPDATE harness_shared.routines
       SET payload_template = COALESCE(payload_template, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
           updated_at = now()
     WHERE workspace_id = ${ws} AND install_slug = ${slug} AND name = ${ROUTINE_NAME}
   RETURNING payload_template`;
  if (rows.length === 0) {
    throw new Error(
      `improvement-watchdog routine not found for install_slug='${slug}' — seed it first (seed-improvement-routines).`,
    );
  }
  return snapshot(rows[0].payload_template ?? null);
}

/** Restore the full payload_template wholesale — the revert primitive (replays `capturePrev`'s payload). */
export async function restoreWatchdogPayload(payload: Record<string, unknown> | null): Promise<void> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const slug = routineSlug();
  await sql`
    UPDATE harness_shared.routines
       SET payload_template = ${payload === null ? null : JSON.stringify(payload)}::jsonb,
           updated_at = now()
     WHERE workspace_id = ${ws} AND install_slug = ${slug} AND name = ${ROUTINE_NAME}`;
}
