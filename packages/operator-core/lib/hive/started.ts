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

/**
 * The RAW per-hive started row (`hive_started:<ws>:<slug>`) — the PER-HIVE
 * placement/display bit, IGNORING the workspace-sentinel collapse (per-hive
 * start-stop 2026-06-30). Default false. This answers "is THIS hive's work
 * placed", DISTINCT from {@link getHiveStarted} (sentinel-first = "is the
 * workspace Queen loop running" under WORKSPACE_COORDINATION).
 */
export async function getHivePlacementStarted(workspaceId: string, installSlug: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT value FROM harness_shared.operator_settings WHERE key = ${key(workspaceId, installSlug)} LIMIT 1`;
  return (rows[0] as { value?: string } | undefined)?.value === 'true';
}

/** Write the RAW per-hive started row (the per-hive placement/display bit). */
export async function setHivePlacementStarted(
  workspaceId: string,
  installSlug: string,
  started: boolean,
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at)
    VALUES (
      ${key(workspaceId, installSlug)},
      ${started ? 'true' : 'false'},
      ${'Per-hive Start/Stop placement bit (per-hive start-stop 2026-06-30). true = this hive\'s work is placed by the workspace Queen.'},
      ${Date.now()}
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

/**
 * Whether ANY hive in the workspace still has its per-hive placement bit set,
 * EXCLUDING the workspace sentinel row (installSlug === workspaceId) and an
 * optional just-stopped slug. hive:pause uses this to decide whether stopping
 * THIS hive also idles the workspace Queen LOOP (sentinel off) — the one loop
 * stays up while any other hive remains started.
 */
export async function anyHivePlacementStarted(workspaceId: string, excludeSlug?: string): Promise<boolean> {
  const rows = await readStartedRows();
  return rows.some(
    (r) => r.workspaceId === workspaceId && r.installSlug !== workspaceId && r.installSlug !== excludeSlug,
  );
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

/** Coerce an operator_settings.updated_at value (stored as a Date.now() ms-epoch
 *  number by setHiveStarted, but tolerant of a numeric string or a timestamptz)
 *  to ms-epoch, or null when unparseable. */
function toEpochMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.getTime();
  const s = String(v);
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Every (workspace, install) currently marked PAUSED (value='false'), with the
 *  ms-epoch it was last paused (updated_at — for a row whose current value is
 *  'false' that is the pause time). The paused-hive recovery watchdog
 *  (autonomous-loop-canary-reliability P-003) iterates this set: a hive paused
 *  with standing demand is a SILENT OUTAGE the started-only seams cannot see
 *  (they skip !started). pausedAtMs is null when the timestamp is unreadable —
 *  the sweep then declines to act blind. */
export async function listPausedHives(): Promise<
  Array<{ workspaceId: string; installSlug: string; pausedAtMs: number | null }>
> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT key, updated_at FROM harness_shared.operator_settings
    WHERE key LIKE ${PREFIX + '%'} AND value = 'false'
  `;
  const out: Array<{ workspaceId: string; installSlug: string; pausedAtMs: number | null }> = [];
  for (const r of rows as unknown as Array<{ key: string; updated_at: unknown }>) {
    const rest = r.key.slice(PREFIX.length);
    const i = rest.indexOf(':');
    if (i <= 0) continue;
    out.push({
      workspaceId: rest.slice(0, i),
      installSlug: rest.slice(i + 1),
      pausedAtMs: toEpochMs(r.updated_at),
    });
  }
  return out;
}
