import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertSeedLoadedSecurityFiles, bindSeedFrozenDependencies, readSeedInstalledPackages, verifySeedSecurityPackage } from './seed-frozen-execution';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'seed-d177-')); dirs.push(dir); return dir; };
const write = (file: string, value: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
const pkg = (root: string, path: string, name: string, version = '1.0.0') => {
  write(join(root, path, 'package.json'), JSON.stringify({ name, version }));
  write(join(root, path, 'index.js'), 'module.exports = "verified";\n');
};
const sha512 = (bytes: Buffer) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const library = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../apps/operator/bin/release/dependency-generation.sh');
const bash = (root: string, code: string, ...args: string[]) => execFileSync('bash', ['-euo', 'pipefail', '-c',
  'source "$1"; shift; ' + code, 'test', join(root, 'apps/operator/bin/release/dependency-generation.sh'), ...args],
{ encoding: 'utf8' }).trim();
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('D177 installed dependency census', () => {
  it('censuses nested and scoped packages and permits a missing optional entry', async () => {
    const root = temp();
    pkg(root, 'node_modules/a', 'a'); pkg(root, 'node_modules/a/node_modules/@scope/b', '@scope/b');
    const locks = [{ path: 'package-lock.json', packages: { 'node_modules/a': { version: '1.0.0' },
      'node_modules/a/node_modules/@scope/b': { version: '1.0.0' }, 'node_modules/optional': { version: '1.0.0', optional: true } } }];
    const rows = await readSeedInstalledPackages(root, ['node_modules'], locks);
    expect(rows.map(row => row.path)).toEqual(['node_modules/a', 'node_modules/a/node_modules/@scope/b']);
    pkg(root, 'node_modules/unlocked', 'unlocked');
    await expect(readSeedInstalledPackages(root, ['node_modules'], locks)).rejects.toThrow('no committed lock entry');
  });
  it('refuses wrong names, wrong versions and missing non-optional packages', async () => {
    const root = temp(); pkg(root, 'node_modules/a', 'a');
    const locks = [{ path: 'package-lock.json', packages: { 'node_modules/a': { version: '1.0.0' } } }];
    for (const metadata of [{ name: 'wrong', version: '1.0.0' }, { name: 'a', version: '2.0.0' }]) {
      write(join(root, 'node_modules/a/package.json'), JSON.stringify(metadata));
      await expect(readSeedInstalledPackages(root, ['node_modules'], locks)).rejects.toThrow('name/version mismatch');
    }
    pkg(root, 'node_modules/a', 'a'); locks[0].packages['node_modules/a'].version = '1.0.0';
    await expect(readSeedInstalledPackages(root, ['node_modules'], [{ ...locks[0],
      packages: { ...locks[0].packages, 'node_modules/missing': { version: '1.0.0' } } }])).rejects.toThrow('non-optional');
  });
  it('includes each generation tree and uses its own committed lock', async () => {
    const root = temp(); pkg(root, 'node_modules/a', 'a'); pkg(root, 'tools/fixture/node_modules/b', 'b');
    const rows = await readSeedInstalledPackages(root, ['node_modules', 'tools/fixture/node_modules'], [
      { path: 'package-lock.json', packages: { 'node_modules/a': { version: '1.0.0' } } },
      { path: 'tools/fixture/package-lock.json', packages: { 'node_modules/b': { version: '1.0.0' } } }]);
    expect(rows.map(row => row.name)).toEqual(['a', 'b']);
  });
});

function archive(root: string, name: string) {
  const staging = temp(); pkg(staging, 'package', name);
  return execFileSync('tar', ['-czf', '-', '-C', staging, 'package']);
}
describe('D177 security package content integrity', () => {
  it('verifies sha512 archive and every installed member; refuses byte drift and extra executed files', async () => {
    const root = temp(); pkg(root, 'node_modules/hypercore', 'hypercore'); const bytes = archive(root, 'hypercore');
    const row = { path: 'node_modules/hypercore', name: 'hypercore', version: '1.0.0',
      entry: { resolved: 'https://registry.npmjs.org/hypercore/-/fixture.tgz', integrity: sha512(bytes) } };
    const result = await verifySeedSecurityPackage(root, row, async () => bytes);
    expect(result.files.map(file => file.path)).toEqual(['index.js', 'package.json']);
    await expect(verifySeedSecurityPackage(root, row, async () => Buffer.from('wrong archive'))).rejects.toThrow('archive integrity mismatch');
    write(join(root, row.path, 'index.js'), 'tampered');
    await expect(verifySeedSecurityPackage(root, row, async () => bytes)).rejects.toThrow('file integrity mismatch');
    pkg(root, row.path, 'hypercore'); write(join(root, row.path, 'extra.node'), 'unbound native code');
    await expect(verifySeedSecurityPackage(root, row, async () => bytes)).rejects.toThrow('file integrity mismatch');
  });
  it('refuses version-only security locks instead of inventing integrity metadata', async () => {
    const root = temp(); pkg(root, 'node_modules/sodium-native', 'sodium-native');
    const fetch = vi.fn();
    await expect(verifySeedSecurityPackage(root, { path: 'node_modules/sodium-native', name: 'sodium-native', version: '1.0.0',
      entry: { version: '1.0.0' } }, fetch)).rejects.toThrow('lacks committed sha512/resolved');
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function frozen() {
  const base = temp(); const root = join(base, 'source'); const generationRoot = join(base, 'published');
  const generationId = 'v1-' + 'a'.repeat(64); const generation = join(generationRoot, generationId);
  const names = ['hypercore', 'hyperbee', 'hypercore-crypto', 'sodium-native', 'sodium-universal'];
  const archives = new Map<string, Buffer>(); const packages: Record<string, object> = {};
  for (const name of names) {
    pkg(join(generation, 'tree'), `node_modules/${name}`, name);
    const bytes = archive(root, name); const url = `https://registry.npmjs.org/${name}/-/fixture.tgz`;
    archives.set(url, bytes); packages[`node_modules/${name}`] = { version: '1.0.0', resolved: url, integrity: sha512(bytes) };
  }
  write(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  write(join(root, '.gitignore'), 'node_modules/\n');
  mkdirSync(dirname(join(root, 'apps/operator/bin/release/dependency-generation.sh')), { recursive: true });
  copyFileSync(library, join(root, 'apps/operator/bin/release/dependency-generation.sh'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // Isolated fixture repository only; the shared staging tree is never committed here.
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'frozen inputs');
  execFileSync('find', [join(generation, 'tree'), '-type', 'f', '-exec', 'chmod', 'a-w', '{}', '+']);
  execFileSync('cp', ['-a', join(generation, 'tree/node_modules'), join(root, 'node_modules')]);
  write(join(root, 'node_modules/.papercusp-isolated-snapshot'), `generation=${generationId}\n`);
  write(join(root, 'node_modules/.papercusp-dependency-generation'), `identity=${generationId}\nsource=${'a'.repeat(64)}\n`);
  const snapshot = bash(root, 'dependency_generation_set_fingerprint "$1"', join(generation, 'tree'));
  write(join(generation, '.papercusp-dependency-generation'), `schema=1\nidentity=${generationId}\nsource=${'a'.repeat(64)}\nclosure=${'b'.repeat(64)}\nsnapshot=${snapshot}\nscope=full\n`);
  const commit = git('rev-parse', 'HEAD');
  const input = bash(root, 'dependency_generation_input_fingerprint_ref "$1" "$2"', root, commit);
  const token = bash(root, 'dependency_generation_selector_token "$1"', generation);
  const selector = join(generationRoot, '.inputs', input);
  write(selector, `input=${input}\nidentity=${generationId}\ntoken=${token}\n`);
  vi.stubEnv('PAPERCUSP_DEPENDENCY_GENERATION_ROOT', generationRoot);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true,
    arrayBuffer: async () => archives.get(url) ?? Buffer.from('missing fixture archive') })));
  return { root, generation, generationId, selector, input, snapshot, commit };
}

describe('D177 maintained publication binding', () => {
  it('refuses stale loaded security bytes or modules from another installation', async () => {
    const f = await frozen(); const { securityPackages } = await bindSeedFrozenDependencies(f.root, f.commit);
    const row = securityPackages[0]; const file = row.files.find(file => file.path === 'index.js')!;
    expect(() => assertSeedLoadedSecurityFiles(f.root, securityPackages,
      [{ path: join(f.root, row.path, file.path), sha256: file.sha256 }])).not.toThrow();
    expect(() => assertSeedLoadedSecurityFiles(f.root, securityPackages,
      [{ path: join(f.root, row.path, file.path), sha256: '0'.repeat(64) }])).toThrow('loaded security module');
    expect(() => assertSeedLoadedSecurityFiles(f.root, securityPackages,
      [{ path: join(f.generation, 'tree', row.path, file.path), sha256: file.sha256 }])).toThrow('loaded security module');
  });
  it('binds a real committed input key and published generation without a hidden npm lock', async () => {
    const f = await frozen(); const result = await bindSeedFrozenDependencies(f.root, f.commit);
    expect(result).toMatchObject({ dependencyGeneration: f.generationId, dependencyInputSha256: f.input,
      dependencyGenerationSnapshotSha256: f.snapshot });
    expect(result.securityPackages).toHaveLength(5);
    expect(result).not.toHaveProperty('installedLockSha256');
    expect(await bindSeedFrozenDependencies(f.root, f.commit)).toEqual(result);
  });
  it('refuses a selector for another generation', async () => {
    const f = await frozen(); write(f.selector, readFileSync(f.selector, 'utf8').replace(f.generationId, 'v1-' + 'f'.repeat(64)));
    await expect(bindSeedFrozenDependencies(f.root, f.commit)).rejects.toThrow('input/generation mismatch');
  });
  it('refuses published tree mutation and a materialized copy with changed bytes', async () => {
    const f = await frozen(); chmodSync(join(f.generation, 'tree/node_modules/hypercore/index.js'), 0o644);
    write(join(f.generation, 'tree/node_modules/hypercore/index.js'), 'publication changed');
    await expect(bindSeedFrozenDependencies(f.root, f.commit)).rejects.toThrow('published dependency generation drift');
    const g = await frozen(); chmodSync(join(g.root, 'node_modules/hypercore/index.js'), 0o644);
    write(join(g.root, 'node_modules/hypercore/index.js'), 'copy changed');
    await expect(bindSeedFrozenDependencies(g.root, g.commit)).rejects.toThrow('materialized dependency tree drift');
  });
});
