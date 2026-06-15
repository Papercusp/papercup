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

import {
  INSTALLED_BLUEPRINTS_DIR,
  operatorResolveExtends,
  availableHiveBlueprintIds,
} from './installed-blueprints';

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

describe('availableHiveBlueprintIds (P-019 — the hive:create picker set)', () => {
  it('lists the built-in kind:hive blueprints and excludes kind:harness ones', () => {
    // Reads the REAL built-in blueprints dir (the install tier is mocked-empty).
    const hives = availableHiveBlueprintIds();
    expect(hives).toContain('hive');
    expect(hives).toContain('generic-hive');
    // research / coding are kind:harness — never offered as a hive template.
    expect(hives).not.toContain('research');
    expect(hives).not.toContain('coding');
  });
});
