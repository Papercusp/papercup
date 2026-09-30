/**
 * R-39 (generic-rag-chunking-2026-09-29, D-005): every duplicate and novelty
 * check ranks by the parent vector alone.
 *
 * Those checks compare WHOLE items ("is this the same plan / the same bug?"),
 * so a match inside one window of a long parent must not count: chunk vectors
 * would flag a new item as a duplicate of any long item that merely mentions
 * the same thing somewhere past its opening. Each site below must keep ranking
 * by its parent's own vector (`<=>` over the parent table) and must not read a
 * chunk table or call the chunk-aware leg in retrieve mode.
 *
 * The sources are scanned with comments removed but string and template
 * literals KEPT: the SQL lives inside template literals, so stripping them
 * would hide exactly the table names this guard looks for.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../../..');

/** The duplicate and novelty checks R-39 names, one entry per file. */
const PARENT_VECTOR_SITES = [
  { file: 'packages/operator-core/lib/agent-tools/plans/semantic-dedup.ts', what: "plans:new's duplicate guard" },
  { file: 'packages/operator-core/lib/agent-tools/work_items/semantic-dupe-guard.ts', what: 'the work-item duplicate guard' },
  { file: 'packages/operator-core/lib/work-items-admission-promoter.ts', what: 'the admission promoter' },
  { file: 'packages/operator-core/lib/work-items-admission-census.ts', what: 'the admission census' },
  { file: 'packages/operator-core/lib/scout/semantic-novelty-leg.ts', what: 'the scout novelty leg' },
  { file: 'packages/operator-core/lib/scout/intent-rank-leg.ts', what: 'the scout intent leg' },
  // D-027: consult:get_feedback's archive-first serve answers a new question with a
  // past answer, a duplicate decision, so it stays on the question's own vector.
  { file: 'packages/operator-core/lib/consult/get-feedback-core.ts', what: "consult:get_feedback's archive-first serve" },
] as const;

/** Readers that DO retrieve by chunk: the detector must flag them (calibration). */
const KNOWN_CHUNK_READERS = [
  'packages/operator-core/lib/agent-tools/plans/semantic-leg.ts',
  'packages/operator-core/lib/agent-tools/search/sources.ts',
  'packages/operator-core/lib/work-items.ts',
  'packages/operator-core/lib/consult/peers-know.ts',
] as const;

/** Remove block and line comments; keep string and template literals intact. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** What in `source` reads chunk vectors; empty when it ranks by the parent vector alone. */
function chunkReadsIn(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  if (/\btext_chunks\b/.test(code)) found.push('reads harness_shared.text_chunks');
  if (/\bsession_turn_chunks\b/.test(code)) found.push('reads harness_shared.session_turn_chunks');
  if (/\bchunkAwareVectorLeg(Sql)?\b/.test(code) && /['"]retrieve['"]/.test(code)) {
    found.push('calls the chunk-aware leg in retrieve mode');
  }
  return found;
}

const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8');

describe('R-39: duplicate and novelty checks rank by the parent vector alone', () => {
  it.each(PARENT_VECTOR_SITES)('$what ($file) still ranks by a vector', ({ file }) => {
    // Positive control: a site whose query moved elsewhere would pass the
    // chunk check vacuously.
    expect(stripComments(read(file))).toMatch(/<=>/);
  });

  it.each(PARENT_VECTOR_SITES)('$what ($file) reads no chunk vectors', ({ file }) => {
    expect(chunkReadsIn(read(file))).toEqual([]);
  });

  it.each(KNOWN_CHUNK_READERS)('calibration: the detector flags the retrieve-mode reader %s', (file) => {
    expect(chunkReadsIn(read(file))).toContain('calls the chunk-aware leg in retrieve mode');
  });

  it('the detector flags each chunk read and ignores comments and gist mode', () => {
    expect(chunkReadsIn('sql`SELECT 1 FROM harness_shared.text_chunks c`')).toEqual(['reads harness_shared.text_chunks']);
    expect(chunkReadsIn('sql`JOIN harness_shared.session_turn_chunks s`')).toEqual([
      'reads harness_shared.session_turn_chunks',
    ]);
    expect(chunkReadsIn("chunkAwareVectorLegSql(sql, { mode: 'retrieve' })")).toEqual([
      'calls the chunk-aware leg in retrieve mode',
    ]);
    expect(chunkReadsIn("chunkAwareVectorLeg(sql, { mode: 'gist' })")).toEqual([]);
    expect(chunkReadsIn('// text_chunks is not read here\n/* nor session_turn_chunks */ const x = 1;')).toEqual([]);
  });
});
