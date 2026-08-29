/**
 * Migration 1024 materialized `harness_plans.is_blender_origin` as a STORED generated
 * column whose expression HARDCODES the Blender provenance marker as a SQL literal.
 *
 * That literal is a SECOND COPY of `BLENDER_PLAN_SQL_PATTERN` in `plan-provenance.ts` --
 * the derived-truth-ladder rung-2 "PIN" case. A generated column's expression cannot read
 * a TypeScript constant, so the value genuinely cannot be DERIVED at DDL time; that is
 * exactly why it must be PINNED, or it will drift the way every hand-maintained second
 * copy in this repo has drifted.
 *
 * The failure this prevents is silent and total: change the marker in TS and every
 * plan-index read keeps returning provenance computed from the OLD marker baked into the
 * column. Nothing throws, no test fails, `plans:list` just quietly reports the wrong
 * `origin` forever -- and the column is STORED, so even a backfill of `content` will not
 * correct rows until the column is rebuilt.
 *
 * Fixture controls are load-bearing for the reason the sibling doc-claims tests state:
 * once the live assertion goes green it stops being evidence that the detector works.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLENDER_PLAN_SQL_PATTERN } from '../agent-tools/plans/plan-provenance';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIGRATION = join(
  ROOT,
  'libs/papercusp/libs/db/sql/1024-plan-is-blender-origin-generated-column.sql',
);

export interface PinVerdict {
  ok: boolean;
  /** The decoded pattern the generated column actually compares against, if found. */
  sqlPattern: string | null;
  violations: string[];
}

/**
 * PURE. Extract the `content LIKE E'...'` literal from the generated-column DDL and
 * decode the SQL E-string escapes so it can be compared to the TS constant verbatim.
 *
 * Deliberately anchored on `GENERATED ALWAYS AS (...) STORED` rather than on any
 * `content LIKE` in the file: a comment mentioning the old expression must NOT satisfy
 * the pin (the migration's own header quotes it, and an earlier draft of this test was
 * fooled by exactly that).
 */
export function judgeBlenderColumnPin(migrationSql: string, tsPattern: string): PinVerdict {
  const violations: string[] = [];

  // Strip -- line comments so prose in the header cannot satisfy the match.
  const executable = migrationSql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

  const generated = /GENERATED\s+ALWAYS\s+AS\s*\((.*?)\)\s*STORED/is.exec(executable);
  if (!generated) {
    return {
      ok: false,
      sqlPattern: null,
      violations: ['no GENERATED ALWAYS AS (...) STORED expression found in the migration'],
    };
  }

  const like = /content\s+LIKE\s+E'((?:[^'\\]|\\.|'')*)'/i.exec(generated[1]);
  if (!like) {
    return {
      ok: false,
      sqlPattern: null,
      violations: [`generated expression does not compare content with an E'' literal: ${generated[1]}`],
    };
  }

  // Decode the SQL E'' escapes we actually use. Order matters: backslash last.
  const sqlPattern = like[1]
    .replace(/''/g, "'")
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');

  if (sqlPattern !== tsPattern) {
    violations.push(
      `generated column compares ${JSON.stringify(sqlPattern)} but BLENDER_PLAN_SQL_PATTERN is ` +
        `${JSON.stringify(tsPattern)} -- migration 1024's column is computing the wrong marker`,
    );
  }

  return { ok: violations.length === 0, sqlPattern, violations };
}

describe('migration 1024 is_blender_origin column pin', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches a drifted marker — the whole point of the pin', () => {
      const verdict = judgeBlenderColumnPin(
        `ALTER TABLE t ADD COLUMN c boolean GENERATED ALWAYS AS (content LIKE E'%\\norigin: blender\\n%') STORED;`,
        '%\norigin: scout\n%',
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/computing the wrong marker/);
    });

    it('is NOT satisfied by a comment that merely quotes the expression', () => {
      const verdict = judgeBlenderColumnPin(
        `-- content LIKE E'%\\norigin: scout\\n%' is what we used to do\nALTER TABLE t ADD COLUMN c boolean;`,
        '%\norigin: scout\n%',
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/no GENERATED ALWAYS AS/);
    });

    it('catches the column being rewritten to a non-generated one', () => {
      const verdict = judgeBlenderColumnPin(
        `ALTER TABLE t ADD COLUMN is_blender_origin boolean DEFAULT false;`,
        '%\norigin: scout\n%',
      );
      expect(verdict.ok).toBe(false);
    });

    it('accepts a correctly pinned expression', () => {
      const verdict = judgeBlenderColumnPin(
        `ALTER TABLE t ADD COLUMN c boolean GENERATED ALWAYS AS (content LIKE E'%\\norigin: scout\\n%') STORED;`,
        '%\norigin: scout\n%',
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.sqlPattern).toBe('%\norigin: scout\n%');
    });
  });

  describe('the live claim', () => {
    it('migration 1024 computes exactly BLENDER_PLAN_SQL_PATTERN', () => {
      const verdict = judgeBlenderColumnPin(
        readFileSync(MIGRATION, 'utf8'),
        BLENDER_PLAN_SQL_PATTERN,
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });
  });
});
