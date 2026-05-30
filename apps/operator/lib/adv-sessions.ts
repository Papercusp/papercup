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

import { getOrgPg } from '@restart/db-org';
import { ensureAdvSessionsTable } from './ensure-schema';
import { activeWorkspaceId } from './workspace-registry';

export interface AdvSessionRow {
  id: number;
  workspaceId: string;
  planSlug: string | null;
  mode: 'omp' | 'console';
  terminalBin: string | null;
  pid: number | null;
  windowId: string | null;
  ompThreadId: string | null;
  label: string | null;
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

export interface RecordOpts {
  planSlug?: string | null;
  mode: 'omp' | 'console';
  terminalBin?: string | null;
  pid?: number | null;
  label?: string | null;
  ompThreadId?: string | null;
  cwd?: string | null;
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
  mode: 'omp' | 'console';
  terminal_bin: string | null;
  pid: number | null;
  window_id: string | null;
  omp_thread_id: string | null;
  label: string | null;
  cwd: string | null;
  started_at: string | Date;
  ended_at: string | Date | null;
  exit_code: number | null;
}): AdvSessionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    planSlug: r.plan_slug,
    mode: r.mode,
    terminalBin: r.terminal_bin,
    pid: r.pid,
    windowId: r.window_id,
    ompThreadId: r.omp_thread_id,
    cwd: r.cwd,
    label: r.label,
    startedAt: toIsoTimestamp(r.started_at)!,
    endedAt: toIsoTimestamp(r.ended_at),
    exitCode: r.exit_code,
  };
}

export async function recordAdvSession(opts: RecordOpts): Promise<number | null> {
  try {
    await ensureAdvSessionsTable();
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, plan_slug, mode, terminal_bin, pid, label, omp_thread_id, cwd)
      VALUES
        (${activeWorkspaceId()}, ${opts.planSlug ?? null}, ${opts.mode},
         ${opts.terminalBin ?? null}, ${opts.pid ?? null}, ${opts.label ?? null},
         ${opts.ompThreadId ?? null}, ${opts.cwd ?? null})
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
    await ensureAdvSessionsTable();
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
    await ensureAdvSessionsTable();
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
    await ensureAdvSessionsTable();
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
    await ensureAdvSessionsTable();
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
      mode: 'omp' | 'console';
      terminal_bin: string | null;
      pid: number | null;
      window_id: string | null;
      omp_thread_id: string | null;
      label: string | null;
      cwd: string | null;
      started_at: string | Date;
      ended_at: string | Date | null;
      exit_code: number | null;
    }>>`
      SELECT id, workspace_id, plan_slug, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, started_at, ended_at, exit_code
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

export async function getAdvSession(id: number): Promise<AdvSessionRow | null> {
  try {
    await ensureAdvSessionsTable();
    const { sql } = getOrgPg();
    const rows = await sql<Array<{
      id: number;
      workspace_id: string;
      plan_slug: string | null;
      mode: 'omp' | 'console';
      terminal_bin: string | null;
      pid: number | null;
      window_id: string | null;
      omp_thread_id: string | null;
      label: string | null;
      cwd: string | null;
      started_at: string | Date;
      ended_at: string | Date | null;
      exit_code: number | null;
    }>>`
      SELECT id, workspace_id, plan_slug, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, started_at, ended_at, exit_code
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
