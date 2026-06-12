/**
 * Tests for the plugin loader. Run with:
 *   cd packages/papercusp-plugin-loader && npx tsx --test src/loader.test.ts
 */
import { describe, it, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginFromDir, loadPlugins } from './index.ts';

const ROOT = join(tmpdir(), `papercusp-loader-test-${process.pid}`);

async function makePlugin(opts: {
  name: string;
  version?: string;
  manifestVersion?: string;
  noManifest?: boolean;
  noEntry?: boolean;
  manifestVersionMismatch?: boolean;
}): Promise<string> {
  const dir = join(ROOT, opts.name);
  await fs.mkdir(dir, { recursive: true });
  const version = opts.version ?? '0.1.0';
  const manifestVersion = opts.manifestVersionMismatch ? '0.9.9' : (opts.manifestVersion ?? version);

  if (!opts.noManifest) {
    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: opts.name, version: manifestVersion }), 'utf8');
  }

  if (!opts.noEntry) {
    const entry = `
      export default {
        name: ${JSON.stringify(opts.name)},
        version: ${JSON.stringify(version)},
        papercusp: '^0.1.0',
        capabilities: [],
        hooks: {
          afterDone: async () => {},
        },
      };
    `;
    await fs.writeFile(join(dir, 'index.mjs'), entry, 'utf8');
  }
  return dir;
}

before(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
});

after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('loadPluginFromDir', () => {
  it('loads a valid plugin', async () => {
    const dir = await makePlugin({ name: 'happy-path' });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok(!('error' in r), `expected success, got ${JSON.stringify(r)}`);
    if ('plugin' in r) {
      assert.equal(r.plugin.name, 'happy-path');
      assert.equal(r.plugin.version, '0.1.0');
      assert.equal(r.source, 'project');
    }
  });

  it('rejects when manifest is missing', async () => {
    const dir = await makePlugin({ name: 'no-manifest', noManifest: true });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /papercusp\.json/);
    }
  });

  it('rejects when entry point is missing but the manifest declares tools', async () => {
    // Tool handlers live on the entry's `tools` export — a tools-declaring
    // manifest with no entry is a broken plugin, not a manifest-only one.
    const dir = join(ROOT, 'no-entry-with-tools');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'papercusp.json'),
      JSON.stringify({
        name: 'no-entry-with-tools',
        version: '0.1.0',
        tools: [{ name: 'pack', capabilities: ['tools:pack'] }],
      }),
      'utf8',
    );
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /entry point/);
    }
  });

  it('rejects a pack with no entry point (a pack exists to provide tool handlers)', async () => {
    const dir = join(ROOT, 'no-entry-pack');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'papercusp.json'),
      JSON.stringify({
        name: 'no-entry-pack',
        version: '0.1.0',
        kind: 'pack',
        tools: [{ name: 'pack', capabilities: ['tools:pack'] }],
      }),
      'utf8',
    );
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /entry point/);
    }
  });

  it('loads a manifest-only plugin (no entry, no tools — provision/roles/config only)', async () => {
    // The cloudflare-stack shape: a fully declarative plugin (provision
    // scripts, manifest-declared roles, configSchema) with no code at all.
    const dir = await makePlugin({ name: 'manifest-only', noEntry: true });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok(!('error' in r) && !('skipped' in r), `expected success, got ${JSON.stringify(r)}`);
    if ('plugin' in r) {
      assert.equal(r.plugin.name, 'manifest-only');
      assert.equal((r.plugin as unknown as { __runtime?: string }).__runtime, 'manifest-only');
      assert.deepEqual(r.toolDefinitions, []);
    }
  });

  it('rejects when manifest.version != plugin.version', async () => {
    const dir = await makePlugin({ name: 'version-mismatch', manifestVersionMismatch: true });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /version/);
    }
  });

  it('rejects when papercusp range excludes the runtime version', async () => {
    // Runtime is 0.1.0; ^99.0.0 is incompatible.
    const dir = join(ROOT, 'incompatible-runtime');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'papercusp.json'),
      JSON.stringify({ name: 'incompatible-runtime', version: '0.1.0' }),
      'utf8',
    );
    await fs.writeFile(
      join(dir, 'index.mjs'),
      `export default {
        name: 'incompatible-runtime',
        version: '0.1.0',
        papercusp: '^99.0.0',
        capabilities: [],
        hooks: {},
      };`,
      'utf8',
    );
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /papercusp runtime/);
    }
  });
});

describe('loadPlugins', () => {
  it('walks projectDir/plugins/', async () => {
    const projectDir = join(ROOT, 'walked-project');
    await fs.mkdir(join(projectDir, 'plugins'), { recursive: true });
    // Override the global dir to an empty temp path so the test doesn't
    // pick up plugins the developer happens to have installed in
    // ~/.papercusp/global-plugins/.
    const globalDir = join(ROOT, 'walked-empty-global');
    await fs.mkdir(globalDir, { recursive: true });
    // Move two plugins under the project
    for (const name of ['plugin-a', 'plugin-b']) {
      const src = await makePlugin({ name });
      await fs.cp(src, join(projectDir, 'plugins', name), { recursive: true });
    }
    const r = await loadPlugins({ projectDir, globalPluginsDir: globalDir });
    assert.equal(r.errors.length, 0);
    const names = r.loaded.map((l) => l.plugin.name).sort();
    assert.deepEqual(names, ['plugin-a', 'plugin-b']);
    for (const lp of r.loaded) assert.equal(lp.source, 'project');
  });

  it('skips dirs with neither manifest nor entry (not-a-plugin)', async () => {
    // pi/ dir at ~/.papercusp/global-plugins/pi/ holds extension.ts for
    // pi-omp integration; it's not a papercusp plugin. Loader should skip
    // silently rather than emit a loud error.
    const dir = await makePlugin({ name: 'omp-stub', noManifest: true, noEntry: true });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('skipped' in r, `expected skipped, got ${JSON.stringify(r)}`);
    if ('skipped' in r) assert.equal(r.skipped, 'not-a-plugin');
  });

  it('recurses into @scope/ dirs as plugin candidates', async () => {
    const globalDir = join(ROOT, 'scoped-global');
    await fs.mkdir(join(globalDir, '@papercupai'), { recursive: true });
    const innerSrc = await makePlugin({ name: 'inside-scope' });
    await fs.cp(innerSrc, join(globalDir, '@papercupai', 'inside-scope'), { recursive: true });
    const r = await loadPlugins({ globalPluginsDir: globalDir });
    assert.equal(r.errors.length, 0, `got errors: ${JSON.stringify(r.errors)}`);
    const names = r.loaded.map((l) => l.plugin.name);
    assert.ok(names.includes('inside-scope'));
  });

  it('dedupes by plugin name across sources', async () => {
    const projectDir = join(ROOT, 'dedupe-project');
    await fs.mkdir(join(projectDir, 'plugins/dedupe-a'), { recursive: true });
    const projectVersion = await makePlugin({ name: 'dedupe-a', version: '1.0.0' });
    await fs.cp(projectVersion, join(projectDir, 'plugins/dedupe-a'), { recursive: true, force: true });

    const globalDir = join(ROOT, 'dedupe-global');
    await fs.mkdir(join(globalDir, 'dedupe-a'), { recursive: true });
    const globalVersion = await makePlugin({ name: 'dedupe-a', version: '0.0.1' });
    await fs.cp(globalVersion, join(globalDir, 'dedupe-a'), { recursive: true, force: true });

    const r = await loadPlugins({ projectDir, globalPluginsDir: globalDir });
    assert.equal(r.loaded.length, 1);
    assert.equal(r.loaded[0].plugin.name, 'dedupe-a');
    // Project wins.
    assert.equal(r.loaded[0].plugin.version, '1.0.0');
    assert.equal(r.loaded[0].source, 'project');
  });
});

