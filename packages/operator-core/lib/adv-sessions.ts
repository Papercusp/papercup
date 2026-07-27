/**
 * adv-sessions.ts — server-side lifecycle helpers for the /adv
 * Sessions surface. Wraps the `harness_shared.adv_sessions` table
 * (migration 079, ensured at runtime via ensureAdvSessionsTable).
 *
 * Two writers:
 *   - `recordAdvSession` inserts a row at spawn time and returns the
 *     new row id.
 *   - `markAdvSessionEnded` updates the row when the child exits.
 *
 * One reader: `listAdvSessions`, used by both the UI route and the
 * `adv:sessions_list` MCP tool (later).
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import type { SuAgent } from './su-agents';

/**
 * Log a best-effort read/write failure UNLESS it's PG's undefined_table
 * (42P01) — a minimal/isolated schema (many unit/integration test fixtures
 * build only the tables their scenario needs) legitimately lacks
 * harness_shared.adv_sessions, and every function in this file already
 * degrades cleanly (returns [] / null / no-op) on any error. Warning on that
 * EXPECTED case was pure noise that, under vitest-fail-on-console, turned
 * into red tests unrelated to adv-sessions itself (EI-8194) — the same
 * 42P01-swallow precedent used elsewhere (work-items.ts, decision-ledger,
 * sync-resolver). Real, unexpected errors still warn loudly.
 */
function warnUnlessMissingTable(e: unknown, label: string): void {
  if ((e as { code?: string } | undefined)?.code === '42P01') return;
  console.warn(`[adv-sessions] ${label} failed:`, (e as Error).message);
}

export interface AdvSessionRow {
  id: number;
  workspaceId: string;
  planSlug: string | null;
  /** Which agent CLI backs this session; null for pre-*-su rows. */
  agent: SuAgent | null;
  /** Pipeline role this session runs as (worker/validator/…); null = plain SU/engineer. */
  role: string | null;
  /** Feature the role session is scoped to; null when none. */
  feature: string | null;
  mode: 'omp' | 'console';
  terminalBin: string | null;
  pid: number | null;
  windowId: string | null;
  ompThreadId: string | null;
  label: string | null;
  cwd: string | null;
  /** The coord identity (PAPERCUSP_SID) baked into the session env — the
   *  join key to coord_presence.owner_id for the live roster. null for
   *  console launches and pre-existing rows (no SID minted at record time). */
  coordOwnerId: string | null;
  /** The agent's NATIVE session id (claude/codex UUID) when psu forces +
   *  records it — the join key that lets `psu --resume <native-uuid>`
   *  correlate this row. null for omp (uses ompThreadId), codex (resumes via
   *  its per-session CODEX_HOME), and rows that predate native-id tracking. */
  sessionId: string | null;
  /** Pane-worthiness hint (pui-reactive-session-panes D-002/D-006): 'workbench'
   *  marks an INTERACTIVE launch the pui should reactively open a pane for;
   *  null for normal already-spawned sessions + autonomous cup:spawn rows. */
  display: string | null;
  /** The exact argv the pui pane runs for a pending workbench launch (a fresh
   *  `psu …`). null for non-deferred rows. */
  launchArgv: string[] | null;
  /** When the pui consumed a pending workbench launch by opening its pane.
   *  A PENDING launch is `display='workbench' AND launchedAt IS NULL AND
   *  endedAt IS NULL`; once set the row drops out of the pending roster tier. */
  launchedAt: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  /** Cross-backend session-port lineage. A port target remains hidden from
   * resumable surfaces until portStatus='delivered'. */
  portId?: string | null;
  portSourceAdvSessionId?: number | null;
  portStatus?: string | null;
  portMetadata?: Record<string, unknown> | null;
}

export interface RecordOpts {
  planSlug?: string | null;
  agent?: SuAgent | null;
  /** Pipeline role this session runs as (worker/validator/…); omit for plain SU. */
  role?: string | null;
  /** Feature the role session is scoped to. */
  feature?: string | null;
  /** Workspace to record the row in; defaults to the active workspace. */
  workspaceId?: string;
  mode: 'omp' | 'console';
  terminalBin?: string | null;
  pid?: number | null;
  label?: string | null;
  ompThreadId?: string | null;
  cwd?: string | null;
  /** The coord owner_id (PAPERCUSP_SID) for this session — the live-roster
   *  join key to coord_presence. Set by the psu launcher; omit for console. */
  coordOwnerId?: string | null;
  /** The agent's native session id (claude --session-id UUID) when psu forces
   *  it at launch. Recorded so resume-by-native-uuid can find this row. */
  sessionId?: string | null;
  /** Pane-worthiness hint (D-002/D-006) — 'workbench' for a deferred-spawn
   *  interactive launch the pui should pane; omit for normal sessions. */
  display?: string | null;
  /** The exact argv the pui pane runs (a fresh `psu …`) for a deferred launch. */
  launchArgv?: string[] | null;
  portId?: string | null;
  portSourceAdvSessionId?: number | null;
  portStatus?: string | null;
  portMetadata?: Record<string, unknown> | null;
}

export function toIsoTimestamp(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  throw new Error(`invalid timestamp: ${String(value)}`);
}

export function mapAdvSessionRow(r: {
  id: number;
  workspace_id: string;
  plan_slug: string | null;
  agent: string | null;
  role: string | null;
  feature: string | null;
  mode: 'omp' | 'console';
  terminal_bin: string | null;
  pid: number | null;
  window_id: string | null;
  omp_thread_id: string | null;
  label: string | null;
  cwd: string | null;
  coord_owner_id: string | null;
  session_id: string | null;
  // pui-reactive-session-panes (D-006): optional — only the pending-launch query
  // SELECTs them; every other query omits them and they map to null.
  display?: string | null;
  launch_argv?: string[] | null;
  launched_at?: string | Date | null;
  started_at: string | Date;
  ended_at: string | Date | null;
  exit_code: number | null;
  port_id?: string | null;
  port_source_adv_session_id?: number | string | null;
  port_status?: string | null;
  port_metadata?: Record<string, unknown> | null;
}): AdvSessionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    planSlug: r.plan_slug,
    agent: (r.agent as SuAgent | null) ?? null,
    role: r.role ?? null,
    feature: r.feature ?? null,
    mode: r.mode,
    terminalBin: r.terminal_bin,
    pid: r.pid,
    windowId: r.window_id,
    ompThreadId: r.omp_thread_id,
    cwd: r.cwd,
    coordOwnerId: r.coord_owner_id ?? null,
    sessionId: r.session_id ?? null,
    display: r.display ?? null,
    launchArgv: r.launch_argv ?? null,
    launchedAt: toIsoTimestamp(r.launched_at ?? null),
    label: r.label,
    startedAt: toIsoTimestamp(r.started_at)!,
    endedAt: toIsoTimestamp(r.ended_at),
    exitCode: r.exit_code,
    portId: r.port_id ?? null,
    portSourceAdvSessionId: r.port_source_adv_session_id == null ? null : Number(r.port_source_adv_session_id),
    portStatus: r.port_status ?? null,
    portMetadata: r.port_metadata ?? null,
  };
}

/**
 * Workspace recorded for a coord owner (PAPERCUSP_SID) at launch — the
 * SID→workspace fallback for superuser MCP calls whose URL/headers carry no
 * workspace (stale user-level MCP configs; resumed sessions whose env dropped
 * PAPERCUSP_WORKSPACE). Most-recent row wins (a SID is minted per launch and
 * reused by resumes). Read-through TTL cache only — PG stays authoritative;
 * this can run on every superuser tool call when no explicit workspace rides
 * the request, and 30s of staleness is harmless (a SID's workspace is fixed
 * at launch).
 */
const coordOwnerWsCache = new Map<string, { ws: string | null; at: number }>();
const COORD_OWNER_WS_TTL_MS = 30_000;

export async function workspaceForCoordOwner(coordOwnerId: string): Promise<string | null> {
  const hit = coordOwnerWsCache.get(coordOwnerId);
  if (hit && Date.now() - hit.at < COORD_OWNER_WS_TTL_MS) return hit.ws;
  let ws: string | null = null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${coordOwnerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    ws = rows[0]?.workspace_id ?? null;
  } catch (e) {
    warnUnlessMissingTable(e, 'workspaceForCoordOwner');
    return null; // don't cache a transient DB failure as "no workspace"
  }
  if (coordOwnerWsCache.size > 512) coordOwnerWsCache.clear(); // bounded; it's only a cache
  coordOwnerWsCache.set(coordOwnerId, { ws, at: Date.now() });
  return ws;
}

export async function recordAdvSession(opts: RecordOpts): Promise<number | null> {
  try {
    const { sql } = getOrgPg();
    // Rollout-order compatibility (WI-4936): ordinary sessions must remain
    // writable while migration 611 is still pending. Mentioning a new column in
    // an INSERT fails at parse time, even when its value is null, so only the
    // actual session-port path uses the extended INSERT. A port correctly fails
    // closed until its schema exists; every pre-existing caller stays legacy-safe.
    const rows = opts.portId
      ? await sql<{ id: number }[]>`
          INSERT INTO harness_shared.adv_sessions
            (workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid, label, omp_thread_id, cwd, coord_owner_id, session_id, display, launch_argv,
             port_id, port_source_adv_session_id, port_status, port_metadata)
          VALUES
            (${opts.workspaceId ?? activeWorkspaceId()}, ${opts.planSlug ?? null}, ${opts.agent ?? null},
             ${opts.role ?? null}, ${opts.feature ?? null}, ${opts.mode},
             ${opts.terminalBin ?? null}, ${opts.pid ?? null}, ${opts.label ?? null},
             ${opts.ompThreadId ?? null}, ${opts.cwd ?? null}, ${opts.coordOwnerId ?? null}, ${opts.sessionId ?? null},
             ${opts.display ?? null}, ${opts.launchArgv ? JSON.stringify(opts.launchArgv) : null}::text::jsonb,
             ${opts.portId}, ${opts.portSourceAdvSessionId ?? null}, ${opts.portStatus ?? null},
             ${opts.portMetadata ? JSON.stringify(opts.portMetadata) : null}::text::jsonb)
          RETURNING id`
      : await sql<{ id: number }[]>`
          INSERT INTO harness_shared.adv_sessions
            (workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid, label, omp_thread_id, cwd, coord_owner_id, session_id, display, launch_argv)
          VALUES
            (${opts.workspaceId ?? activeWorkspaceId()}, ${opts.planSlug ?? null}, ${opts.agent ?? null},
             ${opts.role ?? null}, ${opts.feature ?? null}, ${opts.mode},
             ${opts.terminalBin ?? null}, ${opts.pid ?? null}, ${opts.label ?? null},
             ${opts.ompThreadId ?? null}, ${opts.cwd ?? null}, ${opts.coordOwnerId ?? null}, ${opts.sessionId ?? null},
             ${opts.display ?? null}, ${opts.launchArgv ? JSON.stringify(opts.launchArgv) : null}::text::jsonb)
          RETURNING id`;
    return rows[0]?.id ?? null;
  } catch (e) {
    warnUnlessMissingTable(e, 'recordAdvSession');
    return null;
  }
}
/**
 * Pending "workbench launch" requests (pui-reactive-session-panes D-006): rows
 * the desktop new-session RECORDED (display='workbench') but the pui has not yet
 * consumed (launched_at IS NULL) and that have not ended. These are the deferred
 * launches the pui reactively opens a work-area pane for. Workspace-scoped (the
 * recording desktop + the pui that panes it share a box), most-recent first.
 */
export async function listPendingWorkbenchLaunches(
  opts: { workspaceId?: string | null; limit?: number } = {},
): Promise<AdvSessionRow[]> {
  const limit = opts.limit ?? 50;
  const ws = opts.workspaceId ?? null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id,
             display, launch_argv, launched_at, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE display = 'workbench'
         AND launched_at IS NULL
         AND ended_at IS NULL
         AND (${ws}::text IS NULL OR workspace_id = ${ws})
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listPendingWorkbenchLaunches');
    return [];
  }
}

/**
 * `display` for a TERMINAL-spawned psu launch (WI-6376). Deliberately NOT
 * 'workbench': that value is pui-reactive-session-panes D-006's pane QUEUE, where
 * `launched_at IS NULL` means "the pui has not opened a pane for this row yet".
 * A terminal launch already owns a real terminal, so feeding it into that queue
 * would make the pui open a second, redundant work-area pane for it. The two
 * values are read by two different queries on purpose — keep them distinct.
 */
export const DISPLAY_TERMINAL_LAUNCH = 'terminal';

/** How long a terminal launch stays on the board before it ages out entirely.
 *  Long enough that a launch which never booted is VISIBLE as a failure rather
 *  than silently absent (the WI-6376 complaint), bounded so it cannot accrete. */
export const STARTING_LAUNCH_WINDOW_SEC = 15 * 60;

/**
 * Terminal-spawned psu launches that have not ended, within the boot window
 * (WI-6376 / owner ask 2026-07-25: "I want the sessions to show up there whether
 * or not they are launched with the new session button or if they are launched
 * with the psu utility").
 *
 * Between the spawn and psu's own coord-presence registration there is no
 * presence row, so the presence-primary roster cannot see the session at all —
 * the board showed it NOWHERE. This is the durable representation that covers
 * that window; the caller drops any row whose owner has since come online, so a
 * booted session is rendered once, from presence, not twice.
 */
export async function listStartingTerminalLaunches(
  opts: { workspaceId?: string | null; limit?: number; withinSec?: number } = {},
): Promise<AdvSessionRow[]> {
  const limit = opts.limit ?? 50;
  const withinSec = opts.withinSec ?? STARTING_LAUNCH_WINDOW_SEC;
  const ws = opts.workspaceId ?? null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id,
             display, launch_argv, launched_at, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE display = ${DISPLAY_TERMINAL_LAUNCH}
         AND ended_at IS NULL
         AND started_at > now() - (${withinSec}::int * interval '1 second')
         AND (${ws}::text IS NULL OR workspace_id = ${ws})
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listStartingTerminalLaunches');
    return [];
  }
}

/**
 * Mark a pending workbench launch CONSUMED — the pui opened its pane (D-006).
 * Idempotent (only stamps an unset launched_at), so a roster-refresh race can't
 * double-consume. Returns true when this call did the stamping.
 */
export async function markAdvSessionLaunched(id: number): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET launched_at = now()
       WHERE id = ${id}
         AND launched_at IS NULL
       RETURNING id
    `;
    return rows.length > 0;
  } catch (e) {
    warnUnlessMissingTable(e, 'markAdvSessionLaunched');
    return false;
  }
}

export async function setAdvSessionPid(id: number, pid: number | null): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.adv_sessions
         SET pid = ${pid}
       WHERE id = ${id}
         AND workspace_id = ${activeWorkspaceId()}
    `;
  } catch (e) {
    warnUnlessMissingTable(e, 'setAdvSessionPid');
  }
}

export async function setAdvSessionWindowId(id: number, windowId: string | null): Promise<void> {
  const trimmed = windowId?.trim() || null;
  if (!trimmed) return;
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.adv_sessions
         SET window_id = ${trimmed}
       WHERE id = ${id}
         AND workspace_id = ${activeWorkspaceId()}
    `;
  } catch (e) {
    warnUnlessMissingTable(e, 'setAdvSessionWindowId');
  }
}

export type AdvSessionLinkResult = 'linked' | 'already_linked' | 'not_found' | 'conflict';

export async function setAdvSessionOmpThreadId(id: number, ompThreadId: string): Promise<AdvSessionLinkResult> {
  const trimmed = ompThreadId.trim();
  if (!trimmed) return 'not_found';
  try {
    const { sql } = getOrgPg();
    const currentRows = await sql<Array<{ omp_thread_id: string | null }>>`
      SELECT omp_thread_id
        FROM harness_shared.adv_sessions
       WHERE id = ${id}
         AND workspace_id = ${activeWorkspaceId()}
       LIMIT 1
    `;
    const current = currentRows[0];
    if (!current) return 'not_found';
    if (current.omp_thread_id === trimmed) return 'already_linked';
    if (current.omp_thread_id != null && current.omp_thread_id !== trimmed) return 'conflict';
    await sql`
      UPDATE harness_shared.adv_sessions
         SET omp_thread_id = ${trimmed}
       WHERE id = ${id}
         AND workspace_id = ${activeWorkspaceId()}
    `;
    return 'linked';
  } catch (e) {
    warnUnlessMissingTable(e, 'setAdvSessionOmpThreadId');
    return 'not_found';
  }
}

export async function markAdvSessionEnded(id: number, exitCode: number | null): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const r = await sql`
      UPDATE harness_shared.adv_sessions
         SET ended_at = now(), exit_code = ${exitCode}
       WHERE id = ${id} AND ended_at IS NULL
       RETURNING id
    `;
    if (r.length) {
      // End-of-session fast path (session-db-archive-retire-dirs-2026-07-10
      // P-004): archive-then-delete the session's files after a settle delay.
      // Dynamic import: no module cycle, and this hot end path stays free of
      // FS/zstd imports. Fire-and-forget — ending never blocks on archival;
      // a missed schedule is caught by the P-006 reconciler.
      void import('./session-archive-hook')
        .then((m) => m.scheduleArchiveForAdvSession(id))
        .catch((e) => console.warn(`[adv-sessions] archive hook unavailable: ${(e as Error)?.message ?? e}`));
    }
  } catch (e) {
    warnUnlessMissingTable(e, 'markAdvSessionEnded');
  }
}

/**
 * Re-activate a tracked session row on RESUME — the inverse of
 * `markAdvSessionEnded` (presence-derive-from-session-log-2026-06-22 P-002 /
 * resume-visibility).
 *
 * `psu --resume` brings the agent PROCESS back to life, but `launchResume` does
 * NOT re-POST bootstrap-su, so the row kept the `ended_at`/`exit_code` from the
 * PRIOR exit — leaving a RUNNING agent recorded as dead, hence invisible to the
 * roster + presence-as-a-view (which correctly trust "ended means ended"). This
 * clears that stamp so a resumed session shows live the instant it resumes,
 * before it touches coord. `started_at` is bumped to now() so this incarnation
 * reads as freshly-live for the roster's recency window (the row represents the
 * CURRENT live session; resume time is its real "live since"). Idempotent: only
 * an already-ENDED row is touched. Returns true when this call re-activated a
 * row (false = no such ended row — already live, unknown id, or DB error).
 */
export async function reactivateAdvSession(id: number): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET ended_at = NULL, exit_code = NULL, started_at = now()
       WHERE id = ${id} AND ended_at IS NOT NULL
      RETURNING id
    `;
    return rows.length > 0;
  } catch (e) {
    warnUnlessMissingTable(e, 'reactivateAdvSession');
    return false;
  }
}

/**
 * WI-573 (honest-presence): reactivate a resumed session's adv row keyed by its COORD owner id,
 * for resume paths that never re-POST bootstrap-su (harness compaction, or any resume that is not
 * `psu --resume`). Called from the declared-activity presence write so the instant a live agent
 * declares intent / orients, a stale `ended_at` left by a prior incarnation is cleared and it reads
 * LIVE instead of `ended`. Touches only the most-recent ENDED row for that owner; idempotent + cheap
 * (a 0-row no-op when the session is already live). Generalizes `reactivateAdvSession` (by numeric id,
 * psu-launcher only) so EVERY resume path is honest. Returns true when a row was re-activated.
 */
export async function reactivateAdvSessionByOwner(coordOwnerId: string): Promise<boolean> {
  if (!coordOwnerId) return false;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET ended_at = NULL, exit_code = NULL, started_at = now()
       WHERE id = (
         SELECT id FROM harness_shared.adv_sessions
          WHERE coord_owner_id = ${coordOwnerId} AND ended_at IS NOT NULL
          ORDER BY started_at DESC
          LIMIT 1
       )
      RETURNING id
    `;
    return rows.length > 0;
  } catch (e) {
    warnUnlessMissingTable(e, 'reactivateAdvSessionByOwner');
    return false;
  }
}

/**
 * WI-5075 (P-018 carry-respawn kill loop): re-anchor a tracked session row's
 * NATIVE session id after a managed-host respawn (carry-respawn / cold RECYCLE).
 *
 * psu-pty-host's recycleChild kills the Claude child and boots a successor under
 * a FRESH `--session-id`, but this row — the authoritative owner→native mapping
 * that `resolveSessionRef` / `estimateContextTokensForOwner` read — kept naming
 * the dead predecessor. The compaction watchdog's context estimate therefore
 * stayed pinned to the predecessor's over-limit transcript and re-killed every
 * successor at each retry-grace expiry (193 CARRY-RESPAWN firings 2026-07-15/16).
 * Updating `session_id` in place keeps the row the SAME logical session (same
 * coord owner, same pty, same adv id) while tracking the live incarnation;
 * ended/exit stamps are cleared and `started_at` bumped for the same
 * resume-visibility reasons as {@link reactivateAdvSession}. Idempotent per
 * native id; returns true when a row was updated.
 */
export async function reanchorAdvSessionNativeId(
  id: number,
  sessionId: string,
): Promise<{ reanchored: boolean; owner: string | null }> {
  if (!sessionId) return { reanchored: false, owner: null };
  try {
    const { sql } = getOrgPg();
    // ⚠ `RETURNING coord_owner_id` — there is NO `owner` column on adv_sessions.
    // The original WI-5075 ship wrote `RETURNING id, owner`, which made the WHOLE
    // statement throw 42703 into the catch below: the re-anchor silently never
    // committed for ANY cohort and only the watchdog's streak breaker masked it
    // (the 2026-07-18 su-57b6247d 3-successor kill loop).
    const rows = await sql<{ id: number; owner: string | null }[]>`
      UPDATE harness_shared.adv_sessions
         SET session_id = ${sessionId}, ended_at = NULL, exit_code = NULL, started_at = now()
       WHERE id = ${id} AND session_id IS DISTINCT FROM ${sessionId}
      RETURNING id, coord_owner_id AS owner
    `;
    // The owner rides back so the respawn route can clear the frozen context
    // gauge (the successor keeps the coord ownerId, so the in-process usage
    // cache would otherwise serve the DEAD predecessor's near-limit estimate
    // for up to a watchdog cadence — the "89% on a fresh successor" bug).
    return { reanchored: rows.length > 0, owner: rows[0]?.owner ?? null };
  } catch (e) {
    warnUnlessMissingTable(e, 'reanchorAdvSessionNativeId');
    return { reanchored: false, owner: null };
  }
}

/**
 * Owner-keyed sibling of {@link reanchorAdvSessionNativeId} for sessions with NO
 * numeric adv id in their environment — an interactive `psu` / `psu --resume`
 * launch never gets PAPERCUSP_ADV_SESSION_ID, so its respawn report can only
 * name the coord ownerId. Without this path that whole cohort was invisible to
 * WI-5075: its adv row kept naming the dead predecessor and the compaction
 * watchdog re-killed each successor (2026-07-18 su-57b6247d, 3 cuts in 16 min).
 * Re-anchors the NEWEST row for the owner — the same row `resolveSessionRef`
 * reads (both order by started_at DESC), so the two stay consistent by
 * construction. Idempotent per native id.
 */
export async function reanchorAdvSessionNativeIdByOwner(
  coordOwnerId: string,
  sessionId: string,
): Promise<{ reanchored: boolean; owner: string | null }> {
  if (!coordOwnerId || !sessionId) return { reanchored: false, owner: null };
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET session_id = ${sessionId}, ended_at = NULL, exit_code = NULL, started_at = now()
       WHERE id = (
         SELECT id FROM harness_shared.adv_sessions
          WHERE coord_owner_id = ${coordOwnerId}
          ORDER BY started_at DESC
          LIMIT 1
       ) AND session_id IS DISTINCT FROM ${sessionId}
      RETURNING id
    `;
    return { reanchored: rows.length > 0, owner: rows.length > 0 ? coordOwnerId : null };
  } catch (e) {
    warnUnlessMissingTable(e, 'reanchorAdvSessionNativeIdByOwner');
    return { reanchored: false, owner: null };
  }
}

export async function listAdvSessions(limit = 100): Promise<AdvSessionRow[]> {
  try {
    const { sql } = getOrgPg();
    // Filter "dead-on-arrival" rows — a terminal that ended within 5
    // seconds of launch and never recorded an omp_thread_id never
    // produced a transcript. Showing those rows is just noise: the
    // detail panel can't load state, the Inspect / Resume buttons
    // dead-end, the user has no recourse. They're tracked in PG (audit
    // trail) but excluded from the UI list. A surviving session with
    // no omp_thread_id is still shown (it might be brand-new and
    // OMP just hasn't written its JSONL header yet).
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
        port_id?: string | null;
        port_source_adv_session_id?: number | string | null;
        port_status?: string | null;
        port_metadata?: Record<string, unknown> | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code,
             to_jsonb(a)->>'port_id' AS port_id,
             to_jsonb(a)->>'port_source_adv_session_id' AS port_source_adv_session_id,
             to_jsonb(a)->>'port_status' AS port_status,
             to_jsonb(a)->'port_metadata' AS port_metadata
        FROM harness_shared.adv_sessions a
       WHERE workspace_id = ${activeWorkspaceId()}
         AND NOT (
           ended_at IS NOT NULL
           AND omp_thread_id IS NULL
           AND EXTRACT(EPOCH FROM (ended_at - started_at)) < 5
         )
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listAdvSessions');
    return [];
  }
}

/**
 * Recent psu-tracked sessions (agent + cwd present), most-recent first,
 * across ALL workspaces — the data the `psu --resume` picker walks. Unlike
 * listAdvSessions this is NOT workspace-scoped (you may want to resume a
 * session launched in a different workspace) and includes ended rows
 * (resume revives them).
 */
export async function listResumableSessions(limit = 30): Promise<AdvSessionRow[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions a
       WHERE agent IS NOT NULL
         AND cwd IS NOT NULL
         -- to_jsonb(row)->key is parse-safe before migration 611: a missing
         -- key is NULL, while pending post-migration ports remain hidden.
         AND COALESCE(to_jsonb(a)->>'port_status', 'delivered') = 'delivered'
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listResumableSessions');
    return [];
  }
}

export async function getAdvSession(id: number): Promise<AdvSessionRow | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
        port_id?: string | null;
        port_source_adv_session_id?: number | string | null;
        port_status?: string | null;
        port_metadata?: Record<string, unknown> | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code,
             to_jsonb(a)->>'port_id' AS port_id,
             to_jsonb(a)->>'port_source_adv_session_id' AS port_source_adv_session_id,
             to_jsonb(a)->>'port_status' AS port_status,
             to_jsonb(a)->'port_metadata' AS port_metadata
        FROM harness_shared.adv_sessions a
       WHERE workspace_id = ${activeWorkspaceId()}
         AND id = ${id}
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    return mapAdvSessionRow(r);
  } catch (e) {
    warnUnlessMissingTable(e, 'getAdvSession');
    return null;
  }
}

/** Explicit workspace lookup for a server-side port request. getAdvSession()
 * remains active-workspace scoped for legacy UI callers. */
export async function getAdvSessionInWorkspace(id: number, workspaceId: string): Promise<AdvSessionRow | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id,
             started_at, ended_at, exit_code,
             to_jsonb(a)->>'port_id' AS port_id,
             to_jsonb(a)->>'port_source_adv_session_id' AS port_source_adv_session_id,
             to_jsonb(a)->>'port_status' AS port_status,
             to_jsonb(a)->'port_metadata' AS port_metadata
        FROM harness_shared.adv_sessions a
       WHERE workspace_id = ${workspaceId} AND id = ${id}
       LIMIT 1`;
    return rows[0] ? mapAdvSessionRow(rows[0]) : null;
  } catch (e) {
    warnUnlessMissingTable(e, 'getAdvSessionInWorkspace');
    return null;
  }
}

export async function updateAdvSessionPortStatus(
  id: number,
  workspaceId: string,
  status: 'pending' | 'delivered' | 'failed',
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: number }[]>`
    UPDATE harness_shared.adv_sessions
       SET port_status = ${status},
           port_metadata = COALESCE(port_metadata, '{}'::jsonb) || ${JSON.stringify(metadata)}::text::jsonb,
           ended_at = CASE WHEN ${status} = 'failed' THEN COALESCE(ended_at, now()) ELSE ended_at END
     WHERE id = ${id} AND workspace_id = ${workspaceId}
     RETURNING id`;
  return rows.length > 0;
}

/**
 * adv_sessions keyed by coord_owner_id — the enrichment side of the live-roster
 * join (coord_presence.owner_id = adv_sessions.coord_owner_id; D-002). Returns
 * a Map so mergeRoster() can look up each presence row's launch metadata in O(1).
 *
 * Deliberately NOT workspace-scoped: coord_owner_id (the session SID) is
 * globally unique, and a presence row's workspace ('*' for an unscoped SU
 * shell) need not equal its adv row's concrete workspace — scoping here would
 * silently drop valid joins. Most-recent row wins per owner (a SID is minted
 * per launch, so collisions are not expected; the guard is belt-and-suspenders).
 * adv-sessions-live-roster P-002.
 */
export async function advSessionsByCoordOwner(limit = 500): Promise<Map<string, AdvSessionRow>> {
  const out = new Map<string, AdvSessionRow>();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id IS NOT NULL
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    for (const r of rows) {
      const mapped = mapAdvSessionRow(r);
      // ORDER BY started_at DESC → first seen per owner is the most recent.
      if (mapped.coordOwnerId && !out.has(mapped.coordOwnerId)) out.set(mapped.coordOwnerId, mapped);
    }
  } catch (e) {
    warnUnlessMissingTable(e, 'advSessionsByCoordOwner');
  }
  return out;
}

/** Default recency bound for the live-recorded-session leg of the roster. A
 *  session whose clean-exit `markAdvSessionEnded` never ran (killed/crashed
 *  process) ages out of the live leg after this, instead of lingering as an
 *  eternal `ended_at IS NULL` zombie. */
export const RECORDED_LIVE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Live recorded sessions — the AUTHORITATIVE "what is running right now" leg of
 * the presence roster (presence-derive-from-session-log-2026-06-22 P-001).
 *
 * Every session the system RECORDED — any CLI (claude/codex/omp), any launch
 * mode (console/role/spawn/interactive) — that has NOT yet ended (ended_at IS
 * NULL) and carries a coord owner id (the join key to coord_presence.owner_id).
 * The presence snapshot synthesizes a roster row for any of these NOT already
 * self-registered in coord_presence, so a session is VISIBLE + ADDRESSABLE the
 * instant it is recorded — never gated on the agent volunteering a heartbeat
 * (the structural gap this closes: a recorded live session with no presence row
 * was invisible + undispatchable, worst for console/autonomous agents that
 * never heartbeat at all).
 *
 * Recency-bounded (`maxAgeMs`, default 12h) so an unreaped zombie ages out.
 * `DISTINCT ON (coord_owner_id)` most-recent row per owner (a resume reuses the
 * SID). Workspace-scoped when given. Best-effort → [] on any DB error: the
 * roster must render even if this leg fails.
 */
export async function listRecordedLiveSessions(
  opts: { workspaceId?: string | null; maxAgeMs?: number; limit?: number } = {},
): Promise<AdvSessionRow[]> {
  const ws = opts.workspaceId ?? null;
  const maxAgeSec = Math.max(1, Math.round((opts.maxAgeMs ?? RECORDED_LIVE_MAX_AGE_MS) / 1000));
  const limit = opts.limit ?? 500;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT DISTINCT ON (coord_owner_id)
             id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE ended_at IS NULL
         AND coord_owner_id IS NOT NULL
         AND started_at > now() - make_interval(secs => ${maxAgeSec})
         AND (${ws}::text IS NULL OR workspace_id = ${ws})
       ORDER BY coord_owner_id, started_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listRecordedLiveSessions');
    return [];
  }
}

/**
 * Batch: which of `coordOwnerIds` have a RECORDED session whose MOST-RECENT row
 * has ENDED (`adv_sessions.ended_at IS NOT NULL`) — POSITIVE evidence the owner's
 * process has exited, keyed by owner (EI-6374, the fleet-coverage liveness-drift).
 *
 * This is the authoritative "is it actually still running" signal a coverage
 * reader needs to override a still-WARM `coord_presence` heartbeat: session end
 * sets `ended_at` in the SAME teardown that cancels the inbox-wake await (harness
 * spawn + su/console launch paths), so a bee reported `ended` by the wake path
 * lands here too. Positive-evidence by design — an owner with NO recorded session
 * (a test-synthetic presence row, a legacy agent) is NEVER flagged, and a
 * launching / live / RESUMED session (reactivateAdvSession clears `ended_at`) has
 * a LIVE most-recent row → excluded. `DISTINCT ON (coord_owner_id)` most-recent
 * row per owner (a resume reuses the SID, so the latest row wins). Federated
 * (`fed:…`) owners never have a local record → dropped up front. Best-effort →
 * empty set on any DB error (no owner is downgraded; the reader degrades to
 * heartbeat-only liveness and never over-reports death).
 */
export async function endedRecordedOwnerIds(coordOwnerIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(coordOwnerIds.filter((id) => !!id && !id.startsWith('fed:')))];
  if (ids.length === 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ coord_owner_id: string; ended_at: string | Date | null }[]>`
      SELECT DISTINCT ON (coord_owner_id) coord_owner_id, ended_at
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ANY(${ids}::text[])
       ORDER BY coord_owner_id, started_at DESC
    `;
    return new Set(rows.filter((r) => r.ended_at != null).map((r) => r.coord_owner_id));
  } catch (e) {
    warnUnlessMissingTable(e, 'endedRecordedOwnerIds');
    return new Set();
  }
}

/**
 * Batch: which of `coordOwnerIds` have POSITIVE live-session evidence even if
 * they have not registered an inbox-wake await yet. This is the read-side twin
 * of coord:presence's `recorded` state: a freshly-launched session in its
 * bootstrap/orient window is alive, but not yet coord-dispatchable.
 *
 * Sources:
 *   - adv_sessions: an authoritative live interactive/terminal session row
 *     (`ended_at IS NULL`) keyed by coord_owner_id.
 *   - spawned_agents: the nursery's running row, keyed by any alias the
 *     fleet_assignment view can expose (spawn_id/session_owner/run_id), with a
 *     fresh process heartbeat.
 *
 * Positive-evidence by design. On query failure it returns empty so callers
 * degrade to the stricter wakeability-only behavior instead of fabricating
 * liveness.
 */
export async function recordedLiveOwnerIds(coordOwnerIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(coordOwnerIds.filter((id) => !!id && !id.startsWith('fed:')))];
  if (ids.length === 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ owner_id: string }[]>`
      WITH requested(id) AS (
        SELECT unnest(${ids}::text[])
      ),
      live_adv AS (
        SELECT coord_owner_id AS owner_id
          FROM harness_shared.adv_sessions
         WHERE coord_owner_id = ANY(${ids}::text[])
           AND ended_at IS NULL
      ),
      live_spawn AS (
        SELECT alias.owner_id
          FROM harness_shared.spawned_agents sa
          CROSS JOIN LATERAL (
            VALUES (sa.spawn_id), (sa.session_owner), (sa.run_id)
          ) AS alias(owner_id)
          JOIN requested r ON r.id = alias.owner_id
         WHERE sa.status = 'running'
           AND sa.finished_at IS NULL
           AND sa.heartbeat_at > now() - interval '10 minutes'
      )
      SELECT DISTINCT owner_id FROM live_adv
      UNION
      SELECT DISTINCT owner_id FROM live_spawn
    `;
    return new Set(rows.map((r) => r.owner_id));
  } catch (e) {
    warnUnlessMissingTable(e, 'recordedLiveOwnerIds');
    return new Set();
  }
}

/**
 * The most recent adv_sessions row for ONE coord owner — the await-event
 * wake-handle capture (await-event-primitive-2026-06-05 D-003): events:await
 * stamps this row's {id, agent, session_id, omp_thread_id, cwd, pid} onto the
 * subscription at registration. NOT workspace-scoped, same rationale as
 * advSessionsByCoordOwner above.
 */
export async function latestAdvSessionByCoordOwner(coordOwnerId: string): Promise<AdvSessionRow | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${coordOwnerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const r = rows[0];
    return r ? mapAdvSessionRow(r) : null;
  } catch (e) {
    warnUnlessMissingTable(e, 'latestAdvSessionByCoordOwner');
    return null;
  }
}

/**
 * The newest STILL-LIVE adv_sessions row carrying `label` in `workspaceId` that
 * has a booted coord owner id — the correlation key for a labelled session
 * launch (the tutorial docs-agent: launch `psu --label='docs-tutor'`, then find
 * the resulting session here to route follow-up questions to its coord owner).
 *
 * "Live" = `ended_at IS NULL` AND started within RECORDED_LIVE_MAX_AGE_MS (so a
 * terminal whose exit was never recorded — the operator-restart caveat — ages
 * out instead of masquerading as live forever). `coord_owner_id IS NOT NULL`
 * because a row without one is mid-boot (bootstrap-su sets it) and not yet
 * addressable. Most-recent first. Returns null on no match / a missing table.
 */
export async function latestLiveAdvSessionByLabel(
  label: string,
  workspaceId: string,
): Promise<AdvSessionRow | null> {
  try {
    const { sql } = getOrgPg();
    const cutoffIso = new Date(Date.now() - RECORDED_LIVE_MAX_AGE_MS).toISOString();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE label = ${label}
         AND workspace_id = ${workspaceId}
         AND ended_at IS NULL
         AND coord_owner_id IS NOT NULL
         AND started_at >= ${cutoffIso}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const r = rows[0];
    return r ? mapAdvSessionRow(r) : null;
  } catch (e) {
    warnUnlessMissingTable(e, 'latestLiveAdvSessionByLabel');
    return null;
  }
}

/**
 * Recently-ended, inspectable agent sessions — the durable history half of the
 * live-roster view (the active half is the presence-driven mergeRoster).
 *
 * A console launch records an outer terminal-wrapper row before `psu` starts
 * or resumes the real agent. Those wrappers intentionally have no agent,
 * coord owner, or native transcript handle. They are useful lifecycle audit
 * records, but they are not agent sessions and cannot open in the transcript
 * inspector. Keep them out of this agent-history feed instead of rendering a
 * dead `resume · …` row in the Agents running popover (WI-5103 / EI-13166).
 *
 * Scoped to a workspace when given, else cross-workspace. Most-recently-ended
 * first. adv-sessions-live-roster P-003.
 */
export async function listEndedAdvSessions(
  opts: { workspaceId?: string | null; limit?: number; before?: string | null } = {},
): Promise<AdvSessionRow[]> {
  const limit = opts.limit ?? 50;
  const ws = opts.workspaceId ?? null;
  // Keyset cursor for the "inactive sessions" infinite scroll: only rows that
  // ended strictly BEFORE this timestamp. ended_at DESC + `before` = the next
  // page; null = the first page. (agents-pill-inactive-search-2026-07-09 P-001)
  const before = opts.before ?? null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE ended_at IS NOT NULL
         -- Match the transcript handles understood by endedSessionStreamUrl:
         -- Claude/native UUID, OMP thread id, or Codex's per-row CODEX_HOME.
         -- In particular, this excludes handleless console-launch wrappers.
         AND (
           NULLIF(BTRIM(session_id), '') IS NOT NULL
           OR NULLIF(BTRIM(omp_thread_id), '') IS NOT NULL
           OR agent = 'codex'
         )
         AND (${ws}::text IS NULL OR workspace_id = ${ws})
         AND (${before}::timestamptz IS NULL OR ended_at < ${before}::timestamptz)
       ORDER BY ended_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'listEndedAdvSessions');
    return [];
  }
}

/** One agent session attributed to a plan, display-shaped for the plan popup's
 *  Sessions tab (owner-plans-single-pane-2026-07-17 P-004). One row per distinct
 *  agent identity (coord_owner_id) — the addressable unit SessionChatModal
 *  resolves owner → live/recent transcript from. */
export interface PlanSessionRow {
  coordOwnerId: string;
  sessionId: string | null;
  ompThreadId: string | null;
  agent: string | null;
  mode: 'omp' | 'console';
  role: string | null;
  label: string | null;
  startedAt: string;
  endedAt: string | null;
  /** ended_at IS NULL — the process has not cleanly exited (a live/recent
   *  session). The client still ages very old NULLs out visually. */
  live: boolean;
  /** How this session was attributed: 'plan' = launched bound to this plan
   *  (adv_sessions.plan_slug); 'claim' = a plan-UNBOUND session of an agent that
   *  claimed/completed one of the plan's work-items (D-005 supplement leg). */
  via: 'plan' | 'claim';
}

/**
 * Every agent session that touched a plan (owner-plans-single-pane-2026-07-17
 * P-004) — the plan popup's Sessions tab. Two legs (D-005):
 *   A. PRIMARY — adv_sessions whose plan_slug binds them to this plan (the
 *      launch binding; the reliable backbone).
 *   B. SUPPLEMENT — plan-UNBOUND sessions (plan_slug IS NULL) of agents that
 *      are terminal_owner / taken_by on a feature-family work-item created from
 *      this plan (source_plan_slug). Catches an agent that claimed plan work but
 *      was launched without a plan binding. Deliberately excludes a session
 *      bound to a DIFFERENT plan, so it never misattributes.
 * DISTINCT ON (coord_owner_id) — one row per agent identity, preferring its
 * plan-bound session then its most recent. Best-effort → [] on any DB error.
 */
export async function listPlanSessions(
  planSlug: string,
  opts: { workspaceId?: string | null; limit?: number } = {},
): Promise<PlanSessionRow[]> {
  const ws = opts.workspaceId ?? null;
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  if (!planSlug) return [];
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        coord_owner_id: string;
        session_id: string | null;
        omp_thread_id: string | null;
        agent: string | null;
        mode: 'omp' | 'console';
        role: string | null;
        label: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        via: 'plan' | 'claim';
      }>
    >`
      WITH claim_owners AS (
        SELECT DISTINCT owner FROM (
          SELECT terminal_owner AS owner
            FROM harness_shared.work_items
           WHERE source_plan_slug = ${planSlug} AND terminal_owner IS NOT NULL
          UNION
          SELECT taken_by AS owner
            FROM harness_shared.work_items
           WHERE source_plan_slug = ${planSlug} AND taken_by IS NOT NULL
        ) o
      ),
      candidate AS (
        SELECT s.coord_owner_id, s.session_id, s.omp_thread_id, s.agent, s.mode,
               s.role, s.label, s.started_at, s.ended_at, 'plan'::text AS via
          FROM harness_shared.adv_sessions s
         WHERE s.plan_slug = ${planSlug}
           AND s.coord_owner_id IS NOT NULL
           AND (${ws}::text IS NULL OR s.workspace_id = ${ws})
        UNION ALL
        SELECT s.coord_owner_id, s.session_id, s.omp_thread_id, s.agent, s.mode,
               s.role, s.label, s.started_at, s.ended_at, 'claim'::text AS via
          FROM harness_shared.adv_sessions s
          JOIN claim_owners c ON c.owner = s.coord_owner_id
         WHERE s.plan_slug IS NULL
           AND s.coord_owner_id IS NOT NULL
           AND (${ws}::text IS NULL OR s.workspace_id = ${ws})
      ),
      deduped AS (
        SELECT DISTINCT ON (coord_owner_id)
               coord_owner_id, session_id, omp_thread_id, agent, mode, role,
               label, started_at, ended_at, via
          FROM candidate
         ORDER BY coord_owner_id, (via = 'plan') DESC, started_at DESC
      )
      SELECT * FROM deduped
       ORDER BY (ended_at IS NULL) DESC, started_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      coordOwnerId: r.coord_owner_id,
      sessionId: r.session_id,
      ompThreadId: r.omp_thread_id,
      agent: r.agent,
      mode: r.mode,
      role: r.role,
      label: r.label,
      startedAt: toIsoTimestamp(r.started_at) ?? new Date(0).toISOString(),
      endedAt: toIsoTimestamp(r.ended_at),
      live: r.ended_at == null,
      via: r.via,
    }));
  } catch (e) {
    warnUnlessMissingTable(e, 'listPlanSessions');
    return [];
  }
}

/**
 * adv_sessions rows matched by their transcript handles — `session_id` (a
 * claude transcript uuid) or `omp_thread_id`. Used by the transcript-search
 * route to attach session metadata (label/plan/agent/endedAt + the codex
 * open-key `id`) to session_turns hits (agents-pill-inactive-search-2026-07-09
 * P-002). Newest row per handle wins downstream (rows come back newest-first).
 */
export async function advSessionsByTranscriptHandles(
  handles: { sessionIds?: readonly string[]; ompThreadIds?: readonly string[] },
): Promise<AdvSessionRow[]> {
  const sessionIds = handles.sessionIds && handles.sessionIds.length ? [...handles.sessionIds] : null;
  const ompThreadIds = handles.ompThreadIds && handles.ompThreadIds.length ? [...handles.ompThreadIds] : null;
  if (!sessionIds && !ompThreadIds) return [];
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: number;
        workspace_id: string;
        plan_slug: string | null;
        agent: string | null;
        role: string | null;
        feature: string | null;
        mode: 'omp' | 'console';
        terminal_bin: string | null;
        pid: number | null;
        window_id: string | null;
        omp_thread_id: string | null;
        label: string | null;
        cwd: string | null;
        coord_owner_id: string | null;
        session_id: string | null;
        started_at: string | Date;
        ended_at: string | Date | null;
        exit_code: number | null;
      }>
    >`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE (${sessionIds}::text[] IS NOT NULL AND session_id = ANY(${sessionIds}::text[]))
          OR (${ompThreadIds}::text[] IS NOT NULL AND omp_thread_id = ANY(${ompThreadIds}::text[]))
       ORDER BY started_at DESC
       LIMIT 500
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'advSessionsByTranscriptHandles');
    return [];
  }
}

