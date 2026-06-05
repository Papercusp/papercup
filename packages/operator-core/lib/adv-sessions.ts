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
    label: r.label,
    startedAt: toIsoTimestamp(r.started_at)!,
    endedAt: toIsoTimestamp(r.ended_at),
    exitCode: r.exit_code,
  };
}

export async function recordAdvSession(opts: RecordOpts): Promise<number | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid, label, omp_thread_id, cwd, coord_owner_id, session_id)
      VALUES
        (${opts.workspaceId ?? activeWorkspaceId()}, ${opts.planSlug ?? null}, ${opts.agent ?? null},
         ${opts.role ?? null}, ${opts.feature ?? null}, ${opts.mode},
         ${opts.terminalBin ?? null}, ${opts.pid ?? null}, ${opts.label ?? null},
         ${opts.ompThreadId ?? null}, ${opts.cwd ?? null}, ${opts.coordOwnerId ?? null}, ${opts.sessionId ?? null})
      RETURNING id
    `;
    return rows[0]?.id ?? null;
  } catch (e) {
    console.warn('[adv-sessions] recordAdvSession failed:', (e as Error).message);
    return null;
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
 * Bring an X11 window to the foreground via `wmctrl -ia <wid>`.
 * User-initiated only — see memory feedback_e2e_no_focus_steal: this
 * pattern is forbidden for automated drivers but fine for an explicit
 * focus-button click.
 */
export async function focusWindowId(windowId: string): Promise<boolean> {
  const { spawnSync } = await import('node:child_process');
  try {
    const r = spawnSync('wmctrl', ['-ia', windowId], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}
