#!/usr/bin/env node
/**
 * lint:migration-forward-compat
 *
 * A migration runs against the SHARED database immediately. The operator serving
 * :3070 runs from the RELEASE checkout, which lags staging by a full
 * commit -> green-checkpoint -> deploy cycle. So for the whole length of that
 * cycle the database is NEWER than the code querying it.
 *
 * That means destructive DDL is not "a schema change" -- it is a live change to
 * the contract that the CURRENTLY DEPLOYED binary is still relying on.
 *
 * WHY THIS EXISTS (EI-18797473716313783, 2026-07-27):
 *   migration 689-agent-facts-append-versioning.sql did, in ONE file:
 *     CREATE UNIQUE INDEX agent_facts_identity_current ... WHERE superseded_at IS NULL;
 *     DROP INDEX IF EXISTS harness_shared.agent_facts_identity;   <-- the arbiter
 *   The deployed release's facts:assert used
 *     ON CONFLICT (workspace_id, scope, coalesce(scope_ref,''), key, coalesce(source_hive,''))
 *   with no WHERE predicate. Postgres cannot infer a PARTIAL unique index unless the
 *   conflict target repeats the predicate, so once the old non-partial index was
 *   dropped there was no inferable arbiter at all and EVERY facts:assert call failed
 *   fleet-wide with:
 *     "there is no unique or exclusion constraint matching the ON CONFLICT specification"
 *   The migration applied at 08:37:31Z. The code fix was written ~2h41m LATER, and the
 *   outage was not noticed for ~3 HOURS -- during which the mandated durable-conclusion
 *   path for every looping agent was silently failing.
 *
 * THE DISCIPLINE (expand / contract):
 *   Split it across two migrations. EXPAND first (add the new index/column, ship and
 *   deploy the code that uses it), CONTRACT later (drop the old one, once no deployed
 *   release still references it). Never both in one file.
 *
 * If a destructive statement genuinely IS safe for the deployed release, say so in the
 * migration with an explicit acknowledgment line:
 *
 *   -- FORWARD-COMPAT: <why the currently-deployed release does not use this>
 *
 * That is deliberately a human sentence, not a flag: the point is to force the author
 * to check the release checkout before dropping something out from under it.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripCommentsOnly, stripSqlComments } from './lib/strip-comments-and-strings.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Repo-relative form of the scanned directory, EXPORTED so the repo-wide invariant
 * guard that routes this lint (MIGRATION_SQL_DIR in scripts/affected-tests.mjs) can be
 * asserted against the directory this lint actually reads, rather than a hand-copied
 * duplicate of it. Mirrors SCHEMA_FILE_REL in check-partial-index-alignment.mjs, and
 * exists for the same reason: if the two silently disagree the guard stops firing and
 * the run stays green while no longer checking anything. (WI-9573)
 */
export const SQL_DIR_REL = 'libs/papercusp/libs/db/sql';
const SQL_DIR = join(__dirname, '..', ...SQL_DIR_REL.split('/'));

/**
 * A migration is authored in a parked filename before it is armed. The runner
 * intentionally ignores these suffixes, but the authoring-time dependency guard
 * must not: this is the exact window in which code can start naming a column that
 * the shared database does not have yet.
 */
export const PARKED_SUFFIXES = ['.DRAFT', '.PENDING-CODE-DEPLOY'];

/**
 * Production source roots searched for references to columns added by parked
 * migrations. Keep this explicit: scanning generated output, docs, or dependency
 * trees would turn a cheap authoring guard into a noisy repository grep.
 *
 * Exported so the affected-tests router can mirror the exact domain and attach the
 * guard when either the parked migration OR a source consumer changes.
 */
export const SOURCE_ROOTS = [
  'apps',
  'packages',
  'libs/papercusp/packages',
  'libs/papercusp/libs/db/src',
];

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const SOURCE_SKIP_DIRS = new Set([
  '.git',
  '__snapshots__',
  '_retired',
  'build',
  'coverage',
  'dist',
  'dist-host',
  'node_modules',
  'public',
  'target',
]);

/**
 * Migrations are immutable once applied, so historical files can never be fixed.
 * Enforce from the first migration authored after this guard landed.
 */
export const ENFORCE_FROM = 693;

/**
 * The acknowledgment token, EXPORTED for the same reason SQL_DIR_REL is: the
 * authoring-time PostToolUse nudge
 * (apps/operator/scripts/hooks/cc/posttooluse-migration-forward-compat-nudge.mjs)
 * must apply THIS marker, not a hand-copied duplicate. A second copy that
 * silently disagreed would let the nudge stay quiet on a file the gate then
 * reds on — reintroducing the exact discover-it-hours-later cost the nudge
 * exists to remove.
 *
 * NOTE for anyone tempted to seed a placeholder ack into new migrations: this
 * matches ANY non-whitespace after the colon, so `-- FORWARD-COMPAT: TODO` and
 * `-- FORWARD-COMPAT: <why>` both SATISFY it. A seeded placeholder would
 * therefore rubber-stamp every migration and silence the guard permanently.
 * scripts/next-migration.mjs deliberately emits prose that does NOT match;
 * `forward-compat-authoring-nudge.test.ts` pins that.
 */
export const ACK_MARKER = /^[ \t]*--[ \t]*FORWARD-COMPAT:[ \t]*\S/im;

const RULES = [
  {
    id: 'drop-index',
    re: /\bDROP\s+INDEX\b/i,
    why: 'drops an index the deployed release may be relying on as an ON CONFLICT arbiter (this is exactly EI-18797473716313783)',
  },
  {
    id: 'drop-constraint',
    re: /\bDROP\s+CONSTRAINT\b/i,
    why: 'removes a constraint the deployed release may depend on for upsert/validation behavior',
  },
  {
    id: 'drop-column',
    re: /\bDROP\s+COLUMN\b/i,
    why: 'removes a column the deployed release almost certainly still SELECTs or INSERTs',
  },
  {
    id: 'drop-table',
    re: /\bDROP\s+TABLE\b/i,
    why: 'removes a relation the deployed release may still query',
  },
  {
    id: 'rename',
    re: /\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b/i,
    why: 'a rename is a drop plus an add as far as the deployed release is concerned',
  },
  {
    id: 'narrowing-unique-index',
    re: /\bCREATE\s+UNIQUE\s+INDEX\b[\s\S]*?\bWHERE\b/i,
    why: 'a PARTIAL unique index cannot serve an un-predicated ON CONFLICT -- deployed code that relied on a non-partial index of the same columns will fail to infer an arbiter',
  },
  {
    id: 'set-not-null',
    re: /\bALTER\s+COLUMN\b[\s\S]{0,120}?\bSET\s+NOT\s+NULL\b/i,
    why: 'the deployed release may still INSERT rows without this column',
  },
];

/**
 * Strip SQL comments so prose describing DDL is never mistaken for DDL.
 *
 * Uses the CANONICAL shared mask (EI-20073035509369492). The private regex pair this
 * replaced -- `/\*...*\/` then `--[^\n]*` -- was not quote-aware, which made this guard
 * fail at its own job in a way no test covered:
 *
 *   INSERT INTO t(note) VALUES ('see -- below'); ALTER TABLE t ALTER COLUMN c SET NOT NULL;
 *
 * The `--` there is INSIDE a string literal, so the naive regex erased the rest of the
 * line -- taking the real SET NOT NULL with it and reporting the file CLEAN. A guard whose
 * whole purpose is catching destructive DDL silently missed a destructive DDL. Pinned by a
 * falsifying control in the self-test below.
 *
 * ⚠ COMMENTS-ONLY, deliberately -- NOT `stripSqlCommentsAndStrings`. The RULES below match
 * DDL KEYWORDS, and the strings variant seals `$tag$` bodies wholesale, which would hide
 * REAL DDL inside a DO block (a false NEGATIVE on a forward-compat guard). The comments-only
 * mask recurses into those bodies instead: body CODE stays live, body COMMENTS get masked.
 * Both directions are pinned in the self-test.
 */
function stripComments(sql) {
  return stripSqlComments(sql);
}

/**
 * The single detection rule. EXPORTED so the authoring-time nudge reuses it
 * verbatim rather than re-implementing the regex set (see ACK_MARKER's note).
 * Returns the matched RULES entries ({ id, re, why }), empty when clean.
 */
/**
 * Split stripped SQL into individual statements.
 *
 * WHY THIS EXISTS (EI-20745458722827468): several rules use `[\s\S]*?` to span a clause
 * that may wrap lines — `narrowing-unique-index` looks for a WHERE after CREATE UNIQUE
 * INDEX. Tested against the WHOLE FILE that wildcard also spans STATEMENT BOUNDARIES, so
 * the rule fired whenever a unique index appeared anywhere before any WHERE anywhere
 * later — even a WHERE belonging to a different, non-unique index. That is not a partial
 * unique index; it is "a unique index exists, and the file mentions WHERE later", which
 * is a routine and entirely safe shape (an identity unique index plus a partial index for
 * a hot filtered read). Matching per statement makes each rule mean what it says.
 *
 * Splitting on `;` is safe here because comments (which may contain semicolons) are
 * already stripped, and a `$$`-quoted DO block is kept whole below.
 *
 * @param {string} code comment-stripped SQL
 * @returns {string[]}
 */
function splitStatements(code) {
  const statements = [];
  let current = '';
  let inDollarBlock = false;
  for (let i = 0; i < code.length; i += 1) {
    // A DO $$ ... $$ block legitimately contains semicolons; keep it intact so its
    // inner statements are still each seen as part of one enclosing statement rather
    // than being sliced mid-block.
    if (code.startsWith('$$', i)) {
      inDollarBlock = !inDollarBlock;
      current += '$$';
      i += 1;
      continue;
    }
    if (code[i] === ';' && !inDollarBlock) {
      statements.push(current);
      current = '';
      continue;
    }
    current += code[i];
  }
  if (current.trim()) statements.push(current);
  return statements;
}

export function violationsFor(sqlText) {
  const code = stripComments(sqlText);
  const statements = splitStatements(code);
  // A rule fires when ANY single statement violates it — never on a wildcard that
  // wandered across statements into an unrelated one.
  return RULES.filter((r) => statements.some((s) => r.re.test(s)));
}

/**
 * True when `file` is a migration this guard ENFORCES on — i.e. `NNN-*.sql`
 * with NNN >= ENFORCE_FROM. Exported so the nudge applies the same cutoff and
 * never nags about a historical migration that can no longer be edited.
 */
export function isEnforcedMigrationFile(file) {
  if (!file.endsWith('.sql')) return false;
  const dash = file.indexOf('-');
  if (dash <= 0) return false;
  const num = Number.parseInt(file.slice(0, dash), 10);
  return Number.isFinite(num) && num >= ENFORCE_FROM;
}

/**
 * True when a filename is an armed migration or a parked migration artifact.
 * The main lint uses this instead of `endsWith('.sql')` so a DRAFT can reach the
 * dependency check while destructive-DDL enforcement remains limited to armed SQL.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isMigrationArtifactFile(file) {
  return file.endsWith('.sql') || PARKED_SUFFIXES.some((suffix) => file.endsWith(`.sql${suffix}`));
}

/** True when `file` is an enforced migration that has not been armed yet. */
export function isDraftMigrationFile(file) {
  const suffix = PARKED_SUFFIXES.find((candidate) => file.endsWith(`.sql${candidate}`));
  return suffix ? isEnforcedMigrationFile(file.slice(0, -suffix.length)) : false;
}

/**
 * Extract column identifiers introduced by an ALTER TABLE ADD COLUMN statement.
 * Comments are masked first, while SQL string bodies remain visible so a real
 * EXECUTE statement inside a DO block is still checked. This intentionally covers
 * the narrow, mechanically decidable class behind EI-20208711931756460.
 */
export function addedColumnsFor(sqlText) {
  const code = stripComments(sqlText);
  const columns = [];
  const seen = new Set();
  const addColumn = /\bADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))/gi;
  for (const match of code.matchAll(addColumn)) {
    const column = match[1] ?? match[2];
    if (!seen.has(column)) {
      seen.add(column);
      columns.push(column);
    }
  }
  return columns;
}

/**
 * Extract the table identifiers an ALTER TABLE statement targets, WITHOUT the schema
 * qualifier (`harness_shared.local_backends` -> `local_backends`), because source code
 * names the bare table far more often than the schema-qualified one.
 *
 * This exists to qualify the column scan below. A bare column-name match alone is far too
 * broad: measured on migration 843, the column `lifecycle` matched **357 source files**,
 * none of which had anything to do with `local_backends` — plugin lifecycle, release
 * lifecycle, work-item lifecycle. That flood is not a conservative guard, it is the thing
 * that makes authors reach for the `-- FORWARD-COMPAT:` escape hatch to silence a lint they
 * (correctly) read as broken, which is how a REAL forward-compat break gets waved through.
 */
export function alteredTablesFor(sqlText) {
  const code = stripComments(sqlText);
  const tables = new Set();
  const alterTable = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))*)/gi;
  for (const match of code.matchAll(alterTable)) {
    const last = match[1].split('.').pop().trim();
    tables.add(last.replace(/^"|"$/g, ''));
  }
  return [...tables];
}

function sourceFileExtension(file) {
  return extname(file).toLowerCase();
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(sourceFileExtension(file));
}

function isMissingFileError(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'ENOENT');
}

/**
 * Read a path found by a directory scan after re-stat'ing it.
 *
 * A parked migration is an in-flight authoring artifact: reservation and rename
 * can remove it after readdirSync returned its name. Re-stat narrows the normal
 * race window, while the read catch closes the final stat/read window. Callers
 * choose whether ENOENT is tolerable; other errors always remain fatal.
 *
 * @param {string} filePath
 * @param {{ allowMissing?: boolean, readFile?: Function, stat?: Function }} options
 * @returns {string|null}
 */
export function readScannedFile(filePath, { allowMissing = false, readFile = readFileSync, stat = statSync } = {}) {
  try {
    stat(filePath);
  } catch (error) {
    if (allowMissing && isMissingFileError(error)) return null;
    throw error;
  }

  try {
    return readFile(filePath, 'utf8');
  } catch (error) {
    if (allowMissing && isMissingFileError(error)) return null;
    throw error;
  }
}

/**
 * Read the names returned by a directory scan, tolerating only explicitly
 * allowed files that disappear while the scan is in flight.
 *
 * @param {string} directory
 * @param {string[]} files
 * @param {{ allowMissing?: boolean|((file: string) => boolean), readFile?: Function, stat?: Function }} options
 * @returns {Array<{file: string, text: string}>}
 */
export function readScannedFiles(directory, files, { allowMissing = false, readFile = readFileSync, stat = statSync } = {}) {
  const loaded = [];
  for (const file of files) {
    const tolerateMissing = typeof allowMissing === 'function' ? allowMissing(file) : allowMissing;
    const text = readScannedFile(join(directory, file), { allowMissing: tolerateMissing, readFile, stat });
    if (text !== null) loaded.push({ file, text });
  }
  return loaded;
}

function sourceCommentsMasked(text, file) {
  return sourceFileExtension(file) === '.sql' ? stripSqlComments(text) : stripCommentsOnly(text, file);
}

function sourceFilesForRepo() {
  const files = [];

  function walk(absDir) {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || SOURCE_SKIP_DIRS.has(entry.name)) continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const file = relative(resolve(__dirname, '..'), abs).split(sep).join('/');
      if (!entry.isFile() || !isSourceFile(file) || file.startsWith(`${SQL_DIR_REL}/`)) continue;
      const text = readScannedFile(abs, { allowMissing: true });
      if (text !== null) files.push({ file, text });
    }
  }

  const repoRoot = resolve(__dirname, '..');
  for (const root of SOURCE_ROOTS) {
    const abs = join(repoRoot, ...root.split('/'));
    if (existsSync(abs)) walk(abs);
  }
  return files;
}

/**
 * Find source files that already reference columns introduced by a parked
 * migration. `sourceFiles` is injectable so unit tests can prove the detector on
 * small fixtures without writing into the shared checkout.
 *
 * @param {string} sqlText
 * @param {Array<{file: string, text: string}>} sourceFiles
 * @returns {{ columns: string[], references: Array<{column: string, file: string, line: number}> }}
 */
export function findDraftColumnReferences(sqlText, sourceFiles = []) {
  const columns = addedColumnsFor(sqlText);
  const tables = alteredTablesFor(sqlText);
  // A file cannot be reading `<table>.<column>` if it never mentions `<table>`. Requiring both
  // is what makes the scan usable for a column whose name is also an ordinary programming word.
  // If no table could be parsed we fall back to the column-only match, so an SQL shape this
  // regex does not understand is still scanned exactly as strictly as it was before.
  const tableTokens = tables.map((t) => new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(t)}(?![A-Za-z0-9_$])`, 'i'));
  const references = [];
  for (const column of columns) {
    const token = new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(column)}(?![A-Za-z0-9_$])`, 'i');
    for (const source of sourceFiles) {
      if (source.file.startsWith(`${SQL_DIR_REL}/`)) continue;
      const masked = sourceCommentsMasked(source.text, source.file);
      const match = token.exec(masked);
      if (!match || match.index === undefined) continue;
      if (tableTokens.length && !tableTokens.some((t) => t.test(masked))) continue;
      references.push({
        column,
        file: source.file,
        line: masked.slice(0, match.index).split('\n').length,
      });
    }
  }
  return { columns, references };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * NON-VACUITY SELF-TEST (D-076 section 4).
 *
 * A structural scan that silently matches nothing reports GREEN and is worse than no
 * gate at all. Before trusting a clean run we prove the detector still fires on a
 * known-positive and stays quiet on a known-negative. These fixtures are embedded so
 * the self-test cannot rot when files move on disk.
 */
function selfTest() {
  const positive = `
    CREATE UNIQUE INDEX IF NOT EXISTS agent_facts_identity_current
      ON harness_shared.agent_facts (workspace_id, scope, key)
      WHERE superseded_at IS NULL;
    DROP INDEX IF EXISTS harness_shared.agent_facts_identity;
  `;
  const negative = `
    -- This migration only talks about how we used to DROP INDEX things.
    -- It also mentions DROP COLUMN and RENAME TO purely in prose.
    CREATE TABLE IF NOT EXISTS harness_shared.some_new_table (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS some_new_table_created ON harness_shared.some_new_table (created_at);
  `;

  /**
   * The shape that used to false-positive (EI-20745458722827468): a NON-partial unique
   * index, followed later in the same file by a PARTIAL but NON-unique index. Nothing
   * here narrows an ON CONFLICT arbiter — the WHERE belongs to a different statement and
   * a different index — so the detector must stay quiet. Without this fixture the
   * statement-scoping fix is untested, and the rule could silently regress to matching
   * across statements again.
   */
  const negativeCrossStatement = `
    CREATE TABLE IF NOT EXISTS harness_shared.census_probe (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      surface_id text NOT NULL,
      retired_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS census_probe_identity
      ON harness_shared.census_probe (workspace_id, surface_id);
    CREATE INDEX IF NOT EXISTS census_probe_live
      ON harness_shared.census_probe (workspace_id)
      WHERE retired_at IS NULL;
  `;

  const failures = [];

  const posHits = violationsFor(positive).map((r) => r.id);
  if (!posHits.includes('drop-index')) {
    failures.push('detector did NOT fire on a known-positive DROP INDEX fixture');
  }
  if (!posHits.includes('narrowing-unique-index')) {
    failures.push('detector did NOT fire on a known-positive partial-unique-index fixture');
  }

  const crossHits = violationsFor(negativeCrossStatement).map((r) => r.id);
  if (crossHits.includes('narrowing-unique-index')) {
    failures.push(
      'detector fired ACROSS STATEMENTS on a non-partial unique index followed by a partial ' +
        'NON-unique index (EI-20745458722827468) — the wildcard is spanning statements again',
    );
  }

  const negHits = violationsFor(negative).map((r) => r.id);
  if (negHits.length > 0) {
    failures.push(
      `detector fired on a known-negative fixture (comment text mistaken for DDL): ${negHits.join(', ')}`,
    );
  }

  /*
   * MASK CONTRACT (EI-20073035509369492). The three fixtures below pin WHICH mask this
   * guard may use. They are falsifying controls, not coverage padding: each one FAILED
   * under a mask this guard plausibly could have been given.
   */

  // (a) A `--` inside a STRING LITERAL is not a comment. The private regex this guard used
  //     until 2026-08-10 erased the rest of the line, swallowing the real SET NOT NULL and
  //     reporting CLEAN -- the exact failure this guard exists to prevent. Fails on any
  //     non-quote-aware mask.
  const commentInString = `INSERT INTO t(note) VALUES ('see -- below'); ALTER TABLE t ALTER COLUMN c SET NOT NULL;`;
  if (!violationsFor(commentInString).some((r) => r.id === 'set-not-null')) {
    failures.push(
      'detector MISSED real DDL following a `--` inside a string literal (mask is not quote-aware)',
    );
  }

  // (b) REAL DDL inside a dollar-quoted body must still fire. Fails under
  //     stripSqlCommentsAndStrings, which seals `$tag$` bodies wholesale -- a false NEGATIVE.
  const ddlInBody = `DO $$ BEGIN\n  ALTER TABLE t ALTER COLUMN c SET NOT NULL;\nEND $$;`;
  if (!violationsFor(ddlInBody).some((r) => r.id === 'set-not-null')) {
    failures.push(
      'detector MISSED real DDL inside a dollar-quoted body (mask seals `$$` bodies -- must be comments-only)',
    );
  }

  // (c) A COMMENT inside a dollar-quoted body is still a comment. Fails under a mask that
  //     skips `$tag$` bodies instead of recursing into them -- a false POSITIVE.
  const commentInBody = `DO $$ BEGIN\n  -- ALTER TABLE t ALTER COLUMN c SET NOT NULL;\n  PERFORM 1;\nEND $$;`;
  const bodyCommentHits = violationsFor(commentInBody).map((r) => r.id);
  if (bodyCommentHits.length > 0) {
    failures.push(
      `detector fired on a COMMENTED-OUT statement inside a dollar-quoted body (mask skips bodies instead of recursing): ${bodyCommentHits.join(', ')}`,
    );
  }

  if (!ACK_MARKER.test('-- FORWARD-COMPAT: the deployed release never reads this column')) {
    failures.push('acknowledgment marker did not match a valid FORWARD-COMPAT line');
  }
  if (ACK_MARKER.test('-- FORWARD-COMPAT:')) {
    failures.push('acknowledgment marker matched an EMPTY FORWARD-COMPAT line (must require a reason)');
  }

  const draftFixture = `
    -- ADD COLUMN IF NOT EXISTS commented_out text;
    ALTER TABLE harness_shared.adv_sessions
      ADD COLUMN IF NOT EXISTS ended_signal text;
  `;
  const draftRefs = findDraftColumnReferences(draftFixture, [
    { file: 'packages/operator-core/lib/adv-sessions.ts', text: 'const q = sql`SELECT ended_signal FROM adv_sessions`;\n' },
    { file: 'packages/operator-core/lib/comment.ts', text: '// ended_signal is documented here, not read\n' },
  ]);
  if (!draftRefs.columns.includes('ended_signal')) {
    failures.push('draft dependency detector did NOT extract an ADD COLUMN identifier');
  }
  if (
    !draftRefs.references.some(
      (ref) => ref.column === 'ended_signal' && ref.file === 'packages/operator-core/lib/adv-sessions.ts',
    )
  ) {
    failures.push('draft dependency detector did NOT find a source reference');
  }
  if (draftRefs.references.some((ref) => ref.file.endsWith('/comment.ts'))) {
    failures.push('draft dependency detector treated a source comment as a reference');
  }

  return failures;
}

function main() {
  const selfTestFailures = selfTest();
  if (selfTestFailures.length > 0) {
    console.error('check-migration-forward-compat: SELF-TEST FAILED -- the checker itself is broken.');
    console.error('Refusing to report green, because a broken detector reports green on everything.\n');
    for (const f of selfTestFailures) console.error(`  - ${f}`);
    process.exit(1);
  }

  if (!existsSync(SQL_DIR)) {
    console.error(`check-migration-forward-compat: migrations dir not found: ${SQL_DIR}`);
    console.error('Refusing to report green on a scan that found nothing to scan.');
    process.exit(1);
  }

  const all = readdirSync(SQL_DIR).filter(isMigrationArtifactFile);
  if (all.length === 0) {
    console.error(`check-migration-forward-compat: zero migration artifacts in ${SQL_DIR}`);
    console.error('Refusing to report green on an empty scan.');
    process.exit(1);
  }

  const inScope = all
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => isEnforcedMigrationFile(f))
    .map((f) => ({ file: f, num: Number.parseInt(f.slice(0, f.indexOf('-')), 10) }))
    .sort((a, b) => a.num - b.num);

  const offenders = [];
  for (const { file, text } of readScannedFiles(SQL_DIR, inScope.map(({ file }) => file))) {
    const hits = violationsFor(text);
    if (hits.length === 0) continue;
    if (ACK_MARKER.test(text)) continue;
    offenders.push({ file, hits });
  }

  const draftOffenders = [];
  const draftFiles = all.filter(isDraftMigrationFile).sort();
  if (draftFiles.length > 0) {
    const sourceFiles = sourceFilesForRepo();
    for (const { file, text } of readScannedFiles(SQL_DIR, draftFiles, { allowMissing: true })) {
      const dependency = findDraftColumnReferences(text, sourceFiles);
      if (dependency.references.length > 0) draftOffenders.push({ file, ...dependency });
    }
  }

  if (offenders.length > 0 || draftOffenders.length > 0) {
    if (offenders.length > 0) {
      console.error('Forward-incompatible migration(s): destructive DDL with no FORWARD-COMPAT acknowledgment.\n');
      console.error('The database migrates NOW; :3070 keeps running the older release checkout until the');
      console.error('next commit -> green-checkpoint -> deploy cycle finishes. Destructive DDL therefore');
      console.error('breaks code that is still live.\n');
      for (const { file, hits } of offenders) {
        console.error(`  ${file}`);
        for (const h of hits) console.error(`      [${h.id}] ${h.why}`);
      }
      console.error('\nFix by splitting into expand/contract:');
      console.error('  1. EXPAND  - add the new index/column; ship and DEPLOY the code that uses it.');
      console.error('  2. CONTRACT - a LATER migration drops the old one, once no deployed release uses it.');
      console.error('\nOr, if the deployed release genuinely does not touch it, record why in the migration:');
      console.error('  -- FORWARD-COMPAT: <why the currently-deployed release does not use this>');
      console.error('\nBackground: EI-18797473716313783 (migration 689 dropped an ON CONFLICT arbiter and');
      console.error('broke facts:assert fleet-wide for ~3 hours).');
    }
    if (draftOffenders.length > 0) {
      console.error('\nDraft migration(s) already referenced by source before they were armed:\n');
      console.error('The runner ignores *.DRAFT and *.PENDING-CODE-DEPLOY files. A source read that');
      console.error('names a column from one of those files breaks every live operator until the');
      console.error('migration is armed and applied. Keep dependent code out of the draft, or arm/apply');
      console.error('the migration before shipping the code that reads it.\n');
      for (const { file, columns, references } of draftOffenders) {
        console.error(`  ${file} adds: ${columns.join(', ')}`);
        for (const ref of references) console.error(`      [add-column] ${ref.column} referenced by ${ref.file}:${ref.line}`);
      }
    }
    process.exit(1);
  }

  console.log(
    `check-migration-forward-compat: OK (${inScope.length} migration(s) at or after ${ENFORCE_FROM} checked, ${all.length} total on disk)`,
  );
}

// Run the CLI ONLY when executed directly — never on import. The authoring-time
// nudge imports this module for `violationsFor` / `ACK_MARKER`, and an
// unguarded `main()` would run the whole repo scan (and possibly process.exit(1))
// inside a PostToolUse hook that must always fail open.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
