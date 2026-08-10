/**
 * Migration 787's column comments claim that `upsertDocRecord` never populates
 * harness_docs.content / frontmatter / content_mode (EI-20059518283492409).
 * This pins that claim to the live writer.
 *
 * The FIXTURE CONTROLS are load-bearing, for the reason the doc-claims siblings
 * state: once the live assertion goes green it stops being evidence that the
 * detector works at all. Each fixture below reproduces a shape that MUST be caught
 * — including the exact change that would silently falsify the comments (populating
 * `content` on the anchor path), which is fix direction #2 on that item and is a
 * plausible next edit here.
 *
 * Note these fixtures are STRINGS. Proving falsifiability by mutating the real file
 * is unsafe in this tree: git-sync commits the whole working tree on a schedule, so
 * a probe that holds doc-record.ts mutated for the length of a suite run can have the
 * mutant committed even when nothing goes wrong and no handler fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeDocRecordContentClaim, CLAIMED_UNWRITTEN_COLUMNS } from './doc-record-content-claim';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC_RECORD = join(HERE, 'doc-record.ts');

/** The shape of the live writer, reduced to what the judge inspects. */
const cleanWriter = `
export async function upsertDocRecord(input: UpsertDocInput): Promise<HarnessDocRecord> {
  const rows = await sql\`
    INSERT INTO harness_shared.harness_docs
      (workspace_id, harness_slug, doc_id, source, subject_ref, anchor_paths,
       generated_from_sha, last_verified_sha, last_verified_at, overlay,
       status, status_detail, status_checked_at, title)
    VALUES (\${ws}, \${input.harnessSlug}, \${input.docId})
    ON CONFLICT (workspace_id, harness_slug, doc_id) DO UPDATE SET
      title = COALESCE(EXCLUDED.title, harness_shared.harness_docs.title)
    RETURNING *\`;
  return rowToRecord(rows[0]);
}

export async function setDocStatus(): Promise<void> {}
`;

describe('doc-record content-claim guard (migration 787)', () => {
  describe('fixture controls — the detector must be able to FAIL', () => {
    it('catches the writer starting to populate `content` (fix direction #2 landing silently)', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter.replace('status_checked_at, title)', 'status_checked_at, title, content)'),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.writtenColumns).toEqual(['content']);
      expect(verdict.violations.join('\n')).toMatch(/comment on .*harness_docs\.content states/i);
    });

    it('catches a column written only in the ON CONFLICT branch, not the INSERT list', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter.replace(
          'title = COALESCE(EXCLUDED.title, harness_shared.harness_docs.title)',
          "content_mode = 'authored',\n      title = COALESCE(EXCLUDED.title, harness_shared.harness_docs.title)",
        ),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.writtenColumns).toEqual(['content_mode']);
    });

    it('catches `frontmatter` being backfilled', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter.replace('status_checked_at, title)', 'status_checked_at, title, frontmatter)'),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.writtenColumns).toEqual(['frontmatter']);
    });

    it('treats a RENAMED writer as a violation, never a quiet pass', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter.replace('upsertDocRecord', 'upsertHarnessDocRecord'),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.writerFound).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/was not found/i);
    });

    it('does NOT flag `content_hash` — the substring trap `\\bcontent\\b` must survive', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter.replace('status_checked_at, title)', 'status_checked_at, title, content_hash)'),
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.writtenColumns).toEqual([]);
    });

    it('does NOT flag these column names appearing in a SQL comment', () => {
      const verdict = judgeDocRecordContentClaim(
        cleanWriter.replace(
          'RETURNING *',
          '-- deliberately writes no content / frontmatter / content_mode\n    RETURNING *',
        ),
      );
      expect(verdict.ok).toBe(true);
    });

    it('does NOT flag a mention OUTSIDE the writer (a sibling function may write them)', () => {
      const verdict = judgeDocRecordContentClaim(
        `${cleanWriter}\nexport async function cacheProjectedDoc() { await sql\`UPDATE harness_shared.harness_docs SET content = \${body}\`; }\n`,
      );
      expect(verdict.ok).toBe(true);
    });
  });

  describe('the live claim', () => {
    it('upsertDocRecord writes none of the columns migration 787 says it does not', () => {
      const verdict = judgeDocRecordContentClaim(readFileSync(DOC_RECORD, 'utf8'));
      expect(verdict.writerFound).toBe(true);
      expect(verdict.violations).toEqual([]);
      expect(verdict.writtenColumns).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('pins the exact column set the comments name', () => {
      expect([...CLAIMED_UNWRITTEN_COLUMNS]).toEqual(['content', 'frontmatter', 'content_mode']);
    });

    it('reads a real file — a bad path would otherwise make the live assertion vacuous', () => {
      expect(readFileSync(DOC_RECORD, 'utf8')).toContain('export async function upsertDocRecord');
    });
  });
});
