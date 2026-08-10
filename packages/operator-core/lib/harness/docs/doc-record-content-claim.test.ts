/**
 * Migration 789's column comments claim that `upsertDocRecord` populates
 * harness_docs.content / content_hash / frontmatter, and never writes content_mode
 * (P-008 / D-025). This pins that claim to the live writer.
 *
 * ⚠ THIS SUITE INVERTED. Until 2026-08-10 it pinned the OPPOSITE claim (migration 787:
 * "no writer populates these"), which was true then — 0 of 952 authored rows held
 * content. P-008 made PG canonical for authored doc prose, so the writer now populates
 * them. Both the guard and these fixtures track the contract; neither outlives it.
 *
 * The FIXTURE CONTROLS are load-bearing, for the reason the doc-claims siblings state:
 * once the live assertion goes green it stops being evidence that the detector works at
 * all. Each fixture reproduces a shape that MUST be caught — including the regression
 * back to metadata-only upserts, which is the plausible next edit here and would leave
 * PG "canonical" while silently saving no prose.
 *
 * Note these fixtures are STRINGS. Proving falsifiability by mutating the real file is
 * unsafe in this tree: git-sync commits the whole working tree on a schedule, so a probe
 * that holds doc-record.ts mutated for the length of a suite run can have the mutant
 * committed even when nothing goes wrong and no handler fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgeDocRecordContentClaim,
  assignsColumn,
  insertColumnList,
  CLAIMED_WRITTEN_COLUMNS,
  CLAIMED_UNWRITTEN_COLUMNS,
} from './doc-record-content-claim';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC_RECORD = join(HERE, 'doc-record.ts');

/** The shape of the live writer, reduced to what the judge inspects. */
const cleanWriter = `
export async function upsertDocRecord(input: UpsertDocInput): Promise<HarnessDocRecord> {
  const rows = await sql\`
    INSERT INTO harness_shared.harness_docs
      (workspace_id, harness_slug, doc_id, source, subject_ref, anchor_paths,
       status, status_detail, status_checked_at, title,
       content, content_hash, frontmatter)
    VALUES (\${ws}, \${input.harnessSlug}, \${input.docId})
    ON CONFLICT (workspace_id, harness_slug, doc_id) DO UPDATE SET
      title = COALESCE(EXCLUDED.title, harness_shared.harness_docs.title),
      content = CASE WHEN harness_shared.harness_docs.content_mode = 'composed'
                     THEN harness_shared.harness_docs.content
                     ELSE COALESCE(\${content}::text, harness_shared.harness_docs.content) END,
      content_hash = COALESCE(\${contentHash}::text, harness_shared.harness_docs.content_hash),
      frontmatter = COALESCE(\${frontmatterJson}::jsonb, harness_shared.harness_docs.frontmatter)
    RETURNING *\`;
  return rowToRecord(rows[0]);
}

export async function setDocStatus(): Promise<void> {}
`;

describe('doc-record content-claim guard (migration 789)', () => {
  describe('fixture controls — the detector must be able to FAIL', () => {
    it('catches the writer REGRESSING to a metadata-only upsert (prose silently unsaved)', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter
          .replace('       content, content_hash, frontmatter)', '       )')
          .replace(/^\s*content = CASE[\s\S]*?END,$/m, '')
          .replace(/^\s*content_hash = .*$/m, '')
          .replace(/^\s*frontmatter = .*$/m, ''),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.missingColumns.sort()).toEqual(['content', 'content_hash', 'frontmatter']);
      expect(verdict.violations.join('\n')).toMatch(/no longer assigns the column/i);
    });

    it('catches ONLY frontmatter being dropped (the partial regression)', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter
          .replace(', content_hash, frontmatter)', ', content_hash)')
          .replace(/^\s*frontmatter = .*$/m, ''),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.missingColumns).toEqual(['frontmatter']);
    });

    it('catches content_hash being dropped while content is still written (they must not drift)', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter.replace(', content_hash, frontmatter)', ', frontmatter)').replace(/^\s*content_hash = .*$/m, ''),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.missingColumns).toEqual(['content_hash']);
    });

    it('catches content_mode being ASSIGNED — the composed-row corruption hazard', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter.replace(
          '      content_hash = COALESCE',
          "      content_mode = 'authored',\n      content_hash = COALESCE",
        ),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.writtenColumns).toEqual(['content_mode']);
      expect(verdict.violations.join('\n')).toMatch(/must never write/i);
    });

    it('catches content_mode smuggled into the INSERT column list', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter.replace(', content_hash, frontmatter)', ', content_hash, frontmatter, content_mode)'),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.writtenColumns).toEqual(['content_mode']);
    });

    it('treats a RENAMED writer as a violation, never a quiet pass', () => {
      const verdict = judgeDocRecordContentClaim(cleanWriter.replace('upsertDocRecord', 'upsertHarnessDocRecord'));
      expect(verdict.ok).toBe(false);
      expect(verdict.writerFound).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/was not found/i);
    });
  });

  describe('non-matches — the judge must not fire on correct code', () => {
    it('does NOT flag content_mode being READ in a CASE predicate — that read IS the guard', () => {
      // The load-bearing non-match. The live writer reads content_mode precisely to
      // PROTECT composed rows; a judge matching a bare \bcontent_mode\b would flag the
      // protection itself as the violation.
      expect(judgeDocRecordContentClaim(cleanWriter).ok).toBe(true);
      expect(cleanWriter).toContain("harness_shared.harness_docs.content_mode = 'composed'");
    });

    it('does NOT confuse content_hash with content — the substring trap must survive', () => {
      // `content` must be satisfied by a real `content` assignment, never by the
      // `content_hash` one that contains it as a prefix.
      const onlyHash = cleanWriter
        .replace(', content_hash, frontmatter)', ', content_hash, frontmatter)')
        .replace(/^\s*content = CASE[\s\S]*?END,$/m, '');
      const verdict = judgeDocRecordContentClaim(onlyHash.replace('       content, content_hash', '       content_hash'));
      expect(verdict.missingColumns).toEqual(['content']);
    });

    it('does NOT read a column name inside a SQL comment as an assignment', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter.replace('    RETURNING *', "    -- content_mode = 'composed' is never written here\n    RETURNING *"),
      );
      expect(verdict.ok).toBe(true);
    });

    it('does NOT flag a write in a SIBLING function outside the writer', () => {
      const verdict = judgeDocRecordContentClaim(
        `${cleanWriter}\nexport async function setDocMode() { await sql\`UPDATE harness_shared.harness_docs SET content_mode = 'composed'\`; }\n`,
      );
      expect(verdict.ok).toBe(true);
    });

    it('does NOT treat an equality COMPARISON as an assignment', () => {
      expect(assignsColumn("WHERE t.content_mode == 'composed'", 'content_mode')).toBe(false);
    });
  });

  describe('insertColumnList', () => {
    it('parses the column list', () => {
      expect(insertColumnList('INSERT INTO t.x (a, b,\n c) VALUES (1,2,3)')).toEqual(['a', 'b', 'c']);
    });

    it('returns [] for a statement with no INSERT rather than throwing', () => {
      expect(insertColumnList('UPDATE t.x SET a = 1')).toEqual([]);
    });
  });

  describe('the live claim', () => {
    it('upsertDocRecord writes every column migration 789 says it does', () => {
      const verdict = judgeDocRecordContentClaim(readFileSync(DOC_RECORD, 'utf8'));
      expect(verdict.writerFound).toBe(true);
      expect(verdict.missingColumns).toEqual([]);
      expect(verdict.writtenColumns).toEqual([]);
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('pins the exact column sets the comments name', () => {
      expect([...CLAIMED_WRITTEN_COLUMNS]).toEqual(['content', 'content_hash', 'frontmatter']);
      expect([...CLAIMED_UNWRITTEN_COLUMNS]).toEqual(['content_mode']);
    });

    it('reads a real file — a bad path would otherwise make the live assertion vacuous', () => {
      expect(readFileSync(DOC_RECORD, 'utf8')).toContain('export async function upsertDocRecord');
    });
  });
});
