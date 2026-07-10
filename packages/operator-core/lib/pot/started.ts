/**
 * started.ts — the persisted Start/Pause-Pot state
 * (start-hive-wake-orchestration-2026-06-09 P-004 / D-006).
 *
 * A net-new boolean: is this pot STARTED (the colony is meant to be running
 * autonomously) or PAUSED? Nothing persisted this before — the wake declaration
 * said *when* the Mug next wakes, never *whether the pot is supposed to be
 * alive at all*. The watchdog (./watchdog.ts) keys its entire liveness
 * invariant off this bit (D-002: a time wake is always armed WHILE STARTED),
 * and pot:start / pot:pause are its only writers.
 *
 * Stored in the `operator_settings` KV (PG, per storage policy — same home as
 * the wake-mode default, agent-tools/coordination/wake-mode.ts), one row per
 * (workspace, install): key `hive_started:<workspaceId>:<installSlug>`.
 *
 * K1 workspace-brain re-key (workspace-scoped-coordination-2026-06-20 P-003 /
 * D-006/D-007): when FLAGS.WORKSPACE_COORDINATION is ON, the started bit
 * collapses to ONE row per WORKSPACE — the install dimension is replaced by the
 * shared workspace PAPERCUP (= workspaceId) via `workspaceBrainScopeKey`, so the
 * one workspace Mug has a single liveness bit spanning all the workspace's
 * hives. Every read ships a READ-FALLBACK to the legacy per-pot row
 * (`workspaceBrainReadKeys`) so the live single-pot workspace stays
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

// Pause PROVENANCE (WI-3261, owner-reported: "I keep pausing the Mug and it keeps
// mysteriously getting unpaused"). The started bit alone can't tell a DELIBERATE
// owner pause (pot:pause) from a plain paused/idle state — so the paused-pot
// recovery watchdog (./watchdog.ts pausedPotRecoverySweep) treated "paused past
// the stale threshold + demand queued" as a silent outage and auto-resumed it,
// which is EXACTLY what an intentional pause with queued work looks like. This
// parallel bit records "was the CURRENT pause deliberate" so the sweep can alert
// without ever auto-resuming an owner-initiated pause. Cleared on every resume
// (started:true), regardless of caller, so it never lingers stale.
const DELIBERATE_PREFIX = 'hive_paused_deliberate:';
const deliberateKey = (workspaceId: string, scope: string): string => `${DELIBERATE_PREFIX}${workspaceId}:${scope}`;

async function setPotPausedDeliberate(workspaceId: string, scope: string, deliberate: boolean): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (
      ${deliberateKey(workspaceId, scope)},
      ${deliberate ? 'true' : 'false'},
      ${'Pause provenance (WI-3261). true = the CURRENT pause was owner-initiated (pot:pause) — the paused-pot recovery watchdog must never auto-resume it, only alert. Cleared on every resume.'},
      ${Date.now()},
      ${workspaceId}
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

/** Whether the pot is started (default false — a pot is born paused/idle).
 *  K1: ON ⇒ read the workspace-papercup row first, then fall back to the legacy
 *  per-pot row (zero regression pre-backfill). OFF ⇒ the per-pot row only,
 *  byte-identical to today. */
export async function getPotStarted(workspaceId: string, installSlug: string): Promise<boolean> {
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

/** K1: ON ⇒ write the workspace-papercup row (the install dimension collapses);
 *  OFF ⇒ the per-pot row, byte-identical to today. `deliberate` (WI-3261) marks
 *  a `started:false` write as an OWNER-INITIATED pause (pot:pause passes true);
 *  any `started:true` write (a resume, from ANY caller including the watchdog's
 *  own auto-resume) always CLEARS it. Ignored when `started` is true. */
export async function setPotStarted(
  workspaceId: string,
  installSlug: string,
  started: boolean,
  opts: { deliberate?: boolean } = {},
): Promise<void> {
  const { sql } = getOrgPg();
  const scope = workspaceBrainScopeKey(workspaceId, installSlug, await isWorkspaceCoordinationOn());
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (
      ${key(workspaceId, scope)},
      ${started ? 'true' : 'false'},
      ${'Start/Pause Pot state (start-pot-wake P-004 / D-006). true = the colony should be running; the watchdog holds the liveness invariant only while true.'},
      ${Date.now()},
      ${workspaceId}
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
  await setPotPausedDeliberate(workspaceId, scope, started ? false : (opts.deliberate ?? false));
}

/**
 * The RAW per-pot started row (`hive_started:<ws>:<slug>`) — the PER-POT
 * placement/display bit, IGNORING the workspace-papercup collapse (per-pot
 * start-stop 2026-06-30). Default false. This answers "is THIS pot's work
 * placed", DISTINCT from {@link getPotStarted} (papercup-first = "is the
 * workspace Mug loop running" under WORKSPACE_COORDINATION).
 */
export async function getPotPlacementStarted(workspaceId: string, installSlug: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT value FROM harness_shared.operator_settings WHERE key = ${key(workspaceId, installSlug)} LIMIT 1`;
  return (rows[0] as { value?: string } | undefined)?.value === 'true';
}

/** Write the RAW per-pot started row (the per-pot placement/display bit).
 *  `deliberate` (WI-3309, the Mug auto-unpause RECURRENCE): the per-pot Stop is
 *  what pot:pause writes for a single pot (the papercup-scoped setPotStarted
 *  only fires when the LAST pot pauses), so without its own provenance bit an
 *  owner's per-pot pause read as `deliberate:false` — a "silent outage" — to
 *  the paused-pot recovery sweep, which then auto-resumed it. Same semantics
 *  as setPotStarted: a resume (started:true) always CLEARS the bit. */
export async function setPotPlacementStarted(
  workspaceId: string,
  installSlug: string,
  started: boolean,
  opts: { deliberate?: boolean } = {},
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (
      ${key(workspaceId, installSlug)},
      ${started ? 'true' : 'false'},
      ${'Per-pot Start/Stop placement bit (per-pot start-stop 2026-06-30). true = this pot\'s work is placed by the workspace Mug.'},
      ${Date.now()},
      ${workspaceId}
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
  await setPotPausedDeliberate(workspaceId, installSlug, started ? false : (opts.deliberate ?? false));
}

/**
 * Whether ANY pot in the workspace still has its per-pot placement bit set,
 * EXCLUDING the workspace papercup row (installSlug === workspaceId) and an
 * optional just-stopped slug. pot:pause uses this to decide whether stopping
 * THIS pot also idles the workspace Mug LOOP (papercup off) — the one loop
 * stays up while any other pot remains started.
 */
export async function anyPotPlacementStarted(workspaceId: string, excludeSlug?: string): Promise<boolean> {
  const rows = await readStartedRows();
  const candidates = rows.filter(
    (r) => r.workspaceId === workspaceId && r.installSlug !== workspaceId && r.installSlug !== excludeSlug,
  );
  if (candidates.length === 0) return false;
  // WI-3193 (owner-reported: "I clicked Stop / paused the mug and it kept running"):
  // ONLY a CURRENTLY-REGISTERED pot keeps the workspace Mug loop alive. A stale
  // `hive_started:<ws>:<slug>='true'` row left behind by a dead/unregistered test-pot
  // must NOT pin loopIdle=false forever — that made pot:pause skip idling the Mug
  // (the papercup stayed `true`, so the liveness watchdog re-armed the wake within its
  // ~30s tick AND the declare_wake paused-gate never tripped), so the UI "Stop" flipped
  // the per-pot placement bit but the pot kept waking. Intersect the started rows with
  // the registry's kind:'hive' slugs. Fail-open to the prior (unfiltered) result if the
  // registry is unreadable — a rare, transient case where we must not wrongly idle a
  // legitimately-running sibling pot.
  try {
    const { loadHarnessRegistry } = await import('../harness-registry');
    const reg = await loadHarnessRegistry(workspaceId);
    const registeredPotSlugs = new Set(
      reg.projects.filter((p) => p.harness_kind === 'hive').map((p) => p.slug),
    );
    return candidates.some((r) => registeredPotSlugs.has(r.installSlug));
  } catch {
    return candidates.length > 0;
  }
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
 *  `listStartedWorkspaceLoops()` so the per-pot placement gate (orchestrator
 *  `resolveTickHarnesses`) keeps gating per real pot slug. */
export async function listStartedPots(): Promise<Array<{ workspaceId: string; installSlug: string }>> {
  return readStartedRows();
}

/**
 * The DE-DUPED Mug-liveness loop set (K1, workspace-scoped-coordination P-003
 * / D-006). The liveness loops (watchdog boot/sweep, throughput) must run ONE
 * loop per workspace under the workspace Mug, not N per-pot loops.
 *
 * - OFF (the dark default) ⇒ the raw per-(ws,install) set, BYTE-IDENTICAL to
 *   `listStartedPots()` — every existing liveness loop is unchanged.
 * - ON ⇒ collapse to ONE entry per started workspace, seated at the workspace's
 *   home pot (`resolvePotHomeSlug`, = `PAPERCUSP_POT_HOME_SLUG`), so the
 *   single workspace loop's liveness/wake keys resolve against the same papercup
 *   the wake routine (./wake.ts) is re-keyed to. The seat-home falls back to the
 *   row's own install slug when no env home is set (multi-home pre-flip stays
 *   sane); for the live single-pot workspace papercusp==papercusp-workspace the
 *   seat-home IS that pot → zero regression.
 */
export async function listStartedWorkspaceLoops(): Promise<
  Array<{ workspaceId: string; installSlug: string }>
> {
  const rows = await readStartedRows();
  if (!(await isWorkspaceCoordinationOn())) return rows;
  // ON: one loop per workspace, seated at the workspace home pot.
  const { resolvePotHomeSlug } = await import('./wake');
  // The papercup row's installSlug is the workspace id, not necessarily a
  // registered pot.  Never seat a live loop on that synthetic/dead target.
  // Registry failure is fail-closed here: an unvalidated seat is worse than a
  // temporarily skipped supervisor, because it creates a durable wake loop no
  // process can consume.
  const seen = new Set<string>();
  const out: Array<{ workspaceId: string; installSlug: string }> = [];
  for (const r of rows) {
    if (seen.has(r.workspaceId)) continue;
    seen.add(r.workspaceId);
    let registeredPotSlugs: Set<string>;
    try {
      const { loadHarnessRegistry } = await import('../harness-registry');
      const registry = await loadHarnessRegistry(r.workspaceId);
      registeredPotSlugs = new Set(
        registry.projects.filter((p) => p.harness_kind === 'hive').map((p) => p.slug),
      );
    } catch {
      continue;
    }
    // The env home is workspace-agnostic today (single live workspace), but it
    // must still be validated. Prefer it, then a real started pot in this
    // workspace; never return the workspace papercup as a seat.
    const envHome = resolvePotHomeSlug(undefined, undefined);
    const seatHome = [
      envHome,
      ...rows
        .filter((candidate) => candidate.workspaceId === r.workspaceId)
        .map((candidate) => candidate.installSlug),
    ].find((candidate) => candidate && registeredPotSlugs.has(candidate));
    if (seatHome) out.push({ workspaceId: r.workspaceId, installSlug: seatHome });
  }
  return out;
}

/** Coerce an operator_settings.updated_at value (stored as a Date.now() ms-epoch
 *  number by setPotStarted, but tolerant of a numeric string or a timestamptz)
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
 *  'false' that is the pause time), and whether the CURRENT pause is deliberate
 *  (WI-3261 provenance — owner-initiated via pot:pause, vs a plain paused/idle
 *  state). The paused-pot recovery watchdog (autonomous-loop-canary-reliability
 *  P-003) iterates this set: a pot paused with standing demand is a SILENT
 *  OUTAGE the started-only seams cannot see (they skip !started) — but it must
 *  never auto-resume a `deliberate` pause (only alert). pausedAtMs is null when
 *  the timestamp is unreadable — the sweep then declines to act blind. */
export async function listPausedPots(): Promise<
  Array<{ workspaceId: string; installSlug: string; pausedAtMs: number | null; deliberate: boolean }>
> {
  const { sql } = getOrgPg();
  const [pausedRows, deliberateRows] = await Promise.all([
    sql`
      SELECT key, updated_at FROM harness_shared.operator_settings
      WHERE key LIKE ${PREFIX + '%'} AND value = 'false'
    `,
    sql`
      SELECT key FROM harness_shared.operator_settings
      WHERE key LIKE ${DELIBERATE_PREFIX + '%'} AND value = 'true'
    `,
  ]);
  const deliberateSet = new Set(
    (deliberateRows as unknown as Array<{ key: string }>).map((r) => r.key.slice(DELIBERATE_PREFIX.length)),
  );
  const out: Array<{ workspaceId: string; installSlug: string; pausedAtMs: number | null; deliberate: boolean }> = [];
  for (const r of pausedRows as unknown as Array<{ key: string; updated_at: unknown }>) {
    const rest = r.key.slice(PREFIX.length);
    const i = rest.indexOf(':');
    if (i <= 0) continue;
    out.push({
      workspaceId: rest.slice(0, i),
      installSlug: rest.slice(i + 1),
      pausedAtMs: toEpochMs(r.updated_at),
      deliberate: deliberateSet.has(rest),
    });
  }
  return out;
}
