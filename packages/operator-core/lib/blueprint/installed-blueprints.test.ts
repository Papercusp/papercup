/**
 * Tests for the operator's blueprint-distribution wiring: the installed-dir path
 * + the composed local→installed→built-in `extends` resolver.
 * Run with: cd packages/operator-core && npx vitest run lib/blueprint/installed-blueprints.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinBlueprintPath } from '@papercusp/orchestrator/blueprint';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rootMock = vi.hoisted(() => ({ fn: vi.fn(() => '/home/u/.papercusp') }));
vi.mock('../papercusp-root', () => ({ papercuspRoot: rootMock.fn }));
const inventoryMock = vi.hoisted(() => ({ builtinRoot: null as string | null,
  unreadable: null as string | null, disappear: null as string | null }));
vi.mock('@papercusp/orchestrator/blueprint', async importOriginal => {
  const actual = await importOriginal<typeof import('@papercusp/orchestrator/blueprint')>();
  return { ...actual, builtinBlueprintPath: (id: string) => inventoryMock.builtinRoot
    ? `${inventoryMock.builtinRoot}/${id}/blueprint.yaml` : actual.builtinBlueprintPath(id) };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
    if (args[0] === inventoryMock.disappear) actual.rmSync(inventoryMock.disappear, { recursive: true });
    return actual.readdirSync(...args);
  }, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (args[0] === inventoryMock.unreadable) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
    return actual.readFileSync(...args);
  } };
});

const composeMock = vi.hoisted(() => {
  const resolver = vi.fn((_id: string): string | null => null);
  return { fn: vi.fn(() => resolver), resolver };
});
vi.mock('@papercusp/blueprint-distribution', () => ({ makeComposedResolveExtends: composeMock.fn }));

import {
  INSTALLED_BLUEPRINTS_DIR,
  operatorResolveExtends,
  availableHiveBlueprintIds,
  availableBlueprintSources,
  readBlueprintSourcePopulation,
} from './installed-blueprints';

const tempRoots: string[] = [];

afterEach(() => {
  composeMock.fn.mockClear();
  rootMock.fn.mockReturnValue('/home/u/.papercusp');
  inventoryMock.builtinRoot = null;
  inventoryMock.unreadable = null;
  inventoryMock.disappear = null;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('complete blueprint library source inventory (P-002)', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'blueprint-population-'));
    tempRoots.push(root);
    rootMock.fn.mockReturnValue(root);
    const dirs = [join(root, 'builtin'), join(root, 'blueprints'), join(root, 'local')];
    inventoryMock.builtinRoot = dirs[0];
    for (const dir of dirs) {
      mkdirSync(join(dir, 'shared', 'prompts'), { recursive: true });
      writeFileSync(join(dir, 'shared', 'blueprint.yaml'), 'id: shared\nslots: []\n');
      writeFileSync(join(dir, 'shared', 'prompts', 'policy.md'), 'original');
    }
    const options = { localDirs: [dirs[2]] };
    const read = () => {
      const result = readBlueprintSourcePopulation(options);
      if (result.status !== 'ok') throw new Error('fixture inventory unavailable');
      return result;
    };
    return { root, dirs, options, read };
  }

  it('retains hidden tiers and malformed declarations without changing selected catalog precedence', () => {
    const { dirs, options, read } = fixture();
    writeFileSync(join(dirs[1], 'shared', 'blueprint.yaml'), 'malformed: [');
    const result = read();
    expect(result.sources.map(({ tier, selected }) => ({ tier, selected }))).toEqual([
      { tier: 'builtin', selected: false }, { tier: 'installed', selected: false }, { tier: 'local', selected: true },
    ]);
    expect(availableBlueprintSources(options)).toEqual([{ id: 'shared', tier: 'local', file: join(dirs[2], 'shared', 'blueprint.yaml') }]);
    expect(readBlueprintSourcePopulation({ ...options, expectedRevision: result.revision })).toEqual(result);
  });

  it.each([0, 1, 2])('detects same-size content edits in tier %i even with the original mtime', tier => {
    const { dirs, options, read } = fixture();
    const before = read();
    const file = join(dirs[tier], 'shared', 'prompts', 'policy.md');
    const original = statSync(file);
    writeFileSync(file, 'modified');
    utimesSync(file, original.atime, original.mtime);
    expect(readBlueprintSourcePopulation({ ...options, expectedRevision: before.revision })).toMatchObject({ status: 'stale' });
    expect(read().sources[tier].revision).not.toBe(before.sources[tier].revision);
  });

  it.each(['add', 'remove', 'empty-directory', 'release-metadata', 'dot-resource'])('detects %s outside the currently selected declaration', change => {
    const { dirs, options, read } = fixture();
    const before = read();
    if (change === 'add') writeFileSync(join(dirs[1], 'shared', 'new-resource.json'), '{}');
    if (change === 'remove') rmSync(join(dirs[0], 'shared', 'prompts', 'policy.md'));
    if (change === 'empty-directory') mkdirSync(join(dirs[2], 'empty-future-source'));
    if (change === 'dot-resource') writeFileSync(join(dirs[0], 'shared', 'prompts', '.git'), 'also source bytes');
    if (change === 'release-metadata') {
      mkdirSync(join(dirs[1], '.releases', 'shared'), { recursive: true });
      writeFileSync(join(dirs[1], '.releases', 'shared', 'index.json'), '{}');
    }
    expect(readBlueprintSourcePopulation({ ...options, expectedRevision: before.revision })).toMatchObject({ status: 'stale' });
    expect(read().sources.filter(source => source.selected).map(source => source.file))
      .toEqual(before.sources.filter(source => source.selected).map(source => source.file));
  });

  it('pins source additions, removals and changes in local-root precedence', () => {
    const { root, dirs, read } = fixture();
    const other = join(root, 'other');
    mkdirSync(join(other, 'shared'), { recursive: true });
    writeFileSync(join(other, 'shared', 'blueprint.yaml'), 'id: shared\n');
    const before = readBlueprintSourcePopulation({ localDirs: [dirs[2], other] });
    const reversed = readBlueprintSourcePopulation({ localDirs: [other, dirs[2]] });
    expect(before.status).toBe('ok');
    expect(reversed.status).toBe('ok');
    if (before.status !== 'ok' || reversed.status !== 'ok') throw new Error('fixture inventory unavailable');
    expect(reversed.revision).not.toBe(before.revision);
    if (reversed.status === 'ok') expect(reversed.sources.find(source => source.selected)?.file).toBe(join(other, 'shared', 'blueprint.yaml'));
    const initial = read();
    mkdirSync(join(dirs[1], 'additional'));
    writeFileSync(join(dirs[1], 'additional', 'blueprint.yaml'), 'id: additional\n');
    expect(read().sources).toHaveLength(initial.sources.length + 1);
    rmSync(join(dirs[1], 'additional'), { recursive: true });
    expect(read()).toEqual(initial);
  });

  it('distinguishes absent and empty roots and deduplicates repeated local roots', () => {
    const { root, dirs, read } = fixture();
    const empty = join(root, 'empty');
    const missing = join(root, 'missing');
    mkdirSync(empty);
    const result = readBlueprintSourcePopulation({ localDirs: [dirs[2], dirs[2], empty, missing] });
    if (result.status !== 'ok') throw new Error('fixture inventory unavailable');
    expect(result.roots.filter(entry => entry.root === dirs[2])).toHaveLength(1);
    expect(result.roots.find(entry => entry.root === empty)).toMatchObject({ state: 'present' });
    expect(result.roots.find(entry => entry.root === missing)).toMatchObject({ state: 'absent', canonicalRoot: null });
    expect(result.revision).not.toBe(read().revision);
  });

  it.each(['root', 'package', 'file'])('refuses a %s symlink instead of omitting or trusting it', kind => {
    const { root, dirs, options } = fixture();
    const target = join(root, 'external');
    writeFileSync(target, 'untrusted');
    if (kind === 'root') { rmSync(dirs[2], { recursive: true }); symlinkSync(dirs[1], dirs[2]); }
    if (kind === 'package') symlinkSync(join(dirs[0], 'shared'), join(dirs[2], 'linked'));
    if (kind === 'file') symlinkSync(target, join(dirs[2], 'shared', 'linked.md'));
    expect(readBlueprintSourcePopulation(options)).toMatchObject({ status: 'unavailable' });
  });

  it('refuses unreadable hidden data and invalid root/declaration types', () => {
    const { root, dirs, options } = fixture();
    inventoryMock.unreadable = join(dirs[0], 'shared', 'prompts', 'policy.md');
    expect(readBlueprintSourcePopulation(options)).toMatchObject({ status: 'unavailable', reason: 'fixture permission denied' });
    inventoryMock.unreadable = null;
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'invalid root');
    expect(readBlueprintSourcePopulation({ localDirs: [file] })).toMatchObject({ status: 'unavailable' });
    rmSync(join(dirs[2], 'shared', 'blueprint.yaml'));
    mkdirSync(join(dirs[2], 'shared', 'blueprint.yaml'));
    expect(readBlueprintSourcePopulation(options)).toMatchObject({ status: 'unavailable' });
  });

  it('refuses a root that disappears after traversal starts', () => {
    const { dirs, options } = fixture();
    inventoryMock.disappear = dirs[1];
    expect(readBlueprintSourcePopulation(options)).toMatchObject({ status: 'unavailable' });
    inventoryMock.disappear = null;
    const absent = readBlueprintSourcePopulation(options);
    if (absent.status !== 'ok') throw new Error('fixture inventory unavailable');
    expect(absent.roots.find(root => root.root === dirs[1])).toMatchObject({ state: 'absent' });
  });

  it('rejects malformed revision pins and keeps root identity in the revision', () => {
    const { dirs, options, read } = fixture();
    expect(() => readBlueprintSourcePopulation({ ...options, expectedRevision: '' })).toThrow('exact content revision');
    const withoutLocal = readBlueprintSourcePopulation({ localDirs: [] });
    if (withoutLocal.status !== 'ok') throw new Error('fixture inventory unavailable');
    expect(withoutLocal.revision).not.toBe(read().revision);
    expect(readBlueprintSourcePopulation({ localDirs: [...options.localDirs, dirs[2]] })).toEqual(read());
  });
});

describe('INSTALLED_BLUEPRINTS_DIR', () => {
  it('is <papercuspRoot>/blueprints', () => {
    expect(INSTALLED_BLUEPRINTS_DIR()).toBe('/home/u/.papercusp/blueprints');
  });
});

describe('operatorResolveExtends', () => {
  it('composes a resolver with the installed dir and no local dirs by default', () => {
    const out = operatorResolveExtends();
    expect(out).toBe(composeMock.resolver);
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
    composeMock.fn.mockReturnValueOnce(vi.fn((id: string) => {
      const installed = join(installedDir, id, 'blueprint.yaml');
      return existsSync(installed) ? installed : builtinBlueprintPath(id);
    }));

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
