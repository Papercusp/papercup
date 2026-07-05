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
import { focusWindowByTitle, isWindowsDesktopHost, listWindowsByTitle } from './windows-desktop-windows';

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
}

export function toIsoTimestamp(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  throw new Error(`invalid timestamp: ${String(value)}`);
}

function mapAdvSessionRow(r: {
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
    console.warn('[adv-sessions] workspaceForCoordOwner failed:', (e as Error).message);
    return null; // don't cache a transient DB failure as "no workspace"
  }
  if (coordOwnerWsCache.size > 512) coordOwnerWsCache.clear(); // bounded; it's only a cache
  coordOwnerWsCache.set(coordOwnerId, { ws, at: Date.now() });
  return ws;
}

export async function recordAdvSession(opts: RecordOpts): Promise<number | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid, label, omp_thread_id, cwd, coord_owner_id, session_id, display, launch_argv)
      VALUES
        (${opts.workspaceId ?? activeWorkspaceId()}, ${opts.planSlug ?? null}, ${opts.agent ?? null},
         ${opts.role ?? null}, ${opts.feature ?? null}, ${opts.mode},
         ${opts.terminalBin ?? null}, ${opts.pid ?? null}, ${opts.label ?? null},
         ${opts.ompThreadId ?? null}, ${opts.cwd ?? null}, ${opts.coordOwnerId ?? null}, ${opts.sessionId ?? null},
         ${opts.display ?? null}, ${opts.launchArgv ? JSON.stringify(opts.launchArgv) : null}::text::jsonb)
      RETURNING id
    `;
    return rows[0]?.id ?? null;
  } catch (e) {
    console.warn('[adv-sessions] recordAdvSession failed:', (e as Error).message);
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
    console.warn('[adv-sessions] listPendingWorkbenchLaunches failed:', (e as Error).message);
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
    console.warn('[adv-sessions] markAdvSessionLaunched failed:', (e as Error).message);
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
    console.warn('[adv-sessions] setAdvSessionPid failed:', (e as Error).message);
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
    console.warn('[adv-sessions] setAdvSessionWindowId failed:', (e as Error).message);
  }
}

export type AdvSessionLinkResult =
  | 'linked'
  | 'already_linked'
  | 'not_found'
  | 'conflict';

export async function setAdvSessionOmpThreadId(
  id: number,
  ompThreadId: string,
): Promise<AdvSessionLinkResult> {
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
    console.warn('[adv-sessions] setAdvSessionOmpThreadId failed:', (e as Error).message);
    return 'not_found';
  }
}

export async function markAdvSessionEnded(id: number, exitCode: number | null): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.adv_sessions
         SET ended_at = now(), exit_code = ${exitCode}
       WHERE id = ${id} AND ended_at IS NULL
    `;
  } catch (e) {
    console.warn('[adv-sessions] markAdvSessionEnded failed:', (e as Error).message);
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
    console.warn('[adv-sessions] reactivateAdvSession failed:', (e as Error).message);
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
    console.warn('[adv-sessions] reactivateAdvSessionByOwner failed:', (e as Error).message);
    return false;
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
    const rows = await sql<Array<{
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
    }>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
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
    console.warn('[adv-sessions] listAdvSessions failed:', (e as Error).message);
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
    const rows = await sql<Array<{
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
    }>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE agent IS NOT NULL
         AND cwd IS NOT NULL
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    console.warn('[adv-sessions] listResumableSessions failed:', (e as Error).message);
    return [];
  }
}

export async function getAdvSession(id: number): Promise<AdvSessionRow | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{
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
    }>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE workspace_id = ${activeWorkspaceId()}
         AND id = ${id}
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) return null;
    return mapAdvSessionRow(r);
  } catch (e) {
    console.warn('[adv-sessions] getAdvSession failed:', (e as Error).message);
    return null;
  }
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
    const rows = await sql<Array<{
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
    }>>`
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
    console.warn('[adv-sessions] advSessionsByCoordOwner failed:', (e as Error).message);
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
    console.warn('[adv-sessions] listRecordedLiveSessions failed:', (e as Error).message);
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
    console.warn('[adv-sessions] endedRecordedOwnerIds failed:', (e as Error).message);
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
    console.warn('[adv-sessions] latestAdvSessionByCoordOwner failed:', (e as Error).message);
    return null;
  }
}

/**
 * Recently-ended adv_sessions — the durable history half of the live-roster
 * view (the active half is the presence-driven mergeRoster). Scoped to a
 * workspace when given, else cross-workspace. Most-recently-ended first.
 * adv-sessions-live-roster P-003.
 */
export async function listEndedAdvSessions(
  opts: { workspaceId?: string | null; limit?: number } = {},
): Promise<AdvSessionRow[]> {
  const limit = opts.limit ?? 50;
  const ws = opts.workspaceId ?? null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{
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
    }>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code
        FROM harness_shared.adv_sessions
       WHERE ended_at IS NOT NULL
         AND (${ws}::text IS NULL OR workspace_id = ${ws})
       ORDER BY ended_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    console.warn('[adv-sessions] listEndedAdvSessions failed:', (e as Error).message);
    return [];
  }
}

/**
 * Resolve a pid → X11 window id via `wmctrl -lp`. Best-effort: returns
 * null on any failure (no wmctrl, no DISPLAY, pid not yet windowed,
 * etc.). Callers should accept the null and surface a "couldn't focus"
 * message rather than crashing.
 */
export async function resolveWindowIdForPid(pid: number): Promise<string | null> {
  const { spawnSync } = await import('node:child_process');
  try {
    const r = spawnSync('wmctrl', ['-lp'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    // wmctrl -lp output: <wid> <desktop> <pid> <host> <title>
    for (const line of r.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/, 5);
      if (parts.length < 4) continue;
      if (Number(parts[2]) === pid) return parts[0];
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveWindowIdForTitleFragment(fragment: string): Promise<string | null> {
  const wanted = fragment.trim();
  if (!wanted) return null;
  if (isWindowsDesktopHost()) {
    // windows-desktop-feature-parity-2026-07-02 P-010: there is no
    // pid→window mapping across the WSL↔Windows boundary (see
    // windows-desktop-windows.ts header), so the "window id" we persist for
    // a Windows session IS its exact window TITLE — durable + effectively
    // unique because native_console.rs mints it as `Papercup — <uuid>`. A
    // Windows hwnd would be cheaper to compare but isn't safe to persist:
    // this helper's contract is "give me something focusWindowId can use
    // LATER", and re-resolving by title at focus time (rather than trusting
    // a cached hwnd) is the only approach that survives the window being
    // re-created (e.g. after a WSL restart).
    //
    // NOTE: guard is isWindowsDesktopHost(), NOT process.platform === 'win32'
    // — the operator always runs as a `wsl.exe --exec node` Linux process
    // (main.rs), so process.platform reports 'linux' even on a real Windows
    // box (P-025 audit finding, WI-1646's sibling — see
    // windows-desktop-windows.ts's module doc). Don't regress this.
    try {
      const windows = await listWindowsByTitle();
      const match = windows.find((w) => w.title.includes(wanted));
      return match ? match.title : null;
    } catch {
      return null;
    }
  }
  const { spawnSync } = await import('node:child_process');
  try {
    const r = spawnSync('wmctrl', ['-lp'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    for (const line of r.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/, 5);
      if (parts.length < 5) continue;
      if (parts[4]?.includes(wanted)) return parts[0];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Bring a window to the foreground. Linux: `wmctrl -ia <wid>` (X11 window
 * id). Windows: `windowId` is actually a TITLE (per
 * `resolveWindowIdForTitleFragment`'s win32 branch above — hwnds aren't
 * stable enough to persist across the WSL boundary), so refocus BY TITLE via
 * windows-desktop-windows.ts. User-initiated only — see memory
 * feedback_e2e_no_focus_steal: this pattern is forbidden for automated
 * drivers but fine for an explicit focus-button click.
 */
export async function focusWindowId(windowId: string): Promise<boolean> {
  if (isWindowsDesktopHost()) {
    try {
      return await focusWindowByTitle(windowId);
    } catch {
      return false;
    }
  }
  const { spawnSync } = await import('node:child_process');
  try {
    const r = spawnSync('wmctrl', ['-ia', windowId], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}
