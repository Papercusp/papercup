/**
 * Unit tests for the bundle-app manifest core
 * (cupboard-app-distribution-2026-07-14 P-008).
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPackCatalogView, type PackDescriptor } from '@papercusp/blueprint-distribution';
import type { DerivedPackCatalog } from './pack-catalog';
import { readBundleSource, writeBundleSource } from './bundle-app-install-io';
import {
  planBundleAppInstall,
  installBundleApp,
  type BundleAppManifest,
  type BundleHostState,
  type BundleAppInstallers,
} from './bundle-app-manifest';
import type { ResolveAndInstallResult } from './resolve-and-install';

function makeCatalog(installedNames: string[], cupboardNames: string[]): DerivedPackCatalog {
  const packs: PackDescriptor[] = [
    ...installedNames.map(
      (name): PackDescriptor => ({
        name,
        tools: [],
        events: [],
        kind: 'plugin',
        hasRuntime: true,
        source: 'installed',
      }),
    ),
    ...cupboardNames.map(
      (name): PackDescriptor => ({
        name,
        tools: [],
        events: [],
        kind: 'plugin',
        hasRuntime: false,
        source: 'cupboard',
        listingId: name,
      }),
    ),
  ];
  return {
    view: buildPackCatalogView(packs, new Set<string>()),
    packs,
    builtinTools: new Set<string>(),
    cupboardReachable: true,
  };
}

function makeHost(overrides: Partial<BundleHostState> = {}): BundleHostState {
  return {
    hasDatatype: vi.fn().mockResolvedValue(false),
    deriveCatalog: vi.fn().mockResolvedValue(makeCatalog([], [])),
    installedBlueprintSource: vi.fn().mockResolvedValue(null),
    installedTemplateSource: vi.fn().mockResolvedValue(null),
    installedRubricSource: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('planBundleAppInstall', () => {
  it('classifies a fully-new manifest as all clean', async () => {
    const manifest: BundleAppManifest = { name: 'demo', datatypes: ['dt.a'], plugins: ['plugin-x'], packs: ['pack-y'] };
    const host = makeHost({ deriveCatalog: vi.fn().mockResolvedValue(makeCatalog([], ['plugin-x', 'pack-y'])) });
    const review = await planBundleAppInstall(manifest, host);
    expect(review.conflicts).toEqual([]);
    expect(review.duplicates).toEqual([]);
    expect(review.clean.map((c) => c.ref).sort()).toEqual(['dt.a', 'pack-y', 'plugin-x']);
  });

  it('classifies already-present units as duplicates, not conflicts', async () => {
    const manifest: BundleAppManifest = {
      name: 'demo',
      datatypes: ['dt.a'],
      plugins: ['plugin-x'],
      blueprint: { id: 'bp.demo', githubUrl: 'https://github.com/org/repo' },
    };
    const host = makeHost({
      hasDatatype: vi.fn().mockResolvedValue(true),
      deriveCatalog: vi.fn().mockResolvedValue(makeCatalog(['plugin-x'], [])),
      installedBlueprintSource: vi.fn().mockResolvedValue('https://github.com/org/repo'),
    });
    const review = await planBundleAppInstall(manifest, host);
    expect(review.conflicts).toEqual([]);
    expect(review.duplicates.map((c) => c.ref).sort()).toEqual(['bp.demo', 'dt.a', 'plugin-x']);
    expect(review.clean).toEqual([]);
  });

  it('flags a blueprint id installed from a DIFFERENT source as a conflict', async () => {
    const manifest: BundleAppManifest = {
      name: 'demo',
      blueprint: { id: 'bp.demo', githubUrl: 'https://github.com/org/new-repo' },
    };
    const host = makeHost({ installedBlueprintSource: vi.fn().mockResolvedValue('https://github.com/org/old-repo') });
    const review = await planBundleAppInstall(manifest, host);
    expect(review.conflicts).toHaveLength(1);
    expect(review.conflicts[0]).toMatchObject({ kind: 'blueprint', ref: 'bp.demo', status: 'conflict' });
    expect(review.conflicts[0].detail).toContain('old-repo');
  });

  it('classifies multiple blueprints, templates, and rubrics with source-aware duplicates', async () => {
    const manifest: BundleAppManifest = {
      name: 'content bundle',
      blueprints: [
        { id: 'bp.one', githubUrl: 'https://github.com/org/content', listingRef: 'blueprints/one' },
        { id: 'bp.two', githubUrl: 'https://github.com/org/content', listingRef: 'blueprints/two' },
      ],
      templates: [{ id: 'tpl.one', githubUrl: 'https://github.com/org/content', listingRef: 'templates/one' }],
      rubrics: [{ id: 'rubric.one', githubUrl: 'https://github.com/org/content', listingRef: 'rubrics/one' }],
    };
    const host = makeHost({
      installedBlueprintSource: vi.fn(async (unit) =>
        unit.id === 'bp.one' ? 'https://github.com/org/content#blueprints/one' : null,
      ),
      installedRubricSource: vi.fn().mockResolvedValue('https://github.com/org/elsewhere#rubrics/one'),
    });
    const review = await planBundleAppInstall(manifest, host);
    expect(review.duplicates).toEqual([
      expect.objectContaining({ kind: 'blueprint', ref: 'bp.one', status: 'duplicate' }),
    ]);
    expect(review.clean.map(({ kind, ref }) => `${kind}:${ref}`)).toEqual(['blueprint:bp.two', 'template:tpl.one']);
    expect(review.conflicts).toEqual([
      expect.objectContaining({ kind: 'rubric', ref: 'rubric.one', status: 'conflict' }),
    ]);
  });

  it('blocks a manifest that declares the same content id from different sources', async () => {
    const review = await planBundleAppInstall(
      {
        name: 'ambiguous',
        templates: [
          { id: 'tpl.one', githubUrl: 'https://github.com/org/one' },
          { id: 'tpl.one', githubUrl: 'https://github.com/org/two' },
        ],
      },
      makeHost(),
    );
    expect(review.conflicts).toEqual([
      expect.objectContaining({ kind: 'template', ref: 'tpl.one', status: 'conflict' }),
    ]);
  });

  it('never classifies the reserved surfaces field (no installer exists for it)', async () => {
    const manifest: BundleAppManifest = { name: 'demo', surfaces: [{ anything: 'goes' }] };
    const host = makeHost();
    const review = await planBundleAppInstall(manifest, host);
    expect(review.clean).toEqual([]);
    expect(review.duplicates).toEqual([]);
    expect(review.conflicts).toEqual([]);
  });
});

describe('installBundleApp', () => {
  const okDeps: ResolveAndInstallResult = {
    ok: true,
    installed: [],
    stillMissing: { tools: [], packs: [], plugins: [], events: [] },
    advisory: [],
    rounds: 0,
  };

  function makeInstallers(overrides: Partial<BundleAppInstallers> = {}): BundleAppInstallers {
    return {
      resolveAndInstallDeps: vi.fn().mockResolvedValue(okDeps),
      installDatatype: vi.fn().mockResolvedValue({ ok: true }),
      installBlueprint: vi.fn().mockResolvedValue({ ok: true }),
      installTemplate: vi.fn().mockResolvedValue({ ok: true }),
      installRubric: vi.fn().mockResolvedValue({ ok: true }),
      ...overrides,
    };
  }

  it('refuses to install anything when the review finds an unresolved conflict', async () => {
    const manifest: BundleAppManifest = {
      name: 'demo',
      blueprint: { id: 'bp.demo', githubUrl: 'https://github.com/org/new' },
    };
    const host = makeHost({ installedBlueprintSource: vi.fn().mockResolvedValue('https://github.com/org/old') });
    const installers = makeInstallers();
    const res = await installBundleApp(manifest, host, installers);
    expect(res).toMatchObject({ ok: false, blockedByConflicts: true, deps: null, datatypes: [], blueprint: null });
    expect(installers.resolveAndInstallDeps).not.toHaveBeenCalled();
    expect(installers.installDatatype).not.toHaveBeenCalled();
    expect(installers.installBlueprint).not.toHaveBeenCalled();
    expect(installers.installTemplate).not.toHaveBeenCalled();
    expect(installers.installRubric).not.toHaveBeenCalled();
  });

  it('installs the clean set via the injected per-kind installers when there are no conflicts', async () => {
    const manifest: BundleAppManifest = {
      name: 'demo',
      datatypes: ['dt.a', 'dt.b'],
      plugins: ['plugin-x'],
      packs: ['pack-y'],
      blueprint: { id: 'bp.demo', githubUrl: 'https://github.com/org/repo' },
    };
    const host = makeHost();
    const installers = makeInstallers();
    const res = await installBundleApp(manifest, host, installers);
    expect(res.ok).toBe(true);
    expect(res.blockedByConflicts).toBe(false);
    expect(installers.resolveAndInstallDeps).toHaveBeenCalledWith({ packs: ['pack-y'], plugins: ['plugin-x'] });
    expect(installers.installDatatype).toHaveBeenCalledWith('dt.a');
    expect(installers.installDatatype).toHaveBeenCalledWith('dt.b');
    expect(installers.installBlueprint).toHaveBeenCalledWith(manifest.blueprint);
    expect(res.datatypes).toEqual([
      { id: 'dt.a', ok: true },
      { id: 'dt.b', ok: true },
    ]);
    expect(res.blueprint).toEqual({ id: 'bp.demo', ok: true });
  });

  it('fans multiple content units out once each while keeping the legacy blueprint result', async () => {
    const first = { id: 'bp.one', githubUrl: 'https://github.com/org/content', listingRef: 'blueprints/one' };
    const second = { id: 'bp.two', githubUrl: 'https://github.com/org/content', listingRef: 'blueprints/two' };
    const template = { id: 'tpl.one', githubUrl: 'https://github.com/org/content', listingRef: 'templates/one' };
    const rubric = { id: 'rubric.one', githubUrl: 'https://github.com/org/content', listingRef: 'rubrics/one' };
    const manifest: BundleAppManifest = {
      name: 'content bundle',
      blueprint: first,
      blueprints: [first, second],
      templates: [template],
      rubrics: [rubric],
    };
    const installers = makeInstallers();
    const res = await installBundleApp(manifest, makeHost(), installers);
    expect(res.ok).toBe(true);
    expect(installers.installBlueprint).toHaveBeenCalledTimes(2);
    expect(installers.installBlueprint).toHaveBeenNthCalledWith(1, first);
    expect(installers.installBlueprint).toHaveBeenNthCalledWith(2, second);
    expect(installers.installTemplate).toHaveBeenCalledWith(template);
    expect(installers.installRubric).toHaveBeenCalledWith(rubric);
    expect(res.blueprint).toEqual({ id: 'bp.one', ok: true });
    expect(res.blueprints).toEqual([
      { id: 'bp.one', ok: true },
      { id: 'bp.two', ok: true },
    ]);
    expect(res.templates).toEqual([{ id: 'tpl.one', ok: true }]);
    expect(res.rubrics).toEqual([{ id: 'rubric.one', ok: true }]);
  });

  it('proceeds when allowConflicts:true is explicitly set, and surfaces the review anyway', async () => {
    const manifest: BundleAppManifest = {
      name: 'demo',
      blueprint: { id: 'bp.demo', githubUrl: 'https://github.com/org/new' },
    };
    const host = makeHost({ installedBlueprintSource: vi.fn().mockResolvedValue('https://github.com/org/old') });
    const installers = makeInstallers();
    const res = await installBundleApp(manifest, host, installers, { allowConflicts: true });
    expect(res.blockedByConflicts).toBe(false);
    expect(res.review.conflicts).toHaveLength(1);
    expect(installers.installBlueprint).toHaveBeenCalled();
  });

  it('reports ok:false (without blocking) when an individual installer fails partway through', async () => {
    const manifest: BundleAppManifest = { name: 'demo', datatypes: ['dt.a'] };
    const host = makeHost();
    const installers = makeInstallers({ installDatatype: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }) });
    const res = await installBundleApp(manifest, host, installers);
    expect(res.ok).toBe(false);
    expect(res.blockedByConflicts).toBe(false);
    expect(res.datatypes).toEqual([{ id: 'dt.a', ok: false, error: 'boom' }]);
  });

  it('skips duplicates by including them in the resolve fan-out call unchanged (resolveAndInstallDeps itself is idempotent)', async () => {
    // duplicates are not filtered out of the call — resolveAndInstallDeps already
    // treats an installed unit as satisfied (see resolve-and-install.ts classify()),
    // so this core does not need to duplicate that skip logic for packs/plugins.
    const manifest: BundleAppManifest = { name: 'demo', plugins: ['plugin-x'] };
    const host = makeHost({ deriveCatalog: vi.fn().mockResolvedValue(makeCatalog(['plugin-x'], [])) });
    const installers = makeInstallers();
    const res = await installBundleApp(manifest, host, installers);
    expect(res.review.duplicates.map((c) => c.ref)).toEqual(['plugin-x']);
    expect(installers.resolveAndInstallDeps).toHaveBeenCalledWith({ packs: [], plugins: ['plugin-x'] });
  });
});

describe('bundle content source provenance', () => {
  it('distinguishes absent, unknown, and matching installed sources durably', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'bundle-source-'));
    const installed = join(root, 'template.demo');
    try {
      expect(await readBundleSource(installed, 'template.yaml')).toBeNull();
      await fs.mkdir(installed, { recursive: true });
      await fs.writeFile(join(installed, 'template.yaml'), 'id: template.demo\n', 'utf8');
      expect(await readBundleSource(installed, 'template.yaml')).toBe('unknown (not installed via a bundle app)');

      const unit = {
        id: 'template.demo',
        githubUrl: 'https://github.com/org/content',
        listingRef: 'templates/demo',
      };
      await writeBundleSource(installed, unit);
      expect(await readBundleSource(installed, 'template.yaml')).toBe('https://github.com/org/content#templates/demo');
      expect(JSON.parse(await fs.readFile(join(installed, '.papercusp-bundle-source.json'), 'utf8'))).toMatchObject({
        source: 'https://github.com/org/content#templates/demo',
        githubUrl: 'https://github.com/org/content',
        listingRef: 'templates/demo',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
