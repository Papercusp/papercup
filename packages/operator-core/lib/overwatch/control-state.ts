/**
 * control-state.ts — the persisted Start/Pause-Overwatch state + wake cadence
 * (overwatch-role-2026-06-15 B-07).
 *
 * The overwatch is a sibling autonomous loop to the Queen (D-005, per-hive). Like
 * the hive's `hive_started` bit (hive/started.ts), THIS is the load-bearing
 * control signal the overwatch loop (B-04) and its liveness watchdog (B-09) gate
 * on: a wake is armed WHILE STARTED, nothing fires while paused. The control
 * tools `overwatch:start` / `overwatch:pause` (B-07) are its only writers — the
 * loop/watchdog are pure readers (exactly the hive split, where the watchdog
 * re-arms a wake purely from `hive_started`).
 *
 * Stored in the `operator_settings` KV (PG, per storage policy — the same home
 * as `hive_started` and the wake-mode default), one row per (workspace, install):
 *   key `overwatch_started:<workspaceId>:<installSlug>`     → 'true' | 'false'
 *   key `overwatch_cadence_sec:<workspaceId>:<installSlug>` → '<int seconds>'
 *
 * No migration: it reuses the existing KV table + its `ON CONFLICT (key)` upsert,
 * exactly as hive/started.ts does.
 */
import { getOrgPg } from '@papercusp/db-org';

const STARTED_PREFIX = 'overwatch_started:';
const CADENCE_PREFIX = 'overwatch_cadence_sec:';

/**
 * Default wake cadence. The overwatch is a SHORT-TERM control loop (catch drift +
 * nudge it back in real time), so it runs MORE responsively than the Queen's
 * ~30 min scheduler cadence (plan architecture: "Queen = scheduler, NOW;
 * Overwatch = control-loop, SHORT-TERM").
 */
export const DEFAULT_OVERWATCH_CADENCE_SEC = 600; // 10 min
/** Floor — the anti-spin guard (a control loop must not thrash, D-002). */
export const MIN_OVERWATCH_CADENCE_SEC = 60; // 1 min
/** Ceiling — beyond this the loop is too slow to be a live supervisor. */
export const MAX_OVERWATCH_CADENCE_SEC = 3600; // 1 h

const startedKey = (workspaceId: string, installSlug: string): string =>
  `${STARTED_PREFIX}${workspaceId}:${installSlug}`;
const cadenceKey = (workspaceId: string, installSlug: string): string =>
  `${CADENCE_PREFIX}${workspaceId}:${installSlug}`;

/** Clamp a requested cadence into [MIN, MAX]; non-finite → the default. */
export function clampOverwatchCadenceSec(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_OVERWATCH_CADENCE_SEC;
  return Math.min(MAX_OVERWATCH_CADENCE_SEC, Math.max(MIN_OVERWATCH_CADENCE_SEC, Math.round(sec)));
}

async function readSetting(key: string): Promise<string | undefined> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT value FROM harness_shared.operator_settings WHERE key = ${key} LIMIT 1`;
  return (rows[0] as { value?: string } | undefined)?.value;
}

async function writeSetting(key: string, value: string, description: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at)
    VALUES (${key}, ${value}, ${description}, ${Date.now()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

/** Whether the overwatch is started (default false — born paused/idle, like the hive). */
export async function getOverwatchStarted(workspaceId: string, installSlug: string): Promise<boolean> {
  return (await readSetting(startedKey(workspaceId, installSlug))) === 'true';
}

export async function setOverwatchStarted(
  workspaceId: string,
  installSlug: string,
  started: boolean,
): Promise<void> {
  await writeSetting(
    startedKey(workspaceId, installSlug),
    started ? 'true' : 'false',
    'Start/Pause Overwatch state (overwatch-role B-07). true = the overwatch supervisor loop should be running; the loop (B-04) + liveness watchdog (B-09) hold the wake-armed invariant only while true.',
  );
}

/** The configured wake cadence (seconds), clamped; the default when unset/invalid. */
export async function getOverwatchCadenceSec(workspaceId: string, installSlug: string): Promise<number> {
  const raw = await readSetting(cadenceKey(workspaceId, installSlug));
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? clampOverwatchCadenceSec(n) : DEFAULT_OVERWATCH_CADENCE_SEC;
}

/** Persist the wake cadence (clamped); returns the clamped value actually stored. */
export async function setOverwatchCadenceSec(
  workspaceId: string,
  installSlug: string,
  sec: number,
): Promise<number> {
  const clamped = clampOverwatchCadenceSec(sec);
  await writeSetting(
    cadenceKey(workspaceId, installSlug),
    String(clamped),
    'Overwatch wake cadence in seconds (overwatch-role B-07). The loop (B-04) declares its next wake this far out while started.',
  );
  return clamped;
}

/**
 * Every (workspace, install) currently marked started — the loop's routine sweep
 * (B-04) and the liveness watchdog (B-09) iterate exactly this set, mirroring
 * `listStartedHives()`.
 */
export async function listStartedOverwatches(): Promise<Array<{ workspaceId: string; installSlug: string }>> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT key FROM harness_shared.operator_settings
    WHERE key LIKE ${STARTED_PREFIX + '%'} AND value = 'true'
  `;
  const out: Array<{ workspaceId: string; installSlug: string }> = [];
  for (const r of rows as unknown as Array<{ key: string }>) {
    const rest = r.key.slice(STARTED_PREFIX.length);
    // workspace ids and install slugs are colon-free (slug charset is
    // [a-z0-9-]); the FIRST ':' is the separator (same parse as listStartedHives).
    const i = rest.indexOf(':');
    if (i <= 0) continue;
    out.push({ workspaceId: rest.slice(0, i), installSlug: rest.slice(i + 1) });
  }
  return out;
}
