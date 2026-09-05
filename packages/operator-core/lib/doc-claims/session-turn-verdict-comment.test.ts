/**
 * The `turn_origin_verdict` column comment must name every verdict the classifier
 * can persist (EI-21506915532672609).
 *
 * The FIXTURE CONTROLS are load-bearing for the reason the siblings in this
 * directory state: once the live assertion goes green it stops being evidence that
 * the detector works at all. The first fixture is migration 794's actual text —
 * the exact shape that shipped and cost an agent a false "the owner never said it".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPersistedVerdicts,
  extractVerdictComment,
  judgeVerdictComment,
} from './session-turn-verdict-comment';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FILTERS = join(ROOT, 'packages/operator-core/lib/agent-tools/search/filters.ts');
const SQL_DIR = join(ROOT, 'libs/papercusp/libs/db/sql');

/** The text migration 794 shipped: five values, three real ones missing. */
const COMMENT_794 =
  'classifyRecordedTurn verdict: agent-injected | machine-surface | synthetic | ' +
  "owner-typed | unknown. NULL means NEVER CLASSIFIED (not yet backfilled) and is " +
  "deliberately distinct from 'unknown' (classified, undeterminable). NOTE: owner-typed " +
  'is the RESIDUAL of a versioned deny-list, i.e. "no rule matched" -- it is NOT positive ' +
  'evidence of owner speech, and must never be read as such (D-013).';

const ALL_SEVEN = [
  'owner-typed',
  'owner-dialog',
  'agent-injected',
  'machine-surface',
  'synthetic',
  'unenrolled-origin',
  'not-user-turn',
];

/**
 * The migration that most recently sets the comment — the one Postgres applies
 * last, and therefore the text a reader actually meets.
 */
function latestVerdictComment(): { file: string; comment: string } {
  const files = readdirSync(SQL_DIR)
    .filter((f) => /^\d+-.*\.sql$/.test(f))
    .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));

  for (const file of files) {
    const comment = extractVerdictComment(readFileSync(join(SQL_DIR, file), 'utf8'));
    if (comment !== null) return { file, comment };
  }
  throw new Error('no migration sets the turn_origin_verdict column comment');
}

describe('session_turns.turn_origin_verdict column comment', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it("catches migration 794's real text — the shape that shipped the defect", () => {
      const v = judgeVerdictComment(COMMENT_794, ALL_SEVEN);
      expect(v.ok).toBe(false);
      // All three omissions, not just the one that prompted the report.
      expect(v.missing.sort()).toEqual(
        ['not-user-turn', 'owner-dialog', 'unenrolled-origin'].sort(),
      );
      expect(v.violations.join('\n')).toMatch(/omits persisted verdict/);
    });

    it("catches a comment missing only 'unenrolled-origin' — the false-negative bucket", () => {
      const nearly = `persisted: ${ALL_SEVEN.filter((v) => v !== 'unenrolled-origin').join(' | ')}`;
      const v = judgeVerdictComment(nearly, ALL_SEVEN);
      expect(v.ok).toBe(false);
      expect(v.missing).toEqual(['unenrolled-origin']);
    });

    it('refuses to pass vacuously when the filters enum cannot be found', () => {
      // Without this, a rename in filters.ts would silently turn every run green —
      // a guard that measures nothing, reported as a clean bill.
      const v = judgeVerdictComment(COMMENT_794, []);
      expect(v.ok).toBe(false);
      expect(v.violations.join('\n')).toMatch(/measured nothing/);
    });

    it('calibration: a comment naming all seven passes', () => {
      const v = judgeVerdictComment(`persisted: ${ALL_SEVEN.join(' | ')}`, ALL_SEVEN);
      expect(v.ok).toBe(true);
      expect(v.missing).toEqual([]);
    });

    it("does NOT demand deleting 'unknown' — it is reserved, not emitted", () => {
      // The direction is CODE ⊆ COMMENT. session-ingest.ts calls the NULL-vs-unknown
      // distinction load-bearing, so a comment carrying a reserved value is correct.
      const withReserved = `persisted: ${ALL_SEVEN.join(' | ')}. 'unknown' is RESERVED.`;
      expect(judgeVerdictComment(withReserved, ALL_SEVEN).ok).toBe(true);
    });
  });

  describe('extraction', () => {
    it('reads the persisted vocabulary out of the live filters.ts enum', () => {
      const verdicts = extractPersistedVerdicts(readFileSync(FILTERS, 'utf8'));
      expect(verdicts.sort()).toEqual(ALL_SEVEN.slice().sort());
    });

    it('unescapes SQL doubled quotes so comparisons see what a reader sees', () => {
      const sql =
        "COMMENT ON COLUMN harness_shared.session_turns.turn_origin_verdict IS\n  'a ''quoted'' value';";
      expect(extractVerdictComment(sql)).toBe("a 'quoted' value");
    });

    it('returns null for a migration that does not set this comment', () => {
      expect(extractVerdictComment('COMMENT ON COLUMN other.table.col IS ' + "'x';")).toBeNull();
    });
  });

  describe('the live comment', () => {
    it('names every verdict the classifier can persist', () => {
      const { file, comment } = latestVerdictComment();
      const verdicts = extractPersistedVerdicts(readFileSync(FILTERS, 'utf8'));
      const v = judgeVerdictComment(comment, verdicts);
      expect(v.violations.join('\n'), `in ${file}`).toBe('');
      expect(v.ok).toBe(true);
    });

    it('tells the reader how to ask whether the owner said something', () => {
      // The whole point of the report: the comment must carry the false-NEGATIVE
      // half, not just D-013's false-positive warning.
      const { comment } = latestVerdictComment();
      expect(comment).toMatch(/OWNER_CANDIDATE_TURN_VERDICTS/);
      expect(comment).toMatch(/D-013/);
    });
  });
});
