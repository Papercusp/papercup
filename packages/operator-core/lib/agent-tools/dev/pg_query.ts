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
  extractPgErrorInfo,
  buildTenantScopeAdvisory,
  describeReferencedTableColumns,
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
    seeAlso: [
      'dev:pg_active_queries (live / long-running queries)',
      'dev:pg_table_sizes (table + index sizes)',
      'dev:pg_health (connection + pool health)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup', 'mug', 'scoper', 'reviewer', 'validator', 'worker'],
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
      // P-005(b): tenant-scope advisory on a filtered read of a multi-tenant
      // table with no workspace_id/harness_slug predicate — the silent
      // wrong-tenant match footgun. Advisory only; never blocks the result.
      const advisory = await buildTenantScopeAdvisory(args.sql).catch(() => null);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...(advisory ? { advisory } : {}),
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
      // Surface Postgres' own HINT/DETAIL/code/position (dropped if we only
      // pass err.message) — PG emits e.g. `HINT: Perhaps you meant to reference
      // the column "w.feature_id"` on a column error, which saves agents from
      // guessing non-obvious column names (EI-8301).
      const info = extractPgErrorInfo(err);
      const payload: Record<string, unknown> = { error: info.message };
      if (info.hint) payload.hint = info.hint;
      if (info.detail) payload.detail = info.detail;
      if (info.code) payload.code = info.code;
      if (info.position) payload.position = info.position;
      // P-005(a): a 42703 (undefined_column) carries the referenced tables'
      // CANONICAL column lists so the retry takes one round trip, not a
      // guessing loop (a fresh post-compaction context has no query memory).
      if (info.code === '42703') {
        const described = await describeReferencedTableColumns(args.sql).catch(() => []);
        if (described.length) {
          payload.knownColumns = Object.fromEntries(described.map((d) => [d.table, d.columns]));
        }
      }
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    }
  },
});
