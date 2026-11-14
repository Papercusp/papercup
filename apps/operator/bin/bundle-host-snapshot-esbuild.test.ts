/**
 * bundle-host-snapshot-esbuild.mjs (WI-6554700010048234) compiles a snapshot-labelled
 * bundle from the label's git blobs, so peers editing the shared tree mid-build cannot
 * move its inputs. These tests drive the CLI exactly as bundle_host_esbuild calls it,
 * against the repo's own esbuild (its version is the required version).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FENCE_EXIT_MOVED } from './bundle-host-snapshot-fence';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const COMMON = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');
const FENCE = join(REPO_ROOT, 'apps/operator/bin/bundle-host-snapshot-fence.ts');
const HELPER = join(REPO_ROOT, 'apps/operator/bin/bundle-host-snapshot-esbuild.mjs');
const ESBUILD = join(REPO_ROOT, 'node_modules/esbuild/bin/esbuild');
const VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules/esbuild/package.json'), 'utf8')) as
  { version: string }).version;
const RECIPE = ['entry.ts', '--bundle', '--platform=node', '--format=esm', '--log-level=warning'];

let dir = '';
let sup = '';
let snapshot = '';
let env: NodeJS.ProcessEnv = {};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const repo = (name: string, files: Record<string, string>) => {
  const path = join(dir, name);
  git(dir, 'init', '-q', '-b', 'main', path);
  for (const [file, body] of Object.entries(files)) writeFileSync(join(path, file), body);
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', name);
  return path;
};
const out = (name: string) => join(dir, 'out', name);
const helper = (sha: string, args: string[], { version = VERSION, receipt = '-' } = {}) =>
  spawnSync(process.execPath, [HELPER, sup, ESBUILD, version, sha, receipt, '--', ...args], { env, encoding: 'utf8' });

describe('bundle-host-snapshot-esbuild', () => {
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'bundle-host-snapshot-esbuild-')));
    mkdirSync(join(dir, 'out'));
    const config = join(dir, 'gitconfig');
    writeFileSync(config, '[user]\n\tname = t\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n'
      + '[commit]\n\tgpgsign = false\n');
    env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
    const sub = repo('sub-src', { 'dep.ts': "export const dep = 'SNAP_SUB';\n" });
    sup = repo('sup', {
      'package.json': '{"name":"fixture","type":"module"}\n',
      // Changes emitted code: class fields become constructor assignments.
      'tsconfig.json': '{"compilerOptions":{"useDefineForClassFields":false}}\n',
      '.gitignore': 'gen.ts\n',
      'data.json': '{"marker":"SNAP_JSON"}\n',
      'lib.ts': "export class Box { v = 'SNAP_LIB'; }\n",
      'entry.ts': ["import data from './data.json';", "import { Box } from './lib';",
        "import { dep } from './sub/dep';", "import { extra } from './extra';", "import { gen } from './gen';",
        'export const out = [data.marker, new Box().v, dep, extra, gen];', ''].join('\n'),
    });
    git(sup, 'submodule', 'add', '-q', sub, 'sub');
    git(sup, 'commit', '-q', '-m', 'sub');
    // Untracked (snapshotted) and ignored (never snapshotted, read from disk).
    writeFileSync(join(sup, 'extra.ts'), "export const extra = 'SNAP_EXTRA';\n");
    writeFileSync(join(sup, 'gen.ts'), "export const gen = 'DISK_GEN';\n");
    snapshot = execFileSync('bash', ['-c', 'source "$1"; bundle_host_snapshot_commit "$2"', 'snapshot-test', COMMON, sup],
      { env, encoding: 'utf8' }).trim();
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('byte-equals the esbuild CLI on the same recipe while the tree matches the snapshot', () => {
    expect(snapshot).toMatch(/^[a-f0-9]{40}$/);
    const receipt = join(dir, 'clean-receipt.json');
    const run = helper(snapshot, [...RECIPE, `--outfile=${out('helper.js')}`], { receipt });
    expect(run.stderr).toContain('✓ snapshot compile');
    expect(run.status).toBe(0);
    execFileSync(ESBUILD, [...RECIPE, `--outfile=${out('cli.js')}`], { cwd: sup, env, encoding: 'utf8' });

    const built = readFileSync(out('helper.js'), 'utf8');
    expect(built).toBe(readFileSync(out('cli.js'), 'utf8'));
    // tsconfig, the .json loader and the package type all reached the snapshot-served inputs.
    expect(built).toContain('this.v = "SNAP_LIB"');
    expect(built).toContain('SNAP_JSON');
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
      sha: snapshot,
      served: { 'data.json': expect.any(String), 'entry.ts': expect.any(String), 'extra.ts': expect.any(String),
        'lib.ts': expect.any(String), 'sub/dep.ts': expect.any(String) },
      fallback: ['gen.ts'],
    });
  });

  it('compiles the snapshot bytes after the live tree moved, and the fence passes on the served receipt', () => {
    writeFileSync(join(sup, 'lib.ts'), "export class Box { v = 'LIVE_LIB'; }\n");
    writeFileSync(join(sup, 'data.json'), '{"marker":"LIVE_JSON"}\n');
    writeFileSync(join(sup, 'sub', 'dep.ts'), "export const dep = 'LIVE_SUB';\n");
    const receipt = join(dir, 'moved-receipt.json');
    const metafile = out('meta.json');
    const run = helper(snapshot, [...RECIPE, `--outfile=${out('moved.js')}`, `--metafile=${metafile}`], { receipt });
    expect(run.status, run.stderr).toBe(0);

    const built = readFileSync(out('moved.js'), 'utf8');
    for (const marker of ['SNAP_LIB', 'SNAP_JSON', 'SNAP_SUB', 'SNAP_EXTRA', 'DISK_GEN']) expect(built).toContain(marker);
    for (const marker of ['LIVE_LIB', 'LIVE_JSON', 'LIVE_SUB']) expect(built).not.toContain(marker);

    const fence = (...served: string[]) =>
      spawnSync(process.execPath, [FENCE, sup, snapshot, metafile, join(dir, 'fence.json'), ...served], { env, encoding: 'utf8' });
    const confirmed = fence(receipt);
    expect(confirmed.status, confirmed.stderr).toBe(0);
    // Without the receipt the fence sees the moved live bytes: exactly the race this removes.
    const raced = fence();
    expect(raced.status).toBe(FENCE_EXIT_MOVED);
    expect(raced.stderr).toContain('lib.ts');
  });

  it('refuses an off-recipe switch, a different compiler version and an unknown snapshot with exit 78', () => {
    const outfile = `--outfile=${out('refused.js')}`;
    for (const run of [
      helper(snapshot, [...RECIPE, outfile, '--sourcemap']),
      helper(snapshot, [...RECIPE, outfile], { version: '0.0.0' }),
      helper('f'.repeat(40), [...RECIPE, outfile]),
    ]) {
      expect(run.status, run.stderr).toBe(78);
      expect(run.stderr).toContain('snapshot compile refused');
    }
  });
});
