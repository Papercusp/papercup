/**
 * dev:pg_query — run a READ-ONLY SQL query against the operator Postgres.
 *
 * Plans, work-items, issues, observations, tool_invocations, scorecards,
 * recipes, … are PG-CANONICAL; the `*:list` tools and `docs/plans/*.md` are
 * projections. This is the ESCAPE HATCH for a genuinely one-off analytic read —
 * NOT the default way to read canonical state
 * (claimable-read-tool-and-sql-encapsulation-audit-2026-07-21 P-004): a hot read
 * with a stable shape belongs behind a tool that wraps the SQL so it cannot
 * drift (work_items:claimable, plans:list's filters + groupBy, …). Read-only
 * enforced (write attempts are rejected by the transaction), statement_timeout +
 * row cap.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  pgReadQuery,
  extractPgErrorInfo,
  buildClaimabilityAdvisory,
  buildSilentNullPathAdvisory,
  buildTenantScopeAdvisory,
  buildDerivedColumnRedirect,
  describeReferencedTableColumns,
  describeRelation,
  listRelations,
  PG_READ_QUERY_DEFAULT_MAX_ROWS,
  PG_READ_QUERY_HARD_MAX_ROWS,
} from '../../pg-read-query';

/** A successful JSON payload in the MCP content shape. */
function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/** An error payload in the MCP content shape. */
function jsonError(reason: string, message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, reason }) }],
  };
}

export default defineTool({
  name: 'dev:pg_query',
  profile: 'engineer',
  description:
    'Run a read-only SELECT / WITH…SELECT against the operator Postgres (canonical store behind plans, work-items, issues, tool_invocations, scorecards, recipes, …), or pass `describe` to inspect a relation\'s columns/indexes/constraints (psql `\\d` equivalent). Read-only enforced; 5s statement_timeout; rows capped. bigint/int8 columns (e.g. queryid) come back as exact-precision STRINGS, never a rounded number.',
  capability: 'intel:read',
  guidance: {
    when:
      "A genuinely ad-hoc / analytic read of PG-canonical state — a one-off group-by/join/slice you won't run again. NOT the default way to read canonical state: most hot reads already have a stable-shape tool (work_items:claimable, work_items:list, plans:list/plans:items, search:*, gitnexus:query). Reach here only when no tool covers the shape.",
    notWhen:
      'A read a documented tool above already covers (hand-written claimability/plan queries are the classic footgun, and a predicate missing workspace_id/harness_slug can match another tenant), or to CHANGE state — writes are rejected here.',
    chaining:
      'Check a table\'s shape first with `describe: "schema.table"` (or a glob) instead of `psql -c "\\d …"`. ' +
      'Alias duplicate output columns (the row cap wraps the query in a subquery). Pass `maxRows` to widen the cap; if `truncated`, tighten WHERE/LIMIT instead of raising it blindly.',
    seeAlso: [
      'work_items:claimable (what issue-family work is claimable RIGHT NOW — the SSOT claim floors as a tool; a raw status=open query is not claimability)',
      'plans:list (plan directory, recency filters, and groupBy/aggregateOnly counts — instead of hand-written SQL over harness_plans)',
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
      .optional()
      .describe('A single read-only SELECT or WITH…SELECT statement. No `;`-separated statements.'),
    describe: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Instead of running SQL, describe a relation: columns, indexes and constraints — the psql `\\d schema.table` equivalent. Accepts a bare table name, or a `*`/glob pattern to LIST matching relations.',
      ),
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
  async handler(args, ctx) {
    // `describe` is the `\d` path (P-011): a psql CLIENT meta-command has no
    // SQL form, so it cannot ride through pgReadQuery's statement path at all.
    if (args.describe) {
      if (args.sql) {
        return jsonError('conflicting_args', 'Pass either `sql` or `describe`, not both.');
      }
      try {
        // A glob (or bare `*`) means "list what matches" rather than "describe one".
        if (/[*?]/.test(args.describe)) {
          const relations = await listRelations(args.describe);
          return jsonResult({ pattern: args.describe, relationCount: relations.length, relations });
        }
        const description = await describeRelation(args.describe);
        if (!description) {
          const near = await listRelations(`*${args.describe.replace(/^.*\./, '')}*`, { limit: 10 }).catch(() => []);
          return jsonError(
            'relation_not_found',
            `No relation matching "${args.describe}".` + (near.length ? ` Did you mean: ${near.map((r) => r.relation).join(', ')}?` : ''),
          );
        }
        return jsonResult(description);
      } catch (err) {
        return jsonError('describe_failed', extractPgErrorInfo(err).message ?? String(err));
      }
    }

    if (!args.sql) {
      return jsonError('missing_args', 'Pass `sql` (a read-only SELECT) or `describe` (a relation to inspect).');
    }
    const sql = args.sql;

    try {
      const result = await pgReadQuery(sql, { maxRows: args.maxRows, timeoutMs: args.timeoutMs });
      // P-005(b): tenant-scope advisory on a filtered read of a multi-tenant
      // table with no workspace_id/harness_slug predicate — the silent
      // wrong-tenant match footgun. Advisory only; never blocks the result.
      const tenantAdvisory = await buildTenantScopeAdvisory(sql, {
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.harnessSlug,
      }).catch(() => null);
      // WI-6674: an accessor that is always-NULL on the relation queried. Not
      // folded into the tenant advisory because it is a different failure —
      // that one warns the answer may be from the wrong TENANT, this one warns
      // the answer is wrong for EVERY row and looks like a clean "none".
      let nullPathAdvisory: string | null = null;
      try {
        nullPathAdvisory = buildSilentNullPathAdvisory(sql);
      } catch {
        nullPathAdvisory = null;
      }
      // A read that answers the WRONG QUESTION correctly: status='open' (or the
      // candidate view) treated as "what can be claimed". Distinct again from
      // both above — the row set is right for the question asked, and wrong for
      // the question meant, so nothing about the result looks suspicious.
      let claimabilityAdvisory: string | null = null;
      try {
        claimabilityAdvisory = buildClaimabilityAdvisory(sql);
      } catch {
        claimabilityAdvisory = null;
      }
      const advisory =
        [claimabilityAdvisory, nullPathAdvisory, tenantAdvisory].filter(Boolean).join(' ') || null;
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
        const described = await describeReferencedTableColumns(sql).catch(() => []);
        if (described.length) {
          payload.knownColumns = Object.fromEntries(described.map((d) => [d.table, d.columns]));
        }
        // EI-18801042715296007: when the missing column is DERIVED (sessionState
        // and the rest of the liveness family), `knownColumns` alone is actively
        // harmful — the columns that exist on coord_presence are the raw
        // keepalive signals the docs warn against, so the most helpful-looking
        // part of this error steers the retry onto a documented-wrong signal.
        // The redirect names the real surface AND the fallback to avoid.
        const redirect = buildDerivedColumnRedirect(sql, info.message);
        if (redirect) payload.derivedColumn = redirect;
      }
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    }
  },
});
