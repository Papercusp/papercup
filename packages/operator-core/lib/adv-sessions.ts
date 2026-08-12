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
import { boundedOrgTxn } from './pg-bounded-txn';
import { activeWorkspaceId } from './workspace-registry';
import type { SuAgent } from './su-agents';
import { caveat, type FieldCaveat } from './field-reliability';

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

/** Claude native session ids are v4 UUIDs; refuse anything else so a corrupted
 *  report can never poison the authoritative owner→native mapping (WI-5075).
 *  Shared by every writer of `adv_sessions.session_id` from an externally
 *  reported id (the respawn report, the SessionStart lifecycle hook) so the
 *  validation can't drift between call sites. */
export const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who wrote a row's `ended_at` (migration 735), and whether the exit was VOLUNTARY
 * (migration 800).
 *
 * TWO ORTHOGONAL AXES live in this one column, and conflating them is what made a
 * mass reap invisible (WI-38054). Read them separately:
 *
 * | value          | `ended_at` is...  | the exit was...                        |
 * |----------------|-------------------|----------------------------------------|
 * | `'self'`       | the real end time | voluntary                              |
 * | `'signal'`     | the real end time | INVOLUNTARY — killed by `ended_signal` |
 * | `'reaper'`     | a NOTICE time     | unknown; already gone when noticed     |
 * | `'reconciler'` | a NOTICE time     | unknown; already gone when noticed     |
 * | `'cleanup'`    | a CLOSE time      | never ran                              |
 * | `null`         | unknown           | unknown (legacy, pre-735)              |
 *
 * ⚠ `'signal'` is an OBSERVATION, so it groups with `'self'` on the TIME axis and
 * against it on the VOLUNTARY axis. Use {@link isObserverEndedSession} for the first
 * question and {@link isInvoluntaryEnd} for the second — never `!== 'self'` for both,
 * which is the shortcut that produced the original wrong answer.
 *
 * WHY `'signal'` AND NOT `'reaped'`: the reporting parent observes only "my child died
 * from signal N". It cannot know whether the sender was a host restart, an owner's
 * Ctrl-C, a peer's `processes:kill`, or the OOM killer. Naming it after a cause nothing
 * observed would re-commit the very over-attribution this column exists to prevent.
 */
export type AdvSessionEndedBy = 'self' | 'signal' | 'reaper' | 'reconciler' | 'cleanup';

/**
 * The writers whose `ended_at` is a REAL end time because a live parent watched the
 * process go, as opposed to a sweeper stamping `now()` on noticing a corpse.
 *
 * Declared once so the two axes can never drift apart again: every "is this timestamp
 * trustworthy?" check reads this set, and nothing re-derives it from `!== 'self'`.
 */
const OBSERVED_END_WRITERS: ReadonlySet<AdvSessionEndedBy> = new Set(['self', 'signal']);

export interface AdvSessionRow {
  id: number;
  workspaceId: string;
  /** Harness scope persisted in the resolved su launch spec, when available.
   *  Older rows and pre-migration databases omit it and remain workspace-only. */
  harnessSlug?: string | null;
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
  /**
   * When this row was marked ended — WHICH IS NOT NECESSARILY WHEN THE SESSION ENDED.
   *
   * Read `endedBy` before reasoning from this. Only `endedBy === 'self'` makes this an
   * observation; every other value (including `null`) means a sweeper stamped `now()` on
   * noticing a process that was ALREADY gone, so the true end time is unknown and the gap
   * is of arbitrary length. See {@link advSessionEndedAtCaveat}.
   */
  endedAt: string | null;
  /**
   * NULL here does NOT mean "clean exit" — it means "no code was ever observed", and that
   * happens for two unrelated reasons that are indistinguishable from this column alone:
   *
   *  - a genuine self-report with no code (`harness/spawn.ts` passes `r.exitCode ?? null`
   *    unconditionally, so a real self-reported end can still leave this NULL); or
   *  - we never reaped the process at all — it is not our child, so no status was ever
   *    read (see the `reconcileDeadTerminalLaunches` comment above, which documents this
   *    for the terminal-launch case specifically).
   *
   * Whoever writes it inherits the SAME provenance gap {@link endedAt} has (P-015,
   * WI-7126/EI-19375527037368001): when {@link isObserverEndedSession} is true for this row,
   * this NULL is an observer's absence-of-evidence, not evidence of a clean exit — do not
   * render it as "exited cleanly" or "code unknown but healthy". Pass it through
   * {@link advSessionExitCodeCaveat} before exposing it, the same way
   * {@link advSessionEndedAtCaveat} guards `endedAt`.
   *
   * ⚠ A NON-null `0` is the more dangerous case, and it is NOT hypothetical (WI-38054):
   * node-pty reports a signal death as `{ exitCode: 0, signal: N }`, so a KILLED session
   * carries a zero that looks exactly like a clean exit. Check {@link endedBy} — a
   * `'signal'` row's `exitCode` is a placeholder and carries no status at all.
   */
  exitCode: number | null;
  /**
   * Who wrote {@link endedAt}, and whether the exit was voluntary. `null` = legacy row
   * (migration 735) — provenance UNKNOWN, which is NOT the same as 'self' and must not
   * be read as it. See {@link AdvSessionEndedBy} for the two-axis table.
   */
  endedBy: AdvSessionEndedBy | null;
  /**
   * The signal that killed this session (e.g. `'SIGHUP'`), when {@link endedBy} is
   * `'signal'`; `null` for every other writer (enforced by a CHECK, migration 800).
   *
   * This is the ONLY field that can contradict a signal row's misleading `exitCode: 0`,
   * which is why it is persisted rather than derived — the discarding of this exact
   * value is what let a mass reap read as two voluntary exits.
   */
  endedSignal: string | null;
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
  harness_slug?: string | null;
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
  /** Optional so a SELECT that omits it maps to null = UNKNOWN provenance, which is
   *  treated as un-attributed (caveated), never as a clean 'self' exit. */
  ended_by?: string | null;
  /** Optional for the same reason as {@link ended_by}: a SELECT that omits it maps to
   *  null, which reads as "no signal recorded" rather than inventing one. */
  ended_signal?: string | null;
  port_id?: string | null;
  port_source_adv_session_id?: number | string | null;
  port_status?: string | null;
  port_metadata?: Record<string, unknown> | null;
}): AdvSessionRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug ?? null,
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
    endedBy: (r.ended_by as AdvSessionEndedBy | null) ?? null,
    endedSignal: r.ended_signal ?? null,
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
             display, launch_argv, launched_at, started_at, ended_at, exit_code, ended_by, ended_signal
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
 * Is `pid` a live OS process? Signal 0 = existence check; EPERM = alive-not-ours.
 * Deliberately a local copy of adv-roster's identical helper rather than a shared
 * import: adv-roster imports THIS module, so importing it back closes a cycle.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * A terminal launch we can PROVE never made it: its window process is gone and
 * it never registered a session. This is the OBSERVATION that WI-6821 was
 * missing — until it existed, a dead launch and a still-booting one were
 * indistinguishable, so the roster advertised the corpse as `starting` for the
 * whole window and the only thing that ever corrected the copy was a 60s
 * client-side timer (a guess, not evidence).
 *
 * `gnome-terminal --wait` is what makes this sound: the recorded pid is a
 * liveness handle for the terminal WINDOW's lifetime, so its absence is real
 * evidence rather than an inference from elapsed time.
 *
 * Both wrong answers are avoided deliberately:
 *  - `sessionId != null` ⇒ it registered, so it booted; never call that failed.
 *  - `pid == null` ⇒ no handle, hence NO EVIDENCE — leave it alone rather than
 *    guess (the status quo is a spinner; a false failure is a fabricated
 *    diagnosis, which is the very bug class this item is about).
 *  - a RECYCLED pid can only read alive, never gone — so pid-wrap (≈daily on
 *    this box under fleet load) can only make us miss a dead launch, never
 *    declare a live one dead. The error direction is the safe one.
 *
 * Host-safety: a pid is only meaningful on its own host, and `adv_sessions` has
 * no host column — but a `display='terminal'` row is LOCAL BY CONSTRUCTION
 * (`spawnInTerminal` spawns on the operator's own box), so the probe is sound
 * without one. If terminal launches ever become remote, this invariant breaks
 * and the row needs a host before it can be probed.
 *
 * Pure + injected `pidAlive` (the local idiom — see release-checkpoint-launch)
 * so the decision is unit-testable without real processes.
 */
export function isDeadTerminalLaunch(
  row: AdvSessionRow,
  pidAlive: (pid: number) => boolean = isPidAlive,
): boolean {
  if (row.display !== DISPLAY_TERMINAL_LAUNCH) return false;
  if (row.endedAt != null) return false; // already reconciled
  if (row.sessionId != null) return false; // it registered — it booted
  if (row.pid == null) return false; // no handle → no evidence
  return !pidAlive(row.pid);
}

/**
 * Does PERSISTED state say this launch failed? Pure — no probe. A terminal row
 * that has ended while never having registered a session is, by definition, a
 * launch that died before coming online.
 *
 * Derived rather than carried as a transient flag on purpose: "failed" then has
 * exactly ONE definition, shared by the reconciler that writes it and every
 * reader that renders it, and it survives a reload because it is a fact about
 * the row rather than about one process's memory.
 */
export function isFailedTerminalLaunch(row: AdvSessionRow): boolean {
  return (
    row.display === DISPLAY_TERMINAL_LAUNCH && row.endedAt != null && row.sessionId == null
  );
}

/**
 * Stamp the launches we can prove are dead, and reflect the stamp in the rows we
 * return so the caller renders the truth on THIS poll rather than the next one.
 *
 * ⚠ `exit_code` is deliberately left NULL. We never reap this process — it is not
 * our child — so we never observe a status, and inventing a sentinel would be the
 * same fabrication this item exists to remove. The durable marker for "died before
 * registering" is `session_id IS NULL` (see isFailedTerminalLaunch), which is a
 * thing we actually know.
 *
 * The write is best-effort and the returned rows are corrected in memory first,
 * so a failed stamp degrades to "re-detected on the next poll", never to a wrong
 * answer.
 */
async function reconcileDeadTerminalLaunches(
  rows: AdvSessionRow[],
  pidAlive: (pid: number) => boolean = isPidAlive,
): Promise<AdvSessionRow[]> {
  const dead = rows.filter((r) => isDeadTerminalLaunch(r, pidAlive));
  if (dead.length === 0) return rows;
  const endedAt = new Date().toISOString();
  for (const r of dead) {
    r.endedAt = endedAt;
    // Keep the in-memory correction consistent with the write below: this stamp is a
    // NOTICE time, and a caller reading the corrected row must be able to tell.
    r.endedBy = 'reconciler';
  }
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.adv_sessions
         SET ended_at = now(), ended_by = 'reconciler'
       WHERE id = ANY(${dead.map((r) => r.id)}::bigint[])
         AND ended_at IS NULL
         AND session_id IS NULL
    `;
  } catch (e) {
    warnUnlessMissingTable(e, 'reconcileDeadTerminalLaunches');
  }
  return rows;
}

/**
 * Terminal-spawned psu launches inside the boot window (WI-6376 / owner ask
 * 2026-07-25: "I want the sessions to show up there whether or not they are
 * launched with the new session button or if they are launched with the psu
 * utility").
 *
 * Between the spawn and psu's own coord-presence registration there is no
 * presence row, so the presence-primary roster cannot see the session at all —
 * the board showed it NOWHERE. This is the durable representation that covers
 * that window; the caller drops any row whose owner has since come online, so a
 * booted session is rendered once, from presence, not twice.
 *
 * Ended rows are included when they NEVER REGISTERED (WI-6821). A launch that
 * booted and later ended has a session_id and belongs in the `ended` list; one
 * that ended having never registered is a FAILED LAUNCH, and dropping it here
 * would leave the modal to fall through to "No recent Claude session found for
 * this agent" — replacing a spinner with a shrug. Keeping it in the tier, marked
 * failed, is what finally delivers the intent STARTING_LAUNCH_WINDOW_SEC was
 * written for: "a launch which never booted is VISIBLE as a failure rather than
 * silently absent".
 */
export async function listStartingTerminalLaunches(
  opts: {
    workspaceId?: string | null;
    limit?: number;
    withinSec?: number;
    pidAlive?: (pid: number) => boolean;
  } = {},
): Promise<AdvSessionRow[]> {
  const limit = opts.limit ?? 50;
  const withinSec = opts.withinSec ?? STARTING_LAUNCH_WINDOW_SEC;
  const ws = opts.workspaceId ?? null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<Parameters<typeof mapAdvSessionRow>[0]>>`
      SELECT id, workspace_id, plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id,
             display, launch_argv, launched_at, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE display = ${DISPLAY_TERMINAL_LAUNCH}
         AND (ended_at IS NULL OR session_id IS NULL)
         AND started_at > now() - (${withinSec}::int * interval '1 second')
         AND (${ws}::text IS NULL OR workspace_id = ${ws})
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return await reconcileDeadTerminalLaunches(rows.map(mapAdvSessionRow), opts.pidAlive);
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

/**
 * ADOPT the launcher's starting row as this session's own (WI-37743).
 *
 * A programmatic spawner that PRE-PINS the owner id (`psu --owner-id=…`) writes a
 * `display='terminal'` starting row for the board to render during the boot window
 * (WI-6376) — and that row is bound to the very owner id the booting psu is about
 * to claim. It is this session's row, written moments early by its own launcher;
 * it is NOT a second session. So bootstrap COMPLETES it instead of inserting a
 * duplicate beside it.
 *
 * Two bugs die here:
 *  - the terminal launch itself. bootstrap's pre-pinned-owner freshness guard
 *    refuses an id that already has an un-ended row, so the launcher's own row
 *    made psu exit 1 — and since the one-liner is `exec psu`, that exit closed the
 *    window and surfaced as "its terminal closed before the session came online".
 *  - the ORPHAN. The headless path won that race the other way (its spawn helper
 *    returns slowly enough that psu registered first), leaving a registered row
 *    PLUS a starting row that never got a session_id — which `isFailedTerminalLaunch`
 *    later reads as a failed launch for a session that ran perfectly.
 *
 * Guarded to `session_id IS NULL AND ended_at IS NULL` so it can only ever complete
 * a genuine not-yet-online precursor: a row already carrying a session, or one the
 * reconciler has stamped, is left untouched and the caller falls back to inserting.
 * Returns true when this call did the adopting.
 */
export async function adoptStartingTerminalLaunch(opts: {
  id: number;
  sessionId: string | null;
  planSlug?: string | null;
  label?: string | null;
  cwd?: string | null;
  mode?: string | null;
  launchArgv?: string[] | null;
}): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ id: number }[]>`
      UPDATE harness_shared.adv_sessions
         SET session_id = ${opts.sessionId},
             plan_slug  = COALESCE(${opts.planSlug ?? null}, plan_slug),
             label      = COALESCE(${opts.label ?? null}, label),
             cwd        = COALESCE(${opts.cwd ?? null}, cwd),
             mode       = COALESCE(${opts.mode ?? null}, mode),
             launch_argv = COALESCE(
               ${opts.launchArgv ? JSON.stringify(opts.launchArgv) : null}::text::jsonb,
               launch_argv
             )
       WHERE id = ${opts.id}
         AND display = ${DISPLAY_TERMINAL_LAUNCH}
         AND session_id IS NULL
         AND ended_at IS NULL
       RETURNING id
    `;
    return rows.length > 0;
  } catch (e) {
    warnUnlessMissingTable(e, 'adoptStartingTerminalLaunch');
    return false;
  }
}

/**
 * Stamp the spawn result onto an already-written row.
 *
 * `terminalBin` is optional and COALESCE'd (WI-37743): a caller that writes its
 * starting row BEFORE spawning — which is the only ordering that lets
 * {@link adoptStartingTerminalLaunch} work at all, since a booting psu races
 * the launcher — has no pid or terminal yet, and fills both in here once the
 * spawn returns. Omitting it must never blank a value another writer set.
 */
export async function setAdvSessionPid(
  id: number,
  pid: number | null,
  terminalBin?: string | null,
): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.adv_sessions
         SET pid = ${pid},
             terminal_bin = COALESCE(${terminalBin ?? null}, terminal_bin)
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

/**
 * Is this row's `endedAt` an OBSERVATION of the session ending, or the moment a sweeper
 * NOTICED it was already gone?
 *
 * ⚠ Do NOT try to infer this from `exitCode`. The obvious shortcut — "exitCode == null
 * means a sweeper wrote it" — is WRONG: `harness/spawn.ts` passes `r.exitCode ?? null`,
 * so a genuine self-report also writes NULL. That inference over-fires on real
 * self-reports, which is the same confident-wrong-answer this function exists to prevent.
 *
 * `endedBy == null` (a legacy row) is UNKNOWN provenance and is treated as un-attributed,
 * NOT as 'self' — absence of attribution is not evidence of a clean exit.
 */
export function isObserverEndedSession(row: Pick<AdvSessionRow, 'endedAt' | 'endedBy'>): boolean {
  if (row.endedAt == null) return false;
  // ⚠ NOT `!== 'self'`. A 'signal' row was watched by its live parent, so its timestamp
  // is every bit as good as a self-report — it is the VOLUNTARINESS that differs, and
  // that question belongs to isInvoluntaryEnd. Collapsing the two axes here would make
  // every killed session's end time read as an unreliable NOTICE time, which is a fresh
  // wrong answer rather than a fix (WI-38054).
  return !OBSERVED_END_WRITERS.has(row.endedBy as AdvSessionEndedBy);
}

/**
 * Was this session KILLED rather than allowed to exit?
 *
 * The question `ended_by`'s original single axis could not answer, and the one the
 * owner actually needed: a reaped agent and a finished agent looked identical.
 *
 * Deliberately FALSE for the sweeper writers. A `'reaper'` row means "the process was
 * already gone when we looked" — we genuinely do not know whether it was killed or
 * exited, and answering `true` would assert a cause nobody observed. Only `'signal'`,
 * where a live parent watched the kill land, is a positive observation of one.
 */
export function isInvoluntaryEnd(row: Pick<AdvSessionRow, 'endedBy'>): boolean {
  return row.endedBy === 'signal';
}

/**
 * Validate a launcher-reported killing signal, returning the signal NAME or `null`.
 *
 * This string arrives over HTTP from the psu launcher and is then persisted as the
 * stated reason an agent died, so it is SHAPE-CHECKED rather than trusted: only a real
 * signal name is storable.
 *
 * ⚠ The failure mode to keep in mind is that rejecting is NOT free. A rejected value
 * degrades to `'self'` — i.e. "it exited voluntarily" — so an over-strict rule here
 * silently recreates the very bug this fixes, for whichever signal it fails to match.
 * That is why the pattern accepts digits (`signalNameFromCode` emits `SIG<number>` for a
 * signal this Node build cannot name) rather than only a closed list of known names.
 */
export function parseKilledBySignalReport(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return /^SIG[A-Z0-9]{1,15}$/.test(raw) ? raw : null;
}

/**
 * The caveat for a row's `exit_code`, or `null` when the number means what it says.
 *
 * MEASURED against the real node-pty in this tree: killing a child with SIGHUP yields
 * `{ exitCode: 0, signal: 1 }`. The zero is a placeholder, not a status — so a KILLED
 * session carries the most persuasive possible evidence of a clean exit. Two of the
 * owner's agents were read as voluntary exits on exactly that zero (WI-38054).
 *
 * Pass the result through {@link withFieldReliability}, which is a no-op for an empty
 * caveat list, so healthy rows gain no noise.
 */
export function advSessionExitCodeCaveat(
  row: Pick<AdvSessionRow, 'endedAt' | 'endedBy' | 'exitCode'>,
  field = 'exitCode',
): FieldCaveat | null {
  if (row.endedBy !== 'signal') return null;
  return caveat({
    field,
    reliability: 'inferred',
    cannotAnswer: 'did this session exit cleanly?',
    insteadRead: 'ended_signal — the signal that killed it; this exit code is a placeholder',
    because:
      'node-pty reports a signal death as exitCode 0 with the signal in a separate field, ' +
      'so a killed session records the same 0 a clean exit does. Measured 2026-08-12 (WI-38054): ' +
      'two owner-launched agents killed by a sidecar restart both recorded exit 0.',
  });
}

/**
 * The field-reliability caveat for a row whose `endedAt` a sweeper wrote — or `null` when
 * the row's end time is a real observation and the result needs no caveat.
 *
 * Pass the result through {@link withFieldReliability}; it returns the object unchanged
 * when the caveat list is empty, so callers need no conditional.
 */
export function advSessionEndedAtCaveat(
  row: Pick<AdvSessionRow, 'endedAt' | 'endedBy'>,
  field = 'endedAt',
): FieldCaveat | null {
  if (!isObserverEndedSession(row)) return null;
  const who =
    row.endedBy == null
      ? 'a row predating migration 735, so its writer is unknown'
      : `the ${row.endedBy}, which stamps now() on NOTICING a process that had already gone`;
  return caveat({
    field,
    reliability: 'inferred',
    cannotAnswer: 'when did this session actually end?',
    insteadRead: 'coord_presence.last_active_at for this session\'s owner — the last turn it actually took',
    because: `written by ${who}. Measured 2026-08-02 (WI-7126): one sweep stamped 9 rows within 13ms, one of them gone since 20 July — an artificial cluster that read as a simultaneous mass kill.`,
  });
}

/**
 * The one phrase every PROSE surface should use to describe when a session ended.
 *
 * Prose is where this goes wrong most quietly: a structured field can carry a caveat
 * beside it, but `ended ${endedAt}` states a time as fact with nowhere to put the doubt.
 * Three outcomes, and only the first is an actual end time:
 *
 *   'ended 2026-08-02T18:26:03Z'                     — self-reported, a real observation
 *   'last recorded … — that is when the reaper NOTICED it was gone, not when it ended'
 *   'end time unknown'                               — never ended, or no timestamp
 */
export function describeSessionEndTime(
  row: Pick<AdvSessionRow, 'endedAt' | 'endedBy'> & Partial<Pick<AdvSessionRow, 'endedSignal'>>,
): string {
  if (row.endedAt == null) return 'end time unknown';
  if (row.endedBy === 'self') return `ended ${row.endedAt}`;
  if (row.endedBy === 'signal') {
    // Both halves are load-bearing. The TIME is a real observation, so state it plainly
    // — hedging it would destroy the "several agents died in the same second" signature
    // that is the only way a mass reap is currently detectable. The KILL is the half
    // that must never be droppable, so it leads the clause. Name the signal when we
    // have it and stay silent when we do not, rather than inventing a plausible one.
    const bySignal = row.endedSignal ? ` by ${row.endedSignal}` : '';
    return `KILLED${bySignal} at ${row.endedAt} — an observed end time, but NOT a voluntary exit`;
  }
  const who = row.endedBy ?? 'an unrecorded writer';
  return `last recorded ${row.endedAt} — that is when ${who} NOTICED it was gone, not when it ended`;
}

/**
 * Mark a session ended.
 *
 * `endedBy` is REQUIRED on purpose: a row that cannot say who ended it cannot say whether
 * its `ended_at` is an observation, and that ambiguity is what made a sweep look like a
 * mass kill (WI-7126). Pass `'self'` ONLY when this process actually observed the
 * session's own exit.
 *
 * ⚠ AND ONLY WHEN THAT EXIT WAS VOLUNTARY. Observing a child die is not the same as the
 * child choosing to die: if it was killed, pass `'signal'` with `opts.signal`, not
 * `'self'`. Reporting a kill as `'self'` is what silently reaped two of the owner's
 * agents (WI-38054) — and because node-pty hands a signal death an `exitCode` of 0, the
 * resulting row actively asserts a clean exit instead of merely failing to describe one.
 */
export async function markAdvSessionEnded(
  id: number,
  exitCode: number | null,
  endedBy: AdvSessionEndedBy,
  opts: { signal?: string | null } = {},
): Promise<void> {
  try {
    const { sql } = getOrgPg();
    // The CHECK (migration 800) allows a signal name ONLY on a 'signal' row; normalise
    // here so a caller that passes both can never trip a constraint violation on the
    // telemetry path, which is best-effort and must never throw into an exiting session.
    const endedSignal = endedBy === 'signal' ? (opts.signal ?? null) : null;
    const r = await sql`
      UPDATE harness_shared.adv_sessions
         SET ended_at = now(), exit_code = ${exitCode}, ended_by = ${endedBy},
             ended_signal = ${endedSignal}
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

/**
 * Persist the RESOLVED su persona render inputs on the session's row (migration
 * 738), so a carry-respawn can re-render the launch context from current prompt
 * sources instead of inheriting the predecessor's already-rendered file
 * (stale-prompt-render-in-live-sessions-2026-08-02 P-002).
 *
 * Best-effort and never throws: a launch must not fail because this bookkeeping
 * did. The cost of it missing is bounded and known — that session's respawns keep
 * the inherited render, i.e. exactly today's behaviour.
 */
export async function recordSuLaunchSpec(
  advSessionId: number | null,
  coordOwnerId: string | null,
  launchSpec: unknown,
): Promise<boolean> {
  if (!launchSpec) return false;
  if ((advSessionId == null || advSessionId <= 0) && !coordOwnerId) return false;
  try {
    const { sql } = getOrgPg();
    const payload = JSON.stringify(launchSpec);
    // Prefer the exact row id; fall back to the owner's NEWEST row for the
    // interactive cohort, which never carries PAPERCUSP_ADV_SESSION_ID (the same
    // keying reanchorAdvSessionNativeIdByOwner uses, so the two agree by
    // construction).
    const rows =
      advSessionId != null && advSessionId > 0
        ? await sql<{ id: number }[]>`
            UPDATE harness_shared.adv_sessions
               SET launch_spec = ${payload}::jsonb
             WHERE id = ${advSessionId}
            RETURNING id
          `
        : await sql<{ id: number }[]>`
            UPDATE harness_shared.adv_sessions
               SET launch_spec = ${payload}::jsonb
             WHERE id = (
               SELECT id FROM harness_shared.adv_sessions
                WHERE coord_owner_id = ${coordOwnerId}
                ORDER BY started_at DESC
                LIMIT 1
             )
            RETURNING id
          `;
    return rows.length > 0;
  } catch (e) {
    warnUnlessMissingTable(e, 'recordSuLaunchSpec');
    return false;
  }
}

/**
 * Read back the persona render inputs for a coord owner — the respawn key, which
 * is stable across every respawn by design (mintRecycleArgs rotates only the
 * NATIVE claude session id; PAPERCUSP_SID is deliberately untouched).
 *
 * Reads the NEWEST row for the owner, matching `reanchorAdvSessionNativeIdByOwner`
 * and `resolveSessionRef`. Returns null (never throws) when there is no row, no
 * spec, or the store is unavailable — every one of which fail-softs the caller to
 * the inherited render.
 */
export async function readSuLaunchSpecByOwner(coordOwnerId: string): Promise<unknown | null> {
  if (!coordOwnerId) return null;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ launch_spec: unknown }[]>`
      SELECT launch_spec
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${coordOwnerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    return rows[0]?.launch_spec ?? null;
  } catch (e) {
    warnUnlessMissingTable(e, 'readSuLaunchSpecByOwner');
    return null;
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
        harness_slug?: string | null;
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
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal,
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
      SELECT id, workspace_id,
             -- launch_spec was added after the resumable-session surface. Reading
             -- through to_jsonb keeps this query parse-safe on a pre-migration
             -- operator; absent launch_spec then correctly means no harness scope.
             to_jsonb(a)->'launch_spec'->>'harnessSlug' AS harness_slug,
             plan_slug, agent, role, feature, mode, terminal_bin, pid,
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
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

/**
 * EI-19284963139619048: `loop:status`'s wake-reachability probe reads the caller's
 * session row through this function to decide the wake channel. It used to run on
 * the plain, unbounded `getOrgPg()` admin pool — no statement_timeout — so a stall
 * here (lock wait / slow scan under fleet load) hung `loop:status` itself until the
 * client's own 300s idle-timeout killed the call blind (pg-bounded-txn.ts's header
 * documents this exact symptom class, already fixed for `work_items:comment`).
 * boundedOrgTxn sets a real statement_timeout so a stall now fails fast + typed —
 * caught by the SAME try/catch this function already had for a missing-table read,
 * so a timeout degrades to `null` exactly like today's other error paths.
 */
export async function getAdvSession(id: number): Promise<AdvSessionRow | null> {
  try {
    const rows = await boundedOrgTxn((tx) => tx<
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
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal,
             to_jsonb(a)->>'port_id' AS port_id,
             to_jsonb(a)->>'port_source_adv_session_id' AS port_source_adv_session_id,
             to_jsonb(a)->>'port_status' AS port_status,
             to_jsonb(a)->'port_metadata' AS port_metadata
        FROM harness_shared.adv_sessions a
       WHERE workspace_id = ${activeWorkspaceId()}
         AND id = ${id}
       LIMIT 1
    `);
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
             started_at, ended_at, exit_code, ended_by, ended_signal,
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
/**
 * The ACTIVE roster tier's adv rows, keyed by coord owner.
 *
 * ⚠ `launch_argv` MUST stay in this SELECT (WI-6510). It is declared OPTIONAL on
 * `AdvSessionDbRow` ("only the pending-launch query SELECTs it"), so dropping it
 * from the column list does NOT fail typecheck: `mapAdvSessionRow` maps the
 * missing column to `null`, the roster's `adv?.launchArgv ?? []` turns that into
 * an empty argv, and every live agent silently reports "no model recorded" while
 * the DB row holds the full spec. Verified live 2026-08-11: the chat MODEL pill
 * vanished entirely for a session launched with `--model=sonnet[1m]:high`, with
 * unit tests and typecheck both green — the fixtures set the field by hand, so
 * only a live drive could see it.
 */
export async function advSessionsByCoordOwner(limit = 500): Promise<Map<string, AdvSessionRow>> {
  const out = new Map<string, AdvSessionRow>();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<
      Array<{
        id: number;
        /** See the docblock: omitting this maps to null, not a type error. */
        launch_argv?: string[] | null;
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
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, launch_argv,
             started_at, ended_at, exit_code, ended_by, ended_signal
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
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
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
 * When this coord owner FIRST existed — the EARLIEST `first_seen_at` across all
 * of its adv_sessions rows, as an ISO string (null when it has none on record).
 *
 * unread-count-truthfulness-2026-07-27 D-012: the unread cursor's birth floor.
 * A coord owner id survives respawns/carry-compactions, so this deliberately
 * takes the EARLIEST row, not the latest — flooring at the latest respawn would
 * silently drop mail that arrived during an earlier leg of the same owner's life.
 *
 * ⚠ WI-6589 — that safeguard used to be INERT, and reading `started_at` here was
 * why. The table keeps exactly ONE row per coord owner (13,797 of 13,797), and
 * `started_at` is bumped in place by every resume/re-anchor path below, so
 * MIN(started_at) === MAX(started_at) === the LATEST LAUNCH. The MIN could never
 * engage; a test seeding two rows for one owner asserted a shape production
 * cannot produce. `first_seen_at` (migration 707) is written once at INSERT and
 * never updated, so the MIN is a true birth. Do NOT revert this to `started_at`,
 * and do not add an UPDATE that touches `first_seen_at`.
 *
 * Fails soft to null if the column is not yet present (a deploy that has not run
 * migration 707): null = no floor, which OVER-counts broadcasts rather than
 * hiding mail — the safe direction.
 *
 * NOT workspace-scoped, same rationale as advSessionsByCoordOwner above (and
 * the same as its `latest` sibling below) — a coord owner id is globally unique,
 * and scoping here would make a cross-workspace row read as "never existed",
 * which floors to null and silently restores the count-from-epoch behaviour.
 */
export async function firstAdvSessionStartByCoordOwner(
  coordOwnerId: string,
): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ started_at: Date | string | null }>>`
      SELECT MIN(first_seen_at) AS started_at
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${coordOwnerId}
    `;
    const raw = rows[0]?.started_at ?? null;
    if (raw == null) return null;
    const d = raw instanceof Date ? raw : new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch (e) {
    warnUnlessMissingTable(e, 'firstAdvSessionStartByCoordOwner');
    return null;
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
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
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
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
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
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
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
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
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

/**
 * WI-37204 — recorded sessions whose coord owner id, native session id, or omp
 * thread id STARTS WITH `token`. Backs the id leg of
 * GET /api/adv/sessions/search-transcripts, which is what makes an ENDED
 * session findable by an id pasted out of a log or a work-item (the live roster
 * only answers for sessions that are still running).
 *
 * Prefix, not substring: `su-bc38a419` must find `su-bc38a419-8dc6-…` (the
 * short handle IS what the UI renders), while an id's tail is not a handle
 * anyone is given and a mid-string match would pull in unrelated sessions that
 * merely share a run of hex. `token` is lowercased by the caller
 * (`parseSessionIdQuery`); the columns hold lowercase uuids, so the comparison
 * is done on `lower(col)` to stay correct for any row that ever stored one
 * mixed-case.
 *
 * `like_escape` guards the two LIKE metacharacters: an id token is
 * caller-supplied text, and an unescaped `%` would turn a typo into a
 * whole-table scan that matches everything.
 */
export async function advSessionsByIdToken(
  token: string,
  opts: { limit?: number } = {},
): Promise<AdvSessionRow[]> {
  const t = token.trim().toLowerCase();
  if (!t) return [];
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const pattern = `${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
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
             window_id, omp_thread_id, label, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code, ended_by, ended_signal
        FROM harness_shared.adv_sessions
       WHERE lower(coord_owner_id) LIKE ${pattern}
          OR lower(session_id)     LIKE ${pattern}
          OR lower(omp_thread_id)  LIKE ${pattern}
       ORDER BY started_at DESC
       LIMIT ${limit}
    `;
    return rows.map(mapAdvSessionRow);
  } catch (e) {
    warnUnlessMissingTable(e, 'advSessionsByIdToken');
    return [];
  }
}
