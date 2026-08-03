import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import {
  findSqlCommentBacktick,
  sqlCommentBacktickScopeMatches,
} from './sql-comment-backtick';

/**
 * Fixtures are built as arrays of single-quoted lines joined with '\n', never as
 * template literals — a template literal holding these fixtures would itself be
 * terminated by the very backticks under test. (That is not a cute observation:
 * it is the bug, reproduced at authoring time.)
 */
const src = (...lines: string[]) => lines.join('\n');

describe('findSqlCommentBacktick — the three real incidents', () => {
  it('catches the SILENT case: a backtick in a comment inside a sql`` tagged template (EI-7661, mig-504)', () => {
    // 2026-07-05: this amputated the entire WHERE clause from the LWW upserts.
    // The file still PARSED, so ts-parse could never have seen it.
    const text = src(
      'const r = await sql`',
      '  UPDATE harness_shared.engineer_issues',
      '     SET payload = ${payload}',
      '   WHERE id = ${id}',
      '     -- the bare `>=` applied here lets a stale write win',
      '     AND updated_at <= ${ts}',
      '`;',
    );
    const hit = findSqlCommentBacktick('lww.ts', text);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(5);
    expect(hit!.backticks).toBe(2);
    expect(hit!.text).toContain('the bare');
  });

  it('catches the LOUD case: a plain DDL template with no sql`` tag at all (EI-19317789732905891)', () => {
    // _work-items-schema.ts — 657 lines of DDL across 8 plain template-literal
    // constants. No tagged template anywhere, so USES_SQL_TAG alone missed it.
    const text = src(
      'export const WORK_ITEMS_DDL = [',
      '  "CREATE TABLE harness_shared.work_items (",',
      '  "  id text PRIMARY KEY,",',
      '  "  closed_ts timestamptz",',
      '  -- the `closed_ts` column is written by plans:start',
      '  ");",',
      '].join("\\n");',
    );
    const hit = findSqlCommentBacktick('_work-items-schema.ts', text);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(5);
    expect(hit!.backticks).toBe(2);
  });

  it('catches the third incident spelling: a parenthesised attribution comment', () => {
    const text = src(
      'const q = sql`',
      '  SELECT id',
      '    FROM harness_shared.plans',
      '   -- (op_status, written by `plans:start`)',
      '`;',
    );
    const hit = findSqlCommentBacktick('plans.ts', text);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(4);
  });

  it('reports the column of the FIRST backtick — the one that ends the template', () => {
    const line = '  -- the `kind` column';
    const text = src('const q = sql`', 'SELECT 1', line, '`;');
    const hit = findSqlCommentBacktick('a.ts', text);
    expect(hit).not.toBeNull();
    // 1-based column of the first backtick.
    expect(hit!.col).toBe(line.indexOf('`') + 1);
  });
});

describe('findSqlCommentBacktick — false positives the >=2 rule removes', () => {
  it('does NOT flag the backtick that legitimately TERMINATES a single-line template', () => {
    // The systematic false positive of the original scripts/check-sql-comment-backtick.mjs.
    const text = src(
      'const q = sql`SELECT 1`;',
      'const r = `SELECT 1 -- trailing; comment`;',
    );
    expect(findSqlCommentBacktick('pg-read-query.ts', text)).toBeNull();
  });

  it('does NOT flag a shell/CLI command string whose closing backtick follows a `--` path separator', () => {
    const text = src(
      'const q = sql`SELECT 1`;',
      "const cmd = `git log --format='%H %cI' -3 -- bin/lib/x.sh`;",
    );
    expect(findSqlCommentBacktick('equivalence.ts', text)).toBeNull();
  });

  it('does NOT flag the live registry.ts line that had lint:no-sql-comment-backtick RED', () => {
    // Verbatim from content-lint/registry.ts:339 at the time of writing. One
    // backtick after the marker, inside a single-quoted prose string.
    const text = src(
      'const q = sql`SELECT 1`;',
      '    ' +
        "'line instead: `npm run test:file -- <path> -- -t \"<test name>\"`. On an auto-committing tree that ' +",
    );
    expect(findSqlCommentBacktick('registry.ts', text)).toBeNull();
  });

  it('does NOT flag a CLI flag token (no space after the dashes)', () => {
    const text = src(
      'const q = sql`SELECT 1`;',
      'const args = ["--reporter=json", "--outputFile=`x`"];',
    );
    expect(findSqlCommentBacktick('a.ts', text)).toBeNull();
  });

  it('does NOT flag prose in a // or /* */ JS comment', () => {
    const text = src(
      'const q = sql`SELECT 1`;',
      '// -- the `kind` column is discussed here, not declared',
      ' * -- the `kind` column again',
      '/* -- and `here` too */',
    );
    expect(findSqlCommentBacktick('a.ts', text)).toBeNull();
  });

  it('does NOT flag an ESCAPED backtick — it does not end a template literal', () => {
    const text = src(
      'const q = sql`',
      '  SELECT 1',
      '  -- the \\`kind\\` column, correctly escaped',
      '`;',
    );
    expect(findSqlCommentBacktick('a.ts', text)).toBeNull();
  });
});

describe('findSqlCommentBacktick — file-level SQL scope gate', () => {
  it('returns null for a file with no SQL at all, however many backticked comments it has', () => {
    const text = src('// -- the `kind` column', 'const x = 1;');
    expect(findSqlCommentBacktick('a.ts', text)).toBeNull();
  });

  it('does NOT pull a file into scope merely for DISCUSSING `sql` in prose', () => {
    // The bare /\bsql`/ of the original guard matched the markdown spelling
    // `sql` in a doc comment, which is how registry.ts — a file containing no
    // SQL whatsoever — came to be scanned and then false-positived.
    const text = src(
      '/**',
      ' * A backtick inside a SQL comment inside a `sql` template closes it.',
      ' */',
      "const msg = 'see the `kind` column -- as described above';",
    );
    expect(findSqlCommentBacktick('registry.ts', text)).toBeNull();
  });

  it('DOES scope a file that genuinely uses a sql`` tagged template', () => {
    const text = src('const q = sql`SELECT 1`;', 'const c = "  -- the `kind` column";');
    expect(findSqlCommentBacktick('a.ts', text)).not.toBeNull();
  });

  it('DOES scope a plain DDL file via raw CREATE TABLE/VIEW/INDEX', () => {
    const text = src('const d = "CREATE UNIQUE INDEX x ON t (a)";', 'const c = "  -- the `a` column";');
    expect(findSqlCommentBacktick('a.ts', text)).not.toBeNull();
  });
});

/**
 * These pin the JUSTIFICATION for using a line scanner instead of an AST walk,
 * because the obvious justification is WRONG and was believed here before being
 * measured. If a future reader reaches for the AST approach, these are the facts
 * that must change first.
 */
describe('why an AST walk cannot replace this scanner (measured, not assumed)', () => {
  const parse = (text: string) =>
    ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const diagsOf = (sf: ts.SourceFile) =>
    (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  const countTemplates = (sf: ts.SourceFile) => {
    let n = 0;
    const walk = (node: ts.Node) => {
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) n++;
      ts.forEachChild(node, walk);
    };
    walk(sf);
    return n;
  };

  const SILENT = [
    'const r = await sql`',
    '  UPDATE t SET a = 1',
    '   WHERE id = 2',
    '     -- the bare `>=` applied here',
    '     AND b <= ${x}',
    '`;',
    'export const after = 1;',
  ].join('\n');

  const LOUD = [
    'export const DDL = `',
    'CREATE TABLE t (',
    '  closed_ts timestamptz',
    '  -- the `closed_ts` column is written by plans:start',
    ');',
    '`;',
    'export const after = 1;',
  ].join('\n');

  it('the SILENT case PARSES CLEANLY — so "the file does not parse" is false, and ts-parse is blind to it', () => {
    const sf = parse(SILENT);
    expect(diagsOf(sf)).toHaveLength(0);
    // ...and this is exactly why it is dangerous: it compiles, ships, and RUNS
    // with the query truncated. Only this detector sees it.
    expect(findSqlCommentBacktick('x.ts', SILENT)).not.toBeNull();
  });

  it('the LOUD case still yields template NODES — so "there are no nodes to walk" is false too', () => {
    const sf = parse(LOUD);
    expect(diagsOf(sf).length).toBeGreaterThan(0); // TS1005 cascade
    expect(countTemplates(sf)).toBeGreaterThan(0); // but TS error-RECOVERS
    expect(findSqlCommentBacktick('x.ts', LOUD)).not.toBeNull();
  });

  it('the REAL reason: the stray backtick is consumed as the TERMINATOR, so it is no longer inside any template', () => {
    const sf = parse(SILENT);
    const texts: string[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        texts.push(node.getText(sf));
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
    // The first template ends mid-comment, right AT the offending backtick —
    // getText() includes that terminator, so the node's text ends '--`'. The SQL
    // body it was supposed to carry is truncated at the comment.
    expect(texts[0].endsWith('--`')).toBe(true);
    expect(texts[0]).not.toContain('>=');
    expect(texts[0]).not.toContain('AND b <=');
    // So an AST walk asking "is there a backtick INSIDE this template's SQL?"
    // correctly answers no, on a file that is broken in exactly that way. The
    // evidence has been reinterpreted as syntax. A byte scanner is immune.
  });
});

describe('sqlCommentBacktickScopeMatches', () => {
  it('matches ordinary .ts/.tsx/.mjs source', () => {
    expect(sqlCommentBacktickScopeMatches('packages/operator-core/lib/work-items.ts')).toBe(true);
    expect(sqlCommentBacktickScopeMatches('scripts/x.mjs')).toBe(true);
  });

  it('EXCLUDES test/spec files — they carry deliberate fixtures of this exact bug', () => {
    // ts-parse.test.ts and git-sync/content-guard.test.ts both hold a
    // backtick-in-SQL-comment line ON PURPOSE. Registering them would quarantine
    // the tests that prove this detector works. ts-parse still covers test files
    // for the parse-breaking case — what they forgo is the message, not the guard.
    expect(sqlCommentBacktickScopeMatches('packages/operator-core/lib/content-lint/ts-parse.test.ts')).toBe(false);
    expect(sqlCommentBacktickScopeMatches('a/b/x.integration.test.ts')).toBe(false);
    expect(sqlCommentBacktickScopeMatches('a/b/x.spec.tsx')).toBe(false);
  });

  it('excludes declarations, retired trees, vendored code and build output', () => {
    expect(sqlCommentBacktickScopeMatches('a/b/x.d.ts')).toBe(false);
    expect(sqlCommentBacktickScopeMatches('_retired/x.ts')).toBe(false);
    expect(sqlCommentBacktickScopeMatches('a/_retired/x.ts')).toBe(false);
    expect(sqlCommentBacktickScopeMatches('a/node_modules/x.ts')).toBe(false);
    expect(sqlCommentBacktickScopeMatches('a/dist/x.ts')).toBe(false);
    expect(sqlCommentBacktickScopeMatches('papercusp-desktop/src-tauri/env-sidecars/serve.mjs')).toBe(false);
  });

  it('excludes non-source extensions', () => {
    expect(sqlCommentBacktickScopeMatches('a/b/x.md')).toBe(false);
    expect(sqlCommentBacktickScopeMatches('a/b/x.sql')).toBe(false);
  });
});
