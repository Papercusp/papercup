/**
 * R-8 (generic-rag-chunking-2026-09-29, D-010): the chunking mechanism lives in
 * the library. No module under packages/ or apps/ DEFINES the splitters, the
 * chunk registry types, the sync engine, the chunk-aware vector leg or the HNSW
 * iterative-scan helper; papercusp imports each of them from @papercusp/search.
 *
 * Why a scan and not a type check: a second definition compiles fine. It is a
 * fork, and forks drift (the host copy of hnsw-iterative-scan is how D-010 was
 * found). The scan runs over source with comments and string literals masked,
 * so a mention in prose, a mock property or this file's own fixtures is not a
 * definition. Two controls keep it honest:
 *   - calibration: the detector must find every symbol in the library file
 *     that owns it (a detector that never matches would pass vacuously);
 *   - positive control: a planted definition of each shape must be reported.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripCommentsAndStrings } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';

const REPO_ROOT = resolve(__dirname, '../../../../..');
const LIBRARY_SRC = 'libs/generic/search/src';
/** The trees R-8 names. The rubric's wording follows this list. */
const SCANNED_ROOTS = ['packages', 'apps'] as const;
const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

/** Each library symbol and the file under LIBRARY_SRC that owns its definition. */
const OWNED: Readonly<Record<string, string>> = {
  splitWindows: 'chunk.ts',
  splitMarkdown: 'chunk.ts',
  withIterativeScan: 'hnsw-iterative-scan.ts',
  chunkAwareVectorLeg: 'chunks/vector-leg.ts',
  chunkAwareVectorLegSql: 'chunks/vector-leg.ts',
  planChunks: 'chunks/engine.ts',
  syncChunkSurface: 'chunks/engine.ts',
  syncChunkSurfaces: 'chunks/engine.ts',
  ChunkSurface: 'chunks/types.ts',
  ResolvedChunkSurface: 'chunks/types.ts',
  ChunkStore: 'chunks/types.ts',
  ChunkKeyColumn: 'chunks/types.ts',
  ChunkVectorTable: 'chunks/types.ts',
};
const SYMBOLS = Object.keys(OWNED);

/** The definition shapes that would fork a library symbol. Imports, re-exports,
 * destructuring, object properties (e.g. a vi.mock factory) and a binding to a
 * vitest double (`const withIterativeScan = vi.fn(...)`) are not definitions:
 * a test double stands in for the library symbol, it does not implement it. */
function definitionPattern(name: string): RegExp {
  return new RegExp(
    [
      `\\bfunction\\s*\\*?\\s*${name}\\s*[<(]`,
      `\\b(?:const|let|var)\\s+${name}\\s*(?::|=(?!\\s*vi\\.(?:fn|hoisted|spyOn)\\b))`,
      `\\b(?:interface|class|enum)\\s+${name}\\b`,
      `\\btype\\s+${name}\\s*(?:<[^=]*>)?\\s*=`,
    ].join('|'),
  );
}

/** Symbols the source defines, after comments and string literals are masked. */
export function definedSymbols(source: string, fileName: string, names: readonly string[] = SYMBOLS): string[] {
  const masked = stripCommentsAndStrings(source, fileName);
  return names.filter((name) => definitionPattern(name).test(masked));
}

/** Files under the scanned roots that mention any symbol (tracked or untracked, never ignored). */
function candidateFiles(): string[] {
  const pattern = `\\b(${SYMBOLS.join('|')})\\b`;
  try {
    const out = execFileSync('git', ['grep', '-l', '--untracked', '-E', pattern, '--', ...SCANNED_ROOTS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter((p) => p && SOURCE_FILE.test(p));
  } catch (err) {
    // git grep exits 1 when nothing matches; any other status is a real failure.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

/**
 * Mutation-probe seam: PAPERCUSP_PLACEMENT_EXTRA_FILES is a path-delimited list
 * of absolute paths scanned IN ADDITION to the tree. scripts/mutation-probe.sh
 * points it at a copy of a real importer with a planted fork, so the proof that
 * the tree scan catches a fork never plants one in the shared tree (git-sync
 * would commit it).
 */
function extraScanFiles(): string[] {
  return (process.env.PAPERCUSP_PLACEMENT_EXTRA_FILES ?? '').split(delimiter).filter(Boolean);
}

describe('R-8: the chunking mechanism is defined only in @papercusp/search', () => {
  it('calibration: the detector finds every symbol in the library file that owns it', () => {
    for (const [name, file] of Object.entries(OWNED)) {
      const path = `${LIBRARY_SRC}/${file}`;
      const found = definedSymbols(readFileSync(resolve(REPO_ROOT, path), 'utf8'), path, [name]);
      expect(found, `${name} should be defined in ${path}`).toEqual([name]);
    }
  });

  it('positive control: a planted definition of each shape is reported', () => {
    const planted = [
      'export function splitWindows(text: string) { return [text]; }',
      'export async function withIterativeScan<T>(sql: unknown) { return sql as T; }',
      'const chunkAwareVectorLeg = async () => [];',
      'let planChunks: () => void = () => {};',
      'export interface ChunkSurface { surface: string }',
      'export type ChunkKeyColumn = string;',
      'type ChunkVectorTable<T> = { table: T };',
    ].join('\n');
    expect(definedSymbols(planted, 'planted.ts').sort()).toEqual(
      ['ChunkKeyColumn', 'ChunkSurface', 'ChunkVectorTable', 'chunkAwareVectorLeg', 'planChunks', 'splitWindows', 'withIterativeScan'].sort(),
    );
  });

  it('negative control: imports, re-exports, mocks, prose and strings are not definitions', () => {
    const benign = [
      "import { splitWindows, type ChunkSurface } from '@papercusp/search';",
      "export type { ChunkStore } from '@papercusp/search';",
      "const { withIterativeScan } = await import('@papercusp/search');",
      "vi.mock('@papercusp/search', () => ({ chunkAwareVectorLeg: vi.fn() }));",
      'const withIterativeScan = vi.fn(async (_h: unknown, body: () => unknown) => body());',
      '// function splitMarkdown( is described here, not defined',
      "const note = 'const planChunks = 1';",
      'const rows = await syncChunkSurfaces(sql, surfaces);',
    ].join('\n');
    expect(definedSymbols(benign, 'benign.ts')).toEqual([]);
  });

  it('no module under packages/ or apps/ defines a library symbol', () => {
    const candidates = candidateFiles();
    // The scan must have seen real importers, or it proved nothing.
    expect(candidates).toContain('packages/operator-core/lib/agent-tools/search/sources.ts');
    const scanned = [...candidates.map((path) => resolve(REPO_ROOT, path)), ...extraScanFiles()];
    const violations = scanned.flatMap((path) =>
      definedSymbols(readFileSync(path, 'utf8'), path).map((name) => `${path}: ${name}`),
    );
    expect(violations).toEqual([]);
  });
});
