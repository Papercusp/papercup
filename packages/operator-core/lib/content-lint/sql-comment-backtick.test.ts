import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import {
  findSqlCommentBacktick,
  sqlCommentBacktickScopeMatches,
  autoFixSqlCommentBacktick,
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

  /**
   * WI-9253 — the gap that cost a 17-minute :3170 outage on 2026-08-03.
   *
   * The gate used to require the backtick to follow `sql` IMMEDIATELY, so the
   * typed call form did not match. A SELECT-only file also fails HAS_RAW_DDL,
   * so the whole file was rejected and the detector never ran. 411 non-test
   * files were fully invisible this way — which is why the guard had 0 true
   * positives while the very bug it hunts was crash-looping a shared service.
   *
   * This reproduces the real watchdog.ts:1836 shape, not a minimised stand-in:
   * the tag is generic, the SQL is a bare SELECT, and the offending backticks
   * sit in an ORDER BY rationale comment.
   */
  it('DOES scope the TYPED tag form sql<T>`` with no DDL — the 2026-08-03 :3170 outage (WI-9253)', () => {
    const text = src(
      'const rows = await sql<RoutineFailureRow[]>`',
      "  SELECT name, metadata->>'last_error' AS last_error",
      '    FROM harness_shared.routines',
      '   -- Oldest error first, so the longest-standing failure is never crowded out; `name`',
      '   -- is a total-order tiebreak so set membership is stable across ticks.',
      '   ORDER BY name ASC',
      '   LIMIT 200`;',
    );
    const hit = findSqlCommentBacktick('watchdog.ts', text);
    expect(hit).not.toBeNull();
    expect(hit?.text).toContain('longest-standing failure');
    expect(hit?.backticks).toBe(2);
  });

  it('DOES scope the typed form even when the generic itself is nested', () => {
    const text = src('const q = sql<Array<Row>>`SELECT 1`;', 'const c = "  -- the `kind` column";');
    expect(findSqlCommentBacktick('a.ts', text)).not.toBeNull();
  });

  it('still does NOT scope prose that merely mentions sql followed by a comparison', () => {
    const text = src('// a < b and sql > c, discussed in prose only', 'const c = "  -- the `kind` column";');
    expect(findSqlCommentBacktick('notes.ts', text)).toBeNull();
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
    // Measured, not assumed. The first template node is:
    //   "`\n  UPDATE t SET a = 1\n   WHERE id = 2\n     -- the bare `"
    // It TERMINATES at the offending backtick, mid-comment. Everything the SQL
    // was supposed to carry after that point is simply not in this node.
    expect(texts[0].endsWith('`')).toBe(true);
    expect(texts[0]).toContain('-- the bare');
    expect(texts[0]).not.toContain('>=');
    expect(texts[0]).not.toContain('AND b <=');
    // The remainder re-parses as a SECOND, bogus template — which is why the
    // node count is 2 and why nothing downstream looks obviously wrong.
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('AND b <=');
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

/**
 * The deterministic repair (EI-19493869861442174). Before this existed, every occurrence of
 * this class quarantined the file and waited on the LLM content-fixer — measured at ~76min on
 * 2026-08-04 with :3170 down fleet-wide and a peer's fix stranded, for a two-character change.
 *
 * The contract the git-sync guard relies on is narrow and is what the first test pins: run on
 * a file that FAILED `detect`, the repair must make `detect` return null. If it does not, the
 * guard discards it and quarantines exactly as before — so these tests are the difference
 * between a repair that lands and one that silently never applies.
 */
describe('autoFixSqlCommentBacktick — the deterministic repair', () => {
  const INCIDENT = src(
    'const rows = await sql`',
    '    SELECT id FROM harness_shared.work_items',
    "     WHERE state <> 'done'",
    "     -- ⚠ NOT `<> 'done'`: 209 live plan-items sit at 'dropped', and counting",
    '     LIMIT 200`;',
  );

  it('CLEARS the detector — the contract the git-sync guard checks before keeping a repair', () => {
    expect(findSqlCommentBacktick('a/b/x.ts', INCIDENT)).not.toBeNull();
    const { fixed, changed } = autoFixSqlCommentBacktick(INCIDENT);
    expect(changed).toBe(true);
    expect(findSqlCommentBacktick('a/b/x.ts', fixed)).toBeNull();
  });

  it('produces exactly the remedy detect() prescribes: straight double quotes', () => {
    const { fixed } = autoFixSqlCommentBacktick(INCIDENT);
    expect(fixed).toContain('NOT "<> \'done\'"');
  });

  it('leaves the enclosing template intact — opener and closing backtick both survive', () => {
    const { fixed } = autoFixSqlCommentBacktick(INCIDENT);
    expect(fixed).toContain('await sql`');
    expect(fixed).toContain('LIMIT 200`;');
    // Only the comment line moved; every other line is byte-identical.
    const before = INCIDENT.split('\n');
    const after = fixed.split('\n');
    expect(after.filter((l, i) => l !== before[i])).toHaveLength(1);
  });

  it('repairs EVERY offending line, not just the first — a partial repair would be discarded', () => {
    const many = src(
      'const rows = await sql`',
      '     -- first offender: `alpha` here',
      "     WHERE state <> 'done'",
      '     -- second offender: `beta` here',
      '     LIMIT 1`;',
    );
    const { fixed, changed } = autoFixSqlCommentBacktick(many);
    expect(changed).toBe(true);
    expect(findSqlCommentBacktick('a/b/x.ts', fixed)).toBeNull();
    expect(fixed).toContain('"alpha"');
    expect(fixed).toContain('"beta"');
  });

  it('is idempotent and pure, per the autoFix contract', () => {
    const once = autoFixSqlCommentBacktick(INCIDENT);
    const twice = autoFixSqlCommentBacktick(once.fixed);
    expect(twice.changed).toBe(false);
    expect(twice.fixed).toBe(once.fixed);
    // the input string itself is untouched
    expect(INCIDENT).toContain('`<>');
  });

  it('is a no-op on a clean file', () => {
    const clean = src('const rows = await sql`', "     -- the 'name' column", '     SELECT 1`;');
    expect(autoFixSqlCommentBacktick(clean)).toEqual({ fixed: clean, changed: false });
  });

  // CONTROL (the repo's tier-1 falsifiability pattern for an imported module: keep a
  // deliberately-WRONG repair beside the real one), so "detect returns null after the fix"
  // cannot pass for a weak reason. Repairing only ONE of two offending lines must not satisfy it.
  it('CONTROL: repairing only one offending line does NOT clear the detector', () => {
    const twoOffenders = src(
      'const rows = await sql`',
      '     -- first offender: `alpha` here',
      '     -- second offender: `beta` here',
      '     SELECT 1`;',
    );
    const halfRepaired = twoOffenders.replace('`alpha`', '"alpha"');
    expect(halfRepaired).not.toBe(twoOffenders); // the control really did mutate something
    expect(findSqlCommentBacktick('a/b/x.ts', halfRepaired)).not.toBeNull();
  });

  /**
   * HAZARD PIN. This detector fires only at >=2 unescaped backticks, because exactly one is
   * how a legitimate ONE-LINE template closes. The documented consequence is a residual blind
   * spot: a lone unescaped backtick in a comment inside a MULTI-line template still truncates
   * that template, and this rule stays silent about it (ts-parse catches it instead — and
   * ts-parse has NO autoFix, so it costs a full quarantine + LLM-fixer round).
   *
   * That makes "leave exactly one backtick behind" the single worst thing a repair here could
   * do: it would silence this detector while leaving the file broken, converting a fast
   * deterministic fix into the slow path it exists to avoid. So the repair must clear the
   * WHOLE comment, and this pins both halves of that.
   */
  it('never leaves a LONE backtick behind — the >=2 rule would go silent while the file stays broken', () => {
    const oneLeft = INCIDENT.replace('`<>', '"<>'); // a naive first-backtick-only repair
    expect(findSqlCommentBacktick('a/b/x.ts', oneLeft)).toBeNull(); // silent: the blind spot
    expect(oneLeft).toContain('`'); // ...yet a template-terminating backtick remains

    // The real repair must not produce that state: no backtick survives on the comment line.
    const { fixed } = autoFixSqlCommentBacktick(INCIDENT);
    const commentLine = fixed.split('\n').find((l) => l.includes('209 live plan-items'));
    expect(commentLine).toBeDefined();
    expect(commentLine).not.toContain('`');
  });

  it('leaves an ESCAPED backtick alone — it never terminated the template', () => {
    const withEscape = src(
      'const rows = await sql`',
      '     -- `alpha` and an escaped \\` tick',
      '     SELECT 1`;',
    );
    const { fixed, changed } = autoFixSqlCommentBacktick(withEscape);
    expect(changed).toBe(true);
    expect(fixed).toContain('"alpha"');
    expect(fixed).toContain('\\`'); // the escaped one survives untouched
  });
});

describe('findSqlCommentBacktick — generated files (the sidestage snapshot false positive, 2026-08-17)', () => {
  // build-history.snapshot.ts: a generated data snapshot whose double-quoted JSON
  // strings embed fleet prose — markdown inline-code backticks around a git
  // PATHSPEC separator (a space-padded ` -- `) satisfy the line heuristic, and an
  // embedded body quoting DDL satisfies HAS_RAW_DDL, while tsc parses the file
  // CLEAN (every backtick sits inside a double-quoted string, which a line
  // scanner cannot know).
  const generatedBody = (...header: string[]) =>
    src(
      ...header,
      'export const BUILD_HISTORY_SNAPSHOT = {',
      '  "body": "evidence: CREATE TABLE noise quoted in prose; ran `git log -1 -- libs/dock-workbench` and `-- .gitmodules` -> both d54458cd",',
      '} as const;',
    );

  it('returns null for a machine-generated data file, whatever its strings contain', () => {
    const text = generatedBody('/* Generated by `papercusp project-history generate`. Do not edit by hand. */');
    expect(findSqlCommentBacktick('build-history.snapshot.ts', text)).toBeNull();
  });

  it('honours the other header spellings: // comments, "do not edit", @generated', () => {
    for (const header of [
      '// GENERATED BY scripts/gen-agent-env.mjs -- do not hand-edit',
      '/* eslint-disable */ // @generated',
      '// Do not edit: projected from harness_doc_parts.',
    ]) {
      expect(findSqlCommentBacktick('gen.ts', generatedBody(header))).toBeNull();
    }
  });

  it('honours a generated marker after a Node shebang', () => {
    const text = generatedBody('#!/usr/bin/env node\n/* @generated by apps/operator/bin/bundle-host.sh — do not edit */');
    expect(findSqlCommentBacktick('dist-sidecar/embed-sidecar.mjs', text)).toBeNull();
  });

  it('control: the SAME content without the header still hits — the exemption is the header, not the shape', () => {
    const text = generatedBody('// build-history snapshot data');
    const hit = findSqlCommentBacktick('build-history.snapshot.ts', text);
    expect(hit).not.toBeNull();
    expect(hit!.backticks).toBeGreaterThanOrEqual(2);
  });

  it('the header must be on the FIRST line — a later mention exempts nothing', () => {
    const text = src(
      'const doc = "this file was Generated by hand, honest";',
      'export const DDL = [',
      '  "CREATE TABLE t (",',
      '  -- the `closed_ts` column is written by `plans:start`',
      '  ")",',
      '].join("\\n");',
    );
    expect(findSqlCommentBacktick('x.ts', text)).not.toBeNull();
  });

  it('autoFix inherits the exemption: a generated file is never rewritten', () => {
    const text = generatedBody('/* Generated by `papercusp project-history generate`. Do not edit by hand. */');
    const { changed } = autoFixSqlCommentBacktick(text);
    expect(changed).toBe(false);
  });
});

/** parseDiagnostics is real but not on the public SourceFile type. */
type ParsedFile = ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
const parseErrors = (file: string, text: string): number =>
  (ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) as ParsedFile).parseDiagnostics.length;

/**
 * The SECOND host (EI-21219437374882016): a `//` comment inside a NON-SQL template.
 *
 * The 7th recurrence of this class was `libs/generic/tooldef/src/code-orchestration/
 * run-script.ts`, whose `const WORKER_SRC = ...` template holds generated JS — and
 * therefore `//` comments. Two bare backticks in one of them terminated the template
 * and the file stopped parsing, reported as `Expected ";" but found "inputs"` ON A
 * COMMENT LINE.
 *
 * Containment already existed: ts-parse AND esbuild-transform both flag that content,
 * and both sit on the git-sync content guard (measured 2026-09-05 through
 * `npm run content-lint`). What did not exist was a message naming the actual mistake,
 * which is the whole reason this detector is ordered ahead of them.
 */
describe('findSqlCommentBacktick — the template-literal host (EI-21219437374882016)', () => {
  /** The real 7th-recurrence line, in the smallest host that reproduces it. */
  const workerSrc = (comment: string) =>
    src(
      'const WORKER_SRC = `(() => {',
      '  const inputs = Object.freeze(workerInputs);',
      comment,
      '  return inputs;',
      '})()`;',
    );

  const OFFENDING = '  // bindings.values arrive as workerInputs. They remain immutable through `inputs`, while this';

  it('catches the exact pre-fix run-script.ts line — the permanent known-bad control', () => {
    const hit = findSqlCommentBacktick('run-script.ts', workerSrc(OFFENDING));
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(3);
    expect(hit!.host).toBe('template');
    expect(hit!.backticks).toBe(2);
    expect(hit!.text).toContain('immutable through');
  });

  it('still catches it even though the file DOES NOT PARSE — the mis-parse hides the backtick, not the line', () => {
    // This is the objection the module header raises against an AST walk, and it is
    // real: by the time there are nodes, the stray backtick has been consumed as the
    // template's TERMINATOR. We never ask "is the backtick inside a template". We ask
    // whether the LINE BEGINS inside one — and the template closes PART-WAY THROUGH
    // that line, so the answer survives. Assert both halves, so a future reader sees
    // the distinction rather than assuming the header was ignored.
    const text = workerSrc(OFFENDING);
    expect(parseErrors('run-script.ts', text)).toBeGreaterThan(0); // it really is broken
    expect(findSqlCommentBacktick('run-script.ts', text)).not.toBeNull(); // and we still see it
  });

  it('reports the column of the FIRST backtick — the one that ends the template', () => {
    const hit = findSqlCommentBacktick('run-script.ts', workerSrc(OFFENDING));
    expect(hit!.col).toBe(OFFENDING.indexOf('`') + 1);
  });

  it('does NOT flag the SAME comment in ordinary code, outside any template', () => {
    // The load-bearing false-positive control. Measured over the tracked tree, ~39% of
    // source files carry a `//` comment with a backticked pair; flagging those on the
    // commit path would quarantine a third of the repo.
    const text = src(
      'const inputs = Object.freeze(workerInputs);',
      OFFENDING,
      'export const worker = inputs;',
    );
    expect(findSqlCommentBacktick('ordinary.ts', text)).toBeNull();
  });

  it('does NOT flag a comment block sitting immediately BEFORE a template', () => {
    // node.pos includes LEADING TRIVIA, so a naive span read attributes the preceding
    // comment to the template. That one mistake was most of a 123-hit measurement.
    const text = src(
      '// The worker source below is built from `inputs` and `bindings`.',
      '// It is passed to `new Worker()` verbatim.',
      'const WORKER_SRC = `(() => {',
      '  return 1;',
      '})()`;',
    );
    expect(parseErrors('before.ts', text)).toBe(0); // the fixture itself is healthy
    expect(findSqlCommentBacktick('before.ts', text)).toBeNull();
  });

  it('does NOT flag markdown prose inside a template — a template has no JSDoc block', () => {
    // `**Signal:** ${evidence}` (scout/rubric-rail.ts) was the single remaining hit over
    // the whole tracked tree while `*`-continuation lines were treated as comments.
    const text = src(
      'export const body = `',
      '  **Signal:** ${evidence} and `drill-back` follows',
      '`;',
    );
    expect(findSqlCommentBacktick('rubric-rail.ts', text)).toBeNull();
  });

  it('does NOT flag ESCAPED backticks inside a template comment — they never end it', () => {
    const text = workerSrc('  // They remain immutable through \\`inputs\\`, while this');
    expect(parseErrors('run-script.ts', text)).toBe(0);
    expect(findSqlCommentBacktick('run-script.ts', text)).toBeNull();
  });

  it('does NOT flag a single backtick — the >=2 rule holds for this host too', () => {
    const text = workerSrc('  // the backtick of `inputs here is lone and unbalanced');
    expect(findSqlCommentBacktick('run-script.ts', text)).toBeNull();
  });

  it('the SQL host wins a tie — it is the only one of the two that can fail SILENTLY', () => {
    const text = src(
      'const WORKER_SRC = `(() => {',
      '  // generated js talking about `inputs` and `bindings`',
      '})()`;',
      'const r = await sql`',
      '  SELECT 1',
      '  -- the `closed_ts` column',
      '`;',
    );
    expect(findSqlCommentBacktick('both.ts', text)!.host).toBe('sql');
  });
});

describe('autoFixSqlCommentBacktick — the repair differs by host', () => {
  const OFFENDING = '  // They remain immutable through `inputs`, while this';
  const workerSrc = src('const WORKER_SRC = `(() => {', OFFENDING, '})()`;');

  it('ESCAPES for the template host, and the result parses', () => {
    const { fixed, changed } = autoFixSqlCommentBacktick(workerSrc, 'run-script.ts');
    expect(changed).toBe(true);
    expect(fixed).toContain('\\`inputs\\`');
    expect(fixed).not.toContain('"inputs"'); // NOT the SQL repair
    expect(parseErrors('run-script.ts', fixed)).toBe(0);
    expect(findSqlCommentBacktick('run-script.ts', fixed)).toBeNull();
  });

  it('is idempotent — a second pass changes nothing', () => {
    const { fixed } = autoFixSqlCommentBacktick(workerSrc, 'run-script.ts');
    expect(autoFixSqlCommentBacktick(fixed, 'run-script.ts').changed).toBe(false);
  });

  it('still REQUOTES for the sql host — a double quote inside a SQL comment is inert', () => {
    const text = src('const r = await sql`', '  SELECT 1', '  -- the `closed_ts` column', '`;');
    const { fixed, changed } = autoFixSqlCommentBacktick(text, 'lww.ts');
    expect(changed).toBe(true);
    expect(fixed).toContain('"closed_ts"');
  });
});
