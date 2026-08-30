/**
 * Tests for mock-import-coverage.ts (EI-19362106022997577).
 *
 * The guard's whole value is that it FAILS when a factory goes stale, so the
 * discrimination cases below are the point of this file, not an afterthought: each
 * "detects" test is a permanently-resident deliberately-wrong control, paired with a
 * calibration case the correct input must pass. Without both halves a broken guard and
 * a healthy subject look identical.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  importedNamesFrom,
  requiredImportNames,
  analyzeMockCoverage,
  assertMockCoversImports,
  MockCoverageGuardError,
} from './mock-import-coverage';

const SPEC = 'events/await/store';

describe('importedNamesFrom', () => {
  it('parses a multi-line import block', () => {
    const src = `
import {
  registerAwait,
  cancelAwait,
  probePatternMatchScope,
} from '../../events/await/store';
`;
    expect(importedNamesFrom(src, SPEC)).toEqual(['registerAwait', 'cancelAwait', 'probePatternMatchScope']);
  });

  it('parses a single-line import', () => {
    const src = `import { registerAnnouncement, findNearMissKeys } from '../../events/await/store';`;
    expect(importedNamesFrom(src, SPEC)).toEqual(['registerAnnouncement', 'findNearMissKeys']);
  });

  it('aggregates across several import statements from the same module', () => {
    const src = `
import { a } from '../../events/await/store';
import { b, c } from './store';
`;
    // './store' does not end with the full specifier, so only the first matches.
    expect(importedNamesFrom(src, SPEC)).toEqual(['a']);
  });

  it('returns the ORIGINAL name for an aliased import (that is what the mock must expose)', () => {
    const src = `import { realName as localAlias } from '../../events/await/store';`;
    expect(importedNamesFrom(src, SPEC)).toEqual(['realName']);
  });

  it('excludes a whole type-only import statement', () => {
    const src = `import type { SomeType } from '../../events/await/store';`;
    expect(importedNamesFrom(src, SPEC)).toEqual([]);
  });

  it('excludes an inline type specifier but keeps its value siblings', () => {
    const src = `import { realValue, type SomeType } from '../../events/await/store';`;
    expect(importedNamesFrom(src, SPEC)).toEqual(['realValue']);
  });

  it('ignores commented-out names inside the block', () => {
    const src = `
import {
  kept, // trailing note
  // removedForNow,
  /* alsoNotReal, */
  alsoKept,
} from '../../events/await/store';
`;
    expect(importedNamesFrom(src, SPEC)).toEqual(['kept', 'alsoKept']);
  });

  it('matches double-quoted specifiers', () => {
    const src = `import { q } from "../../events/await/store";`;
    expect(importedNamesFrom(src, SPEC)).toEqual(['q']);
  });

  it('does not match a different module', () => {
    const src = `import { unrelated } from '../../events/await/compose-store';`;
    expect(importedNamesFrom(src, SPEC)).toEqual([]);
  });

  it('treats regex metacharacters in the specifier literally', () => {
    const src = `import { x } from './a.b/store';`;
    // '.' must not act as a wildcard: 'aXb/store' must NOT match a query for 'a.b/store'.
    expect(importedNamesFrom(`import { x } from './aXb/store';`, 'a.b/store')).toEqual([]);
    expect(importedNamesFrom(src, 'a.b/store')).toEqual(['x']);
  });
});

describe('coverage assertions against real files', () => {
  let dir: string;
  let importerUrl: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-import-coverage-'));
    writeFileSync(
      join(dir, 'handler.ts'),
      `import { alpha, beta, gamma } from '../../events/await/store';\n`,
      'utf8',
    );
    writeFileSync(join(dir, 'other.ts'), `import { delta } from '../../events/await/store';\n`, 'utf8');
    writeFileSync(join(dir, 'nothing.ts'), `export const x = 1;\n`, 'utf8');
    // The URL is resolved as a base, so it must point AT a file in the dir.
    importerUrl = pathToFileURL(join(dir, 'suite.test.ts')).href;
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const query = (sources: string[], expectNames?: string[]) => ({
    importerUrl,
    sources,
    moduleSpecifier: SPEC,
    ...(expectNames ? { expectNames } : {}),
  });

  it('aggregates required names across several sources', () => {
    expect(requiredImportNames(query(['./handler.ts', './other.ts']))).toEqual([
      'alpha',
      'beta',
      'gamma',
      'delta',
    ]);
  });

  it('CALIBRATION: passes when the mock covers every imported name', () => {
    const mock = { alpha: 1, beta: 2, gamma: 3, extraIsFine: 4 };
    expect(() => assertMockCoversImports(mock, query(['./handler.ts']))).not.toThrow();
  });

  it('DETECTS a stale factory, naming the missing exports', () => {
    const stale = { alpha: 1 }; // beta + gamma were added to production later
    expect(() => assertMockCoversImports(stale, query(['./handler.ts']))).toThrow(/missing 2 export/);
    expect(() => assertMockCoversImports(stale, query(['./handler.ts']))).toThrow(/beta, gamma/);
  });

  it('reports the gap without throwing via analyzeMockCoverage', () => {
    expect(analyzeMockCoverage({ alpha: 1 }, query(['./handler.ts']))).toEqual({
      required: ['alpha', 'beta', 'gamma'],
      provided: ['alpha'],
      missing: ['beta', 'gamma'],
    });
  });

  it('ANTI-VACUITY: refuses to pass when it parsed nothing to check', () => {
    // The failure this exists to prevent: a guard pointed at the wrong source or
    // specifier finds zero imports, trivially satisfies "nothing missing", and passes
    // forever while checking nothing.
    expect(() => assertMockCoversImports({}, query(['./nothing.ts']))).toThrow(MockCoverageGuardError);
    expect(() => assertMockCoversImports({}, query(['./nothing.ts']))).toThrow(/parsed ZERO imports/);
  });

  it('ANTI-VACUITY: a wrong module specifier is an error, not a pass', () => {
    expect(() =>
      assertMockCoversImports({}, { importerUrl, sources: ['./handler.ts'], moduleSpecifier: 'not/a/real/module' }),
    ).toThrow(MockCoverageGuardError);
  });

  it('ANTI-VACUITY: an unreadable source fails loudly instead of being skipped', () => {
    expect(() => assertMockCoversImports({}, query(['./moved-away.ts']))).toThrow(MockCoverageGuardError);
    expect(() => assertMockCoversImports({}, query(['./moved-away.ts']))).toThrow(/cannot read source/);
  });

  it('ANTI-VACUITY: an empty source list is an error', () => {
    expect(() => assertMockCoversImports({}, query([]))).toThrow(MockCoverageGuardError);
  });

  it('positive control passes when the named import is genuinely present', () => {
    const mock = { alpha: 1, beta: 2, gamma: 3 };
    expect(() => assertMockCoversImports(mock, query(['./handler.ts'], ['beta']))).not.toThrow();
  });

  it('DETECTS a parse that matched the wrong thing, via the positive control', () => {
    const mock = { alpha: 1, beta: 2, gamma: 3 };
    expect(() => assertMockCoversImports(mock, query(['./handler.ts'], ['neverImported']))).toThrow(
      MockCoverageGuardError,
    );
    expect(() => assertMockCoversImports(mock, query(['./handler.ts'], ['neverImported']))).toThrow(
      /positive control/,
    );
  });
});
