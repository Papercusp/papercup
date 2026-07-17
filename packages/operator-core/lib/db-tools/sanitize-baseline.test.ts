import { describe, it, expect } from 'vitest';
import {
  splitStatements,
  transformStatement,
  sanitizeBaselineVerbose,
  stripTopLevelNotNull,
  parseCreateTable,
} from './sanitize-baseline';

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

  it('does not double up IF NOT EXISTS when it is already present', () => {
    // The CREATE itself is passed through verbatim; a per-column ADD COLUMN
    // repair pass is appended (WI-5216 — see the column-drift describe below).
    const s = 'CREATE TABLE IF NOT EXISTS harness_shared.t (id int)';
    const out = transformStatement(s)!;
    expect(out.startsWith(s)).toBe(true);
    expect(out).not.toMatch(/IF NOT EXISTS\s+IF NOT EXISTS/i);
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
    // Table-to-view migrations make baseline table constraints re-apply against a view.
    expect(out).toContain('WHEN wrong_object_type THEN NULL');
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

// ---------------------------------------------------------------------------
// COLUMN DRIFT (WI-5216) — the baseline's headline promise: re-applying against
// an ALREADY-POPULATED DB whose tables carry an OLDER shape must CONVERGE them,
// not silently skip and then explode on the first index that wants the missing
// column. These tests encode the live failure that killed the desktop Server's
// operator for ~7h.
// ---------------------------------------------------------------------------
describe('column drift repair — CREATE TABLE emits per-column ADD COLUMN IF NOT EXISTS', () => {
  /** The REAL adv_sessions shape from 000-baseline.sql that reproduced WI-5216. */
  const ADV_SESSIONS = `CREATE TABLE harness_shared.adv_sessions (
    id bigint NOT NULL,
    workspace_id text NOT NULL,
    mode text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    coord_owner_id text,
    CONSTRAINT adv_sessions_mode_check CHECK ((mode = ANY (ARRAY['omp'::text, 'console'::text])))
)`;

  it('THE WI-5216 REGRESSION: adds the column an older table is missing, so the index that follows resolves', () => {
    const out = transformStatement(ADV_SESSIONS)!;
    // This exact statement is what a drifted DB needs and never got — the
    // column exists ONLY in the baseline; no migration in sql/ adds it.
    expect(out).toContain('ALTER TABLE harness_shared.adv_sessions ADD COLUMN IF NOT EXISTS coord_owner_id text');
    // …and it must still create the table on a fresh DB.
    expect(out).toContain('CREATE TABLE IF NOT EXISTS harness_shared.adv_sessions');
  });

  it('emits one ADD COLUMN per column and never for a table constraint', () => {
    const out = transformStatement(ADV_SESSIONS)!;
    const added = [...out.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(added).toEqual(['id', 'workspace_id', 'mode', 'started_at', 'ended_at', 'coord_owner_id']);
    expect(out).not.toMatch(/ADD COLUMN IF NOT EXISTS adv_sessions_mode_check/);
    expect(out).not.toMatch(/ADD COLUMN IF NOT EXISTS CONSTRAINT/i);
  });

  it('strips NOT NULL from the repair (an un-defaulted NOT NULL add is a hard error on a populated table) but keeps it on the CREATE', () => {
    const out = transformStatement(ADV_SESSIONS)!;
    // The CREATE TABLE keeps the real constraint…
    expect(out).toMatch(/CREATE TABLE IF NOT EXISTS[\s\S]*workspace_id text NOT NULL/);
    // …while the repair adds it nullable rather than failing the boot.
    expect(out).toContain('ADD COLUMN IF NOT EXISTS workspace_id text;');
    const addLines = out.split('\n').filter((l) => l.includes('ADD COLUMN'));
    expect(addLines.every((l) => !/NOT NULL/i.test(l))).toBe(true);
  });

  it('preserves DEFAULT so a defaulted column lands fully-formed', () => {
    const out = transformStatement(ADV_SESSIONS)!;
    expect(out).toContain('ADD COLUMN IF NOT EXISTS started_at timestamp with time zone DEFAULT now();');
  });

  it('keeps commas inside types and CHECK expressions out of the column split', () => {
    const t = `CREATE TABLE s.t (
    amount numeric(10,2),
    kind text,
    CONSTRAINT k CHECK ((kind = ANY (ARRAY['a'::text, 'b'::text])))
)`;
    const added = [...transformStatement(t)!.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(added).toEqual(['amount', 'kind']);
    expect(transformStatement(t)!).toContain('ADD COLUMN IF NOT EXISTS amount numeric(10,2)');
  });

  it('does not strip a NOT NULL nested inside an inline CHECK expression', () => {
    expect(stripTopLevelNotNull("text CHECK (x IS NOT NULL) NOT NULL")).toBe('text CHECK (x IS NOT NULL)');
  });

  it('leaves an IF-NOT-EXISTS CREATE TABLE alone but still backfills it', () => {
    const out = transformStatement('CREATE TABLE IF NOT EXISTS s.t (a int, b text)')!;
    expect(out).not.toMatch(/IF NOT EXISTS\s+IF NOT EXISTS/i);
    expect(out).toContain('ADD COLUMN IF NOT EXISTS a int');
    expect(out).toContain('ADD COLUMN IF NOT EXISTS b text');
  });

  it('every column of every table in a whole dump gets a repair statement', () => {
    const dump = [
      'CREATE TABLE harness_shared.a (id bigint NOT NULL, name text);',
      'CREATE TABLE harness_shared.b (id bigint NOT NULL, ts timestamp with time zone DEFAULT now());',
      'CREATE INDEX b_ts_idx ON harness_shared.b USING btree (ts);',
    ].join('\n');
    const { sql } = sanitizeBaselineVerbose(dump);
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS ([\w."]+)/g)].map((m) => m[1]);
    expect(tables).toEqual(['harness_shared.a', 'harness_shared.b']);
    for (const t of tables) {
      expect(sql).toContain(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS`);
    }
    // The repair must precede the index that depends on the drifted column —
    // that ordering IS the WI-5216 fix.
    expect(sql.indexOf('ADD COLUMN IF NOT EXISTS ts')).toBeLessThan(sql.indexOf('CREATE INDEX IF NOT EXISTS b_ts_idx'));
  });

  it('parseCreateTable returns null for a shape with no plain column list', () => {
    expect(parseCreateTable('CREATE TABLE s.t_2026 PARTITION OF s.t FOR VALUES FROM (1) TO (2)')).toBeNull();
  });
});
