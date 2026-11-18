import { describe, expect, it } from 'vitest';
import { buildSymbolSnapshot, parseSymbolSnapshot, relativeSymbolModule } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';
import { createReuseCallColumns, decodeReuseCallColumns } from './reuse-source-population';

function build(sources: Record<string, string>) {
  const files = Object.keys(sources);
  return buildSymbolSnapshot({ files, readSource: (file: string) => sources[file] ?? null,
    resolveModule: (file: string, spec: string) => relativeSymbolModule(file, spec, new Set(files)) });
}
describe('precomputed symbol snapshot', () => {
  it('streams exact declaration identities without conflating exports in one source file', () => {
    const sources: Record<string, string> = {
      'definitions.ts': 'export default function writer() {}\nexport const serialize = (value: string) => value;',
      'barrel.ts': 'export { default as advance, serialize } from "./definitions"; export * from "./cycle";',
      'cycle.ts': 'export * from "./barrel";',
      'default.ts': 'import run from "./definitions"; run();',
      'renamed.ts': 'import { advance as renamed, serialize } from "./barrel"; renamed(); serialize("x");',
      'namespace.ts': 'import * as api from "./barrel"; api.advance(); api.serialize("x");',
    };
    type Declaration = { id: string; path: string; name: string; line: number; column: number };
    const collect = (files: string[], censusOnly: boolean, partitioned: boolean) => {
      const rows: Array<{ call: string; target: string | null; declaration: Declaration | null }> = [];
      const fileSet = new Set(files);
      const input = { files, censusOnly, includeCallCensus: true,
        readSource: (path: string) => sources[path] ?? null,
        resolveModule: (path: string, spec: string) => relativeSymbolModule(path, spec, fileSet),
        callCensusSink: (call: { path: string; line: number; column: number }, target: string | null,
          _index: number, declaration: Declaration | null) => rows.push({
          call: JSON.stringify([call.path, call.line, call.column]), target, declaration,
        }),
      };
      const parts = partitioned ? files.map(path => parseSymbolSnapshot({ ...input, files: [path] })) : [];
      const parsed = partitioned ? {
        units: new Map(parts.flatMap(part => [...part.units])),
        symbols: new Map(parts.flatMap(part => [...part.symbols])),
        immediateCalls: parts.flatMap(part => part.immediateCalls),
        stats: { ...parts[0]!.stats, files: parts.reduce((sum, part) => sum + part.stats.files, 0) },
      } : undefined;
      const snapshot = buildSymbolSnapshot({ ...input, ...(parsed ? { parsed } : {}) });
      expect(snapshot.stats.callCensusTruncated).toBe(false);
      expect(snapshot.callCensus).toEqual([]);
      return rows.sort((a, b) => a.call.localeCompare(b.call));
    };
    const files = Object.keys(sources), baseline = collect(files, false, false);
    expect(baseline).toHaveLength(5);
    const writer = baseline.filter(row => row.declaration?.name === 'writer');
    const serializer = baseline.filter(row => row.declaration?.name === 'serialize');
    expect(writer).toHaveLength(3);
    expect(serializer).toHaveLength(2);
    expect(new Set(writer.map(row => row.declaration!.id)).size).toBe(1);
    expect(new Set(serializer.map(row => row.declaration!.id)).size).toBe(1);
    expect(writer[0]!.declaration!.id).not.toBe(serializer[0]!.declaration!.id);
    for (const row of baseline) {
      expect(row.target).toBe('definitions.ts');
      expect(row.declaration).toEqual({
        id: JSON.stringify(['definitions.ts', row.declaration!.line, row.declaration!.column, row.declaration!.name]),
        path: 'definitions.ts', name: row.declaration!.name, line: row.declaration!.line, column: row.declaration!.column,
      });
    }
    for (const order of [files, [...files].reverse()]) for (const compact of [false, true]) {
      expect(collect(order, compact, false)).toEqual(baseline);
      expect(collect(order, compact, true)).toEqual(baseline);
    }
  });
  it('keeps unresolved calls and incomplete export closure without declaration proof', () => {
    const sources: Record<string, string> = {
      'a.ts': 'export function target() {}', 'b.ts': 'export function target() {}',
      'barrel.ts': 'export * from "./a"; export * from "./b";',
      'shadow.ts': 'import { target } from "./a"; function run(target: any) { target(); }',
      'missing.ts': 'import { target } from "./absent"; target();',
      'ambiguous.ts': 'import { target } from "./barrel"; target();',
      'dynamic.ts': 'getTarget()();',
      'duplicate.ts': 'export function duplicate() {} export function duplicate() {} duplicate();',
      'duplicate-use.ts': 'import { duplicate } from "./duplicate"; duplicate();',
    };
    const collect = (input: Record<string, string>) => {
      const files = Object.keys(input), rows: Array<{ target: string | null; declaration: unknown }> = [];
      const snapshot = buildSymbolSnapshot({ files, censusOnly: true,
        readSource: (path: string) => input[path] ?? null,
        resolveModule: (path: string, spec: string) => relativeSymbolModule(path, spec, new Set(files)),
        callCensusSink: (_call: unknown, target: string | null, _index: number, declaration: unknown) => {
          rows.push({ target, declaration });
        },
      });
      return { rows, snapshot };
    };
    const unresolved = collect(sources);
    expect(unresolved.rows).toHaveLength(7);
    expect(unresolved.rows.every(row => row.target === null && row.declaration === null)).toBe(true);
    for (const depth of [31, 32, 33]) {
      const name = (index: number) => `chain-${String(index).padStart(3, '0')}`;
      const chain: Record<string, string> = {};
      for (let index = 0; index <= depth; index++) chain[name(index) + '.ts'] = index === depth
        ? 'export function target() {}' : `export * from "./${name(index + 1)}";`;
      chain['use.ts'] = `import { target } from "./${name(0)}"; target();`;
      const result = collect(chain);
      expect(result.rows).toHaveLength(1);
      expect(result.snapshot.stats.callCensusTruncated).toBe(depth >= 32);
      if (depth >= 32) expect(result.rows[0]!.declaration).toBeNull();
      else expect(result.rows[0]!.declaration).toMatchObject({ path: name(depth) + '.ts', name: 'target' });
    }
  });
  it('streams declaration proof past the caller summary boundary without losing call identities', () => {
    for (const count of [499, 500, 501]) {
      const rows: Array<{ index: number; declaration: unknown }> = [];
      const text = 'export function target() {}\n' + 'target();\n'.repeat(count);
      const snapshot = buildSymbolSnapshot({ files: ['target.ts'], readSource: () => text,
        resolveModule: () => null, censusOnly: true,
        callCensusSink: (_call: unknown, _target: string | null, index: number, declaration: unknown) => {
          rows.push({ index, declaration });
        },
      });
      expect(rows.map(row => row.index)).toEqual(Array.from({ length: count }, (_, index) => index));
      expect(rows.every(row => row.declaration !== null && row.declaration !== undefined)).toBe(true);
      expect(new Set(rows.map(row => JSON.stringify(row.declaration))).size).toBe(1);
      expect(snapshot.stats).toMatchObject({ callCensusTruncated: false, truncated: count > 500 });
    }
  });
  it('resolves a merged parse only after cross-partition exports and cycles are complete', () => {
    const sources: Record<string, string> = {
      'a.ts': 'import { alias } from "./barrel"; alias(); new (factory())();',
      'barrel.ts': 'export { target as alias } from "./target"; export * from "./cycle";',
      'cycle.ts': 'export * from "./barrel";',
      'target.ts': 'export function target() {} target();',
      'z.ts': 'new (unknown())();',
      'invalid.ts': 'function broken(',
    };
    const files = Object.keys(sources), fileSet = new Set(files);
    const input = { files, readSource: (path: string) => sources[path] ?? null,
      resolveModule: (path: string, spec: string) => relativeSymbolModule(path, spec, fileSet), censusOnly: true };
    const serial = buildSymbolSnapshot(input);
    const parts = [files.slice(0, 2), files.slice(2)].map(batch => parseSymbolSnapshot({ ...input, files: batch }));
    const parsed = { units: new Map(parts.flatMap(p => [...p.units])), symbols: new Map(parts.flatMap(p => [...p.symbols])),
      immediateCalls: parts.flatMap(p => p.immediateCalls), stats: { ...parts[0]!.stats } };
    for (const part of parts.slice(1)) for (const key of ['files', 'skippedFiles', 'unresolvedCalls'] as const) parsed.stats[key] += part.stats[key];
    expect(buildSymbolSnapshot({ ...input, parsed })).toEqual(serial);
    expect(serial.callCensus).toContainEqual(expect.objectContaining({ from: 'a.ts', to: 'target.ts', resolved: true }));
    expect(serial.stats.skippedFiles).toBe(1);
  });
  it('keeps compact measurement calls and completeness identical to the full brief snapshot', async () => {
    const sources: Record<string, string> = {
      'target.ts': 'export function target() {}\nfunction privateTarget() {} privateTarget();',
      'barrel.ts': 'export { target as renamed } from "./target";',
      'use.ts': 'import { renamed as alias } from "./barrel"; alias(); unknown(); new (factory())();',
      'namespace.ts': 'import * as ns from "./target"; ns.target();',
      'shadow.ts': 'import { target } from "./target"; function run(target: any) { target(); } target();',
      'invalid.ts': 'export function broken(',
      'positions.ts': 'import { target } from "./target";\n/* leading trivia */ target();\nnew (factory())();',
    };
    const files = Object.keys(sources), fileSet = new Set(files);
    const input = { files, readSource: (path: string) => sources[path] ?? null,
      resolveModule: (path: string, spec: string) => relativeSymbolModule(path, spec, fileSet), includeCallCensus: true };
    const full = buildSymbolSnapshot(input), compact = buildSymbolSnapshot({ ...input, censusOnly: true });
    expect(full.symbols.length).toBeGreaterThan(0);
    expect(compact.symbols).toEqual([]);
    expect(compact.callCensus).toEqual(full.callCensus);
    expect(compact.stats).toEqual(full.stats);
    expect(compact.stats.skippedFiles).toBe(1);
    expect(compact.knowledge).toEqual(full.knowledge);
    expect(compact.limitations).toEqual(full.limitations);
    const columns = createReuseCallColumns();
    const packed = buildSymbolSnapshot({ ...input, censusOnly: true, callCensusSink: columns.sink });
    expect(packed.callCensus).toEqual([]);
    expect(packed.stats).toEqual(full.stats);
    expect(await decodeReuseCallColumns(columns.finish())).toEqual(full.callCensus);
    expect(compact.callCensus).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/^positions\.ts:2:22:/), from: 'positions.ts', to: 'target.ts', resolved: true,
    }));
  });
  it('keeps the full call census complete when the compact caller summary reaches its cap', () => {
    const text = 'export function target() {}\n' + 'target();\n'.repeat(501);
    const input = { files: ['target.ts'], readSource: () => text, resolveModule: () => null, includeCallCensus: true };
    const full = buildSymbolSnapshot(input), compact = buildSymbolSnapshot({ ...input, censusOnly: true });
    expect(compact.callCensus).toEqual(full.callCensus);
    expect(compact.callCensus).toHaveLength(501);
    expect(compact.stats).toEqual(full.stats);
    expect(compact.stats).toMatchObject({ truncated: true, callCensusTruncated: false, resolvedCalls: 500 });
  });
  it('marks a non-converged export fixed point as incomplete for the call census', () => {
    const depth = 40;
    const files = Array.from({ length: depth + 1 }, (_, i) => `chain-${depth - i}.ts`).concat('use.ts');
    const sources: Record<string, string> = { 'chain-0.ts': 'export function target() {}',
      'use.ts': `import { target } from "./chain-${depth}"; target();` };
    for (let i = 1; i <= depth; i++) sources[`chain-${i}.ts`] = `export * from "./chain-${i - 1}";`;
    const fileSet = new Set(files);
    const snapshot = buildSymbolSnapshot({ files, readSource: path => sources[path] ?? null,
      resolveModule: (path, specifier) => relativeSymbolModule(path, specifier, fileSet), censusOnly: true });

    expect(snapshot.stats).toMatchObject({ truncated: true, callCensusTruncated: true });
    expect(snapshot.callCensus).toEqual([expect.objectContaining({ from: 'use.ts', to: null, resolved: false })]);
  });
  it('resolves aliases, barrel re-exports and namespace calls without matching comments or strings', () => {
    const result = build({
      'target.ts': 'export function target() {}',
      'barrel.ts': 'export { target as renamed } from "./target";',
      'use.ts': 'import { renamed as alias } from "./barrel"; alias(); // target()\nconst prose="target()";',
      'other.ts': 'import * as ns from "./target"; ns.target();',
    });
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].aliases.sort()).toEqual(['renamed', 'target']);
    expect(result.symbols[0].callers.map((x: { path: string }) => x.path).sort()).toEqual(['other.ts', 'use.ts']);
    expect(result.symbols[0].callers.every((x: { sha256: string }) => /^[a-f0-9]{64}$/.test(x.sha256))).toBe(true);
    expect(result.symbols[0].sources.map((x: { path: string }) => x.path).sort()).toEqual(['barrel.ts', 'other.ts', 'target.ts', 'use.ts']);
  });
  it('never assigns dynamic or shadowed calls, missing modules, or ambiguous star exports', () => {
    const result = build({
      'a.ts': 'export function target() {}', 'b.ts': 'export function target() {}',
      'barrel.ts': 'export * from "./a"; export * from "./b";',
      'shadow.ts': 'import { target } from "./a"; function run(target: any) { target(); }',
      'missing.ts': 'import { target } from "./absent"; target();',
      'ambiguous.ts': 'import { target } from "./barrel"; target();',
      'dynamic.ts': 'const receiver:any={}; receiver.target();',
    });
    expect(result.symbols.every((x: { callers: unknown[] }) => x.callers.length === 0)).toBe(true);
    expect(result.stats.unresolvedCalls).toBe(4);
    expect(result.limitations.join(' ')).toContain('lower bounds');
  });
  it('keeps default exports and local exported arrows source-pinned', () => {
    const result = build({ 'target.ts': 'export default function work() {}\nexport const arrow=()=>{}; arrow();',
      'use.ts': 'import run from "./target"; run();' });
    expect(result.symbols.find((x: { name: string }) => x.name === 'work')?.callers).toHaveLength(1);
    expect(result.symbols.find((x: { name: string }) => x.name === 'arrow')?.callers).toHaveLength(1);
  });
  it('distinguishes top-level declarations from nested shadow bindings', () => {
    const result = build({
      'target.ts': 'export function target() {}',
      'top.ts': 'export const local=()=>{}; local();',
      'nested.ts': 'import { target } from "./target"; { const target=()=>{}; target(); } target();',
      'binding.ts': 'import { target } from "./target"; function run({target}: any) { target(); } target();',
      'class.ts': 'import { target } from "./target"; function run() { class target {} new target(); } target();',
    });
    expect(result.symbols.find((x: { name: string }) => x.name === 'local')?.callers).toHaveLength(1);
    expect(result.symbols.find((x: { name: string }) => x.name === 'target')?.callers).toEqual([]);
    expect(result.stats).toMatchObject({ files: 5, skippedFiles: 0, resolvedCalls: 1, unresolvedCalls: 6, truncated: false });
  });
  it('keeps comment-only JSDoc syntax out of the runtime call census', () => {
    const result = build({
      'target.ts': '/** @template {unknown} T\n * @param {{value: T}} input\n * target(); import("./missing");\n */\nexport function target(input: unknown) {}',
      'use.ts': 'import { target } from "./target"; /** @type {ReturnType<typeof target>} */ const value=target(1);',
    });
    expect(result.stats).toMatchObject({ files: 2, skippedFiles: 0, resolvedCalls: 1, unresolvedCalls: 0, truncated: false });
    expect(result.symbols[0].callers).toEqual([expect.objectContaining({ path: 'use.ts', spelling: 'target' })]);
  });
  it('binds caller workspace names to maintained package manifests, including nested workspaces', () => {
    const sources: Record<string, string> = {
      'lib/target.ts': 'export function target() {}',
      'lib/package.json': '{"name":"@example/lib"}',
      'apps/nested/package.json': '{"name":"@example/nested"}',
      'apps/nested/use.ts': 'import { target } from "../../lib/target"; target();',
    };
    const files = Object.keys(sources);
    const result = buildSymbolSnapshot({ files, readSource: (file: string) => sources[file] ?? null,
      resolveModule: (file: string, spec: string) => relativeSymbolModule(file, spec, new Set(files)),
      workspacePackages: [['@example/lib', ['lib']], ['@example/parent', ['apps']], ['@example/nested', ['apps/nested']]] });
    expect(result.symbols[0]?.callers[0]?.workspace).toBe('@example/nested (apps/nested)');
    expect(result.symbols[0]?.sources.map((site: { path: string }) => site.path)).toContain('apps/nested/package.json');
  });
});
