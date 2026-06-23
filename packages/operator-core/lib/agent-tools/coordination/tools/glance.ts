/**
 * coord:glance — ONE cheap call answering "what should I know right now?":
 * wake-gate state (default mode + staged-wake count), bees in flight, governor
 * pauses, the recent activity rows the fleet statusline already rendered, and
 * contextual TIPS evaluated for the caller's audience (glance-tips.ts).
 *
 * Built for high-frequency consumers (the Claude Code statusline renders on
 * every conversation update), so it stays light: three small PG reads, an
 * in-memory governor snapshot, and the pure tips engine — no usage/$spend
 * aggregation (that's dev:rate_governor_status).
 *
 * The founding tip (2026-06-11): the queen's autonomous loop sat silently
 * queued behind a manual wake gate for hours. coord:glance exists so that
 * state is one statusline line away, with the slash command to fix it.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { snapshotGovernors } from '@papercusp/papercusp-shared/agent';
import { COORD_ROLES } from '../roles';
import { getDefaultWakeMode } from '../wake-mode';
import { countAllPendingWakes } from '../pending-wakes';
import { evaluateTips, GLANCE_AUDIENCES } from '../glance-tips';
import { resolveAgentIdentity } from '../identity';
import { getPresence } from '../presence';
import { getLoopStatus } from '../../../harness/routines/loop';

const DEFAULT_ACTIVITY_LIMIT = 12;

/** Nursery heartbeats are supervisor-maintained; stale running rows are dead. */
const BEE_FRESH_MS = 15 * 60_000;

/**
 * Coerce a candidate objective string to a non-empty trimmed value, or null.
 * The fallback chain (wip-title → presence intent → null) MUST treat a blank
 * value as "absent": `coord_presence.intent` is a NOT-NULL text column defaulting
 * to '', so an undeclared intent reads back as '' (falsy but not nullish) and a
 * bare `?? null` would render an empty `🔭  · ` segment in every client status line.
 */
export function normalizeObjective(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export default defineTool({
  name: 'coord:glance',
  description:
    "One cheap combined fleet glance: wake mode (default) + staged-wake count, bees in flight (fresh-heartbeat nursery rows), paused governor buckets, recent cross-CLI activity rows, and contextual tips (with ready-to-run slash commands) evaluated for the caller's audience. The statusline/TUI read — one call instead of four.",
  guidance: {
    when: "A status surface (statusline, TUI bar, dashboard widget) needs the fleet's headline state in one round-trip, or you want the current contextual tips for an audience.",
    notWhen:
      'Deep rate-limit telemetry (usage %, $spend) — dev:rate_governor_status. Full presence roster — coord:presence. Reviewing/releasing the staged wakes themselves — coord:wake-queue.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    audience: z
      .enum(GLANCE_AUDIENCES)
      .optional()
      .describe("Who is looking — scopes which tips apply. Default 'user' (a human status surface)."),
    state: z
      .record(z.string(), z.string().max(200))
      .optional()
      .describe('Free-form caller state pairs for tip rules to match on (e.g. view=fleet-tab).'),
    activity_limit: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Recent activity rows to include (default 12; 0 to skip).'),
  }),
  async handler(args, ctx) {
    const audience = args.audience ?? 'user';
    const activityLimit = args.activity_limit ?? DEFAULT_ACTIVITY_LIMIT;
    const { sql } = getOrgPg();

    const [wakeDefault, stagedByOwner, beeRows, activity] = await Promise.all([
      getDefaultWakeMode(),
      countAllPendingWakes(),
      sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM harness_shared.spawned_agents
        WHERE status IN ('running', 'restarting')
          AND heartbeat_at > now() - make_interval(secs => ${BEE_FRESH_MS / 1000})
      `,
      activityLimit > 0
        ? sql<Array<{ owner_id: string; summary: string | null; kind: string; created_at: string }>>`
            SELECT owner_id, summary, kind, created_at
            FROM harness_shared.agent_activity
            -- ::bigint, not the text alias — see activity/recent.ts (lexicographic
            -- ordering froze that read at id 999 once).
            ORDER BY id::bigint DESC
            LIMIT ${activityLimit}
          `
        : Promise.resolve([]),
    ]);

    const stagedTotal = [...stagedByOwner.values()].reduce((a, b) => a + b, 0);
    const beesRunning = beeRows[0]?.n ?? 0;
    const now = Date.now();
    const governorPaused = snapshotGovernors()
      .filter((b) => b.state.pausedUntil > now)
      .map((b) => ({ key: b.key, pausedUntil: new Date(b.state.pausedUntil).toISOString() }));

    const tips = evaluateTips({
      audience,
      wakeDefault,
      stagedTotal,
      beesRunning,
      governorPausedKeys: governorPaused.map((g) => g.key),
      state: args.state ?? {},
    });

    // self.objective — the caller's CURRENT objective, for client status displays
    // (session-objective-display-2026-06-22): their in-execution work-item title ??
    // their declared coord intent. The single client-agnostic source the CC/Codex/OMP
    // renders read, so the display tracks coordination state with no LLM file-writing.
    // FAIL-OPEN: glance renders on every statusline tick, so any trouble → null and the
    // existing render is unaffected.
    let selfObjective: string | null = null;
    // self.loop — is THIS session on an engine loop (loop:arm)? Surfaced here (the one
    // client-agnostic glance read the statusline already makes every tick) so the CC/Codex/OMP
    // bottom display + terminal title can show "⟳ <interval>" with NO extra call
    // (loop-status-display-2026-06-23). Only an ACTIVE loop is reported; null otherwise.
    // `reachable` (WI-655): a CHEAP statusline signal derived from the loop row already
    // read — a loop that last fired but reached nobody (`no-session-now`) or whose wake
    // turn died (`stalled`) is the black-hole this surfaces, so the bottom display can
    // render "⟳ <interval> (unreachable!)" with NO extra probe.
    let selfLoop: { active: true; intervalSec: number; parked: boolean; reachable: boolean } | null = null;
    try {
      const { ownerId } = resolveAgentIdentity(ctx);
      if (ownerId) {
        const wipRows = await sql<Array<{ title: string }>>`
          SELECT title FROM harness_shared.work_items
          WHERE taken_by = ${ownerId} AND status IN ('wip', 'building', 'failing')
          ORDER BY taken_at DESC NULLS LAST LIMIT 1`;
        // intent is a NOT-NULL text column defaulting to '' (coord_presence) — an
        // undeclared intent reads back as '' (falsy, not nullish), so a bare `?? null`
        // would leak '' through and render an empty `🔭  · ` segment. Normalize blank
        // titles/intents to null so the fallback chain is honestly wip → intent → null.
        const title = normalizeObjective(wipRows[0]?.title);
        selfObjective = title ?? normalizeObjective((await getPresence(ownerId))?.intent);
        try {
          const ls = await getLoopStatus(ownerId);
          if (ls?.active) {
            const unreachable = ls.lastDeliveryOutcome === 'no-session-now' || ls.stalled === true;
            selfLoop = {
              active: true,
              intervalSec: ls.intervalSec ?? 0,
              parked: !!ls.parked,
              reachable: !unreachable,
            };
          }
        } catch {
          selfLoop = null; // fail-open: loop read never breaks the glance render
        }
      }
    } catch {
      selfObjective = null;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            now: new Date(now).toISOString(),
            wake: {
              default: wakeDefault,
              stagedTotal,
              stagedOwners: stagedByOwner.size,
            },
            bees: { running: beesRunning },
            governor: { anyPaused: governorPaused.length > 0, paused: governorPaused },
            activity,
            tips,
            self: { objective: selfObjective, loop: selfLoop },
          }),
        },
      ],
    };
  },
});
