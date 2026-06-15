/**
 * Install-blueprint-from-Cupboard core
 * (official-blueprints-cupboard-publish-2026-06-05 P-004). Pure-ish: clone /
 * installed dir / extends-resolver / host capability sets are injected, so this
 * covers the locate→validate→dep-check→copy flow without real git, network, or
 * the tool catalog. `cloneRepo` is faked by copying a local fixture dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBuiltinExtends } from '@papercusp/orchestrator/blueprint';
import { makeComposedResolveExtends } from '@papercusp/blueprint-distribution';
import {
  installBlueprintFromCupboardCore,
  InstallBlueprintError,
  type InstallBlueprintCoreDeps,
} from './install-blueprint-core';

let root: string;        // scratch root for fixtures + install target
let fixtureRepo: string; // the "remote" repo a fake clone copies from
let installedDir: string; // the install target (~/.papercusp/blueprints stand-in)

const RUNNABLE_YAML = [
  'id: neat-bp',
  'version: 0.2.0',
  'description: a neat test blueprint',
  'workItem: { kind: feature }',
  'spine: { edges: { DONE: { to: done } } }',
].join('\n');

async function writeBlueprint(dir: string, yaml: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'blueprint.yaml'), yaml, 'utf8');
}

function makeDeps(over: Partial<InstallBlueprintCoreDeps> = {}): InstallBlueprintCoreDeps {
  return {
    cloneRepo: async (_url, dest) => {
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
    installedBlueprintsDir: () => installedDir,
    tmpDir: () => root,
    // Installed tier (the target dir) + the engine's bundled floor — the same
    // composition the operator wires, against the test's own installed dir.
    resolveExtends: makeComposedResolveExtends({ installedDir }),
    resolveHostSets: async () => ({
      availableTools: new Set<string>(),
      installedPlugins: new Set<string>(),
      cupboardPlugins: new Set<string>(),
      cupboardReachable: true,
    }),
    ...over,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'install-bp-core-'));
  fixtureRepo = join(root, 'remote');
  installedDir = join(root, 'blueprints');
  await fs.mkdir(fixtureRepo, { recursive: true });
  // a .git dir that must NOT be copied into the install
  await fs.mkdir(join(fixtureRepo, '.git'), { recursive: true });
  await fs.writeFile(join(fixtureRepo, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('installBlueprintFromCupboardCore', () => {
  it('installs a root-level blueprint (validates, copies, excludes .git)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML);
    await fs.mkdir(join(fixtureRepo, 'prompts'), { recursive: true });
    await fs.writeFile(join(fixtureRepo, 'prompts', 'director.md'), '# persona', 'utf8');

    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/neat-bp' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.id).toBe('neat-bp');
    expect(res.version).toBe('0.2.0');
    expect(res.abstract).toBe(false);
    expect(res.installedTo).toBe(join(installedDir, 'neat-bp'));
    expect(existsSync(join(installedDir, 'neat-bp', 'blueprint.yaml'))).toBe(true);
    // blueprint-local prompts ride along; .git does not
    expect(existsSync(join(installedDir, 'neat-bp', 'prompts', 'director.md'))).toBe(true);
    expect(existsSync(join(installedDir, 'neat-bp', '.git'))).toBe(false);
  });

  it('prefers the listing_ref subdir (multi-blueprint repo — the official library layout)', async () => {
    await writeBlueprint(join(fixtureRepo, 'neat-bp'), RUNNABLE_YAML);
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/blueprints', listingRef: 'neat-bp' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.id).toBe('neat-bp');
  });

  it('resolves extends against the bundled built-in floor (D-004)', async () => {
    await writeBlueprint(fixtureRepo, [
      'id: child-of-base',
      'extends: base',
      'workItem: { kind: feature }',
      'spine: { edges: { DONE: { to: done } } }',
    ].join('\n'));
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/child-of-base' },
      makeDeps({
        resolveExtends: makeComposedResolveExtends({ installedDir, builtin: resolveBuiltinExtends }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.id).toBe('child-of-base');
  });

  it('installs an abstract parent-only blueprint (no workItem/spine) without full validation', async () => {
    await writeBlueprint(fixtureRepo, 'id: my-base\nversion: 1.0.0\nknobs: { logRetention: 100 }');
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/my-base' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.abstract).toBe(true);
    expect(existsSync(join(installedDir, 'my-base', 'blueprint.yaml'))).toBe(true);
  });

  it('rejects an invalid github_url', async () => {
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'http://evil.example/x' }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a repo with no blueprint.yaml', async () => {
    await fs.writeFile(join(fixtureRepo, 'README.md'), 'nope', 'utf8');
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/empty' }, makeDeps()),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects an unsafe blueprint id (path traversal)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML.replace('id: neat-bp', 'id: ../escape'));
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/evil' }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  it('rejects a structurally invalid runnable blueprint', async () => {
    await writeBlueprint(fixtureRepo, 'id: broken\nworkItem: { kind: feature }\nspine: { edges: {} }');
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/broken' }, makeDeps()),
    ).rejects.toMatchObject({ status: 422 });
    expect(existsSync(join(installedDir, 'broken'))).toBe(false);
  });

  it('hard-fails a missing TOOL dependency (catalog is authoritative)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ndependencies: { tools: ["nope:missing"] }');
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps()),
    ).rejects.toThrow(/tool dependencies unmet/);
  });

  it('passes when declared tools are in the catalog; Cupboard-installable plugins are advisory', async () => {
    await writeBlueprint(
      fixtureRepo,
      RUNNABLE_YAML + '\ndependencies: { tools: ["work_items:list"], plugins: ["repomix"] }',
    );
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/neat-bp' },
      makeDeps({
        resolveHostSets: async () => ({
          availableTools: new Set(['work_items:list']),
          installedPlugins: new Set<string>(),
          cupboardPlugins: new Set(['repomix']),
          cupboardReachable: true,
        }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.depCheck?.installable.plugins).toEqual(['repomix']);
  });

  it('hard-fails a plugin in neither installed nor Cupboard when the Cupboard was reachable', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ndependencies: { plugins: ["ghost-plugin"] }');
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps()),
    ).rejects.toThrow(/dependencies unmet: ghost-plugin/);
  });

  it('resolves a spawned-blueprint dep against the built-in/installed tier (P-007)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ndependencies: { blueprints: ["coding"] }');
    const result = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/neat-bp' },
      makeDeps({
        resolveHostSets: async () => ({
          availableTools: new Set<string>(),
          installedPlugins: new Set<string>(),
          cupboardPlugins: new Set<string>(),
          availableBlueprints: new Set<string>(['coding']),
          cupboardReachable: true,
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.dependencies.blueprints).toEqual(['coding']);
    expect(result.depCheck?.missing.blueprints).toEqual([]);
  });

  it('hard-fails a spawned-blueprint dep absent from every tier when the Cupboard was reachable (P-007)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ndependencies: { blueprints: ["ghost-bp"] }');
    await expect(
      installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps()),
    ).rejects.toThrow(/dependencies unmet: ghost-bp/);
  });

  it('does NOT fail missing plugins when the Cupboard was unreachable (transient outage)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML + '\ndependencies: { plugins: ["ghost-plugin"] }');
    const res = await installBlueprintFromCupboardCore(
      { githubUrl: 'https://github.com/acme/neat-bp' },
      makeDeps({
        resolveHostSets: async () => ({
          availableTools: new Set<string>(),
          installedPlugins: new Set<string>(),
          cupboardPlugins: new Set<string>(),
          cupboardReachable: false,
        }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.depCheck?.missing.plugins).toEqual(['ghost-plugin']);
  });

  it('overwrite-installs (re-install replaces the dir)', async () => {
    await writeBlueprint(fixtureRepo, RUNNABLE_YAML);
    await installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps());
    // stale file from a previous version must not survive a re-install
    await fs.writeFile(join(installedDir, 'neat-bp', 'stale.md'), 'old', 'utf8');
    await installBlueprintFromCupboardCore({ githubUrl: 'https://github.com/acme/neat-bp' }, makeDeps());
    expect(existsSync(join(installedDir, 'neat-bp', 'stale.md'))).toBe(false);
    expect(existsSync(join(installedDir, 'neat-bp', 'blueprint.yaml'))).toBe(true);
  });

  it('exports the error class with status mapping', () => {
    const e = new InstallBlueprintError('x', 422);
    expect(e.status).toBe(422);
    expect(e.name).toBe('InstallBlueprintError');
  });
});
