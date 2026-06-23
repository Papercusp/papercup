/**
 * started.ts — the persisted Start/Pause-Hive state
 * (start-hive-wake-orchestration-2026-06-09 P-004 / D-006).
 *
 * A net-new boolean: is this hive STARTED (the colony is meant to be running
 * autonomously) or PAUSED? Nothing persisted this before — the wake declaration
 * said *when* the Queen next wakes, never *whether the hive is supposed to be
 * alive at all*. The watchdog (./watchdog.ts) keys its entire liveness
 * invariant off this bit (D-002: a time wake is always armed WHILE STARTED),
 * and hive:start / hive:pause are its only writers.
 *
 * Stored in the `operator_settings` KV (PG, per storage policy — same home as
 * the wake-mode default, agent-tools/coordination/wake-mode.ts), one row per
 * (workspace, install): key `hive_started:<workspaceId>:<installSlug>`.
 *
 * K1 workspace-brain re-key (workspace-scoped-coordination-2026-06-20 P-003 /
 * D-006/D-007): when FLAGS.WORKSPACE_COORDINATION is ON, the started bit
 * collapses to ONE row per WORKSPACE — the install dimension is replaced by the
 * shared workspace SENTINEL (= workspaceId) via `workspaceBrainScopeKey`, so the
 * one workspace Queen has a single liveness bit spanning all the workspace's
 * hives. Every read ships a READ-FALLBACK to the legacy per-hive row
 * (`workspaceBrainReadKeys`) so the live single-hive workspace stays
 * zero-regression pre-backfill. Flag OFF (the dark default) ⇒ the legacy
 * per-(ws,install) keying, byte-identical to today.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  isWorkspaceCoordinationOn,
  workspaceBrainScopeKey,
  workspaceBrainReadKeys,
} from '../workspace-brain-scope';

const PREFIX = 'hive_started:';
const key = (workspaceId: string, installSlug: string): string => `${PREFIX}${workspaceId}:${installSlug}`;

/** Whether the hive is started (default false — a hive is born paused/idle).
 *  K1: ON ⇒ read the workspace-sentinel row first, then fall back to the legacy
 *  per-hive row (zero regression pre-backfill). OFF ⇒ the per-hive row only,
 *  byte-identical to today. */
export async function getHiveStarted(workspaceId: string, installSlug: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const on = await isWorkspaceCoordinationOn();
  // OFF → exactly one key (installSlug); the loop is byte-identical to the
  // single-row read it replaces.
  for (const scope of workspaceBrainReadKeys(workspaceId, installSlug, on)) {
    const rows = await sql`
      SELECT value FROM harness_shared.operator_settings WHERE key = ${key(workspaceId, scope)} LIMIT 1`;
    const v = (rows[0] as { value?: string } | undefined)?.value;
    if (v != null) return v === 'true';
  }
  return false;
}

/** K1: ON ⇒ write the workspace-sentinel row (the install dimension collapses);
 *  OFF ⇒ the per-hive row, byte-identical to today. */
export async function setHiveStarted(
  workspaceId: string,
  installSlug: string,
  started: boolean,
): Promise<void> {
  const { sql } = getOrgPg();
  const scope = workspaceBrainScopeKey(workspaceId, installSlug, await isWorkspaceCoordinationOn());
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at)
    VALUES (
      ${key(workspaceId, scope)},
      ${started ? 'true' : 'false'},
      ${'Start/Pause Hive state (start-hive-wake P-004 / D-006). true = the colony should be running; the watchdog holds the liveness invariant only while true.'},
      ${Date.now()}
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

/** Parse the raw `hive_started:<ws>:<install>` rows currently marked started. */
async function readStartedRows(): Promise<Array<{ workspaceId: string; installSlug: string }>> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT key FROM harness_shared.operator_settings
    WHERE key LIKE ${PREFIX + '%'} AND value = 'true'
  `;
  const out: Array<{ workspaceId: string; installSlug: string }> = [];
  for (const r of rows as unknown as Array<{ key: string }>) {
    const rest = r.key.slice(PREFIX.length);
    // workspace ids and install slugs are colon-free (slug charset is
    // [a-z0-9-]); the FIRST ':' is the separator.
    const i = rest.indexOf(':');
    if (i <= 0) continue;
    out.push({ workspaceId: rest.slice(0, i), installSlug: rest.slice(i + 1) });
  }
  return out;
}

/** Every (workspace, install) currently marked started — the boot-check (P-010)
 *  and the routinesTick sweep (P-011) iterate exactly this set.
 *
 *  Byte-identical to today: the raw per-(ws,install) started rows, parsed. The
 *  workspace-brain de-dup (K1, when WORKSPACE_COORDINATION is ON) lives in
 *  `listStartedWorkspaceLoops()` so the per-hive placement gate (orchestrator
 *  `resolveTickHarnesses`) keeps gating per real hive slug. */
export async function listStartedHives(): Promise<Array<{ workspaceId: string; installSlug: string }>> {
  return readStartedRows();
}

/**
 * The DE-DUPED Queen-liveness loop set (K1, workspace-scoped-coordination P-003
 * / D-006). The liveness loops (watchdog boot/sweep, throughput) must run ONE
 * loop per workspace under the workspace Queen, not N per-hive loops.
 *
 * - OFF (the dark default) ⇒ the raw per-(ws,install) set, BYTE-IDENTICAL to
 *   `listStartedHives()` — every existing liveness loop is unchanged.
 * - ON ⇒ collapse to ONE entry per started workspace, seated at the workspace's
 *   home hive (`resolveHiveHomeSlug`, = `PAPERCUSP_HIVE_HOME_SLUG`), so the
 *   single workspace loop's liveness/wake keys resolve against the same sentinel
 *   the wake routine (./wake.ts) is re-keyed to. The seat-home falls back to the
 *   row's own install slug when no env home is set (multi-home pre-flip stays
 *   sane); for the live single-hive workspace papercusp==papercusp-workspace the
 *   seat-home IS that hive → zero regression.
 */
export async function listStartedWorkspaceLoops(): Promise<
  Array<{ workspaceId: string; installSlug: string }>
> {
  const rows = await readStartedRows();
  if (!(await isWorkspaceCoordinationOn())) return rows;
  // ON: one loop per workspace, seated at the workspace home hive.
  const { resolveHiveHomeSlug } = await import('./wake');
  const seen = new Set<string>();
  const out: Array<{ workspaceId: string; installSlug: string }> = [];
  for (const r of rows) {
    if (seen.has(r.workspaceId)) continue;
    seen.add(r.workspaceId);
    // The env home is workspace-agnostic today (single live workspace); fall back
    // to this row's install when unset so a never-env'd box still resolves a seat.
    const seatHome = resolveHiveHomeSlug(undefined, undefined) ?? r.installSlug;
    out.push({ workspaceId: r.workspaceId, installSlug: seatHome });
  }
  return out;
}
