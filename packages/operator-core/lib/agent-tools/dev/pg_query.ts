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
  buildCorpusNamespaceAdvisory,
  buildNativeToolAttributionAdvisory,
  buildSplitCompletionEvidenceAdvisory,
  buildSilentNullPathAdvisory,
  buildSchemaColumnRedirect,
  buildTenantScopeAdvisory,
  buildDerivedColumnRedirect,
  buildJsonbPathRedirect,
  describeReferencedTableColumns,
  describeRelation,
  listRelations,
  PG_READ_QUERY_DEFAULT_MAX_ROWS,
  PG_READ_QUERY_HARD_MAX_ROWS,
  PgReadQueryTimeoutError,
} from '../../pg-read-query';

/** A successful JSON payload in the MCP content shape. */
function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/**
 * Return structured data so the tool framework can apply its transport-safe
 * payload shaping before serialising the response. The `describe` path can
 * contain many column comments, index definitions and constraints; returning
 * a hand-serialised content block there lets an oversized relation description
 * reach the result door as invalid, truncated JSON.
 */
function dataResult<T>(data: T) {
  return { data };
}

/** An error payload in the MCP content shape. */
function jsonError(reason: string, message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, reason }) }],
  };
}

/**
 * EI-20218730860484837: PostgreSQL's `regprocedure` input syntax requires a
 * function signature, even for a zero-argument function. The raw 22P02 error
 * says only "expected a left parenthesis", which sends a caller back to SQL
 * trial-and-error. Add a hint only for that exact error shape and query cast;
 * never rewrite the caller's SQL or broaden unrelated parse errors.
 */
function regprocedureSignatureHint(
  sql: string,
  info: { code?: string; message: string; detail?: string },
): string | undefined {
  if (info.code !== '22P02' || !/::\s*regprocedure\b/i.test(sql)) return undefined;
  const errorText = `${info.message} ${info.detail ?? ''}`;
  if (!/expected\s+a\s+left\s+parenthesis/i.test(errorText)) return undefined;
  return (
    'PostgreSQL regprocedure casts require a function signature. For a zero-argument function, use ' +
    "'schema.function()'::regprocedure (for example 'harness_shared.engineer_issues_view_dml()'::regprocedure)."
  );
}

export default defineTool({
  name: 'dev:pg_query',
  profile: 'engineer',
  description:
    'Run a read-only SELECT / WITH…SELECT against operator Postgres, or pass `describe` to inspect a relation. Tenant-scoped reads require a workspace_id/harness_slug predicate unless `allowUnscoped: true`. Read-only enforced; rows capped. `timeoutMs` bounds connect, acquire, and execution; bigint/int8 values return as exact strings.',
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
  // EI-20234305706295524: pgReadQuery uses its own admin-pool transaction and
  // does not read ctx.tx. Retaining the ambient workspace transaction here
  // consumes an app-pool slot while the independent read waits on the pool,
  // so concurrent dev:pg_query calls can deadlock behind withWorkspace.
  skipWorkspaceTx: true,
  // EI-20244135937023756: ptool consumes this response as JSON. The generic
  // result door appends a truncation footer to oversized relation descriptions,
  // which makes the machine-readable JSON invalid instead of returning a
  // parseable result that the caller can inspect or project.
  skipResultDoor: 'programmatic-caller',
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
      .describe(
        'Bounds the WHOLE call — connect/acquire + statement_timeout + execute (default 5000, max 30000). A hung connection acquire (e.g. the operator restarting mid-call) now fails fast around this bound instead of hanging past it.',
      ),
    allowUnscoped: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Explicitly allow a filtered read of a tenant-scoped table without a workspace_id/harness_slug predicate. Use only for deliberate cross-tenant analysis; the response retains the tenant-scope advisory.',
      ),
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
          return dataResult({ pattern: args.describe, relationCount: relations.length, relations });
        }
        const description = await describeRelation(args.describe);
        if (!description) {
          const near = await listRelations(`*${args.describe.replace(/^.*\./, '')}*`, { limit: 10 }).catch(() => []);
          return jsonError(
            'relation_not_found',
            `No relation matching "${args.describe}".` + (near.length ? ` Did you mean: ${near.map((r) => r.relation).join(', ')}?` : ''),
          );
        }
        return dataResult(description);
      } catch (err) {
        return jsonError('describe_failed', extractPgErrorInfo(err).message ?? String(err));
      }
    }

    if (!args.sql) {
      return jsonError('missing_args', 'Pass `sql` (a read-only SELECT) or `describe` (a relation to inspect).');
    }
    const sql = args.sql;

    try {
      // EI-20200627264509977: scope-check BEFORE executing. The old advisory was
      // attached after pgReadQuery had already returned the potentially
      // cross-tenant rows, so it diagnosed the unsafe read without preventing
      // it. Deliberate fleet-wide analysis remains possible, but only through
      // an explicit call-site opt-in that is visible in tool telemetry.
      const tenantAdvisory = await buildTenantScopeAdvisory(sql, {
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.harnessSlug,
      }).catch(() => null);
      if (tenantAdvisory && !args.allowUnscoped) {
        return jsonError(
          'tenant_scope_required',
          `${tenantAdvisory} Add the tenant predicate(s), or pass allowUnscoped: true for a deliberate cross-tenant read.`,
        );
      }
      const result = await pgReadQuery(sql, { maxRows: args.maxRows, timeoutMs: args.timeoutMs });
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
      // EI-20103748074297088 — two more ways a read returns a well-formed ZERO that reads as a
      // real answer. Kept as their own builders, like the three above, because each is a
      // DIFFERENT failure: the tenant advisory warns the rows may be from the wrong tenant;
      // these warn there will be no rows AT ALL, from a query that looks perfectly scoped.
      // They also compose — the tool_invocations zero sends you to the transcript store, where
      // the tenant-predicate habit produces a second zero that looks like corroboration — so
      // both can legitimately fire for one investigation.
      let corpusNamespaceAdvisory: string | null = null;
      try {
        corpusNamespaceAdvisory = buildCorpusNamespaceAdvisory(sql);
      } catch {
        corpusNamespaceAdvisory = null;
      }
      let nativeToolAdvisory: string | null = null;
      try {
        nativeToolAdvisory = buildNativeToolAttributionAdvisory(sql);
      } catch {
        nativeToolAdvisory = null;
      }
      // WI-38056: reading ONE of the two completion-evidence surfaces. Its own
      // builder for the usual reason — this one does not warn about the wrong
      // tenant or an empty table, but about a POPULATED table answering
      // "no evidence" for every row closed through the other route.
      let splitEvidenceAdvisory: string | null = null;
      try {
        splitEvidenceAdvisory = buildSplitCompletionEvidenceAdvisory(sql);
      } catch {
        splitEvidenceAdvisory = null;
      }
      const advisory =
        [
          claimabilityAdvisory,
          nullPathAdvisory,
          splitEvidenceAdvisory,
          nativeToolAdvisory,
          corpusNamespaceAdvisory,
          tenantAdvisory,
        ]
          .filter(Boolean)
          .join(' ') || null;
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
      // EI-19415142351884573: a whole-call timeout (connect/acquire, or PG
      // itself never finishing) is a DIFFERENT failure from a real PG error —
      // "we asked and got told no" vs "we never found out". Naming it fixes
      // the misdiagnosis this bug reported: three consecutive hangs (one with
      // an explicit 25s timeoutMs) were each silently absorbed by the
      // client's 300s idle-abort, with Postgres itself completely idle the
      // whole time, because the operator was restarting mid-call and
      // acquiring a connection never returned. `timeoutMs` now bounds THIS —
      // the whole call, not just server-side execution — so this branch is
      // reachable at a caller-chosen deadline instead of only at 300s.
      if (err instanceof PgReadQueryTimeoutError) {
        return jsonError('call_timeout', err.message);
      }
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
      const regprocedureHint = regprocedureSignatureHint(sql, info);
      if (regprocedureHint && !payload.hint) payload.hint = regprocedureHint;
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
        const schemaColumn = buildSchemaColumnRedirect(sql, info.message);
        if (schemaColumn) payload.schemaColumn = schemaColumn;
        // P-015: the same failure one level down. `knownColumns` answers "what
        // columns exist", which is the wrong answer when the name the caller
        // guessed is a KEY inside a jsonb column rather than a column — the
        // `work_items.payload._ei.severity` shape. Only probed when no derived
        // redirect already claimed the name, so the two advisories never argue
        // about the same column in one payload.
        if (!redirect) {
          const nested = await buildJsonbPathRedirect(sql, info.message).catch(() => null);
          if (nested) payload.jsonbPath = nested;
        }
      }
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    }
  },
});
