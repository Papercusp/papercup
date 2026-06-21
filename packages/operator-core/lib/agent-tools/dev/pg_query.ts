/**
 * dev:pg_query — run a READ-ONLY SQL query against the operator Postgres.
 *
 * Plans, work-items, issues, observations, tool_invocations, scorecards,
 * recipes, … are PG-CANONICAL; the `*:list` tools and `docs/plans/*.md` are
 * projections. Use this for any filtered / aggregate / recency read instead of
 * fetching a full `*:list` and post-filtering. Read-only enforced (write
 * attempts are rejected by the transaction), statement_timeout + row cap.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  pgReadQuery,
  PgReadQueryError,
  PG_READ_QUERY_DEFAULT_MAX_ROWS,
  PG_READ_QUERY_HARD_MAX_ROWS,
} from '../../pg-read-query';

export default defineTool({
  name: 'dev:pg_query',
  profile: 'engineer',
  description:
    'Run a read-only SELECT / WITH…SELECT against the operator Postgres (the canonical store behind plans, work-items, issues, observations, tool_invocations, scorecards, recipes, …). Read-only enforced; statement_timeout 5s; rows capped.',
  capability: 'intel:read',
  guidance: {
    when:
      "A filtered / aggregate / recency read of PG-CANONICAL state. Plans, work-items, issues, observations (engineer_issues), tool_invocations, scorecards are PG tables — the `*:list` tools and `docs/plans/*.md` files are PROJECTIONS. Query PG directly instead of fetching a whole `*:list` and post-filtering (which returns a huge result that spills to a file → don't then jq the projection). Example — recent plans this workspace: `SELECT plan_slug,status,created FROM harness_shared.harness_plans WHERE created >= '2026-06-17' AND workspace_id = '<ws>' ORDER BY created DESC LIMIT 50`. Aggregates (counts/group-by) are first-class here and awkward to jq.",
    notWhen:
      'To CHANGE state — use the documented write verbs (plans:*, work_items:*, issues:* — they emit audit + sync invalidation). Writes are rejected here anyway (read-only transaction). For code-graph queries use `gitnexus:query`; for prose full-text use `search:fulltext` / `search:semantic`.',
    chaining:
      'Alias any duplicate output column names (the result is wrapped in a subquery for the row cap, and PG rejects duplicate subquery columns). Pass `maxRows` to widen the cap up to ' +
      String(PG_READ_QUERY_HARD_MAX_ROWS) +
      '; if `truncated` is true, add a tighter WHERE / LIMIT rather than raising the cap blindly.',
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'bee', 'queen', 'scoper', 'reviewer', 'validator', 'worker'],
  args: z.object({
    sql: z
      .string()
      .min(1)
      .describe('A single read-only SELECT or WITH…SELECT statement. No `;`-separated statements.'),
    maxRows: z
      .number()
      .int()
      .positive()
      .max(PG_READ_QUERY_HARD_MAX_ROWS)
      .optional()
      .describe(`Max rows returned (default ${PG_READ_QUERY_DEFAULT_MAX_ROWS}).`),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(30000)
      .optional()
      .describe('statement_timeout in ms (default 5000, max 30000).'),
  }),
  async handler(args) {
    try {
      const result = await pgReadQuery(args.sql, { maxRows: args.maxRows, timeoutMs: args.timeoutMs });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rowCount: result.rowCount,
              truncated: result.truncated,
              fields: result.fields,
              elapsedMs: result.elapsedMs,
              rows: result.rows,
            }),
          },
        ],
      };
    } catch (err) {
      const message =
        err instanceof PgReadQueryError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      };
    }
  },
});
