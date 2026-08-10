/**
 * Rig column-drift detector (EI-20099366410545026).
 *
 * `composition-rig.ts`'s `setupCellSchema` hand-rolls a "minimal-but-faithful"
 * slice of several `harness_shared` tables. Every time a migration adds a
 * column AND some code path the rig exercises starts reading/writing it, the
 * rig 42703s ("column X does not exist") deep inside an integration test.
 *
 * That has now recurred at least seven times (EI-10579, EI-18820653360383242,
 * WI-37711, EI-20094613443189011 and its authority/closed_ts follow-up, then
 * op_status/items and lane on 2026-08-10). The existing guards
 * (`composition-rig-schema-drift.integration.test.ts`,
 * `composition-rig-issue-schema-drift.test.ts`) check the OPPOSITE direction --
 * "the rig assumes a column the REAL schema lacks" -- so they are structurally
 * blind to this one, as composition-rig.ts's own inline comment says.
 *
 * The expensive part is not the fix (one ALTER); it is that the drift is
 * LAYERED. Postgres reports ONE missing column per query, so each fix reveals
 * the next one a whole integration-test cycle later (~3.5 min each). On
 * 2026-08-10 a single session peeled three layers this way. This module reports
 * EVERY missing column across every checked table in one pass, from source
 * text alone -- no database, no rig boot.
 *
 * Two shapes of requirement are extracted, because the drift has arrived as
 * both:
 *   - WRITE: `INSERT INTO harness_shared.<table> (a, b, c)` column lists.
 *   - READ:  an alias bound to the table (`FROM harness_shared.<table> p`)
 *            followed by `p.<column>` references.
 *
 * Everything here is pure string->data so the guard's own falsifiability can be
 * proven against fixtures instead of by mutating the shared tree (which
 * git-sync would happily commit mid-probe).
 */

/** Identifiers that can follow a table name but are NOT an alias. */
const NOT_AN_ALIAS = new Set([
  'set',
  'where',
  'values',
  'on',
  'using',
  'group',
  'order',
  'limit',
  'offset',
  'returning',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'full',
  'natural',
  'lateral',
  'when',
  'and',
  'or',
  'select',
  'insert',
  'update',
  'delete',
  'from',
  'as',
  'do',
  'nothing',
  'conflict',
  'having',
  'union',
  'with',
  'add',
  'drop',
  'alter',
  'rename',
  'default',
  'is',
  'not',
  'null',
]);

/** Strip `--` line comments so commented-out SQL never counts as a requirement. */
export function stripSqlComments(source: string): string {
  return source.replace(/--[^\n]*/g, '');
}

/**
 * Every column name DECLARED for `harness_shared.<table>` across `sources` --
 * from `CREATE TABLE` blocks and from `ALTER TABLE ... ADD COLUMN` blocks.
 * Scoped to the named table so a sibling table's ALTERs never leak in.
 */
export function extractDeclaredColumns(rawSources: string[], table: string): Set<string> {
  const columns = new Set<string>();
  const t = table.replace(/[^a-z0-9_]/gi, '');
  for (const raw of rawSources) {
    const src = stripSqlComments(raw);

    // CREATE TABLE [IF NOT EXISTS] harness_shared.<t> ( ... );
    const createRe = new RegExp(
      `CREATE TABLE (?:IF NOT EXISTS )?harness_shared\\.${t}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`,
      'gi',
    );
    let cm: RegExpExecArray | null;
    while ((cm = createRe.exec(src)) !== null) {
      for (const rawLine of cm[1].split('\n')) {
        const line = rawLine.trim();
        if (!line || /^(PRIMARY KEY|CONSTRAINT|CHECK|UNIQUE|FOREIGN KEY|EXCLUDE)\b/i.test(line)) {
          continue;
        }
        const col = line.match(/^"?([a-z_][a-z0-9_]*)"?\s+\S/i);
        if (col) columns.add(col[1].toLowerCase());
      }
    }

    // ALTER TABLE harness_shared.<t> ... ADD COLUMN [IF NOT EXISTS] <name>
    const alterRe = new RegExp(`ALTER TABLE (?:ONLY )?harness_shared\\.${t}\\b([\\s\\S]*?);`, 'gi');
    let am: RegExpExecArray | null;
    while ((am = alterRe.exec(src)) !== null) {
      const addRe = /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
      let addM: RegExpExecArray | null;
      while ((addM = addRe.exec(am[1])) !== null) columns.add(addM[1].toLowerCase());
    }
  }
  return columns;
}

/** A column some code path requires on a table, with the evidence that says so. */
export interface RequiredColumn {
  column: string;
  /** 'insert' = named in an INSERT column list; 'read' = referenced as <alias>.<column>. */
  via: 'insert' | 'read';
  /** The alias that bound the table, for 'read' requirements. */
  alias?: string;
}

/**
 * Columns that `sqlLiterals` require on `harness_shared.<table>`.
 *
 * Alias bindings are resolved PER LITERAL (one SQL statement), so an alias
 * meaning `p` = harness_plans in one query cannot leak into another query where
 * `p` means something else.
 */
export function extractRequiredColumns(sqlLiterals: string[], table: string): RequiredColumn[] {
  const t = table.replace(/[^a-z0-9_]/gi, '');
  const found = new Map<string, RequiredColumn>();

  for (const rawLiteral of sqlLiterals) {
    const sql = stripSqlComments(rawLiteral);

    // --- WRITE: INSERT INTO harness_shared.<t> ( ... )
    const insertRe = new RegExp(`INSERT INTO\\s+harness_shared\\.${t}\\s*\\(([^)]*)\\)`, 'gi');
    let im: RegExpExecArray | null;
    while ((im = insertRe.exec(sql)) !== null) {
      for (const piece of im[1].split(',')) {
        const col = piece.trim().replace(/^"|"$/g, '').toLowerCase();
        if (/^[a-z_][a-z0-9_]*$/.test(col)) {
          found.set(`insert:${col}`, { column: col, via: 'insert' });
        }
      }
    }

    // --- READ: bind aliases for this table within THIS literal, then collect
    //     every <alias>.<column> reference.
    const aliases = new Set<string>();
    const bindRe = new RegExp(`harness_shared\\.${t}\\s+(?:AS\\s+)?([a-z][a-z0-9_]*)`, 'gi');
    let bm: RegExpExecArray | null;
    while ((bm = bindRe.exec(sql)) !== null) {
      const alias = bm[1].toLowerCase();
      if (!NOT_AN_ALIAS.has(alias)) aliases.add(alias);
    }
    for (const alias of aliases) {
      const refRe = new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'gi');
      let rm: RegExpExecArray | null;
      while ((rm = refRe.exec(sql)) !== null) {
        const col = rm[1].toLowerCase();
        found.set(`read:${col}`, { column: col, via: 'read', alias });
      }
    }
  }

  return [...found.values()].sort((a, b) => a.column.localeCompare(b.column));
}

/**
 * Extract the text of every template literal in a TypeScript source that looks
 * like SQL. Deliberately text-based (no TS parse): the rig's own guards do the
 * same, and a parse failure here would silently return nothing.
 */
export function extractSqlLiterals(tsSource: string): string[] {
  const literals: string[] = [];
  const re = /`([^`]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tsSource)) !== null) {
    const body = m[1];
    if (/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/i.test(body) && /harness_shared\./.test(body)) {
      literals.push(body);
    }
  }
  return literals;
}

export interface MissingColumn extends RequiredColumn {
  table: string;
}

/**
 * The whole guard: for each (table, code sources) pair, every column the code
 * requires that the rig's hand-rolled schema does not declare.
 *
 * `declaredAs` lets a table be declared in the rig under other names -- the rig
 * mirrors migration 374 by RENAMEing harness_features_consolidated to
 * work_items, so columns declared on the pre-rename name are present on the
 * post-rename table.
 */
export function findMissingColumns(opts: {
  rigSources: string[];
  checks: { table: string; codeSources: string[]; declaredAs?: string[] }[];
}): MissingColumn[] {
  const missing: MissingColumn[] = [];
  for (const check of opts.checks) {
    const names = check.declaredAs?.length ? check.declaredAs : [check.table];
    const declared = new Set<string>();
    for (const name of names) {
      for (const col of extractDeclaredColumns(opts.rigSources, name)) declared.add(col);
    }
    const literals = check.codeSources.flatMap((s) => extractSqlLiterals(s));
    for (const req of extractRequiredColumns(literals, check.table)) {
      if (!declared.has(req.column)) missing.push({ ...req, table: check.table });
    }
  }
  return missing;
}
