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

const DEFAULT_ACTIVITY_LIMIT = 12;

/** Nursery heartbeats are supervisor-maintained; stale running rows are dead. */
const BEE_FRESH_MS = 15 * 60_000;

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
  async handler(args) {
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
          }),
        },
      ],
    };
  },
});
