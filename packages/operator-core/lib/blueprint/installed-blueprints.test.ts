/**
 * Tests for the operator's blueprint-distribution wiring: the installed-dir path
 * + the composed local→installed→built-in `extends` resolver.
 * Run with: cd packages/operator-core && npx vitest run lib/blueprint/installed-blueprints.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const rootMock = vi.hoisted(() => ({ fn: vi.fn(() => '/home/u/.papercusp') }));
vi.mock('../papercusp-root', () => ({ papercuspRoot: rootMock.fn }));

const composeMock = vi.hoisted(() => ({ fn: vi.fn(() => 'RESOLVER') }));
vi.mock('@papercusp/blueprint-distribution', () => ({ makeComposedResolveExtends: composeMock.fn }));

import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from './installed-blueprints';

afterEach(() => composeMock.fn.mockClear());

describe('INSTALLED_BLUEPRINTS_DIR', () => {
  it('is <papercuspRoot>/blueprints', () => {
    expect(INSTALLED_BLUEPRINTS_DIR()).toBe('/home/u/.papercusp/blueprints');
  });
});

describe('operatorResolveExtends', () => {
  it('composes a resolver with the installed dir and no local dirs by default', () => {
    const out = operatorResolveExtends();
    expect(out).toBe('RESOLVER');
    expect(composeMock.fn).toHaveBeenCalledWith({
      localDirs: [],
      installedDir: '/home/u/.papercusp/blueprints',
    });
  });

  it('threads through caller-supplied local dirs', () => {
    operatorResolveExtends({ localDirs: ['/repo/.papercusp/blueprints'] });
    expect(composeMock.fn).toHaveBeenCalledWith({
      localDirs: ['/repo/.papercusp/blueprints'],
      installedDir: '/home/u/.papercusp/blueprints',
    });
  });
});
