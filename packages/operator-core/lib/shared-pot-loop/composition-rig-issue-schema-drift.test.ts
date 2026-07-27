/**
 * composition-rig-issue-schema-drift.test.ts — EI-10579.
 *
 * THE GAP THIS CLOSES (and why it is a PURE UNIT test, no Postgres)
 * -----------------------------------------------------------------
 * composition-rig.ts's `setupCellSchema` builds the rig's `engineer_issues`
 * relation as a REAL table (migration 131 loaded verbatim + two hand-rolled
 * `ALTER TABLE … ADD COLUMN` blocks), NOT as the production
 * `engineer_issues` VIEW. The unified work-item read path
 * (issues-engineer.ts's `ISSUE_COLS`) `SELECT`s a fixed column list from that
 * relation — and `getWorkItem()` probes the issue family via it, which
 * `setWorkItemPriority` (the rig's `mugTurn`) calls first. So the moment a
 * migration adds a column to `ISSUE_COLS` that the rig's hand-rolled
 * `engineer_issues` doesn't carry, EVERY rig test touching that path fails
 * OPAQUELY with a raw `column "<x>" does not exist` (42703).
 *
 * That is exactly EI-10579: migration 588 added `feature_order` to the
 * `engineer_issues` view and EI-10421 made `ISSUE_COLS` select it
 * (`issueToWorkItem` reads `i.featureOrder`) — but the rig's `engineer_issues`
 * ALTER block was never updated, so split-brain-mug (and its siblings) went
 * deterministically red from 2026-07-12.
 *
 * The EXISTING drift guard (composition-rig-schema-drift.integration.test.ts,
 * EI-6794) cannot catch this class: it is scoped to
 * `harness_features_consolidated` ONLY, and it checks the OPPOSITE direction
 * (columns the RIG declares must exist in the REAL schema — catching
 * renames/drops), not "columns the real READ PATH selects must exist in the
 * rig". This test closes that specific gap for `engineer_issues`, and does so
 * WITHOUT a container: it re-derives the rig's `engineer_issues` column set by
 * reading source text (the migration files `setupCellSchema` loads + the rig's
 * own ALTER blocks), parses `ISSUE_COLS` from issues-engineer.ts, and asserts
 * `ISSUE_COLS ⊆` the rig's columns. A future `ISSUE_COLS` addition the rig
 * misses now fails LOUD, HERE, in the fast unit lane, naming the exact column
 * — instead of surfacing opaquely deep in an unrelated hermetic-loop test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const RIG_FILE = join(HERE, 'composition-rig.ts');
const ISSUES_ENGINEER_FILE = resolve(HERE, '..', 'issues-engineer.ts');

/**
 * The migration files `setupCellSchema` loads verbatim (kept in sync with the
 * `for (const file of [...])` list in composition-rig.ts — the ones below are
 * the subset that can define/alter `engineer_issues`; loading a file that
 * doesn't touch it is harmless, the parser just finds nothing).
 */
const RIG_LOADED_MIGRATIONS = ['131-engineer-issues.sql', '241-signal-provenance-origin.sql'];

/**
 * Pure, exported for its own coverage: the column list `ISSUE_COLS`
 * (issues-engineer.ts) selects from the `engineer_issues` relation.
 */
export function extractIssueCols(issuesEngineerSource: string): string[] {
  const m = issuesEngineerSource.match(/const ISSUE_COLS\s*=\s*`([\s\S]*?)`/);
  if (!m) {
    throw new Error(
      'extractIssueCols: could not find `const ISSUE_COLS = `…`` in issues-engineer.ts — did its shape change?',
    );
  }
  return m[1]
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && /^[a-z_][a-z0-9_]*$/i.test(c));
}

/**
 * Pure, exported for its own coverage: every column name declared for
 * `harness_shared.engineer_issues` across `sources` — from BOTH any
 * `CREATE TABLE … engineer_issues (…)` block and any
 * `ALTER TABLE … engineer_issues … ADD COLUMN [IF NOT EXISTS] <name>` block.
 * Scoped to `engineer_issues` so a sibling table's ALTERs (the rig alters
 * several) never leak in.
 */
export function extractEngineerIssuesColumns(rawSources: string[]): Set<string> {
  const columns = new Set<string>();
  // Strip `--` line comments FIRST — Postgres ignores them, and a comment that
  // contains a `;` (the rig's do — e.g. "…feature_order; the column…") would
  // otherwise prematurely terminate the non-greedy ALTER-block capture below,
  // hiding real columns declared after the comment.
  const sources = rawSources.map((s) => s.replace(/--[^\n]*/g, ''));
  for (const src of sources) {
    // CREATE TABLE … engineer_issues ( … );  → first identifier of each column line.
    const createRe = /CREATE TABLE (?:IF NOT EXISTS )?harness_shared\.engineer_issues\s*\(([\s\S]*?)\n\s*\);/g;
    let cm: RegExpExecArray | null;
    while ((cm = createRe.exec(src)) !== null) {
      for (const rawLine of cm[1].split('\n')) {
        const line = rawLine.trim();
        if (
          !line ||
          line.startsWith('--') ||
          /^(PRIMARY KEY|CONSTRAINT|CHECK|UNIQUE|FOREIGN KEY)\b/i.test(line)
        ) {
          continue;
        }
        const col = line.match(/^"?([a-z_][a-z0-9_]*)"?\s+\S/i);
        if (col) columns.add(col[1]);
      }
    }
    // ALTER TABLE … engineer_issues … ; → every ADD COLUMN name inside that block.
    const alterRe = /ALTER TABLE harness_shared\.engineer_issues\b([\s\S]*?);/g;
    let am: RegExpExecArray | null;
    while ((am = alterRe.exec(src)) !== null) {
      const addRe = /ADD COLUMN (?:IF NOT EXISTS )?"?([a-z_][a-z0-9_]*)"?/gi;
      let dm: RegExpExecArray | null;
      while ((dm = addRe.exec(am[1])) !== null) columns.add(dm[1]);
    }
  }
  return columns;
}

describe('ISSUE_COLS / engineer_issues parsers (sanity check the parsers themselves)', () => {
  it('extractIssueCols finds the expected issue read columns', () => {
    const cols = extractIssueCols(readFileSync(ISSUES_ENGINEER_FILE, 'utf8'));
    for (const expected of ['issue_id', 'kind', 'state', 'feature_order', 'terminal_owner']) {
      expect(cols).toContain(expected);
    }
    expect(cols.length).toBeGreaterThan(15);
  });

  it('extractEngineerIssuesColumns reaches both the CREATE (mig 131) and the rig ALTER blocks', () => {
    const rigSrc = readFileSync(RIG_FILE, 'utf8');
    const mig131 = readFileSync(join(SQL_DIR, '131-engineer-issues.sql'), 'utf8');
    const cols = extractEngineerIssuesColumns([mig131, rigSrc]);
    // one from the 131 CREATE, one from a rig ADD COLUMN block — proves both regexes hit.
    expect(cols).toContain('issue_id');
    expect(cols).toContain('assignee_rank');
    expect(cols.size).toBeGreaterThan(15);
  });
});

describe('composition-rig schema drift — engineer_issues vs the read path (ISSUE_COLS)', () => {
  it("carries every column ISSUE_COLS selects (getWorkItem's issue-family probe must not 42703)", () => {
    const rigSrc = readFileSync(RIG_FILE, 'utf8');
    const migSources = RIG_LOADED_MIGRATIONS.map((f) => readFileSync(join(SQL_DIR, f), 'utf8'));
    const rigColumns = extractEngineerIssuesColumns([...migSources, rigSrc]);
    const issueCols = extractIssueCols(readFileSync(ISSUES_ENGINEER_FILE, 'utf8'));

    const missing = issueCols.filter((c) => !rigColumns.has(c));

    if (missing.length > 0) {
      throw new Error(
        `composition-rig.ts's engineer_issues fixture is MISSING column(s) that issues-engineer.ts's ` +
          `ISSUE_COLS selects: ${missing.join(', ')}. Any rig test that hits a getWorkItem / setWorkItemPriority ` +
          `issue-family path will 42703 ("column does not exist") — the EI-10579 drift class. Add each missing ` +
          `column to the "ALTER TABLE harness_shared.engineer_issues ADD COLUMN IF NOT EXISTS …" block in ` +
          `composition-rig.ts's setupCellSchema. Rig columns present: ${[...rigColumns].sort().join(', ')}`,
      );
    }

    expect(missing).toEqual([]);
  });
});

// EI-18752123064847436: every check above validates composition-rig.ts by
// reading it as TEXT and regexing out column names — it never imports the
// module, so a syntactically BROKEN composition-rig.ts (e.g. a stray backtick
// inside a SQL comment prematurely terminating a TS template literal — the
// exact hazard this fixture carries, and the one that bit _work-items-schema.ts
// per the sibling report EI-18748484115079154) passes this guard with a green
// checkmark while every OTHER test that imports the module fails elsewhere,
// with no pointer back here. This block closes that detector gap CHEAPLY:
// `ts.transpileModule` performs a real single-file PARSE (catches syntax
// errors like an unterminated template literal) without importing the module
// or its heavy transitive dependency graph (hyperswarm/hyperdht/testcontainers
// PG helpers) — so, unlike an `await import()` of the real module, it stays a
// fast, no-docker pure-unit check.
describe('composition-rig.ts parses cleanly — the guard must not be blind to its own fixture breaking (EI-18752123064847436)', () => {
  it('is syntactically valid TypeScript (a parse error here would otherwise pass every text-scanning check above)', () => {
    const rigSrc = readFileSync(RIG_FILE, 'utf8');
    const { diagnostics } = ts.transpileModule(rigSrc, {
      fileName: RIG_FILE,
      compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });

    if (diagnostics && diagnostics.length > 0) {
      const messages = diagnostics.map((d) => {
        const loc = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
        const where = loc ? `${loc.line + 1}:${loc.character + 1}` : '?';
        return `  ${where}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
      });
      throw new Error(
        `composition-rig.ts fails to PARSE as TypeScript (${diagnostics.length} syntax error(s)) — every ` +
          `text-scanning check in this file operates on the file's TEXT and cannot detect this, so a broken ` +
          `composition-rig.ts would pass them all while every rig test that imports the module fails elsewhere ` +
          `with no pointer back here. Errors:\n${messages.join('\n')}`,
      );
    }

    expect(diagnostics ?? []).toEqual([]);
  });
});
