import { describe, it, expect } from 'vitest';
import { normalizeMigrationSql, executableSqlEquivalent } from './migration-sql-normalize';

/** Convenience: assert two texts are executable-equivalent (or not). */
function equivalent(a: string, b: string): boolean {
  const r = executableSqlEquivalent(a, b);
  if (!r.ok) throw new Error(`expected a lexable pair, got failure: ${r.reason}`);
  return r.equivalent;
}

function normalized(sql: string): string {
  const r = normalizeMigrationSql(sql);
  if (!r.ok) throw new Error(`expected ok, got failure: ${r.reason}`);
  return r.normalized;
}

/**
 * EI-19408574209859155: the detector must tell a provably-benign comment-only
 * edit apart from a real half-landed migration. These are the two verdicts the
 * whole thing exists to separate.
 */
describe('normalizeMigrationSql — the core verdict', () => {
  it('a comment-only edit is executable-equivalent', () => {
    const applied = `ALTER TABLE t ADD COLUMN c int;\n`;
    const edited = `-- FORWARD-COMPAT: this cannot break the deployed release.\nALTER TABLE t ADD COLUMN c int;\n`;
    expect(equivalent(applied, edited)).toBe(true);
  });

  it('an added DDL statement is NOT equivalent — the mig-708 half-landed hazard', () => {
    const applied = `ALTER TABLE t ADD COLUMN a int;\n`;
    const edited = `ALTER TABLE t ADD COLUMN a int;\nALTER TABLE t ADD COLUMN closed_ts timestamptz;\n`;
    expect(equivalent(applied, edited)).toBe(false);
  });

  it('a whitespace-only reformat is equivalent', () => {
    expect(equivalent(`ALTER TABLE t\n  ADD COLUMN c int;`, `ALTER TABLE t ADD COLUMN c int;`)).toBe(true);
  });

  it('a trailing-newline-only difference is equivalent', () => {
    expect(equivalent(`SELECT 1;`, `SELECT 1;\n\n`)).toBe(true);
  });

  it('block comments are stripped, including nested ones', () => {
    expect(equivalent(`/* a /* nested */ b */ SELECT 1;`, `SELECT 1;`)).toBe(true);
  });

  it('a changed identifier is NOT equivalent', () => {
    expect(equivalent(`ALTER TABLE t ADD COLUMN a int;`, `ALTER TABLE t ADD COLUMN b int;`)).toBe(false);
  });

  it('a case change is NOT treated as benign (executable-equivalent, but still a real edit)', () => {
    expect(equivalent(`select 1;`, `SELECT 1;`)).toBe(false);
  });
});

/**
 * The reason `stripSqlBodies()` from scripts/lint-migrations.mjs could not be
 * reused: it BLANKS string literals. Here a change inside a literal is an
 * executable change, so literals are preserved byte-for-byte.
 */
describe('normalizeMigrationSql — string literals are preserved, never blanked', () => {
  it('a change INSIDE a string literal is NOT equivalent', () => {
    expect(equivalent(`INSERT INTO t VALUES ('alpha');`, `INSERT INTO t VALUES ('beta');`)).toBe(false);
  });

  it('a `--` inside a string literal is data, not a comment, and is preserved', () => {
    expect(normalized(`SELECT '-- not a comment';`)).toBe(`SELECT '-- not a comment';`);
    // ...and changing that data is therefore still a real difference.
    expect(equivalent(`SELECT '-- a';`, `SELECT '-- b';`)).toBe(false);
  });

  it('a `/*` inside a string literal does not open a comment', () => {
    expect(normalized(`SELECT '/* not a comment';`)).toBe(`SELECT '/* not a comment';`);
  });

  it('doubled quotes inside a literal do not terminate it', () => {
    expect(normalized(`SELECT 'it''s -- fine';`)).toBe(`SELECT 'it''s -- fine';`);
  });

  it("whitespace inside a string literal is preserved, not collapsed", () => {
    expect(equivalent(`SELECT 'a    b';`, `SELECT 'a b';`)).toBe(false);
  });

  it("E'' escape strings: a backslash-escaped quote does not terminate the literal", () => {
    expect(normalized(`SELECT E'a\\'b -- c';`)).toBe(`SELECT E'a\\'b -- c';`);
  });

  it('quoted identifiers are preserved verbatim', () => {
    expect(normalized(`SELECT "weird -- name" FROM t;`)).toBe(`SELECT "weird -- name" FROM t;`);
  });
});

/**
 * The case that motivated the work: 727's `-- FORWARD-COMPAT:` comment sits
 * INSIDE a `DO $$ ... $$` block, so a normalizer treating every dollar body as
 * opaque would still report it as drift — i.e. would not fix the motivating
 * case at all.
 */
describe('normalizeMigrationSql — dollar-quoted bodies', () => {
  it('strips comments inside a DO $$ ... $$ code body (the 727 shape)', () => {
    const applied = `DO $$\nBEGIN\n  EXECUTE 'ALTER TABLE t ALTER COLUMN v TYPE vector(768)';\nEND $$;`;
    const edited = `DO $$\nBEGIN\n  -- FORWARD-COMPAT: this DROP INDEX cannot break the deployed release.\n  -- Each index is rebuilt in the SAME transaction.\n  EXECUTE 'ALTER TABLE t ALTER COLUMN v TYPE vector(768)';\nEND $$;`;
    expect(equivalent(applied, edited)).toBe(true);
  });

  it('still catches a real code change inside a DO $$ body', () => {
    const applied = `DO $$ BEGIN EXECUTE 'ALTER TABLE t ADD COLUMN a int'; END $$;`;
    const edited = `DO $$ BEGIN EXECUTE 'ALTER TABLE t ADD COLUMN b int'; END $$;`;
    expect(equivalent(applied, edited)).toBe(false);
  });

  it('strips comments inside a function body introduced by AS $$', () => {
    const applied = `CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;`;
    const edited = `CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN -- why\n RETURN 1; END $$;`;
    expect(equivalent(applied, edited)).toBe(true);
  });

  it('handles a named tag ($func$) the same way', () => {
    expect(
      equivalent(
        `CREATE FUNCTION f() RETURNS int AS $func$ BEGIN RETURN 1; END $func$;`,
        `CREATE FUNCTION f() RETURNS int AS $func$ BEGIN RETURN 1; -- note\n END $func$;`,
      ),
    ).toBe(true);
  });

  it('SAFETY: a dollar body used as DATA stays opaque — a `--` in it is not stripped', () => {
    // Preceding token is `(`, not DO/AS, so this is a data literal. Stripping a
    // `--` here would be stripping real data — the over-strip that fails toward
    // silence, which is the one direction that must never happen.
    const a = `INSERT INTO t VALUES ($$keep -- this$$);`;
    const b = `INSERT INTO t VALUES ($$keep$$);`;
    expect(equivalent(a, b)).toBe(false);
    expect(normalized(a)).toBe(`INSERT INTO t VALUES ($$keep -- this$$);`);
  });

  it('a `$1` positional parameter is not mistaken for a dollar-quote opener', () => {
    expect(normalized(`SELECT $1, $2;`)).toBe(`SELECT $1, $2;`);
  });
});

/**
 * Anything that cannot be lexed with confidence returns a DEFINITE failure, so
 * the caller reports drift rather than guessing. A failure must never be
 * mistakable for "no difference".
 */
describe('normalizeMigrationSql — fails definitely rather than guessing', () => {
  it('an unterminated string literal fails', () => {
    const r = normalizeMigrationSql(`SELECT 'oops;`);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/unterminated string literal/);
  });

  it('an unterminated block comment fails', () => {
    const r = normalizeMigrationSql(`SELECT 1; /* never closed`);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/unterminated block comment/);
  });

  it('an unterminated dollar-quote fails', () => {
    const r = normalizeMigrationSql(`DO $$ BEGIN RETURN; END`);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/unterminated dollar-quoted string/);
  });

  it('an unterminated quoted identifier fails', () => {
    const r = normalizeMigrationSql(`SELECT "oops FROM t;`);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/unterminated quoted identifier/);
  });

  it('executableSqlEquivalent propagates a failure instead of returning a verdict', () => {
    const r = executableSqlEquivalent(`SELECT 'oops;`, `SELECT 1;`);
    expect(r.ok).toBe(false);
    // Critically: there is no `equivalent` field to misread as `false`/`true`.
    expect((r as { equivalent?: boolean }).equivalent).toBeUndefined();
  });
});

describe('normalizeMigrationSql — tokens must not merge across a stripped comment', () => {
  it('a line comment between two tokens leaves a separator', () => {
    // Without the separator this would normalize to `SELECTa`, silently
    // equating two different statements.
    expect(normalized(`SELECT--c\na;`)).toBe(`SELECT a;`);
    expect(equivalent(`SELECT--c\na;`, `SELECTa;`)).toBe(false);
  });

  it('a block comment between two tokens leaves a separator', () => {
    expect(normalized(`SELECT/*c*/a;`)).toBe(`SELECT a;`);
  });

  it('collapses runs of whitespace to a single space and trims the ends', () => {
    expect(normalized(`\n\n  SELECT    1 ;  \n`)).toBe(`SELECT 1 ;`);
  });
});
