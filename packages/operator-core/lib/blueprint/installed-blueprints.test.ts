/**
 * Tests for the operator's blueprint-distribution wiring: the installed-dir path
 * + the composed local→installed→built-in `extends` resolver.
 * Run with: cd packages/operator-core && npx vitest run lib/blueprint/installed-blueprints.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinBlueprintPath } from '@papercusp/orchestrator/blueprint';
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

const tempRoots: string[] = [];

afterEach(() => {
  composeMock.fn.mockClear();
  rootMock.fn.mockReturnValue('/home/u/.papercusp');
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

describe('availableHiveBlueprintIds (P-019 — the pot:create picker set)', () => {
  it('lists live pot blueprints and excludes direct or inherited retirement', () => {
    const root = mkdtempSync(join(tmpdir(), 'installed-blueprints-'));
    tempRoots.push(root);
    rootMock.fn.mockReturnValue(root);
    const installedDir = join(root, 'blueprints');
    const livePotDir = join(installedDir, 'installed-live-pot');
    mkdirSync(livePotDir, { recursive: true });
    writeFileSync(join(livePotDir, 'blueprint.yaml'), [
      'id: installed-live-pot',
      'extends: coding',
      'kind: pot',
      'version: 0.1.0',
      'retired: null',
      '',
    ].join('\n'));
    composeMock.fn.mockReturnValueOnce((id: string) => {
      const installed = join(installedDir, id, 'blueprint.yaml');
      return existsSync(installed) ? installed : builtinBlueprintPath(id);
    });

    const hives = availableHiveBlueprintIds();
    expect(hives).toContain('installed-live-pot');
    // coding is retired directly; work inherits that retirement through extends.
    expect(hives).not.toContain('coding');
    expect(hives).not.toContain('work');
    // research / coding-factory are kind:harness — never offered as a hive template.
    expect(hives).not.toContain('research');
    expect(hives).not.toContain('coding-factory');
  });
});
