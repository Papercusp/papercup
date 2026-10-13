/**
 * The agent-session roster — the ONE read behind the desktop Sessions roster
 * (`advRoster.list` sync query) and the device session list
 * (mobile-agent-sessions-2026-10-12 P-001; the device route is P-002).
 *
 * The four-leg fan-out, its read deadline and its stale-while-revalidate cache
 * live in `sync-resolver/adv-roster-read.ts`. This entry point exists so both
 * surfaces call the same function with the same defaults; a device route that
 * called `readAdvRoster` with its own `endedLimit` or projection would already
 * be a second roster.
 */
import { projectAdvRoster, readAdvRoster } from '../sync-resolver/adv-roster-read';

export interface ReadSessionRosterOptions {
  /** The caller's workspace; null reads every workspace (desktop operator scope). */
  workspaceId?: string | null;
  /** How many ended sessions to include. */
  endedLimit?: number;
  /** `header` is the closed pill's live-count projection; `full` is the roster. */
  view?: 'full' | 'header';
}

export const SESSION_ROSTER_DEFAULT_ENDED_LIMIT = 50;

/** Read the session roster exactly as the desktop Sessions roster shows it. */
export async function readSessionRoster(opts: ReadSessionRosterOptions = {}) {
  const {
    workspaceId = null,
    endedLimit = SESSION_ROSTER_DEFAULT_ENDED_LIMIT,
    view = 'full',
  } = opts;
  return projectAdvRoster(await readAdvRoster({ workspaceId, endedLimit }), view);
}
