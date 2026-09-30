/**
 * generic-rag-chunking-2026-09-29 P-013 / R-31: every embed-backfill TARGET
 * names a search site that reads its vector, and a planted readerless TARGET
 * fails the guard.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './embed-backfill';
import {
  describeReaderViolation,
  findReaderViolations,
  isVectorRead,
  type ReaderCheckTarget,
} from './embed-target-readers';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function readRepoFile(rel: string): string | null {
  const abs = join(REPO_ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

/** A real reader, borrowed so a planted target differs from a real one only where the test says. */
const REAL_READER = { file: 'packages/operator-core/lib/code-recipes-search.ts', evidence: ['ORDER BY embedding <=> ${qVec}::vector'] as [string] };

describe('embed-backfill TARGETS each name a vector reader (R-31)', () => {
  it('positive control: the repo root resolves and TARGETS is the real, populated list', () => {
    expect(readRepoFile('packages/operator-core/lib/search/embed-backfill.ts')).toContain('export const TARGETS');
    expect(TARGETS.length).toBeGreaterThanOrEqual(12);
  });

  it('every real TARGET has at least one reader, and every reader checks out against its file', () => {
    for (const t of TARGETS) expect(t.readers.length, `${t.table}.${t.embedCol}`).toBeGreaterThan(0);
    const violations = findReaderViolations(TARGETS, readRepoFile);
    expect(violations.map(describeReaderViolation)).toEqual([]);
  });

  it('a planted readerless TARGET fails the guard, alongside the real list', () => {
    const planted: ReaderCheckTarget = { table: 'harness_shared.planted_readerless', embedCol: 'embedding', readers: [] };
    const violations = findReaderViolations([...TARGETS, planted], readRepoFile);
    expect(violations).toEqual([{ table: 'harness_shared.planted_readerless', embedCol: 'embedding', reason: 'no-readers' }]);
  });

  it('a TARGET with no readers field at all fails the same way', () => {
    const violations = findReaderViolations([{ table: 'harness_shared.x', embedCol: 'embedding' }], readRepoFile);
    expect(violations.map((v) => v.reason)).toEqual(['no-readers']);
  });

  it('a reader whose evidence is no longer in its file fails (the reader was removed)', () => {
    const planted: ReaderCheckTarget = {
      table: 'harness_shared.code_recipes',
      embedCol: 'embedding',
      readers: [{ file: REAL_READER.file, evidence: ['ORDER BY retired_embedding <=> ${qVec}::vector'] }],
    };
    const violations = findReaderViolations([planted], readRepoFile);
    expect(violations).toEqual([{
      table: 'harness_shared.code_recipes',
      embedCol: 'embedding',
      reason: 'evidence-missing',
      file: REAL_READER.file,
      evidence: 'ORDER BY retired_embedding <=> ${qVec}::vector',
    }]);
  });

  it('a reader whose evidence only names the table, with no vector read, fails', () => {
    const planted: ReaderCheckTarget = {
      table: 'harness_shared.code_recipes',
      embedCol: 'embedding',
      readers: [{ file: REAL_READER.file, evidence: ['FROM harness_shared.code_recipes'] }],
    };
    expect(findReaderViolations([planted], readRepoFile).map((v) => v.reason)).toEqual(['no-vector-read']);
  });

  it('a reader naming a missing file fails', () => {
    const planted: ReaderCheckTarget = {
      table: 'harness_shared.code_recipes',
      embedCol: 'embedding',
      readers: [{ file: 'packages/operator-core/lib/no-such-reader.ts', evidence: ['embedding <=> $1'] }],
    };
    expect(findReaderViolations([planted], readRepoFile).map((v) => v.reason)).toEqual(['file-missing']);
  });

  it('calibration: the same planted shapes pass once given a real reader', () => {
    const fixed: ReaderCheckTarget = { table: 'harness_shared.planted', embedCol: 'embedding', readers: [REAL_READER] };
    expect(findReaderViolations([fixed], readRepoFile)).toEqual([]);
  });

  it('the vectors dropped for having no reader stay out of TARGETS (D-020, D-025)', () => {
    const tables = TARGETS.map((t) => t.table);
    expect(tables).not.toContain('harness_shared.carry_notes');
    expect(tables).not.toContain('harness_shared.harness_docs');
    expect(tables).not.toContain('harness_shared.coord_thread_posts');
  });

  it('isVectorRead recognises the pgvector operators and the chunk-aware leg, and nothing else', () => {
    expect(isVectorRead('ORDER BY embedding <=> $1')).toBe(true);
    expect(isVectorRead('embedding <-> $1')).toBe(true);
    expect(isVectorRead('WITH best AS (${chunkAwareVectorLegSql(sql, {')).toBe(true);
    expect(isVectorRead('FROM harness_shared.doc_sections')).toBe(false);
    expect(isVectorRead('embedding IS NOT NULL')).toBe(false);
  });
});
