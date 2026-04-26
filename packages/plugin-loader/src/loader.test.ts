/**
 * Tests for the plugin loader. Run with:
 *   cd packages/papercusp-plugin-loader && npx tsx --test src/loader.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginFromDir, loadPlugins, collectRoles } from './index.ts';

const ROOT = join(tmpdir(), `papercusp-loader-test-${process.pid}`);

async function makePlugin(opts: {
  name: string;
  version?: string;
  manifestVersion?: string;
  roles?: Record<string, { name: string; prompt: { content: string }; defaultModel?: string }>;
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
    const rolesJs = opts.roles
      ? `roles: ${JSON.stringify(opts.roles)},`
      : 'roles: {},';
    // Auto-include 'roles:register:<name>' caps for every declared role,
    // matching the validation rule in index.ts.
    const declaredRoleCaps = Object.keys(opts.roles ?? {}).map((n) => `'roles:register:${n}'`);
    const capsList = declaredRoleCaps.length ? declaredRoleCaps.join(', ') : '';
    const entry = `
      export default {
        name: ${JSON.stringify(opts.name)},
        version: ${JSON.stringify(version)},
        papercusp: '^0.1.0',
        capabilities: [${capsList}],
        ${rolesJs}
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

  it('rejects when entry point is missing', async () => {
    const dir = await makePlugin({ name: 'no-entry', noEntry: true });
    const r = await loadPluginFromDir(dir, 'project');
    assert.ok('error' in r);
    if ('error' in r) {
      assert.match(r.error, /entry point/);
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
});

describe('loadPlugins', () => {
  it('walks projectDir/plugins/', async () => {
    const projectDir = join(ROOT, 'walked-project');
    await fs.mkdir(join(projectDir, 'plugins'), { recursive: true });
    // Move two plugins under the project
    for (const name of ['plugin-a', 'plugin-b']) {
      const src = await makePlugin({ name });
      await fs.cp(src, join(projectDir, 'plugins', name), { recursive: true });
    }
    const r = await loadPlugins({ projectDir });
    assert.equal(r.errors.length, 0);
    const names = r.loaded.map((l) => l.plugin.name).sort();
    assert.deepEqual(names, ['plugin-a', 'plugin-b']);
    for (const lp of r.loaded) assert.equal(lp.source, 'project');
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

describe('collectRoles', () => {
  it('returns roles from all loaded plugins', async () => {
    const dir1 = await makePlugin({
      name: 'roleful-1',
      roles: { narrator: { name: 'narrator', prompt: { content: 'be a narrator' } } },
    });
    const dir2 = await makePlugin({
      name: 'roleful-2',
      roles: { editor: { name: 'editor', prompt: { content: 'edit things' } } },
    });
    const r1 = await loadPluginFromDir(dir1, 'project');
    const r2 = await loadPluginFromDir(dir2, 'project');
    assert.ok(!('error' in r1) && !('error' in r2));
    if (!('error' in r1) && !('error' in r2)) {
      const collected = collectRoles([r1, r2]);
      assert.deepEqual(Object.keys(collected).sort(), ['editor', 'narrator']);
      assert.equal(collected.narrator.plugin, 'roleful-1');
      assert.equal(collected.editor.plugin, 'roleful-2');
    }
  });

  it('throws on role-name collision', async () => {
    const dirA = await makePlugin({
      name: 'collide-a',
      roles: { same: { name: 'same', prompt: { content: 'a' } } },
    });
    const dirB = await makePlugin({
      name: 'collide-b',
      roles: { same: { name: 'same', prompt: { content: 'b' } } },
    });
    const a = await loadPluginFromDir(dirA, 'project');
    const b = await loadPluginFromDir(dirB, 'project');
    assert.ok(!('error' in a) && !('error' in b));
    if (!('error' in a) && !('error' in b)) {
      assert.throws(() => collectRoles([a, b]), /role "same" claimed by both/);
    }
  });
});
