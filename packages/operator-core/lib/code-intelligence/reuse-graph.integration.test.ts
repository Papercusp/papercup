import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const capture = vi.hoisted(() => ({ onRead: null as null | ((path: string) => void),
  search: vi.fn(async () => { throw new Error('Controlled semantic backend unavailable'); }) }));
vi.mock('./semantic-code-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('./semantic-code-runtime')>();
  return { ...actual, semanticSimilarQuery: (...args: Parameters<typeof actual.semanticSimilarQuery>) =>
    actual.semanticSimilarQuery(...args.slice(0, 4) as [string, string | undefined, Parameters<typeof actual.semanticSimilarQuery>[2], AbortSignal?],
      async () => ({ search: capture.search }) as never) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args);
    capture.onRead?.(String(args[0])); return result;
  } };
});
import graphQuery from '../agent-tools/gitnexus/query';
import { BUDGET, promptWeight } from '../agent-tools/tool-guidance-budget';
import { buildCloneIndex } from './clone-index';
import { queryCloneIndex } from './reuse-graph';
import { extractSemanticFunctions } from './semantic-code';
import { SEMANTIC_HYBRID_MODEL } from './semantic-code-calibration';

const body = 'let total = input;\n' + Array.from({ length: 24 }, (_, i) => `total += input * ${i + 1};`).join('\n') + '\nreturn total;';
const source = `export function calculate(input: number) {\n${body}\n}`;
const renamed = source.replaceAll('total', 'sum').replaceAll('input', 'value').replace('calculate', 'tally');
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reuse-graph-')); roots.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.ts'), source);
  writeFileSync(join(root, 'src/b.ts'), source.replace('calculate', 'copy'));
  writeFileSync(join(root, 'src/c.ts'), renamed);
  writeFileSync(join(root, 'src/near.ts'), source.replace('calculate', 'changed').replace('return total;', 'return total + 1;'));
  return root;
}
afterEach(() => { capture.onRead = null; capture.search.mockReset();
  capture.search.mockRejectedValue(new Error('Controlled semantic backend unavailable'));
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
async function run(root: string, args: Record<string, unknown>) {
  const parsed = graphQuery.args.parse({ paths: ['src'], ...args });
  const result = await graphQuery.handler(parsed, { projectDir: root, workspaceId: 'controlled-workspace' } as never);
  return (result as { data: Record<string, any> }).data;
}

describe('graph:query reuse operations through the real schema and handler', () => {
  it('merges calibrated semantic sites for every selector, preserves score units and clone precedence, and caps deterministic ties', async () => {
    const root = fixture();
    const other = 'export function unique(values: number[]) { return values.filter(value => value > 0).length; }';
    for (const path of ['src/z.ts', 'src/y.ts']) writeFileSync(join(root, path), other);
    const rows = ['src/z.ts', 'src/c.ts', 'src/y.ts'].map(path => ({
      ...extractSemanticFunctions({ path, source: readFileSync(join(root, path), 'utf8') })[0]!,
      rankScore: .02, rankers: ['vector'], cosineSimilarity: .44, relevanceScore: .85, crossEncoderRelevance: .93,
    }));
    capture.search.mockResolvedValue({ matches: rows, vectorStatus: 'measured', relevanceStatus: 'measured',
      relevanceMethod: SEMANTIC_HYBRID_MODEL.id, relevanceCutoff: .70, indexVersion: 'controlled-v1',
      truncation: { truncated: false, totalAvailable: rows.length } } as never);
    for (const input of [{ name: 'calculate' }, { file_path: 'src/a.ts', line1: 4 },
      { snippet: source }, { snippet: body }]) {
      const result = await run(root, { op: 'similar', ...input });
      const matches = result.matches;
      expect(matches.slice(-2).map((row: { path: string }) => row.path)).toEqual(['src/y.ts', 'src/z.ts']);
      expect(matches.filter((row: { path: string }) => row.path === 'src/c.ts')).toHaveLength(1);
      expect(matches.find((row: { path: string }) => row.path === 'src/c.ts').kind).toBe('renamed');
      expect(matches.at(-1)).toMatchObject({ kind: 'semantic', score: .85, scoreMethod: SEMANTIC_HYBRID_MODEL.id,
        cosineSimilarity: .44, rankScore: .02, candidateOnly: true, signature: expect.stringContaining('unique'), location: 'src/z.ts:1' });
      expect(result.calibration.semantic).toMatchObject({ status: 'measured-within-profile', threshold: .70 });
      expect(result.coverage.semantic).toBe('bounded-index-lower-bound');
    }
    const limited = await run(root, { op: 'similar', name: 'calculate', limit: 1 });
    expect(limited.matches).toHaveLength(1);
    expect(limited.matches[0].kind).toBe('exact');
    expect(limited.truncation).toMatchObject({ truncated: true, totalAvailable: 5 });
  });

  it('rejects invalid semantic scores and stale candidate blobs without losing current clone matches', async () => {
    const root = fixture();
    const path = 'src/semantic.ts';
    const text = 'export function count(values: number[]) { return values.filter(value => value > 0).length; }';
    writeFileSync(join(root, path), text);
    const row = { ...extractSemanticFunctions({ path, source: text })[0]!, rankScore: .02, rankers: ['vector'],
      cosineSimilarity: .44, relevanceScore: .85, crossEncoderRelevance: .93 };
    for (const invalid of [{ ...row, relevanceScore: Number.NaN }, { ...row, blobSha: 'stale' }]) {
      capture.search.mockResolvedValue({ matches: [invalid], vectorStatus: 'measured', relevanceStatus: 'measured',
        relevanceMethod: SEMANTIC_HYBRID_MODEL.id, relevanceCutoff: .70, indexVersion: 'controlled-v1',
        truncation: { truncated: false, totalAvailable: 1 } } as never);
      const result = await run(root, { op: 'similar', name: 'calculate' });
      expect(result).toMatchObject({ status: 'ok', semantic: { status: 'unknown', matches: [] } });
      expect(result.matches.map((match: { kind: string }) => match.kind)).toEqual(['exact', 'renamed', 'near']);
    }
  });

  it('keeps unavailable semantic scores unknown and rejects target drift across semantic inference', async () => {
    const root = fixture();
    const unknown = await run(root, { op: 'similar', name: 'calculate' });
    expect(unknown).toMatchObject({ status: 'ok', calibration: { semantic: { status: 'unknown' } }, semantic: { status: 'unknown', matches: [] } });
    capture.search.mockImplementation(async () => {
      writeFileSync(join(root, 'src/a.ts'), source + '\n// changed during semantic inference');
      return { matches: [], vectorStatus: 'measured', relevanceStatus: 'measured',
        relevanceMethod: SEMANTIC_HYBRID_MODEL.id, relevanceCutoff: .70, indexVersion: 'controlled-v1',
        truncation: { truncated: false, totalAvailable: 0 } } as never;
    });
    expect(await run(root, { op: 'similar', name: 'calculate' })).toMatchObject({
      status: 'unknown', matches: [], freshness: { status: 'unknown', staleVsDisk: null },
    });
  });
  it('answers name, path/line, function snippet and body snippet with located exact/renamed/near matches', async () => {
    const root = fixture();
    for (const input of [{ name: 'calculate' }, { file_path: 'src/a.ts', line1: 1 },
      { file_path: 'src/a.ts', line1: 4 }, { snippet: source }, { snippet: body }]) {
      const result = await run(root, { op: 'similar', ...input });
      expect(result.status).toBe('ok');
      expect(result.matches).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'src/b.ts', line1: 1, kind: 'exact', score: 1, signature: expect.stringContaining('copy') }),
        expect.objectContaining({ path: 'src/c.ts', line1: 1, kind: 'renamed', score: 1, location: 'src/c.ts:1' }),
      ]));
      expect(result.matches).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'src/near.ts', line1: 1, kind: 'near', score: expect.any(Number) }),
      ]));
      expect(result.calibration.near).toMatchObject({ status: 'calibrated', threshold: 0.8 });
      expect(result.calibration.semantic.status).toBe('unknown');
      expect(result.calibration.exact.scoreMeaning).toContain('binary equality');
      expect(result.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.freshness).toEqual({ status: 'captured', staleVsDisk: false });
      expect(result.coverage.sourceCompleteness).toBe('lower-bound');
    }
  });

  it('reports families, uses deterministic ties and caps total returned members/sites', async () => {
    const root = fixture();
    const named = await run(root, { op: 'similar', name: 'calculate', limit: 1_000_000 });
    expect(named.limit).toBe(100);
    expect(named.matches.map((match: { kind: string }) => match.kind)).toEqual(['exact', 'renamed', 'near']);
    const limited = await run(root, { op: 'similar', name: 'calculate', limit: 1 });
    expect(limited.matches).toHaveLength(1); expect(limited.truncation.truncated).toBe(true);
    const families = await run(root, { op: 'clones', limit: 2 });
    expect(families.families).toHaveLength(1);
    expect(families.families[0]).toMatchObject({ kind: 'renamed', totalMembers: 3, truncated: true });
    expect(families.families[0].members.map((member: { path: string }) => member.path)).toEqual(['src/a.ts', 'src/b.ts']);
    const again = await run(root, { op: 'clones', paths: ['src/c.ts', 'src/b.ts', 'src/a.ts'] });
    expect(again.families[0].id).toBe(families.families[0].id);
  });

  it('refuses to guess ambiguous names or snippets, and rejects incomplete/mixed selectors', async () => {
    const root = fixture();
    writeFileSync(join(root, 'src/duplicate.ts'), source);
    const ambiguous = await run(root, { op: 'similar', name: 'calculate' });
    expect(ambiguous).toMatchObject({ status: 'ambiguous', matches: [], candidates: [
      { path: 'src/a.ts' }, { path: 'src/duplicate.ts' },
    ] });
    expect(await run(root, { op: 'similar', snippet: source + '\n' + renamed })).toMatchObject({ status: 'ambiguous', matches: [] });
    expect(await run(root, { op: 'similar', snippet: source, name: 'calculate' })).toMatchObject({ status: 'invalid', matches: [] });
    expect(await run(root, { op: 'similar', file_path: 'src/a.ts' })).toMatchObject({ status: 'invalid', matches: [] });
    expect(await run(root, { op: 'similar', name: 'absent' })).toMatchObject({ status: 'unknown', matches: [] });
  });

  it('removes syntax errors/deletions from results and never publishes source drift as current', async () => {
    const root = fixture();
    writeFileSync(join(root, 'src/b.ts'), 'function broken( {');
    rmSync(join(root, 'src/c.ts'));
    rmSync(join(root, 'src/near.ts'));
    const result = await run(root, { op: 'similar', name: 'calculate' });
    expect(result).toMatchObject({ status: 'ok', matches: [], unknown: [{ path: 'src/b.ts', reason: 'syntax-error' }] });
    let reads = 0;
    capture.onRead = path => {
      if (path === join(root, 'src/a.ts') && reads++ === 0) writeFileSync(path, source + '\n// source changed');
    };
    const drift = await run(root, { op: 'similar', name: 'calculate' });
    expect(drift).toMatchObject({ status: 'unknown', matches: [], freshness: { status: 'unknown', staleVsDisk: null } });
    expect(drift.error).toContain('changed during capture');
  });

  it('rejects escaping paths/symlinks, oversized scopes and oversized snippet payloads', async () => {
    const root = fixture(), external = fixture();
    expect(await run(root, { op: 'clones', paths: ['../outside'] })).toMatchObject({ status: 'unknown', families: [] });
    symlinkSync(join(external, 'src/a.ts'), join(root, 'src/escape.ts'));
    expect(await run(root, { op: 'clones', paths: ['src/escape.ts'] })).toMatchObject({ status: 'unknown', families: [] });
    for (let i = 0; i < 201; i++) writeFileSync(join(root, `src/file-${i}.ts`), 'export const value = 1;');
    expect((await run(root, { op: 'clones' })).error).toContain('200-file budget');
    expect(() => graphQuery.args.parse({ op: 'similar', snippet: 'a'.repeat(100_001) })).toThrow();
  });

  it('excludes classified copies and bounds homonyms at two locations in one file', () => {
    const text = source + '\n' + source;
    const sources = new Map([['src/a.ts', text], ['src/b.ts', renamed], ['src/a.test.ts', source]]);
    const index = buildCloneIndex([...sources].map(([path, source]) => ({ path, source })));
    expect(queryCloneIndex(index, { op: 'similar', name: 'calculate', file_path: 'src/a.ts' }, sources).status).toBe('ambiguous');
    const result = queryCloneIndex(index, { op: 'similar', file_path: 'src/a.ts', line1: 1 }, sources);
    expect(result.status).toBe('ok');
    expect('matches' in result && result.matches?.map(match => match.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('keeps the existing tool within its shared prompt budget', () => {
    expect(promptWeight(graphQuery as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
    expect(readFileSync(new URL('../agent-tools/gitnexus/query.ts', import.meta.url), 'utf8')).toContain("name: 'graph:query'");
  });
});
