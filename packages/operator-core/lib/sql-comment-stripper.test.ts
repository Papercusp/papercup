/**
 * The SQL half of scripts/lib/strip-comments-and-strings.mjs (EI-20073035509369492).
 *
 * WHY THIS FILE EXISTS. That module was built on the TypeScript parser, and its `fileName`
 * parameter only ever picked a ScriptKind. Handed SQL it returned the input COMPLETELY
 * UNMASKED — no throw, no warning, no sentinel. That is worse than simply lacking SQL
 * support: the repo's standing advice is "migrate your guard to the shared stripper", and
 * doing that to a `.sql`-scanning guard left the hole wide open WHILE the guard-of-guards
 * classifier reclassified the guard as masked. A no-op indistinguishable from success.
 *
 * These cases pin the three PostgreSQL specifics that the five private implementations this
 * replaces all got wrong, plus the length/offset contract the TypeScript path already
 * guarantees. Every assertion here is one a naive dash-dash-to-end-of-line regex FAILS.
 */
import { describe, expect, it } from 'vitest';
import {
  isLiveCodeAt,
  stripCommentsOnly,
  stripSqlComments,
  stripSqlCommentsAndStrings,
} from '../../../scripts/lib/strip-comments-and-strings.mjs';

describe('SQL comment stripping', () => {
  it('blanks a line comment while preserving length', () => {
    const sql = "-- ws = 'default' prose\nCREATE TABLE t (ws text DEFAULT 'default');";
    const masked = stripSqlComments(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked.split('\n')[0]).not.toMatch(/ws = /);
    // The real DDL default is a string literal and must survive — it is what guards match on.
    expect(masked).toContain("DEFAULT 'default'");
  });

  it('does NOT treat a -- inside a string literal as a comment', () => {
    // The exact silent false-negative that check-workspace-default-sql's hand-rolled
    // per-line test produced: an unrelated -- earlier in the line suppressed everything after it.
    const sql = "INSERT INTO t VALUES ('a--b'), (ws DEFAULT 'default');";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it('does NOT treat -- inside a dollar-quoted body as a comment', () => {
    // Function bodies are dollar-quoted and contain -- freely. A regex masks straight through.
    const sql = "CREATE FUNCTION f() RETURNS int AS $$ -- not a comment\n SELECT 1; $$ LANGUAGE sql;";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it('handles a $tag$-delimited body, not just bare $$', () => {
    const sql = "CREATE FUNCTION f() AS $body$ -- inside\n SELECT 1; $body$ LANGUAGE sql;";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it('counts depth for NESTED block comments (PostgreSQL nests; C does not)', () => {
    const sql = 'SELECT 1; /* outer /* inner */ still comment */ SELECT 2;';
    const masked = stripSqlComments(sql);
    // A first-close-wins implementation stops at the inner */ and leaves this standing.
    expect(masked).not.toContain('still comment');
    expect(masked).toContain('SELECT 2;');
    expect(masked).toHaveLength(sql.length);
  });

  it("treats a doubled '' as an escape that continues the literal", () => {
    const sql = "SELECT 'it''s -- fine', x;";
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it('preserves the line COUNT across a multi-line block comment', () => {
    // Two of the replaced implementations collapsed comments to '\n' or deleted them, which
    // shifts every line after them — so a guard reported the wrong line number.
    const sql = 'SELECT 1;\n/* a\n b\n c */\nSELECT 2;';
    expect(stripSqlComments(sql).split('\n')).toHaveLength(sql.split('\n').length);
  });

  it('blanks literal CONTENT but keeps delimiters, so isLiveCodeAt works as it does for TS', () => {
    const sql = "SELECT 'secret';";
    const masked = stripSqlCommentsAndStrings(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked).not.toContain('secret');
    // Delimiters are program text; their contents are not. This is the documented contract
    // that lets a rule anchor on the opening quote.
    expect(isLiveCodeAt(sql, masked, sql.indexOf("'"))).toBe(true);
    expect(isLiveCodeAt(sql, masked, sql.lastIndexOf("'"))).toBe(true);
    expect(isLiveCodeAt(sql, masked, sql.indexOf("'") + 1)).toBe(false);
  });
});

describe('extension dispatch', () => {
  const sql = "-- ws = 'default' in prose\nCREATE TABLE t ();";

  it('routes a .sql fileName to the SQL path', () => {
    expect(stripCommentsOnly(sql, 'x.sql')).not.toMatch(/ws = /);
  });

  it('still no-ops when the extension is omitted — the documented trap', () => {
    // Pinned deliberately: callers that do not pass a fileName get the TypeScript path, which
    // cannot see SQL comments. If this ever starts masking, the dispatch became content-sniffing
    // and this test should be updated rather than deleted.
    expect(stripCommentsOnly(sql)).toBe(sql);
  });

  it('leaves the TypeScript path unchanged', () => {
    const ts = "// c\nconst u = 'https://x'; const w = s ?? 'default';";
    const masked = stripCommentsOnly(ts, 'x.ts');
    expect(masked).not.toContain('// c');
    // stripCommentsOnly keeps strings — the URL must survive, which is what makes the
    // check-scope-defaults fix possible.
    expect(masked).toContain('https://x');
  });
});
