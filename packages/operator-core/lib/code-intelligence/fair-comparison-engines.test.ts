/**
 * Parser tests for the P-017 third-party adapters. Every fixture below is the
 * SHAPE of real output captured from codegraph 1.6.2 and trace-mcp 3.34.6 on the
 * micro repo (2026-10-06), trimmed to the fields the parsers read.
 */
import { describe, expect, it } from 'vitest';
import type { FairCase } from './fair-comparison';
import {
  askTrace,
  codegraphArgv,
  parseCodegraph,
  traceCandidates,
  traceImpactSymbolIds,
  traceTextSites,
  traceUsageSites,
} from './fair-comparison-engines';

const k = (intent: FairCase['intent'], subject: string, extra: Partial<FairCase> = {}): FairCase => ({
  id: `t-${intent}`,
  intent,
  subject,
  tags: [],
  source: 'micro-repo',
  ...extra,
});
const at = (sites: ReadonlyArray<{ path: string; line1: number | null }>) => sites.map((s) => `${s.path}:${s.line1}`);

describe('codegraph adapter', () => {
  it('passes anchorFile, depth and a raised limit', () => {
    expect(codegraphArgv(k('callers', 'add', { anchorFile: 'src/util/math.ts' }))).toEqual(['callers', 'add', '-j', '-l', '10000', '-f', 'src/util/math.ts']);
    expect(codegraphArgv(k('impact', 'scale', { depth: 3 }))).toEqual(['impact', 'scale', '-j', '-d', '3']);
    expect(codegraphArgv(k('definition', 'doubled'))).toEqual(['query', 'doubled', '-j', '-l', '1000']);
    expect(() => codegraphArgv(k('references', 'x'))).toThrow(/^declined:/);
  });

  it('keeps every caller codegraph reports, file-level import edges included (raw, D-013)', () => {
    const out = JSON.stringify({
      symbol: 'add',
      callers: [
        { name: 'BASE', kind: 'constant', filePath: 'src/app/report.ts', startLine: 4, relationships: ['calls'] },
        { name: 'report.ts', kind: 'file', filePath: 'src/app/report.ts', startLine: 1, relationships: ['imports'] },
      ],
      truncated: false,
    });
    const r = parseCodegraph(k('callers', 'add'), out);
    expect(at(r.sites)).toEqual(['src/app/report.ts:4', 'src/app/report.ts:1']);
    expect(r.note).toBeNull();
  });

  it('reads impact from `affected` and flags truncation', () => {
    const out = JSON.stringify({ affected: [{ name: 'doubled', kind: 'function', filePath: 'src/app/report.ts', startLine: 12 }], truncated: true });
    const r = parseCodegraph(k('impact', 'scale'), out);
    expect(at(r.sites)).toEqual(['src/app/report.ts:12']);
    expect(r.note).toMatch(/truncated/);
  });

  it('keeps only exact-name symbols from a fuzzy query', () => {
    const out = JSON.stringify([
      { node: { name: 'add', kind: 'function', filePath: 'src/util/math.ts', startLine: 2 }, score: 93 },
      { node: { name: 'BASE', kind: 'constant', filePath: 'src/app/report.ts', startLine: 4 }, score: 5 },
    ]);
    expect(at(parseCodegraph(k('symbol-search', 'add'), out).sites)).toEqual(['src/util/math.ts:2']);
  });

  it('reads the not-found notice as a confident empty answer', () => {
    expect(parseCodegraph(k('callers', 'nosuchsym'), '\nℹ Symbol "nosuchsym" not found\n')).toEqual({ sites: [], note: 'codegraph: symbol not found' });
  });

  it('throws on output it cannot read, so a changed format surfaces as a crash', () => {
    expect(() => parseCodegraph(k('callers', 'add'), 'segfault')).toThrow(/no JSON/);
    expect(() => parseCodegraph(k('callers', 'add'), JSON.stringify({ symbol: 'add' }))).toThrow(/no 'callers' array/);
  });
});

describe('trace-mcp adapter', () => {
  const items = [
    { symbol_id: 'src/app/format.ts::add#function', name: 'add', kind: 'function', file: 'src/app/format.ts', line: 2 },
    { symbol_id: 'src/util/math.ts::add#function', name: 'add', kind: 'function', file: 'src/util/math.ts', line: 2 },
    { symbol_id: 'src/app/report.ts::BASE#variable', name: 'BASE', kind: 'variable', file: 'src/app/report.ts', line: 4 },
  ];

  it('narrows same-name candidates to anchorFile, and keeps the union without one', () => {
    expect(traceCandidates(k('callers', 'add', { anchorFile: 'src/util/math.ts' }), { items }).map((i) => i.file)).toEqual(['src/util/math.ts']);
    expect(traceCandidates(k('callers', 'add'), { items }).map((i) => i.file)).toEqual(['src/app/format.ts', 'src/util/math.ts']);
  });

  it('reads text hits and the result cap', () => {
    const json = { files: [{ file: 'src/app/report.ts', hits: [{ line: 3 }, { line: 18 }] }], truncated: false, timed_out: false };
    expect(traceTextSites(json)).toEqual({ sites: [expect.objectContaining({ path: 'src/app/report.ts', line1: 3 }), expect.objectContaining({ line1: 18 })], truncated: false });
    expect(traceTextSites({ ...json, truncated: true }).truncated).toBe(true);
  });

  it('reads usages at the referencing scope, and impact symbol ids', () => {
    expect(at(traceUsageSites({ references: [{ file: 'src/app/report.ts', symbol: { line_start: 12, kind: 'function' } }] }))).toEqual(['src/app/report.ts:12']);
    expect(traceImpactSymbolIds({ dependents: [{ symbols: [{ symbolId: 'src/app/report.ts::doubled#function' }, { symbolId: 'src/app/report.ts::report#function' }] }] })).toEqual([
      'src/app/report.ts::doubled#function',
      'src/app/report.ts::report#function',
    ]);
  });

  const text = (j: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(j) }], ...(isError ? { isError: true } : {}) });
  const fake = (replies: Record<string, (args: Record<string, unknown>) => unknown>) => {
    const calls: string[] = [];
    return {
      calls,
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${String(args.symbol_id ?? args.query ?? '')}`);
        return replies[name]!(args);
      },
    };
  };

  it('resolves the symbol through search, then asks the call graph by symbol id', async () => {
    const s = fake({
      search: () => text({ items }),
      get_call_graph: () => text({ root: { called_by: [{ file: 'src/util/math.ts', line: 6, kind: 'function' }] } }),
    });
    const r = await askTrace(s, k('callers', 'add', { anchorFile: 'src/util/math.ts' }));
    expect(s.calls).toEqual(['search:add', 'get_call_graph:src/util/math.ts::add#function']);
    expect(at(r.sites)).toEqual(['src/util/math.ts:6']);
  });

  it('resolves impact dependents to lines with trace-mcp’s own get_symbol', async () => {
    const s = fake({
      search: () => text({ items: [{ symbol_id: 'src/util/math.ts::scale#function', name: 'scale', file: 'src/util/math.ts', line: 6 }] }),
      get_change_impact: () => text({ dependents: [{ symbols: [{ symbolId: 'src/app/report.ts::doubled#function' }] }] }),
      get_symbol: () => text({ file: 'src/app/report.ts', line_start: 12, kind: 'function' }),
    });
    expect(at((await askTrace(s, k('impact', 'scale', { depth: 2 }))).sites)).toEqual(['src/app/report.ts:12']);
  });

  it('answers empty when the symbol is unknown, and crashes on a real tool error', async () => {
    const none = await askTrace(fake({ search: () => text({ items: [] }) }), k('callers', 'nosuch'));
    expect(none).toMatchObject({ sites: [], error: null, note: 'trace-mcp: symbol not found' });
    const s = fake({ search: () => text({ items }), get_call_graph: () => text({ error: { code: 'INTERNAL', message: 'db locked' } }, true) });
    await expect(askTrace(s, k('callers', 'add'))).rejects.toThrow(/db locked/);
  });
});
