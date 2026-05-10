import { describe, it, expect, beforeEach } from 'vitest';
import {
  installAdapter,
  uninstallAdapter,
  listAdapters,
  adaptersForEcosystem,
  pickAdapter,
  getAdapter,
  getAdapterFor,
  getAdapterWithCapability,
  supportsIrVersion,
  unionUiGlobs,
  AdapterConflictError,
  IrVersionMismatchError,
  AdapterConformanceError,
  assertAdapterConformant,
  checkAdapterConformant,
  _resetAdapterRegistryForTests,
  type DesignEcosystemAdapter,
} from './index';

function makeAdapter(overrides: Partial<DesignEcosystemAdapter> = {}): DesignEcosystemAdapter {
  return {
    id: 'test-adapter',
    displayName: 'Test',
    ecosystem: 'test-eco',
    capabilities: [],
    irVersionsSupported: ['0.x'],
    uiPaths: ['**/*.tsx'],
    ...overrides,
  };
}

beforeEach(() => {
  _resetAdapterRegistryForTests();
});

describe('install / uninstall / list', () => {
  it('installs and lists', () => {
    installAdapter(makeAdapter({ id: 'a' }));
    installAdapter(makeAdapter({ id: 'b', ecosystem: 'other-eco' }));
    expect(listAdapters().map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('replaces on duplicate id', () => {
    installAdapter(makeAdapter({ id: 'a', displayName: 'first' }));
    installAdapter(makeAdapter({ id: 'a', displayName: 'second' }));
    expect(listAdapters()).toHaveLength(1);
    expect(listAdapters()[0].displayName).toBe('second');
  });

  it('uninstalls and clears picks', () => {
    installAdapter(makeAdapter({ id: 'a' }));
    installAdapter(makeAdapter({ id: 'b' }));
    pickAdapter('test-eco', 'a');
    uninstallAdapter('a');
    expect(listAdapters().map((a) => a.id)).toEqual(['b']);
    expect(getAdapter('test-eco')?.id).toBe('b');
  });
});

describe('getAdapter / pickAdapter', () => {
  it('returns null when nothing claims an ecosystem', () => {
    expect(getAdapter('nope')).toBeNull();
  });

  it('returns the sole claimant when there is one', () => {
    installAdapter(makeAdapter({ id: 'only' }));
    expect(getAdapter('test-eco')?.id).toBe('only');
  });

  it('throws AdapterConflictError on multiple unpicked claimants', () => {
    installAdapter(makeAdapter({ id: 'a' }));
    installAdapter(makeAdapter({ id: 'b' }));
    expect(() => getAdapter('test-eco')).toThrow(AdapterConflictError);
  });

  it('honors explicit pick to disambiguate', () => {
    installAdapter(makeAdapter({ id: 'a' }));
    installAdapter(makeAdapter({ id: 'b' }));
    pickAdapter('test-eco', 'b');
    expect(getAdapter('test-eco')?.id).toBe('b');
  });

  it('pickAdapter throws on unknown id', () => {
    expect(() => pickAdapter('test-eco', 'nope')).toThrow();
  });
});

describe('supportsIrVersion', () => {
  it('matches exact', () => {
    expect(supportsIrVersion(makeAdapter({ irVersionsSupported: ['0.1'] }), '0.1')).toBe(true);
    expect(supportsIrVersion(makeAdapter({ irVersionsSupported: ['0.1'] }), '0.2')).toBe(false);
  });

  it('matches major.x range', () => {
    expect(supportsIrVersion(makeAdapter({ irVersionsSupported: ['0.x'] }), '0.5')).toBe(true);
    expect(supportsIrVersion(makeAdapter({ irVersionsSupported: ['0.x'] }), '1.0')).toBe(false);
  });

  it('combines multiple ranges', () => {
    const a = makeAdapter({ irVersionsSupported: ['0.x', '1.x'] });
    expect(supportsIrVersion(a, '0.7')).toBe(true);
    expect(supportsIrVersion(a, '1.3')).toBe(true);
    expect(supportsIrVersion(a, '2.0')).toBe(false);
  });
});

describe('getAdapterFor', () => {
  it('throws when ecosystem not covered', () => {
    expect(() => getAdapterFor('nope', '0.1')).toThrow();
  });

  it('throws IrVersionMismatchError when version unsupported', () => {
    installAdapter(makeAdapter({ irVersionsSupported: ['1.x'] }));
    expect(() => getAdapterFor('test-eco', '0.1')).toThrow(IrVersionMismatchError);
  });

  it('returns the adapter when version matches', () => {
    installAdapter(makeAdapter({ id: 'good', irVersionsSupported: ['0.x'] }));
    expect(getAdapterFor('test-eco', '0.1').id).toBe('good');
  });
});

describe('getAdapterWithCapability', () => {
  it('returns null when adapter lacks the capability', () => {
    installAdapter(makeAdapter({ capabilities: ['tokens'] }));
    expect(getAdapterWithCapability('test-eco', 'codeEmit')).toBeNull();
  });

  it('returns the adapter when capability declared', () => {
    installAdapter(makeAdapter({ capabilities: ['codeEmit'] }));
    expect(getAdapterWithCapability('test-eco', 'codeEmit')?.id).toBe('test-adapter');
  });
});

describe('unionUiGlobs', () => {
  it('unions and dedups across adapters', () => {
    installAdapter(makeAdapter({ id: 'a', uiPaths: ['**/*.tsx', '**/*.css'] }));
    installAdapter(
      makeAdapter({ id: 'b', ecosystem: 'other', uiPaths: ['**/*.css', '**/*.qml'] }),
    );
    const u = unionUiGlobs();
    expect(u.sort()).toEqual(['**/*.css', '**/*.qml', '**/*.tsx']);
  });
});

describe('conformance', () => {
  it('passes a minimal adapter with no capabilities', async () => {
    await expect(assertAdapterConformant(makeAdapter())).resolves.toBeUndefined();
  });

  it('fails when a declared capability is missing its surface', async () => {
    const a = makeAdapter({ capabilities: ['tokens'] });
    const failures = await checkAdapterConformant(a);
    expect(failures.some((f) => f.capability === 'tokens')).toBe(true);
  });

  it('fails when irVersionsSupported is empty', async () => {
    const a = makeAdapter({ irVersionsSupported: [] });
    const failures = await checkAdapterConformant(a);
    expect(failures.some((f) => /irVersionsSupported/.test(f.message))).toBe(true);
  });

  it('fails when adapter does not support the test IR version', async () => {
    const a = makeAdapter({ irVersionsSupported: ['1.x'] });
    const failures = await checkAdapterConformant(a, { testIrVersion: '0.1' });
    expect(failures.some((f) => /test IR version/.test(f.message))).toBe(true);
  });

  it('passes a registry adapter with a valid entry', async () => {
    const a = makeAdapter({
      capabilities: ['registry'],
      registry: {
        sourcePaths: ['libs/x/'],
        async listPrimitives() {
          return [
            {
              id: 'action.primary',
              kind: 'component',
              summary: 'CTA',
              ecosystems: {
                'test-eco': {
                  sourcePointer: { path: 'libs/x/Button.tsx' },
                },
              },
            },
          ];
        },
        async sourceFor() {
          return null;
        },
      },
    });
    await expect(assertAdapterConformant(a)).resolves.toBeUndefined();
  });

  it('fails when a registry entry lacks the adapter ecosystem', async () => {
    const a = makeAdapter({
      capabilities: ['registry'],
      registry: {
        sourcePaths: [],
        async listPrimitives() {
          return [
            {
              id: 'oops',
              kind: 'component' as const,
              summary: 's',
              ecosystems: { 'other-eco': { sourcePointer: { path: 'x' } } },
            },
          ];
        },
        async sourceFor() {
          return null;
        },
      },
    });
    const failures = await checkAdapterConformant(a);
    expect(failures.some((f) => /no source pointer for adapter's own ecosystem/.test(f.message))).toBe(true);
  });

  it('fails when tokens.emit returns nothing', async () => {
    const a = makeAdapter({
      capabilities: ['tokens'],
      tokens: { async emit() { return []; } },
    });
    const failures = await checkAdapterConformant(a);
    expect(failures.some((f) => f.capability === 'tokens')).toBe(true);
  });

  it('fails when codeEmit.fromIR returns nothing', async () => {
    const a = makeAdapter({
      capabilities: ['codeEmit'],
      codeEmit: { async fromIR() { return []; } },
    });
    const failures = await checkAdapterConformant(a);
    expect(failures.some((f) => f.capability === 'codeEmit')).toBe(true);
  });

  it('fails when exportTarget has no targetId', async () => {
    const a = makeAdapter({
      capabilities: ['exportTarget'],
      exportTarget: {
        targetId: '',
        async fromIR() { return {}; },
      },
    });
    const failures = await checkAdapterConformant(a);
    expect(failures.some((f) => f.capability === 'exportTarget')).toBe(true);
  });

  it('respects skip option', async () => {
    const a = makeAdapter({
      capabilities: ['tokens'],
      tokens: { async emit() { return []; } },
    });
    await expect(assertAdapterConformant(a, { skip: ['tokens'] })).resolves.toBeUndefined();
  });

  it('throws AdapterConformanceError on assert', async () => {
    const a = makeAdapter({ capabilities: ['tokens'] });
    await expect(assertAdapterConformant(a)).rejects.toBeInstanceOf(AdapterConformanceError);
  });
});

describe('adaptersForEcosystem', () => {
  it('returns only matching ecosystem adapters', () => {
    installAdapter(makeAdapter({ id: 'a' }));
    installAdapter(makeAdapter({ id: 'b' }));
    installAdapter(makeAdapter({ id: 'c', ecosystem: 'other' }));
    expect(adaptersForEcosystem('test-eco').map((a) => a.id).sort()).toEqual(['a', 'b']);
    expect(adaptersForEcosystem('other').map((a) => a.id)).toEqual(['c']);
  });
});
