/**
 * Install-plugin-from-Cupboard core (revive-cupboard-distribution P2 / D-003).
 * Pure-ish: clone / global-plugins dir / grant / host-invalidate are injected,
 * so this covers the locate→copy→consent→invalidate flow without real git, PG,
 * or the route registry. `cloneRepo` is faked by copying a local fixture dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installPluginFromCupboardCore,
  InstallPluginError,
  type InstallPluginCoreDeps,
} from './install-plugin-core';

let root: string;        // scratch root for fixtures + install target
let fixtureRepo: string; // the "remote" repo a fake clone copies from
let globalDir: string;   // the install target (global-plugins)
let granted: Array<{ pluginName: string; pluginVersion: string; harnessSlug: string; capabilities: string[] }>;
let invalidated: number;

async function writeManifest(dir: string, m: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(m), 'utf8');
}

function makeDeps(over: Partial<InstallPluginCoreDeps> = {}): InstallPluginCoreDeps {
  return {
    // Fake clone = copy the fixture repo into dest (incl. a .git dir to prove exclusion).
    cloneRepo: async (_url, dest) => {
      await fs.cp(fixtureRepo, dest, { recursive: true });
    },
    globalPluginsDir: () => globalDir,
    tmpDir: () => root,
    grant: async (args) => { granted.push(args); },
    invalidateHost: () => { invalidated += 1; },
    ...over,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'install-core-'));
  fixtureRepo = join(root, 'remote');
  globalDir = join(root, 'global-plugins');
  granted = [];
  invalidated = 0;
  await fs.mkdir(fixtureRepo, { recursive: true });
  // a .git dir that must NOT be copied into the install
  await writeManifest(join(fixtureRepo, '.git'), { not: 'a manifest' });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('installPluginFromCupboardCore', () => {
  it('installs a root-level plugin and invalidates the host', async () => {
    await writeManifest(fixtureRepo, { name: 'cool-plugin', version: '1.2.0', capabilities: ['net:fetch'] });
    await fs.writeFile(join(fixtureRepo, 'index.cjs'), 'module.exports = {};', 'utf8');

    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/cool-plugin' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.name).toBe('cool-plugin');
    expect(res.version).toBe('1.2.0');
    expect(res.capabilities).toEqual(['net:fetch']);
    expect(res.granted).toEqual([]); // no harness target → no grant
    expect(invalidated).toBe(1);

    const installed = join(globalDir, 'cool-plugin');
    expect(existsSync(join(installed, 'papercusp.json'))).toBe(true);
    expect(existsSync(join(installed, 'index.cjs'))).toBe(true);
    // .git must be excluded from the install
    expect(existsSync(join(installed, '.git'))).toBe(false);
  });

  it('locates the plugin in the listing_ref subdir when the repo hosts several', async () => {
    await writeManifest(join(fixtureRepo, 'packages', 'b'), { name: 'plugin-b', version: '0.1.0' });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/monorepo', listingRef: 'packages/b' },
      makeDeps(),
    );
    expect(res.name).toBe('plugin-b');
    expect(existsSync(join(globalDir, 'plugin-b', 'papercusp.json'))).toBe(true);
  });

  it('records install-consent grants when a harness + acceptCapabilities are given', async () => {
    await writeManifest(fixtureRepo, { name: 'p', version: '2.0.0', capabilities: ['net:fetch', 'secret:read'] });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/p', harness: 'myharness', acceptCapabilities: true },
      makeDeps(),
    );
    expect(res.granted).toEqual(['net:fetch', 'secret:read']);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      pluginName: 'p',
      pluginVersion: '2.0.0',
      harnessSlug: 'myharness',
      capabilities: ['net:fetch', 'secret:read'],
    });
  });

  it('does not grant when acceptCapabilities is false even with a harness', async () => {
    await writeManifest(fixtureRepo, { name: 'p', version: '2.0.0', capabilities: ['net:fetch'] });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/p', harness: 'myharness', acceptCapabilities: false },
      makeDeps(),
    );
    expect(res.granted).toEqual([]);
    expect(granted).toHaveLength(0);
  });

  it('rejects a non-github URL (400)', async () => {
    await expect(
      installPluginFromCupboardCore({ githubUrl: 'https://evil.example.com/x' }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('fails (422) when the repo has no papercusp.json', async () => {
    // fixtureRepo only has the .git fixture, no manifest at root.
    await expect(
      installPluginFromCupboardCore({ githubUrl: 'https://github.com/acme/empty' }, makeDeps()),
    ).rejects.toBeInstanceOf(InstallPluginError);
  });

  it('rejects a path-traversing manifest name (400) and writes nothing outside global-plugins', async () => {
    // Untrusted manifest.name from the cloned repo must never escape the install
    // dir (security review: name "../evil" → fs.rm(target,{recursive}) outside).
    await writeManifest(fixtureRepo, { name: '../evil', version: '1.0.0' });
    await expect(
      installPluginFromCupboardCore({ githubUrl: 'https://github.com/acme/evil' }, makeDeps()),
    ).rejects.toMatchObject({ status: 400 });
    // The escape target would be join(globalDir, '../evil') === join(root, 'evil').
    expect(existsSync(join(root, 'evil'))).toBe(false);
  });

  it('ignores an unsafe listing_ref (no escape) and falls back to the repo root', async () => {
    await writeManifest(fixtureRepo, { name: 'safe-p', version: '1.0.0' });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/safe-p', listingRef: '../../etc' },
      makeDeps(),
    );
    // The unsafe ref is skipped; install proceeds from the repo root.
    expect(res.name).toBe('safe-p');
    expect(existsSync(join(globalDir, 'safe-p', 'papercusp.json'))).toBe(true);
    // Nothing written outside global-plugins via the traversing ref.
    expect(existsSync(join(root, 'etc'))).toBe(false);
  });

  it('cleans up the clone dir on success', async () => {
    await writeManifest(fixtureRepo, { name: 'p', version: '1.0.0' });
    await installPluginFromCupboardCore({ githubUrl: 'https://github.com/acme/p' }, makeDeps());
    const entries = await fs.readdir(root);
    // only 'remote' + 'global-plugins' remain; the clone temp dir is gone
    expect(entries.filter((e) => e.startsWith('cupboard-plugin-'))).toEqual([]);
  });

  // ── tool-distribution-granularity-2026-06-05: pack installs + the dep gate ──

  it('installs a kind=pack unit and reports kind on the result', async () => {
    await writeManifest(fixtureRepo, {
      name: 'tool-pack',
      version: '0.1.0',
      kind: 'pack',
      tools: [{ name: 'noop' }],
    });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/tool-pack' },
      makeDeps(),
    );
    expect(res.kind).toBe('pack');
    expect(existsSync(join(globalDir, 'tool-pack', 'papercusp.json'))).toBe(true);
  });

  it('fails (422) BEFORE copying when declared dependencies are hard-missing', async () => {
    await writeManifest(fixtureRepo, {
      name: 'needy',
      version: '1.0.0',
      dependencies: { tools: ['ghost.tool'] },
    });
    await expect(
      installPluginFromCupboardCore(
        { githubUrl: 'https://github.com/acme/needy' },
        makeDeps({
          validateDependencies: async () => ({
            ok: false,
            missing: { tools: ['ghost.tool'], packs: [], plugins: [] },
            installable: { tools: [], packs: [], plugins: [] },
            messages: ['needs tool "ghost.tool" — not in the tool catalog and no Cupboard pack/plugin provides it'],
          }),
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(existsSync(join(globalDir, 'needy'))).toBe(false);
  });

  it('proceeds on installable deps and surfaces them advisorily', async () => {
    await writeManifest(fixtureRepo, {
      name: 'soft-needy',
      version: '1.0.0',
      dependencies: { plugins: ['firecrawl'] },
    });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/soft-needy' },
      makeDeps({
        validateDependencies: async () => ({
          ok: true,
          missing: { tools: [], packs: [], plugins: [] },
          installable: { tools: [], packs: [], plugins: ['firecrawl'] },
          messages: [],
        }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.installableDependencies).toEqual({ tools: [], packs: [], plugins: ['firecrawl'] });
  });

  it('does not gate deps when no validateDependencies dep is wired', async () => {
    await writeManifest(fixtureRepo, {
      name: 'ungated',
      version: '1.0.0',
      dependencies: { tools: ['whatever.tool'] },
    });
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/ungated' },
      makeDeps(),
    );
    expect(res.ok).toBe(true);
    expect(res.installableDependencies).toBeUndefined();
  });

  it('skips the validator entirely for a manifest with no declared deps', async () => {
    await writeManifest(fixtureRepo, { name: 'no-deps', version: '1.0.0' });
    const validateDependencies = vi.fn();
    const res = await installPluginFromCupboardCore(
      { githubUrl: 'https://github.com/acme/no-deps' },
      makeDeps({ validateDependencies }),
    );
    expect(res.ok).toBe(true);
    expect(validateDependencies).not.toHaveBeenCalled();
  });
});
