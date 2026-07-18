/**
 * rubrics-replication-sql.test.ts — pure unit coverage for the EI-10514 SQL-drill
 * extractor (extractReplicationSqlStatements). No DB: the async EXPLAIN validation
 * (validateRubricReplicationSql / explainReadQuery) is covered against real Postgres in
 * pg-read-query.integration.test.ts + rubrics-replication-sql.integration.test.ts.
 *
 * Fixtures below are drawn verbatim from LIVE stored rubric `replication` fields
 * (mug-pot-coordination-health, autoloop-release-readiness, ei10443-repro-drill,
 * su-agent-behavior) so the extractor is pinned against real authored drill prose, not
 * synthetic strings that happen to be easy.
 */
import { describe, it, expect } from 'vitest';
import { extractReplicationSqlStatements } from './rubrics-replication-sql';

describe('extractReplicationSqlStatements', () => {
  it('returns [] for undefined/null/empty text', () => {
    expect(extractReplicationSqlStatements(undefined)).toEqual([]);
    expect(extractReplicationSqlStatements(null)).toEqual([]);
    expect(extractReplicationSqlStatements('')).toEqual([]);
  });

  it('returns [] for prose with no embedded SQL', () => {
    expect(extractReplicationSqlStatements('fleet:assignments { harness } -> read summary.coverage')).toEqual([]);
  });

  it('extracts a semicolon-terminated statement, dropping trailing prose', () => {
    const text =
      "SELECT tick_at, frontier_depth, placements, cups_busy, cups_cap FROM harness_shared.pot_throughput_ticks " +
      "WHERE workspace_id='papercusp-workspace' AND tick_at > now()-interval '24 hours' ORDER BY tick_at; " +
      "apply the stuck-run rule above; cross-check accounts:status before rating fail.";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT tick_at, frontier_depth, placements, cups_busy, cups_cap FROM harness_shared.pot_throughput_ticks " +
        "WHERE workspace_id='papercusp-workspace' AND tick_at > now()-interval '24 hours' ORDER BY tick_at",
    ]);
  });

  it('finds the SELECT after a leading tool-call prefix ("accounts:status + SELECT …")', () => {
    const text =
      "accounts:status + SELECT status, gate, count(*) FROM harness_shared.scout_ticks " +
      "WHERE tick_at > now()-interval '48 hours' GROUP BY 1,2;";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT status, gate, count(*) FROM harness_shared.scout_ticks WHERE tick_at > now()-interval '48 hours' GROUP BY 1,2",
    ]);
  });

  it('extracts a statement that runs to end-of-field, stripping one trailing sentence period', () => {
    const text =
      "REPLICATION DRILL: sentinel-ei10443-payload — this exact string must survive rubrics:ratify. Verify: " +
      "SELECT count(*) FROM jsonb_array_elements((SELECT template_data->'criteria' FROM harness_shared.harness_plans " +
      "WHERE plan_slug='ei10443-repro-drill')) c WHERE c->>'replication' LIKE '%sentinel-ei10443-payload%'.";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT count(*) FROM jsonb_array_elements((SELECT template_data->'criteria' FROM harness_shared.harness_plans " +
        "WHERE plan_slug='ei10443-repro-drill')) c WHERE c->>'replication' LIKE '%sentinel-ei10443-payload%'",
    ]);
  });

  it('does not re-extract a nested/subquery SELECT as its own statement', () => {
    const text =
      "SELECT count(*) FROM jsonb_array_elements((SELECT template_data->'criteria' FROM harness_shared.harness_plans)) c;";
    expect(extractReplicationSqlStatements(text)).toHaveLength(1);
  });

  // The real regression this extractor exists to avoid: a query with NO semicolon that
  // is immediately followed by more prose containing its OWN semicolon much later. A
  // naive "capture to the first `;` anywhere in the field" would glue unrelated prose
  // onto valid SQL and manufacture a false-positive syntax error.
  it('stops at a bare sentence-ending period, not a later unrelated semicolon', () => {
    const text =
      "GRADE: SELECT tool_name, status, args_json, invoked_at FROM harness_shared.tool_invocations " +
      "WHERE coord_owner_id='<subject>' ORDER BY invoked_at. Count calls with tool_name LIKE 'plur%' " +
      "or any blocked/hallucinated-tool error; find the longest run of IDENTICAL blocked calls.";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT tool_name, status, args_json, invoked_at FROM harness_shared.tool_invocations " +
        "WHERE coord_owner_id='<subject>' ORDER BY invoked_at",
    ]);
  });

  it('never treats a `;` inside a string literal as a terminator', () => {
    const text = "SELECT * FROM foo WHERE reason = 'text; more text' AND ok = true.";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT * FROM foo WHERE reason = 'text; more text' AND ok = true",
    ]);
  });

  it('never treats a `.`+whitespace inside a string literal as a terminator', () => {
    const text = "SELECT * FROM foo WHERE note = 'e.g. this is fine' ORDER BY id;";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT * FROM foo WHERE note = 'e.g. this is fine' ORDER BY id",
    ]);
  });

  it('handles a schema-qualified dotted identifier without splitting on it', () => {
    expect(extractReplicationSqlStatements('SELECT * FROM harness_shared.autoloop_state LIMIT 10;')).toEqual([
      'SELECT * FROM harness_shared.autoloop_state LIMIT 10',
    ]);
  });

  it('extracts multiple independent statements from one field', () => {
    const text =
      "SELECT 1 AS a; some connecting prose. SELECT 2 AS b;";
    expect(extractReplicationSqlStatements(text)).toEqual(['SELECT 1 AS a', 'SELECT 2 AS b']);
  });

  it('extracts a WITH…SELECT (CTE) as one statement', () => {
    const text = 'WITH t AS (SELECT 1 AS n) SELECT * FROM t;';
    expect(extractReplicationSqlStatements(text)).toEqual(['WITH t AS (SELECT 1 AS n) SELECT * FROM t']);
  });

  it('is case-insensitive on the leading keyword', () => {
    expect(extractReplicationSqlStatements('select 1 as n;')).toEqual(['select 1 as n']);
  });
});
