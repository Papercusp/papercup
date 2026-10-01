import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPORT_INDEX, entryModule, exportIndex } from '../../../../scripts/gen-borrowable-catalog.mjs';

/**
 * The "Export index" section of BORROWABLE.md (shared-vector-search-libraries
 * -2026-09-29 R-15: every export the plan added must be findable in the
 * catalog). The index is parsed from each library's entry module, so these
 * tests pin the parser: a fixture library uses every export form, and for
 * the real indexed libraries the parsed names must equal what the TypeScript
 * checker says the entry module exports.
 */

const REPO = resolve(__dirname, '../../../..');

interface Group {
  label: string;
  external: boolean;
  values: string[];
  types: string[];
  wholesale: boolean;
}

const tmp = mkdtempSync(join(tmpdir(), 'borrowable-export-index-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fixtureLib(files: Record<string, string>, pkg: object = { name: '@fixture/lib', exports: { '.': { types: './src/index.ts' } } }): string {
  const dir = mkdtempSync(join(tmp, 'lib-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

function checkerExportNames(entry: string): string[] {
  const program = ts.createProgram([entry], {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(entry);
  if (!sf) throw new Error(`no source file for ${entry}`);
  const symbol = checker.getSymbolAtLocation(sf);
  if (!symbol) throw new Error(`no module symbol for ${entry}`);
  return checker.getExportsOfModule(symbol).map((s) => s.getName());
}

describe('exportIndex on a fixture library', () => {
  const dir = fixtureLib({
    'src/index.ts': [
      "export * from './star';",
      "export { renamedFn as publicFn, LocalShape } from './named';",
      "export type { OnlyType } from './named';",
      "export { type InlineType, plainValue } from './named';",
      "export * as helpers from './helpers';",
      "export { fromPkg, type PkgType } from 'some-pkg';",
      "export * from 'whole-pkg';",
      'export function declaredFn(): number { return 1; }',
      'export const DECLARED_CONST = 2;',
      'export interface DeclaredIface { a: number }',
      'const hidden = 3;',
      'export { hidden as exposedLocal };',
    ].join('\n'),
    'src/star.ts': "export const starValue = 1;\nexport type StarType = string;\nexport * from './deeper.js';\nexport default 5;\n",
    'src/deeper.ts': 'export class DeeperClass {}\nexport enum DeeperEnum { A }\n',
    'src/named.ts': [
      'export function renamedFn(): void {}',
      'export interface LocalShape { x: number }',
      'export type OnlyType = number;',
      'export type InlineType = boolean;',
      'export const plainValue = 0;',
    ].join('\n'),
    'src/helpers.ts': 'export const h = 1;\n',
  });

  const { entry, groups } = exportIndex(dir) as { entry: string; groups: Group[] };
  const byLabel = new Map(groups.map((g) => [g.label, g]));

  it('resolves the entry from package.json exports', () => {
    expect(entry).toBe(join(dir, 'src/index.ts'));
  });

  it("follows `export *` through nested relative modules and drops the re-exported module's default", () => {
    const star = byLabel.get('./star');
    expect(star?.values.sort()).toEqual(['DeeperClass', 'DeeperEnum', 'starValue']);
    expect(star?.types).toEqual(['StarType']);
  });

  it('classifies named re-exports by the declaration they point at, and uses the exported (aliased) name', () => {
    const named = byLabel.get('./named');
    expect(named?.values).toEqual(['publicFn', 'plainValue']);
    expect(named?.types).toEqual(['LocalShape', 'OnlyType', 'InlineType']);
  });

  it('lists a namespace re-export as one value', () => {
    expect(byLabel.get('./helpers')?.values).toEqual(['helpers']);
  });

  it('marks packages re-exported by name and wholesale as external', () => {
    expect(byLabel.get('some-pkg')).toMatchObject({ external: true, values: ['fromPkg'], types: ['PkgType'], wholesale: false });
    expect(byLabel.get('whole-pkg')).toMatchObject({ external: true, wholesale: true });
  });

  it('groups names the entry declares or exports locally', () => {
    const local = byLabel.get('entry');
    expect(local?.values).toEqual(['declaredFn', 'DECLARED_CONST', 'exposedLocal']);
    expect(local?.types).toEqual(['DeclaredIface']);
  });

  it('agrees with the TypeScript checker on the full name set (packages the fixture cannot resolve aside)', () => {
    const parsed = groups.filter((g) => !g.external).flatMap((g) => [...g.values, ...g.types]);
    const checker = checkerExportNames(entry).filter((n) => !['fromPkg', 'PkgType'].includes(n));
    expect(parsed.sort()).toEqual(checker.sort());
  });
});

describe('exportIndex failure modes', () => {
  it('refuses an unresolvable relative re-export instead of omitting its names', () => {
    const dir = fixtureLib({ 'src/index.ts': "export { gone } from './missing';\n" });
    expect(() => exportIndex(dir)).toThrow(/cannot resolve re-export '.\/missing'/);
  });

  it('refuses a library with no TypeScript entry', () => {
    const dir = fixtureLib({ 'lib/index.js': 'module.exports = {};\n' }, { name: '@fixture/js', main: './lib/index.js' });
    expect(entryModule(dir)).toBeNull();
    expect(() => exportIndex(dir)).toThrow(/no TypeScript entry module/);
  });
});

describe('exportIndex on the indexed libraries', () => {
  it('indexes @papercusp/search and @papercusp/search-core', () => {
    expect([...EXPORT_INDEX].sort()).toEqual(['libs/generic/search', 'libs/generic/search-core']);
  });

  for (const lib of EXPORT_INDEX) {
    it(`${lib}: the parsed export names equal the TypeScript checker's exports of the entry module`, () => {
      const { entry, groups } = exportIndex(join(REPO, lib)) as { entry: string; groups: Group[] };
      const parsed = groups.flatMap((g) => [...g.values, ...g.types]);
      expect(groups.some((g) => g.wholesale)).toBe(false);
      expect(new Set(parsed).size).toBe(parsed.length);
      expect(parsed.sort()).toEqual(checkerExportNames(entry).sort());
    });
  }
});
