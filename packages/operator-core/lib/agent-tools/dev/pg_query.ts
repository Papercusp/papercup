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
 * enforced (write attempts are rejected by validation and the transaction),
 * statement_timeout + row cap. EXPLAIN is allowed only when its explained
 * statement is SELECT/WITH…SELECT, so planner diagnostics remain read-only.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  pgReadQuery,
  extractPgErrorInfo,
  buildBacklogFlowAdvisory,
  buildClaimabilityAdvisory,
  buildEpochUnitAdvisory,
  buildCorpusNamespaceAdvisory,
  buildSessionTurnPartsJsonAdvisory,
  buildNativeToolAttributionAdvisory,
  buildAgentActivityLedgerAdvisory,
  buildAdvSessionsLivenessAdvisory,
  buildAgentFactsSupersessionAdvisory,
  buildEventFireWindowAdvisory,
  buildSplitCompletionEvidenceAdvisory,
  buildJsonTextSearchAdvisory,
  buildSilentNullPathAdvisory,
  buildJsonbTypeofNegationAdvisory,
  buildUnusedCteAdvisory,
  buildPopulationNarrowingAdvisory,
  buildSchemaColumnRedirect,
  buildTenantScopeAdvisory,
  buildDerivedColumnRedirect,
  buildToolRoutingAdvisory,
  buildJsonbPathRedirect,
  describeReferencedTableColumns,
  describeRelation,
  listRelations,
  PG_READ_QUERY_DEFAULT_MAX_ROWS,
  PG_READ_QUERY_HARD_MAX_ROWS,
  PgReadQueryTimeoutError,
} from '../../pg-read-query';

/**
 * The ENVELOPE DISCRIMINATOR (P-011, fleet-friction-remediation-2026-08-21).
 *
 * `dev:pg_query` returns three structurally disjoint payloads — a SQL result, a
 * single-relation description, and a glob relation LIST — and until this existed
 * they shared no common field. A caller could only tell them apart by probing for
 * the presence of `rows` vs `columns` vs `relations`, which is exactly the
 * "schema-guessing loop" the describe path was added to end. Worse, the two
 * describe shapes reach the transport through `dataResult` while the SQL shape is
 * hand-serialised, so they are not even siblings structurally.
 *
 * Every payload now carries `mode`, so callers SWITCH instead of probing. Exported
 * because the published `returns` contract and its recurrence test both read these
 * literals from here: one source, so the documented union cannot drift from the
 * emitted one (CLAUDE.md, derived-truth ladder — DERIVE, not hand-maintained prose).
 */
export const PG_QUERY_MODE = {
  query: 'query',
  describe: 'describe',
  describeList: 'describe-list',
} as const;

export type PgQueryMode = (typeof PG_QUERY_MODE)[keyof typeof PG_QUERY_MODE];

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
 * Rubrics are plan-backed after migration 338/353; keep the removed v1 relation
 * from sending callers into a schema-guessing loop when they use describe.
 */
function canonicalRelationRedirect(ref: string): string | null {
  const normalized = ref.trim().toLowerCase();
  if (normalized !== 'harness_shared.rubrics' && normalized !== 'rubrics') return null;
  return (
    ' Rubrics are plan-backed: the standalone `harness_shared.rubrics` relation was removed. ' +
    "Use `harness_shared.harness_plans` with `template = 'rubric'` for raw schema reads, or " +
    'use `rubrics:list`, `rubrics:get`, and `rubrics:search` for canonical rubric reads.'
  );
}

/**
 * EI-21596258009994255: `describe` is DECLARED, so a caller who sends it with the
 * wrong VALUE gets none of the `argRedirects` machinery — `invalidInputCorrections`
 * returns early unless a key was unrecognized. The measured refusal was the bare Zod
 * line "describe: Invalid input: expected string, received object", which names the
 * type and not the string to send; the reporting caller had passed
 * `describe: { schema, table }`, the natural shape when a relation is thought of as
 * two parts. Nothing on the surface showed the qualified form, because the arg's own
 * text mentioned `schema.table` only inside a reference to the psql meta-command and
 * then offered "a bare table name" as the accepted form.
 *
 * A Zod-level `error` is the right seam: it replaces the leaf message `formatIssues`
 * already renders (verified against the live renderer, which resolves an
 * `invalid_union` down to the closest branch's own sub-issues), so it reaches the
 * caller at the moment of refusal without a new mechanism. It is NOT part of the
 * published JSON Schema, so it costs zero prompt weight — dev:pg_query has 46 chars
 * of headroom against the 1500 budget, so a `description`/`chaining` sentence was not
 * available to carry this.
 *
 * Deliberately NOT widened to accept the object: the string form also carries the
 * glob (`harness_shared.*` LISTS relations), which an object cannot express, so
 * accepting `{ schema, table }` would add a second, strictly weaker encoding of one
 * intent rather than removing the misread.
 */
const DESCRIBE_VALUE_SHAPE =
  'describe takes the relation as a dotted STRING — describe: "harness_shared.work_items" ' +
  '(a bare table name also resolves), or a glob — describe: "harness_shared.*" — to LIST ' +
  'matching relations. It is not an object: { schema, table } is refused; join the two ' +
  'with a dot instead.';

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

/**
 * EI-21579265584174407: PostgreSQL's ARE engine rejects a large bounded
 * repetition such as `.{0,1800}` (its repetition bounds are capped at 255).
 * This is a caller-written SQL error, so return a targeted correction instead
 * of sending the next context into a retry loop with the same PCRE-shaped
 * extraction query. Only attach it when both the server error and the query
 * prove this exact failure; unrelated regex errors should retain their native
 * diagnostics.
 */
function postgresRegexRepetitionHint(
  sql: string,
  info: { code?: string; message: string; detail?: string },
): string | undefined {
  if (info.code !== '2201B') return undefined;
  const errorText = `${info.message} ${info.detail ?? ''}`;
  if (!/invalid\s+repetition\s+count/i.test(errorText)) return undefined;

  const oversized = [...sql.matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*\}/g)].find(([, lower, upper]) => {
    return Number(lower) > 255 || Number(upper) > 255;
  });
  if (!oversized) return undefined;

  const [, lower, upper] = oversized;
  return (
    `PostgreSQL regular-expression repetition bounds are limited to 255; ` +
    `the query contains {${lower},${upper}}. For a larger excerpt, use ` +
    '`left(text_expression, n)` or `substring(text_expression from start for n)`; ' +
    'use `.{m,n}` only when both bounds are at most 255.'
  );
}

/**
 * EI-22394295144242470: PostgreSQL's 42601 diagnostic for a UNION arity
 * mismatch names the structural failure but not the correction. This is a
 * caller-written query error, so point directly at the SELECT-list contract
 * instead of sending the caller through another trial-and-error query.
 */
function unionColumnCountHint(
  sql: string,
  info: { code?: string; message: string; detail?: string },
): string | undefined {
  if (info.code !== '42601' || !/\bunion\b/i.test(sql)) return undefined;
  const errorText = `${info.message} ${info.detail ?? ''}`;
  if (!/each\s+union\s+query\s+must\s+have\s+the\s+same\s+number\s+of\s+columns/i.test(errorText)) {
    return undefined;
  }
  return (
    'PostgreSQL UNION branches must project the same number of columns. Count every expression in ' +
    'each SELECT list (including `NULL` placeholders and function expressions), then add or remove ' +
    'the extra expression—or add a matching placeholder—so every branch has the same arity; keep ' +
    'corresponding positions type-compatible.'
  );
}

export default defineTool({
  name: 'dev:pg_query',
  profile: 'engineer',
  description:
    "Run a bounded read-only SQL query, EXPLAIN a read, or describe a relation in operator Postgres. Tenant reads require scope unless `allowUnscoped`. Pass `positiveControlSql` when zero rows will support an absence claim. PostgreSQL regex repetition bounds are limited to 255; use `left()` or `substring()` for larger excerpts. Rubrics are plan-backed in `harness_shared.harness_plans` (`template = 'rubric'`); `harness_shared.rubrics` is retired.",
  capability: 'intel:read',
  guidance: {
    when:
      'A one-off analytic read or planner diagnostic not covered by a stable-shape tool.',
    notWhen:
      'A documented read tool already covers the question, or to change state. Writes and EXPLAIN of writes are rejected.',
    chaining:
      "Use `describe` before guessing schema. For rubric schema, describe `harness_shared.harness_plans`; use `rubrics:list`, `rubrics:get`, or `rubrics:search` for canonical rubric reads. For an absence claim, pass a known-positive SELECT in `positiveControlSql`; do not use `count(*)`, which always returns a row. Alias duplicate columns and tighten the query when `truncated`. Do not search `tool_invocations.args_json::text` or `metadata_json::text` with LIKE/ILIKE without a SQL LIMIT; `maxRows` does not bound the WHERE scan. Prefer indexed scalar predicates or `activity:tool-log`/`dev:telemetry`; pass `allowUnboundedJsonSearch: true` only for deliberate forensic work. PostgreSQL ARE regex repetition bounds are at most 255 (`{m,n}`); use `left(text, n)` or `substring(text from start for n)` for larger excerpts.",
    returns:
      'A DISCRIMINATED UNION on `mode` — switch on it, do not probe for `rows` vs `columns`. ' +
      `\`mode:"${PG_QUERY_MODE.query}"\` (you passed \`sql\`): ` +
      '`{ mode, rowCount, truncated, fields, elapsedMs, rows, advisory?, positiveControl?, absence? }`; ' +
      'zero rows is `absence.status:"unverified"` unless the same-transaction control found a row. ' +
      `\`mode:"${PG_QUERY_MODE.describe}"\` (you passed a relation name): ` +
      '`{ mode, relation, kind, columns[], indexes[], constraints[] }`. ' +
      `\`mode:"${PG_QUERY_MODE.describeList}"\` (you passed a \`*\`/glob): ` +
      '`{ mode, pattern, relationCount, relations[] }` — names only, NOT column metadata. ' +
      'Errors are `{ error, reason }` and carry no `mode`. `code:run` returns this root directly. bigint/int8 stays exact.',
    seeAlso: [
      'work_items:claimable',
      'plans:list',
      'db:migrations',
      'testing:runs',
      'issues:list / work_items:get',
      'dev:pg_active_queries',
      'dev:pg_table_sizes',
      'dev:pg_health',
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
  // Acceptance judges need the rubric method's ad-hoc, read-only evidence
  // query surface; this does not widen any write-capable role set.
  agentRoles: ['operator', 'architect', 'debugger', 'cup', 'mug', 'scoper', 'reviewer', 'validator', 'worker', 'judge'],
  // Keep the SQL and relation-description intents representable in the published
  // JSON Schema. A refinement would enforce the rule at runtime while still
  // advertising both fields as optional, which is exactly how callers ended up
  // sending both and only learning about the conflict after dispatch.
  args: z.union([
    z.object({
      sql: z
        .string()
        .min(1)
        .describe('A single read-only SELECT, WITH…SELECT, or EXPLAIN whose explained statement is SELECT/WITH…SELECT. No `;`-separated statements.'),
      describe: z.never().optional().describe('Only valid for relation-description calls; omit it when passing `sql`.'),
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
          'Bounds the WHOLE call — connect/acquire + statement_timeout + execute (default 5000, max 30000). A hung connection acquire (e.g. the operator restarting mid-call) fails fast rather than hanging past it. ⚠ This is the SQL budget, not the wall-clock ceiling: the call deadline is timeoutMs PLUS a fixed ~3s overhead allowance (and, on the acquire path, the acquire budget too), so timeoutMs:5000 legitimately surfaces a failure at ~8000ms. Size the value by how long the QUERY may run; do not read a longer elapsed time as the bound being ignored.',
        ),
      positiveControlSql: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Known-positive SELECT/WITH…SELECT expected to return at least one row through the same table/scope/instrument. Runs with the primary query in the same read-only transaction and whole-call deadline. Use when zero rows will support an absence claim; do not use count(*) because it always returns a row.',
        ),
      allowUnscoped: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Explicitly allow a filtered read of a tenant-scoped table without a workspace_id/harness_slug predicate. Use only for deliberate cross-tenant analysis; the response retains the tenant-scope advisory.',
        ),
      allowUnboundedJsonSearch: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Explicitly allow an unbounded LIKE/ILIKE scan over tool_invocations.args_json/metadata_json cast to text. maxRows does not bound the WHERE scan; prefer indexed scalar predicates or activity:tool-log/dev:telemetry.',
        ),
    }),
    z.object({
      sql: z.never().optional().describe('Only valid for SQL calls; omit it when passing `describe`.'),
      // EI-21596258009994255: the `error` carries the VALUE SHAPE to the refusal (see
      // DESCRIBE_VALUE_SHAPE); the `.describe()` states it up front, so a caller reaching
      // for `{ schema, table }` is corrected before the call as well as after it.
      describe: z
        .string({ error: DESCRIBE_VALUE_SHAPE })
        .min(1)
        .describe(
          'Instead of running SQL, describe a relation: columns, indexes and constraints — the psql `\\d` equivalent. A dotted STRING, not an object: `"harness_shared.work_items"` (a bare table name also resolves), or a `*`/glob — `"harness_shared.*"` — to LIST matching relations.',
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
          'Bounds the WHOLE call — connect/acquire + statement_timeout + execute (default 5000, max 30000). A hung connection acquire (e.g. the operator restarting mid-call) fails fast rather than hanging past it. ⚠ This is the SQL budget, not the wall-clock ceiling: the call deadline is timeoutMs PLUS a fixed ~3s overhead allowance (and, on the acquire path, the acquire budget too), so timeoutMs:5000 legitimately surfaces a failure at ~8000ms. Size the value by how long the QUERY may run; do not read a longer elapsed time as the bound being ignored.',
        ),
      positiveControlSql: z
        .never()
        .optional()
        .describe('Only valid for SQL calls; omit it when passing `describe`.'),
      allowUnscoped: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Explicitly allow a filtered read of a tenant-scoped table without a workspace_id/harness_slug predicate. Use only for deliberate cross-tenant analysis; the response retains the tenant-scope advisory.',
        ),
      allowUnboundedJsonSearch: z
        .never()
        .optional()
        .describe('Only valid for SQL calls; omit it when passing `describe`.'),
    }),
  ]),
  /**
   * P-011: the registered shape for ALL THREE envelopes, not just the SQL one.
   * `guidance.returns` may INTERPRET a result, but its structural claims have to
   * be backed here — guidance-output-schema-live-guard enforces exactly that, so
   * the published union is derived from this declaration rather than hand-kept in
   * prose (CLAUDE.md, derived-truth ladder). The describe fields were never
   * declared before, which is why the contract could only describe them as
   * "relation metadata". Fields stay optional because they are per-mode; `mode` is
   * the discriminator that says which set to expect.
   */
  result: z
    .object({
      mode: z.unknown().optional(),
      // mode:"query"
      rowCount: z.unknown().optional(),
      truncated: z.unknown().optional(),
      fields: z.unknown().optional(),
      elapsedMs: z.unknown().optional(),
      rows: z.unknown().optional(),
      advisory: z.unknown().optional(),
      positiveControl: z.unknown().optional(),
      absence: z.unknown().optional(),
      // mode:"describe"
      relation: z.unknown().optional(),
      kind: z.unknown().optional(),
      columns: z.unknown().optional(),
      indexes: z.unknown().optional(),
      constraints: z.unknown().optional(),
      // mode:"describe-list"
      pattern: z.unknown().optional(),
      relationCount: z.unknown().optional(),
      relations: z.unknown().optional(),
      // error envelope (carries no mode)
      error: z.unknown().optional(),
      reason: z.unknown().optional(),
    })
    .passthrough(),
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
          return dataResult({
            mode: PG_QUERY_MODE.describeList,
            pattern: args.describe,
            relationCount: relations.length,
            relations,
          });
        }
        const description = await describeRelation(args.describe);
        if (!description) {
          const near = await listRelations(`*${args.describe.replace(/^.*\./, '')}*`, { limit: 10 }).catch(() => []);
          return jsonError(
            'relation_not_found',
            `No relation matching "${args.describe}".` +
              (near.length ? ` Did you mean: ${near.map((r) => r.relation).join(', ')}?` : '') +
              (canonicalRelationRedirect(args.describe) ?? ''),
          );
        }
        return dataResult({ mode: PG_QUERY_MODE.describe, ...description });
      } catch (err) {
        return jsonError('describe_failed', extractPgErrorInfo(err).message ?? String(err));
      }
    }

    if (!args.sql) {
      return jsonError('missing_args', 'Pass `sql` (a read-only SELECT/WITH or EXPLAIN over SELECT/WITH) or `describe` (a relation to inspect).');
    }
    const sql = args.sql;
    // EI-21163893229122924 hoisted ONE advisory above execution, and gave a
    // reason that was general all along: compute it before the query runs so
    // the same fix is available on both the successful and the failed payload.
    // Every other advisory stayed BELOW pgReadQuery, so a caller whose query
    // THREW reached none of them — and the errored caller is the one who most
    // needs them. EI-21957852799485985 / EI-21957833809596344 are what that
    // cost: two hand-written linked-work-item queries 20s apart from one
    // session, both 42703. `buildToolRoutingAdvisory` fires on exactly that
    // shape ("work_items:list / work_items:get already answer this read"), but
    // only ever reached a caller whose query SUCCEEDED — so the retry after a
    // typo was a second hand-written query instead of a tool call, and the
    // column list the error DID carry made that retry look like the right move.
    // Every builder below is a pure function of the SQL TEXT, so each is just
    // as true of a query that failed to run as of one that ran.
    const advisoryOf = (build: () => string | null): string | null => {
      try {
        return build();
      } catch {
        return null;
      }
    };
    // EI-20261119579595975: an epoch-seconds literal divided by 1000 before
    // to_timestamp() moves an invoked_at cutoff to 1970 and can make
    // historical tool calls look like post-wake evidence.
    const epochUnitAdvisory = advisoryOf(() => buildEpochUnitAdvisory(sql));
    // WI-6674: an accessor that is always-NULL on the relation queried. Not
    // folded into the tenant advisory because it is a different failure —
    // that one warns the answer may be from the wrong TENANT, this one warns
    // the answer is wrong for EVERY row and looks like a clean "none".
    const nullPathAdvisory = advisoryOf(() => buildSilentNullPathAdvisory(sql));
    const jsonbTypeofAdvisory = advisoryOf(() => buildJsonbTypeofNegationAdvisory(sql));
    // EI-20261038811991822: a CTE defined but never joined. The sibling of the
    // advisories above in kind — the query SUCCEEDS and returns well-formed
    // rows from the WRONG population, so nothing in the result distinguishes it
    // from a correctly-scoped answer.
    const unusedCteAdvisory = advisoryOf(() => buildUnusedCteAdvisory(sql));
    // EI-22433765987075358: GROUP BY/HAVING and a caller LIMIT below maxRows
    // narrow the population a zero-row result can speak for. Keep this pure
    // SQL-shape advisory in the shared success/error list so a failed query
    // cannot lose the same absence warning.
    const populationNarrowingAdvisory = advisoryOf(() =>
      buildPopulationNarrowingAdvisory(sql, args.maxRows ?? PG_READ_QUERY_DEFAULT_MAX_ROWS),
    );
    // A read that answers the WRONG QUESTION correctly: status='open' (or the
    // candidate view) treated as "what can be claimed". Distinct again from
    // both above — the row set is right for the question asked, and wrong for
    // the question meant, so nothing about the result looks suspicious.
    const claimabilityAdvisory = advisoryOf(() => buildClaimabilityAdvisory(sql));
    // The FLOW sibling of the claimability advisory above. That one warns a row set is bigger than it
    // looks; this one warns an AGGREGATE is measuring a different population than the reader intends —
    // the observation lane counted as filed work, an evidence-quality column used as a "closed" filter,
    // or a hand-rolled window that work_items:burn_down already computes with the caveats attached.
    // Measured together on 2026-08-17: the three inverted the sign of a backlog trend reported to the owner.
    const backlogFlowAdvisory = advisoryOf(() => buildBacklogFlowAdvisory(sql));
    // EI-19450552881841590 — the agent_facts sibling of the two above, and the
    // reason it is its own builder: those warn about work_items populations,
    // this one about a column whose NAME implies the opposite of its semantics.
    // `superseded_at` is stamped by ordinary re-assertion, so omitting it counts
    // dead versions as live ("the cap stopped enforcing") while trusting it
    // counts corrections as destroyed facts ("an eviction storm"). Both readings
    // are well-formed numbers that survive review, which is why the advisory
    // fires at the moment of the query rather than leaving it to discipline.
    const agentFactsSupersessionAdvisory = advisoryOf(() => buildAgentFactsSupersessionAdvisory(sql));
    // EI-19464809374955438 — the sibling of the advisory above, and its own
    // builder because the FAILURE MODE is different in kind: that one warns a
    // predicate is wrong and names the clause that fixes it; this one warns the
    // question is UNANSWERABLE from the data. event_key_fires is a one-row-per-key
    // latch, so a windowed predicate on its timestamps silently drops every fire
    // but the last and returns a 0 shaped exactly like "no harm occurred". There
    // is deliberately no clearing clause — the honest fix is to downgrade the
    // claim to "unknown", not to rewrite the SQL.
    const eventFireWindowAdvisory = advisoryOf(() => buildEventFireWindowAdvisory(sql));
    // EI-20103748074297088 — two more ways a read returns a well-formed ZERO that reads as a
    // real answer. Kept as their own builders, like the three above, because each is a
    // DIFFERENT failure: the tenant advisory warns the rows may be from the wrong tenant;
    // these warn there will be no rows AT ALL, from a query that looks perfectly scoped.
    // They also compose — the tool_invocations zero sends you to the transcript store, where
    // the tenant-predicate habit produces a second zero that looks like corroboration — so
    // both can legitimately fire for one investigation.
    const corpusNamespaceAdvisory = advisoryOf(() => buildCorpusNamespaceAdvisory(sql));
    const nativeToolAdvisory = advisoryOf(() => buildNativeToolAttributionAdvisory(sql));
    // EI-21847759967934033: the SIBLING of the advisory above, and it exists because that one
    // is silent on the read that actually caused harm. That one fires when the query ASKS FOR a
    // native tool by name; this one fires on the single-agent "is this peer working?" read that
    // never mentions native tools at all, whose truthful MCP-only answer is then read as the
    // agent's whole activity. Both can fire for one investigation and say different things.
    const agentActivityAdvisory = advisoryOf(() => buildAgentActivityLedgerAdvisory(sql));
    // WI-1447231: a THIRD liveness misread, one table over. adv_sessions.ended_at is written
    // only by a session's own cooperative shutdown, so a session an operator SIGKILL cut off
    // mid-turn never writes it — the row reads "running" forever. Its own builder because the
    // wrong reading here is a raw column standing in for the derived sessionState oracle, not a
    // coverage gap (the advisory above) or a misattributed source (the one before it).
    const advSessionsLivenessAdvisory = advisoryOf(() => buildAdvSessionsLivenessAdvisory(sql));
    // WI-38056: reading ONE of the two completion-evidence surfaces. Its own
    // builder for the usual reason — this one does not warn about the wrong
    // tenant or an empty table, but about a POPULATED table answering
    // "no evidence" for every row closed through the other route.
    const splitEvidenceAdvisory = advisoryOf(() => buildSplitCompletionEvidenceAdvisory(sql));
    // EI-21163893229122924: session_turn_parts.text is heterogeneous
    // faithful-render text, so an unguarded JSON cast can fail before a
    // result exists.
    const sessionTurnPartsJsonAdvisory = advisoryOf(() => buildSessionTurnPartsJsonAdvisory(sql));
    // P-001 (sql-escape-tool-routing-2026-08-12): "a tool already answers
    // this read". Distinct from every builder above — those warn the ANSWER
    // may be wrong (wrong tenant, always-NULL path, wrong question, empty by
    // construction); this one fires on a read whose answer is perfectly
    // correct and simply did not need SQL. It is deliberately LAST in every
    // composition: a correctness warning must never be pushed down the line
    // by a routing hint.
    const toolRoutingAdvisory = advisoryOf(() => buildToolRoutingAdvisory(sql));
    // The sql-derived advisories in their established precedence order, shared
    // VERBATIM by the success payload and the error payload so the two can
    // never drift into telling the same caller different things about the same
    // query. The async/result-derived ones (tenant scope, positive control)
    // are not here: they need a round trip or a row count that a failed query
    // never produced.
    const sqlShapeAdvisories: (string | null)[] = [
      advisoryOf(() => buildJsonTextSearchAdvisory(sql)),
      epochUnitAdvisory,
      claimabilityAdvisory,
      backlogFlowAdvisory,
      agentFactsSupersessionAdvisory,
      eventFireWindowAdvisory,
      nullPathAdvisory,
      jsonbTypeofAdvisory,
      unusedCteAdvisory,
      populationNarrowingAdvisory,
      splitEvidenceAdvisory,
      nativeToolAdvisory,
      agentActivityAdvisory,
      advSessionsLivenessAdvisory,
      sessionTurnPartsJsonAdvisory,
      corpusNamespaceAdvisory,
    ];
    const jsonTextSearchAdvisory = sqlShapeAdvisories[0];

    // EI-21663090256112441: maxRows is a result cap, not a WHERE-scan bound.
    // Refuse the known-large JSONB-to-text pattern before tenant probes or
    // pgReadQuery can spend the caller's timeout. The explicit bypass is
    // deliberately named and remains visible in the success/error advisory.
    if (jsonTextSearchAdvisory && !args.allowUnboundedJsonSearch) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `${jsonTextSearchAdvisory} ` +
                'To run this intentionally, pass allowUnboundedJsonSearch: true.',
              reason: 'unbounded_json_search',
              advisory: jsonTextSearchAdvisory,
            }),
          },
        ],
      };
    }

    try {
      // EI-20200627264509977: scope-check BEFORE executing. The old advisory was
      // attached after pgReadQuery had already returned the potentially
      // cross-tenant rows, so it diagnosed the unsafe read without preventing
      // it. Deliberate fleet-wide analysis remains possible, but only through
      // an explicit call-site opt-in that is visible in tool telemetry.
      // ONE scope object for both advisory calls below. Hoisted rather than
      // repeated: a second `harnessSlug: ctx.harnessSlug` literal is a NEW
      // candidate for check-no-raw-harness-sentinel.mjs, whose header states a
      // new candidate is never made green by adding it to BASELINE. Passing the
      // raw sentinel to THIS callee is safe — buildTenantScopeAdvisory
      // normalizes both scope args itself via realScopeValue() — so the fix is
      // to stop duplicating the literal, not to change what is passed.
      const tenantScope = {
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.harnessSlug,
      };
      const tenantAdvisory = await buildTenantScopeAdvisory(sql, tenantScope).catch(() => null);
      if (tenantAdvisory && !args.allowUnscoped) {
        return jsonError(
          'tenant_scope_required',
          `${tenantAdvisory} Add the tenant predicate(s), or pass allowUnscoped: true for a deliberate cross-tenant read.`,
        );
      }
      const positiveControlTenantAdvisory = args.positiveControlSql
        ? await buildTenantScopeAdvisory(args.positiveControlSql, tenantScope).catch(() => null)
        : null;
      if (positiveControlTenantAdvisory && !args.allowUnscoped) {
        return jsonError(
          'positive_control_tenant_scope_required',
          `${positiveControlTenantAdvisory} Add the tenant predicate(s) to positiveControlSql, or pass allowUnscoped: true for a deliberate cross-tenant read.`,
        );
      }
      const result = await pgReadQuery(sql, {
        maxRows: args.maxRows,
        timeoutMs: args.timeoutMs,
        ...(args.positiveControlSql ? { positiveControlSql: args.positiveControlSql } : {}),
      });
      const positiveControl = result.positiveControl
        ? {
            status: result.positiveControl.rowCount > 0 ? ('passed' as const) : ('failed' as const),
            ...result.positiveControl,
          }
        : undefined;
      const absence =
        result.rowCount === 0
          ? positiveControl?.status === 'passed'
            ? { status: 'verified' as const, code: 'positive-control-passed' as const }
            : {
                status: 'unverified' as const,
                code: positiveControl ? ('positive-control-empty' as const) : ('positive-control-not-run' as const),
              }
          : undefined;
      const positiveControlAdvisory =
        result.rowCount === 0 && absence?.status === 'unverified'
          ? positiveControl
            ? '⚠ absence unverified: positiveControlSql also returned 0 rows, so the instrument/scope has not been shown capable of finding a known-positive row.'
            : '⚠ absence unverified: rowCount is 0 and no positiveControlSql was run. Re-run with a known-positive SELECT through the same table/scope/instrument before treating this as evidence of absence.'
          : null;
      const advisory =
        [
          ...sqlShapeAdvisories,
          tenantAdvisory,
          positiveControlTenantAdvisory,
          positiveControlAdvisory,
          toolRoutingAdvisory,
        ]
          .filter(Boolean)
          .join(' ') || null;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...(advisory ? { advisory } : {}),
              mode: PG_QUERY_MODE.query,
              rowCount: result.rowCount,
              truncated: result.truncated,
              fields: result.fields,
              elapsedMs: result.elapsedMs,
              rows: result.rows,
              ...(positiveControl ? { positiveControl } : {}),
              ...(absence ? { absence } : {}),
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
      const regexRepetitionHint = postgresRegexRepetitionHint(sql, info);
      if (regexRepetitionHint && !payload.hint) payload.hint = regexRepetitionHint;
      const unionColumnCountCorrection = unionColumnCountHint(sql, info);
      if (unionColumnCountCorrection && !payload.hint) payload.hint = unionColumnCountCorrection;
      // The SAME sql-derived advisories the success payload composes, in the
      // same order — a query's SHAPE is no less true for having failed to run.
      // Placed AFTER the precise correction (PG's own hint names the column)
      // and BEFORE the 42703 bulk column list, which runs to ~2.4KB for
      // harness_shared.work_items: an advisory emitted after that wall is one
      // the reader has already scrolled past, and burying the fix under the
      // most voluminous-looking part of the payload is the failure this whole
      // error path exists to avoid.
      const errorAdvisory =
        [...sqlShapeAdvisories, toolRoutingAdvisory].filter(Boolean).join(' ') || null;
      if (errorAdvisory) payload.advisory = errorAdvisory;
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
