/**
 * Translate a hand-written `information_schema` query into the `describe` call
 * that answers it (plan `sql-escape-tool-routing-2026-08-12`, P-009).
 *
 * Split out of `sql-reads.ts` for the same reason `model-drift-helpers.ts` exists
 * beside the service pairs: these are the functions a drift test needs to call
 * directly, and importing them from the pair module would drag the whole pair
 * registry into a test that is only asking "does this query translate".
 *
 * Everything here is a best-effort READ of a query's text. Returning null is
 * always a legitimate answer and is the honest one whenever the shape is not
 * unambiguous — a wrong translation would route an agent to a describe call that
 * answers a different question, which is worse than leaving the query alone.
 */

/** A SQL string literal's contents, for a `col = 'value'` predicate. */
function literalAfter(atom: string, column: string): string | null {
  const re = new RegExp(String.raw`\b${column}\s*=\s*'([^']+)'`, 'i');
  return re.exec(atom)?.[1] ?? null;
}

/** The contents of a `col LIKE '…'` / `col ILIKE '…'` predicate. */
function likePatternFor(atom: string, column: string): string | null {
  const re = new RegExp(String.raw`\b${column}\s+i?like\s*'([^']+)'`, 'i');
  return re.exec(atom)?.[1] ?? null;
}

/**
 * `… WHERE table_schema='harness_shared' AND table_name='work_items'` →
 * `harness_shared.work_items`.
 *
 * The schema is REQUIRED even though `describe` would accept a bare name,
 * because a bare relation name can resolve in several schemas here (per-harness
 * clones make that ordinary) and silently describing the wrong one is the single
 * most expensive way this translation can be wrong.
 */
export function describeRelationFromColumnsQuery(atom: string): string | null {
  const table = literalAfter(atom, 'table_name');
  if (!table) return null;
  const schema = literalAfter(atom, 'table_schema');
  if (!schema) return null;
  return `${schema}.${table}`;
}

/**
 * `… WHERE table_name ILIKE '%coord%'` → `*coord*`
 * `… WHERE table_schema='harness_shared'` → `harness_shared.*`
 *
 * The glob is `listRelations`' own dialect: `*` becomes `%` and the match runs
 * against `lower(schema.name)` OR `lower(name)`, so a bare fragment reaches the
 * same rows the hand-written ILIKE does. A query carrying BOTH a schema and a
 * name fragment translates to the schema-qualified glob, which is the narrower
 * (and therefore safer) of the two readings.
 */
export function describePatternFromTablesQuery(atom: string): string | null {
  const schema = literalAfter(atom, 'table_schema');
  const fragment = likePatternFor(atom, 'table_name');

  if (fragment) {
    const glob = fragment.replace(/%/g, '*');
    return schema ? `${schema}.${glob}` : glob;
  }
  // An EXACT name (`table_name = 'spawned_agents'`) is a glob with no wildcards
  // in it: listRelations lowercases both sides and runs LIKE, so a pattern with
  // no `%` is an equality test. Worth handling rather than declining, because
  // "does this relation exist, and in which schema" is one of the questions the
  // corpus asks most and it is the cheapest of all to answer.
  const exact = literalAfter(atom, 'table_name');
  if (exact) return schema ? `${schema}.${exact}` : exact;
  if (schema) return `${schema}.*`;
  return null;
}
