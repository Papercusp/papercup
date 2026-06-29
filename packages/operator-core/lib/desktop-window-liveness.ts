/**
 * desktop-window-liveness.ts — derive which agent sessions are CURRENTLY "on the
 * desktop" (a live OS window on the user's screen), so the idle-session reaper
 * never kills a session the user is looking at and coord:presence can surface
 * which agents are on the desktop ("assign these to the agent on the desktop").
 *
 * Decision (2026-06-29, owner): "on the desktop" == the session's OS window is
 * still present RIGHT NOW — a live `wmctrl` enumeration of the open windows,
 * matched against the launch-recorded `adv_sessions.window_id` (with the unique
 * `[adv:<id>]` window-title tag and the recorded pid as fallbacks). Purely
 * DERIVED — no new column, no migration, recomputed each read.
 *
 * Box-local by design: `wmctrl` talks to the X server of THIS host, so on a
 * headless fleet box (no DISPLAY) it returns nothing → zero on-desktop sessions
 * → the reaper + presence behave exactly as before. The operator host that hosts
 * the desktop is where the console terminals (console-launch.ts) AND this sweep
 * both run, so the window list and the session rows line up.
 *
 * Best-effort throughout: any wmctrl/PG failure yields an EMPTY result, so a
 * desktop-liveness hiccup can only ever make the reaper MORE conservative
 * (over-protect a session) or make presence omit the flag — it can NEVER crash a
 * read/sweep or cause an extra kill. Two pure functions (`parseWmctrlList`,
 * `selectOnDesktopSessions`) carry the parsing + match logic so they unit-test
 * without an X server; the IO seams (`listOpenWindows`, `gatherOnDesktopSessions`)
 * wrap them with the wmctrl spawn + the adv_sessions read, both short-TTL-cached
 * so a burst of presence reads forks wmctrl at most once per window.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';

const execFileAsync = promisify(execFile);

/** One currently-open window (only the fields we match sessions on). */
export interface OpenWindow {
  /** wmctrl window id, e.g. '0x04200007'. */
  wid: string;
  /** Owning pid (wmctrl -lp column 3), or null when unknown. */
  pid: number | null;
  /** Window title (last column) — carries the `[adv:<id>]` launch tag. */
  title: string;
}

/**
 * PURE: parse `wmctrl -lp` stdout → the open windows. No spawn, so the column
 * parsing is unit-tested without an X server. Each line is:
 *   <wid> <desktop> <pid> <host> <title…>
 * A line without a `0x…` window id (or with < 4 columns) is skipped; the title
 * is the 5th column onward rejoined (it may contain spaces — the `[adv:N]` tag
 * survives).
 */
export function parseWmctrlList(stdout: string): OpenWindow[] {
  const out: OpenWindow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4 || !parts[0].startsWith('0x')) continue;
    const pidNum = Number(parts[2]);
    out.push({
      wid: parts[0],
      pid: Number.isFinite(pidNum) && pidNum > 0 ? pidNum : null,
      title: parts.slice(4).join(' '),
    });
  }
  return out;
}

/** wmctrl spawn timeout — a hung X server must never wedge a presence read. */
const WMCTRL_TIMEOUT_MS = 1500;
/** Short cache so a burst of reads (presence + reaper) forks wmctrl at most once. */
const OPEN_WINDOWS_TTL_MS = 5000;

let openWindowsCache: { at: number; windows: OpenWindow[] } | null = null;

/** Injectable side-effects so `listOpenWindows` unit-tests without a real X server. */
export interface ListOpenWindowsDeps {
  /** Returns `wmctrl -lp` stdout, or null on any failure. May be sync (tests) or
   *  async (production uses a non-blocking spawn). */
  run?: () => string | null | Promise<string | null>;
  nowMs?: number;
  ttlMs?: number;
}

/** ASYNC + non-blocking by design: this runs on the single :3070 operator event
 *  loop (the D-007 chokepoint) via the presence read path, so it must NEVER use a
 *  blocking spawnSync — a hung X server would freeze the whole operator. execFile
 *  kills the child at WMCTRL_TIMEOUT_MS and rejects → caught → null. */
async function defaultRunWmctrl(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('wmctrl', ['-lp'], {
      timeout: WMCTRL_TIMEOUT_MS,
      encoding: 'utf8',
    });
    return typeof stdout === 'string' ? stdout : null;
  } catch {
    return null; // no wmctrl / no DISPLAY / spawn error / timeout → no windows
  }
}

/**
 * The currently-open windows on this box (short-TTL cached). Best-effort → []:
 * no wmctrl, no DISPLAY (headless), a spawn timeout, or a parse miss all yield an
 * empty list, which downstream reads as "nobody is on the desktop".
 */
export async function listOpenWindows(deps: ListOpenWindowsDeps = {}): Promise<OpenWindow[]> {
  const ttl = deps.ttlMs ?? OPEN_WINDOWS_TTL_MS;
  const now = deps.nowMs ?? Date.now();
  if (openWindowsCache && now - openWindowsCache.at < ttl) return openWindowsCache.windows;
  const stdout = await (deps.run ?? defaultRunWmctrl)();
  const windows = stdout ? parseWmctrlList(stdout) : [];
  openWindowsCache = { at: now, windows };
  return windows;
}

/** Test seam: drop the cached window list (and the on-desktop result cache). */
export function __resetDesktopLivenessCache(): void {
  openWindowsCache = null;
  onDesktopCache = null;
}

/** A candidate session for the on-desktop check — its launch-recorded handles. */
export interface DesktopCandidateSession {
  /** The adv_sessions row id — used to build the `[adv:<id>]` title-tag fallback. */
  advSessionId: number;
  /** coord owner id (PAPERCUSP_SID) — the reaper/presence join key. */
  coordOwnerId: string | null;
  /** Native session id (claude uuid) — the slice-3 zombie-reap key. */
  sessionId: string | null;
  /** Launch-resolved X11 window id (the primary match key). */
  windowId: string | null;
  /** Recorded launch pid (a fallback match key). */
  pid: number | null;
}

/** The three keyings of "currently on the desktop" the callers need. */
export interface OnDesktopSets {
  /** coord owner ids whose OS window is open — the reaper protect + presence key. */
  owners: Set<string>;
  /** native session ids whose OS window is open — the slice-3 zombie-reap key. */
  sessionIds: Set<string>;
  /** adv_session row ids on the desktop — the /adv/sessions surface key. */
  advSessionIds: Set<number>;
}

function emptyOnDesktopSets(): OnDesktopSets {
  return { owners: new Set(), sessionIds: new Set(), advSessionIds: new Set() };
}

/**
 * PURE: which candidate sessions currently have an open OS window. A session
 * matches when ANY of:
 *   - its recorded `windowId` is in the open-window set (primary, most reliable —
 *     console-launch retries for 5s to resolve + store it by the title tag), OR
 *   - an open window's title carries its `[adv:<id>]` launch tag (the same tag
 *     console-launch sets, so it survives even if window_id capture missed), OR
 *   - an open window's pid equals its recorded launch pid (fallback for
 *     emulators whose window pid == the spawned pid).
 * Injected open-window list so the match logic is unit-tested without wmctrl.
 * Over-matching is SAFE by design (it only over-protects a session from the
 * reaper / shows an extra desktop flag), so the union of cheap signals is
 * deliberate.
 */
export function selectOnDesktopSessions(
  sessions: readonly DesktopCandidateSession[],
  openWindows: readonly OpenWindow[],
): OnDesktopSets {
  const sets = emptyOnDesktopSets();
  if (openWindows.length === 0 || sessions.length === 0) return sets;
  const openWids = new Set(openWindows.map((w) => w.wid));
  const openPids = new Set(
    openWindows.map((w) => w.pid).filter((p): p is number => p != null),
  );
  const titles = openWindows.map((w) => w.title);
  for (const s of sessions) {
    const tag = `[adv:${s.advSessionId}]`;
    const onDesktop =
      (s.windowId != null && openWids.has(s.windowId)) ||
      (s.pid != null && openPids.has(s.pid)) ||
      titles.some((t) => t.includes(tag));
    if (!onDesktop) continue;
    if (s.coordOwnerId) sets.owners.add(s.coordOwnerId);
    if (s.sessionId) sets.sessionIds.add(s.sessionId);
    sets.advSessionIds.add(s.advSessionId);
  }
  return sets;
}

/** Candidate recency bound — a session whose window could still be open. Includes
 *  ended-but-recent rows on purpose: a still-open window on an ended adv row is
 *  exactly the "marked dead but still on screen" case we must spare. Mirrors
 *  adv-sessions RECORDED_LIVE_MAX_AGE_MS (12h). */
export const DESKTOP_CANDIDATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Short cache on the joined result — presence may read it per call; the reaper
 *  per sweep. The window list has its own TTL; this also caches the PG join. */
const ON_DESKTOP_TTL_MS = 5000;
let onDesktopCache: { at: number; sets: OnDesktopSets } | null = null;

/**
 * The sessions currently on the desktop, keyed three ways (owners / sessionIds /
 * advSessionIds). Enumerates the open windows, joins them to the recently-launched
 * adv_sessions that carry a window handle, and returns the matches. Short-TTL
 * cached. Best-effort → empty sets on ANY failure (the reaper/presence then behave
 * as if nothing is on the desktop, never crashing and never over-killing).
 */
export async function gatherOnDesktopSessions(
  opts: { maxAgeMs?: number; nowMs?: number; ttlMs?: number } = {},
): Promise<OnDesktopSets> {
  const ttl = opts.ttlMs ?? ON_DESKTOP_TTL_MS;
  const now = opts.nowMs ?? Date.now();
  if (onDesktopCache && now - onDesktopCache.at < ttl) return onDesktopCache.sets;

  let sets = emptyOnDesktopSets();
  try {
    const windows = await listOpenWindows();
    // No open windows (headless box / no DISPLAY) → nobody is on the desktop.
    if (windows.length > 0) {
      const maxAgeSec = Math.max(1, Math.round((opts.maxAgeMs ?? DESKTOP_CANDIDATE_MAX_AGE_MS) / 1000));
      const { sql } = getOrgPg();
      const rows = await sql<
        Array<{ id: number; coord_owner_id: string | null; session_id: string | null; window_id: string | null; pid: number | null }>
      >`
        SELECT id, coord_owner_id, session_id, window_id, pid
          FROM harness_shared.adv_sessions
         WHERE started_at > now() - make_interval(secs => ${maxAgeSec})
           AND (window_id IS NOT NULL OR pid IS NOT NULL)`;
      sets = selectOnDesktopSessions(
        rows.map((r) => ({
          advSessionId: r.id,
          coordOwnerId: r.coord_owner_id,
          sessionId: r.session_id,
          windowId: r.window_id,
          pid: r.pid,
        })),
        windows,
      );
    }
  } catch (e) {
    console.warn('[desktop-window-liveness] gather failed (non-fatal):', (e as Error)?.message ?? e);
    sets = emptyOnDesktopSets();
  }
  onDesktopCache = { at: now, sets };
  return sets;
}
