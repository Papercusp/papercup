/**
 * fetch/parse the bundle-app manifest (cupboard-app-distribution-2026-07-14
 * P-008, "REMAINING for done" item 1). `cloneRepo` is faked by copying a local
 * fixture dir — mirrors install-blueprint-core.test.ts's pattern.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchBundleManifest,
  parseBundleManifest,
  BundleManifestError,
  type FetchBundleManifestDeps,
} from './bundle-manifest-io';

let root: string;
let fixtureRepo: string;

function makeDeps(over: Partial<FetchBundleManifestDeps> = {}): FetchBundleManifestDeps {
  return {
    cloneRepo: async (_url, dest) => {
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
    tmpDir: () => root,
    ...over,
  };
}

const FULL_YAML = [
  'name: demo-bundle',
  'description: a demo bundle app',
  'datatypes: [dt.a, dt.b]',
  'packs: [pack-y]',
  'plugins: [plugin-x]',
  'blueprint:',
  '  id: bp.demo',
  '  githubUrl: https://github.com/org/bp-repo',
  'blueprints:',
  '  - id: bp.extra',
  '    githubUrl: https://github.com/org/content',
  '    listingRef: blueprints/extra',
  'templates:',
  '  - id: template.demo',
  '    githubUrl: https://github.com/org/content',
  '    listingRef: templates/demo',
  'rubrics:',
  '  - id: rubric.demo',
  '    githubUrl: https://github.com/org/content',
  '    listingRef: rubrics/demo',
].join('\n');

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'bundle-manifest-io-'));
  fixtureRepo = join(root, 'remote');
  await fs.mkdir(fixtureRepo, { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('parseBundleManifest', () => {
  it('parses a full manifest', () => {
    const m = parseBundleManifest(FULL_YAML);
    expect(m).toEqual({
      name: 'demo-bundle',
      description: 'a demo bundle app',
      datatypes: ['dt.a', 'dt.b'],
      packs: ['pack-y'],
      plugins: ['plugin-x'],
      blueprint: { id: 'bp.demo', githubUrl: 'https://github.com/org/bp-repo' },
      blueprints: [{ id: 'bp.extra', githubUrl: 'https://github.com/org/content', listingRef: 'blueprints/extra' }],
      templates: [{ id: 'template.demo', githubUrl: 'https://github.com/org/content', listingRef: 'templates/demo' }],
      rubrics: [{ id: 'rubric.demo', githubUrl: 'https://github.com/org/content', listingRef: 'rubrics/demo' }],
    });
  });

  it('parses a minimal manifest (name only)', () => {
    const m = parseBundleManifest('name: minimal');
    expect(m).toEqual({ name: 'minimal' });
  });

  it('rejects a manifest with no name', () => {
    expect(() => parseBundleManifest('description: nope')).toThrow(BundleManifestError);
  });

  it('rejects invalid YAML', () => {
    expect(() => parseBundleManifest('name: [unterminated')).toThrow(BundleManifestError);
  });

  it('rejects a non-array "datatypes"', () => {
    expect(() => parseBundleManifest('name: x\ndatatypes: not-an-array')).toThrow(BundleManifestError);
  });

  it('rejects a blueprint block missing githubUrl', () => {
    expect(() => parseBundleManifest('name: x\nblueprint:\n  id: bp.demo')).toThrow(BundleManifestError);
  });

  it.each(['blueprints', 'templates', 'rubrics'])('rejects malformed %s content units', (field) => {
    expect(() => parseBundleManifest(`name: x\n${field}:\n  - id: missing-source`)).toThrow(BundleManifestError);
    expect(() => parseBundleManifest(`name: x\n${field}: not-an-array`)).toThrow(BundleManifestError);
  });

  it('passes through a reserved "surfaces" array untouched', () => {
    const m = parseBundleManifest('name: x\nsurfaces: [{ kind: panel }]');
    expect(m.surfaces).toEqual([{ kind: 'panel' }]);
  });
});

describe('fetchBundleManifest', () => {
  it('finds bundle.yaml at the repo root', async () => {
    await fs.writeFile(join(fixtureRepo, 'bundle.yaml'), FULL_YAML, 'utf8');
    const m = await fetchBundleManifest({ githubUrl: 'https://github.com/org/repo' }, makeDeps());
    expect(m.name).toBe('demo-bundle');
    expect(m.blueprint?.id).toBe('bp.demo');
  });

  it('prefers the listingRef subdir over the root', async () => {
    await fs.writeFile(join(fixtureRepo, 'bundle.yaml'), 'name: root-bundle', 'utf8');
    await fs.mkdir(join(fixtureRepo, 'sub'), { recursive: true });
    await fs.writeFile(join(fixtureRepo, 'sub', 'bundle.yaml'), 'name: sub-bundle', 'utf8');
    const m = await fetchBundleManifest({ githubUrl: 'https://github.com/org/repo', listingRef: 'sub' }, makeDeps());
    expect(m.name).toBe('sub-bundle');
  });

  it('falls back to the root when the listingRef subdir has no bundle.yaml', async () => {
    await fs.writeFile(join(fixtureRepo, 'bundle.yaml'), 'name: root-bundle', 'utf8');
    const m = await fetchBundleManifest(
      { githubUrl: 'https://github.com/org/repo', listingRef: 'missing-sub' },
      makeDeps(),
    );
    expect(m.name).toBe('root-bundle');
  });

  it('throws when no bundle.yaml exists anywhere', async () => {
    await expect(fetchBundleManifest({ githubUrl: 'https://github.com/org/repo' }, makeDeps())).rejects.toThrow(
      BundleManifestError,
    );
  });

  it('rejects a non-github url before cloning', async () => {
    await expect(fetchBundleManifest({ githubUrl: 'https://evil.example/repo' }, makeDeps())).rejects.toThrow(
      BundleManifestError,
    );
  });

  it('cleans up the clone scratch dir even on failure', async () => {
    // no bundle.yaml written — locate throws — the finally must still rm cloneDir
    const before = await fs.readdir(root);
    await expect(fetchBundleManifest({ githubUrl: 'https://github.com/org/repo' }, makeDeps())).rejects.toThrow();
    const after = await fs.readdir(root);
    // only 'remote' (the fixture) should remain — the scratch clone dir is gone
    expect(after.filter((n) => n !== 'remote')).toEqual(before.filter((n) => n !== 'remote'));
  });
});
