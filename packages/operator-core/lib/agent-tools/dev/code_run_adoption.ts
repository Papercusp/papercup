/**
 * dev:code_run_adoption — the code:run ADOPTION metric as a first-class read
 * (code-run-adoption directive 2026-06-29).
 *
 * Of the spawns that COULD have batched — a same-tool burst or a fan-out, classified by the
 * SAME thresholds as the live inline nudge (so metric and nudge can never disagree) — how many
 * actually folded the flow into one code:run / recipes:run? Returns the per-(role, day) rollup,
 * a fleet-wide figure, and the graded `tool-utilization` rating (the hive-coordination-health
 * criterion). This is the number the inline batch-nudge + recipes-at-orient are meant to MOVE;
 * exposing it as one call lets the Overwatch grade tool-utilization from data rather than vibes,
 * and makes any A/B of the nudges (flip a CODE_RUN_*_NUDGE flag, compare) measurable. Read-only.
 *
 * The canonical SQL (CODE_RUN_ADOPTION_SQL) is also runnable directly via dev:pg_query; this tool
 * wraps it + the grader so callers get a ready answer in one round-trip (itself the lesson).
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { readCodeRunAdoption, rollupAdoption, gradeToolUtilization, type RunQuery } from '../../code-run-adoption';

export default defineTool({
  name: 'dev:code_run_adoption',
  profile: 'engineer',
  description:
    'code:run adoption: of spawns that COULD batch (same-tool burst / fan-out), how many folded the ' +
    'flow into one code:run — per role/day, a fleet rollup, and the graded tool-utilization rating. Last N days.',
  capability: 'intel:read',
  guidance: {
    when:
      'Grading hive-coordination-health tool-utilization, or checking whether the code:run nudges / ' +
      'recipes-at-orient are moving adoption. Returns the fleet rate + a ready rating + the per-role/day breakdown.',
    notWhen:
      'Raw per-tool call counts (dev:telemetry); which tools co-occur in a spawn (dev:tool_cooccurrence).',
    seeAlso: [
      'dev:telemetry (raw per-tool call counts)',
      'dev:tool_cooccurrence (which tools co-occur in a spawn)',
    ],
  },
  requirePrincipal: false,
  // ALL roles — a read-only metric the whole fleet (esp. the Overwatch grading tool-utilization) can pull.
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    sinceDays: z.number().int().positive().max(90).optional().describe('Window in days (default 7).'),
  }),
  async handler(args) {
    const sinceDays = args.sinceDays ?? 7;
    const { sql } = getOrgPg();
    const runQuery: RunQuery = async <T = unknown>(query: string, params: unknown[]) =>
      (await sql.unsafe(query, params as never)) as unknown as T[];
    const byRoleDay = await readCodeRunAdoption(runQuery, { sinceDays });
    const fleet = rollupAdoption(byRoleDay);
    const grade = gradeToolUtilization(fleet);
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, sinceDays, fleet, grade, byRoleDay }) },
      ],
    };
  },
});
