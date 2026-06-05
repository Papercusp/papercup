import { describe, it, expect } from 'vitest';
import { splitStatements, transformStatement, sanitizeBaselineVerbose } from './sanitize-baseline';

describe('splitStatements', () => {
  it('splits simple statements on top-level semicolons', () => {
    expect(splitStatements('CREATE TABLE a (id int); CREATE TABLE b (id int);')).toEqual([
      'CREATE TABLE a (id int)',
      'CREATE TABLE b (id int)',
    ]);
  });

  it('ignores semicolons inside single-quoted strings', () => {
    const sql = "INSERT INTO t VALUES ('a; b'); SELECT 1;";
    expect(splitStatements(sql)).toEqual(["INSERT INTO t VALUES ('a; b')", 'SELECT 1']);
  });

  it('handles escaped single quotes inside strings', () => {
    const sql = "SELECT 'it''s; fine'; SELECT 2;";
    expect(splitStatements(sql)).toEqual(["SELECT 'it''s; fine'", 'SELECT 2']);
  });

  it('ignores semicolons inside dollar-quoted bodies ($$, $_$, $q$)', () => {
    const fn = 'CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN; RETURN NEW; END; $$';
    expect(splitStatements(`${fn};\nSELECT 1;`)).toEqual([fn, 'SELECT 1']);
    const tagged = 'CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $_$ SELECT 1; $_$';
    expect(splitStatements(`${tagged};`)).toEqual([tagged]);
  });

  it('keeps line comments and ignores semicolons within them', () => {
    const sql = 'CREATE TABLE a (id int); -- a; b; c\nCREATE TABLE b (id int);';
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[1]).toContain('-- a; b; c');
  });
});

describe('transformStatement — idempotency rewrites', () => {
  it('drops SET and set_config / setval noise', () => {
    expect(transformStatement('SET search_path = pg_catalog')).toBeNull();
    expect(transformStatement("SELECT pg_catalog.set_config('search_path', '', false)")).toBeNull();
    expect(transformStatement("SELECT pg_catalog.setval('s', 5, true)")).toBeNull();
  });

  it('adds IF NOT EXISTS to CREATE TABLE/SCHEMA/SEQUENCE/INDEX', () => {
    expect(transformStatement('CREATE TABLE harness_shared.t (id int)')).toMatch(
      /^CREATE TABLE IF NOT EXISTS harness_shared\.t/,
    );
    expect(transformStatement('CREATE SCHEMA harness_shared')).toBe('CREATE SCHEMA IF NOT EXISTS harness_shared');
    expect(transformStatement('CREATE SEQUENCE harness_shared.s')).toMatch(/^CREATE SEQUENCE IF NOT EXISTS/);
    expect(transformStatement('CREATE INDEX i ON harness_shared.t (id)')).toMatch(/^CREATE INDEX IF NOT EXISTS i/);
    expect(transformStatement('CREATE UNIQUE INDEX u ON harness_shared.t (id)')).toMatch(
      /^CREATE UNIQUE INDEX IF NOT EXISTS u/,
    );
  });

  it('is a no-op when IF NOT EXISTS is already present', () => {
    const s = 'CREATE TABLE IF NOT EXISTS harness_shared.t (id int)';
    expect(transformStatement(s)).toBe(s);
  });

  it('converts CREATE FUNCTION/TRIGGER to OR REPLACE', () => {
    expect(transformStatement('CREATE FUNCTION f() RETURNS trigger AS $$x$$')).toMatch(
      /^CREATE OR REPLACE FUNCTION f\(\)/,
    );
    expect(transformStatement('CREATE TRIGGER trg AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()')).toMatch(
      /^CREATE OR REPLACE TRIGGER trg/,
    );
  });

  it('prefixes CREATE POLICY with DROP POLICY IF EXISTS (name + table)', () => {
    const out = transformStatement(
      "CREATE POLICY iso ON harness_shared.adv_sessions USING ((workspace_id = current_setting('app.workspace_id'::text, true)))",
    );
    expect(out).toContain('DROP POLICY IF EXISTS iso ON harness_shared.adv_sessions;');
    expect(out).toContain('CREATE POLICY iso ON harness_shared.adv_sessions');
  });

  it('wraps ADD CONSTRAINT in a duplicate-tolerant DO block', () => {
    const out = transformStatement(
      'ALTER TABLE ONLY harness_shared.t\n    ADD CONSTRAINT t_pkey PRIMARY KEY (id)',
    );
    expect(out).toMatch(/^DO \$baseline_guard\$ BEGIN/);
    expect(out).toContain('ADD CONSTRAINT t_pkey PRIMARY KEY (id);');
    expect(out).toContain('WHEN duplicate_object THEN NULL');
    // PK re-add raises 42P16, not duplicate_object — must be tolerated too
    expect(out).toContain('WHEN invalid_table_definition THEN NULL');
    expect(out).toMatch(/END \$baseline_guard\$$/);
  });

  it('keeps idempotent ALTERs untouched (RLS enable, SET DEFAULT, sequence OWNED BY, COMMENT)', () => {
    const rls = 'ALTER TABLE harness_shared.t ENABLE ROW LEVEL SECURITY';
    const def = "ALTER TABLE ONLY harness_shared.t ALTER COLUMN id SET DEFAULT nextval('harness_shared.s'::regclass)";
    const seq = 'ALTER SEQUENCE harness_shared.s OWNED BY harness_shared.t.id';
    const com = "COMMENT ON TABLE harness_shared.t IS 'hi'";
    const repl = 'ALTER TABLE ONLY harness_shared.t REPLICA IDENTITY FULL';
    expect(transformStatement(rls)).toBe(rls);
    expect(transformStatement(def)).toBe(def);
    expect(transformStatement(seq)).toBe(seq);
    expect(transformStatement(com)).toBe(com);
    expect(transformStatement(repl)).toBe(repl);
  });

  it('strips leading comment lines to classify the real statement', () => {
    const s = '--\n-- Name: t; Type: TABLE\n--\nCREATE TABLE harness_shared.t (id int)';
    expect(transformStatement(s)).toMatch(/CREATE TABLE IF NOT EXISTS harness_shared\.t/);
  });

  it('converts CREATE VIEW to OR REPLACE', () => {
    expect(transformStatement('CREATE VIEW harness_shared.v AS SELECT 1')).toMatch(
      /^CREATE OR REPLACE VIEW harness_shared\.v/,
    );
  });

  it('drops psql backslash metacommands (PG18 \\restrict/\\unrestrict)', () => {
    expect(transformStatement('\\restrict abc123')).toBeNull();
    expect(transformStatement('\\unrestrict abc123')).toBeNull();
  });

  it('flags unknown shapes via onUnknown but keeps them', () => {
    const seen: string[] = [];
    const out = transformStatement('GRANT SELECT ON t TO x', (tok) => seen.push(tok));
    expect(out).toBe('GRANT SELECT ON t TO x');
    expect(seen).toEqual(['GRANT SELECT']);
  });
});

describe('sanitizeBaselineVerbose — whole-dump invariants', () => {
  const RAW = [
    '\\restrict SomeOpaqueKey1234',
    "SET statement_timeout = 0;",
    "SELECT pg_catalog.set_config('search_path', '', false);",
    '',
    '--',
    '-- Name: harness_shared; Type: SCHEMA',
    '--',
    'CREATE SCHEMA harness_shared;',
    '',
    'CREATE FUNCTION harness_shared.f() RETURNS trigger',
    '    LANGUAGE plpgsql',
    '    AS $$ BEGIN; RETURN NEW; END; $$;',
    '',
    'CREATE TABLE harness_shared.t (',
    '    id integer NOT NULL,',
    "    note text DEFAULT 'a; b'",
    ');',
    '',
    'CREATE SEQUENCE harness_shared.t_id_seq;',
    'ALTER SEQUENCE harness_shared.t_id_seq OWNED BY harness_shared.t.id;',
    "ALTER TABLE ONLY harness_shared.t ALTER COLUMN id SET DEFAULT nextval('harness_shared.t_id_seq'::regclass);",
    '',
    'CREATE INDEX t_note_idx ON harness_shared.t USING btree (note);',
    '',
    'ALTER TABLE ONLY harness_shared.t',
    '    ADD CONSTRAINT t_pkey PRIMARY KEY (id);',
    '',
    'ALTER TABLE harness_shared.t ENABLE ROW LEVEL SECURITY;',
    "CREATE POLICY t_iso ON harness_shared.t USING ((workspace_id = current_setting('app.workspace_id'::text, true)));",
    '',
    'CREATE TRIGGER t_trg AFTER INSERT ON harness_shared.t FOR EACH ROW EXECUTE FUNCTION harness_shared.f();',
    '',
    'CREATE VIEW harness_shared.v AS SELECT id FROM harness_shared.t;',
    '\\unrestrict SomeOpaqueKey1234',
  ].join('\n');

  it('rewrites every creator idempotently and drops session noise, with no unknown shapes', () => {
    const { sql, unknown } = sanitizeBaselineVerbose(RAW);
    expect(unknown).toEqual([]); // every statement matched a rule
    // session noise gone
    expect(sql).not.toMatch(/^SET /m);
    expect(sql).not.toContain('set_config');
    // creators guarded
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS harness_shared');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS harness_shared.t');
    expect(sql).toContain('CREATE SEQUENCE IF NOT EXISTS harness_shared.t_id_seq');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS t_note_idx');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION harness_shared.f()');
    expect(sql).toContain('CREATE OR REPLACE TRIGGER t_trg');
    expect(sql).toContain('CREATE OR REPLACE VIEW harness_shared.v');
    expect(sql).not.toMatch(/\\(un)?restrict/); // psql metacommands stripped
    expect(sql).toContain('DROP POLICY IF EXISTS t_iso ON harness_shared.t;');
    expect(sql).toMatch(/DO \$baseline_guard\$ BEGIN[\s\S]*ADD CONSTRAINT t_pkey/);
    // function body preserved intact (dollar-quote not split)
    expect(sql).toContain('AS $$ BEGIN; RETURN NEW; END; $$');
    // idempotent keepers preserved
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('OWNED BY harness_shared.t.id');
  });

  it('every CREATE TABLE/INDEX/SEQUENCE in the output carries IF NOT EXISTS', () => {
    const { sql } = sanitizeBaselineVerbose(RAW);
    const bareCreate = sql.match(/CREATE (TABLE|SEQUENCE|(?:UNIQUE )?INDEX) (?!IF NOT EXISTS)/g);
    expect(bareCreate).toBeNull();
  });
});
