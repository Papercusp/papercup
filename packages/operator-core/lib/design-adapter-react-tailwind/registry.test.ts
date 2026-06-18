import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeReactTailwindRegistry, _CURATED_FOR_TESTS } from './registry';

describe('makeReactTailwindRegistry', () => {
  const reg = makeReactTailwindRegistry({ sourcePaths: ['libs/papercusp'] });

  it('passes sourcePaths through', () => {
    expect(reg.sourcePaths).toEqual(['libs/papercusp']);
  });

  it('listPrimitives returns the curated set', async () => {
    expect(await reg.listPrimitives()).toBe(_CURATED_FOR_TESTS);
  });

  it('sourceFor returns the react-tailwind source pointer for a known id', async () => {
    expect(await reg.sourceFor('action.primary')).toEqual({
      path: 'apps/operator/app/harness/Button.tsx',
      symbol: 'Button',
    });
  });

  it('sourceFor returns null for an unknown id', async () => {
    expect(await reg.sourceFor('does.not.exist')).toBeNull();
  });
});

describe('curated registry invariants', () => {
  it('has unique primitive ids', () => {
    const ids = _CURATED_FOR_TESTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry binds the react-tailwind ecosystem with a source pointer + import hint', () => {
    for (const e of _CURATED_FOR_TESTS) {
      const eco = e.ecosystems['react-tailwind'];
      expect(eco).toBeDefined();
      expect(eco!.sourcePointer.path.length).toBeGreaterThan(0);
      expect(eco!.importHint).toMatch(/^import /);
    }
  });

  it('never points implementers at retired UI code', () => {
    for (const e of _CURATED_FOR_TESTS) {
      const pointer = e.ecosystems['react-tailwind']?.sourcePointer.path ?? '';
      expect(pointer).not.toContain('/_retired/');
      expect(pointer).not.toContain('_retired/');
      expect(e.ecosystems['react-tailwind']?.importHint ?? '').not.toContain('@papercusp/ui');
    }
  });

  it('points at files that exist in the live repo', () => {
    const repoRoot = resolve(__dirname, '../../../..');
    for (const e of _CURATED_FOR_TESTS) {
      const pointer = e.ecosystems['react-tailwind']!.sourcePointer.path;
      expect(existsSync(resolve(repoRoot, pointer)), pointer).toBe(true);
    }
  });

  it('every entry has at least one required input', () => {
    for (const e of _CURATED_FOR_TESTS) {
      expect(e.inputs.some((i) => i.required)).toBe(true);
    }
  });
});
