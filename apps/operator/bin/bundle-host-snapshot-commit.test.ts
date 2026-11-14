/**
 * bundle_host_snapshot_commit (apps/operator/bin/bundle-host-common.sh) gives a
 * dirty working-tree bundle a TRUE source identity: an unreferenced commit
 * whose tree byte-equals the working tree, recursing into submodules. The
 * working-tree operator-API route (WI-6554700010048234) opts in with
 * PAPERCUSP_BUNDLE_SNAPSHOT_DIRTY=1; every other build keeps '<HEAD>+dirty'.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const COMMON = join(REPO_ROOT, 'apps/operator/bin/bundle-host-common.sh');

let dir = '';
let env: NodeJS.ProcessEnv = {};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const common = (fn: string, args: string[], extra: NodeJS.ProcessEnv = {}) => execFileSync('bash',
  ['-c', 'source "$1"; shift; fn="$1"; shift; "$fn" "$@"', 'snapshot-test', COMMON, fn, ...args],
  { env: { ...env, ...extra }, encoding: 'utf8' }).trim();
const repo = (name: string, files: Record<string, string>) => {
  const path = join(dir, name);
  git(dir, 'init', '-q', '-b', 'main', path);
  for (const [file, body] of Object.entries(files)) writeFileSync(join(path, file), body);
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', name);
  return path;
};
/** Everything a snapshot must not move: refs, the real index and the status. */
const untouched = (path: string) => [git(path, 'for-each-ref'), git(path, 'ls-files', '--stage'),
  git(path, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none')].join('\n');

describe('bundle_host_snapshot_commit', () => {
  let sup = '';
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'bundle-host-snapshot-')));
    const config = join(dir, 'gitconfig');
    writeFileSync(config, '[user]\n\tname = t\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n'
      + '[commit]\n\tgpgsign = false\n');
    env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
    const nested = repo('nested-src', { 'n.txt': 'nested\n' });
    const sub = repo('sub-src', { 's.txt': 'sub\n' });
    git(sub, 'submodule', 'add', '-q', nested, 'nested');
    git(sub, 'commit', '-q', '-m', 'nested');
    sup = repo('sup', { 'a.txt': 'a\n', '.gitignore': 'ignored.txt\n' });
    git(sup, 'submodule', 'add', '-q', sub, 'sub');
    git(sup, 'commit', '-q', '-m', 'sub');
    git(sup, 'submodule', 'update', '-q', '--init', '--recursive');
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('returns HEAD for a clean checkout', () => {
    expect(common('bundle_host_snapshot_commit', [sup])).toBe(git(sup, 'rev-parse', 'HEAD'));
  });

  it('snapshots tracked, untracked and nested-submodule bytes without moving refs or the index', () => {
    writeFileSync(join(sup, 'a.txt'), 'a changed\n');
    writeFileSync(join(sup, 'new.txt'), 'untracked\n');
    writeFileSync(join(sup, 'ignored.txt'), 'never snapshotted\n');
    writeFileSync(join(sup, 'sub', 'sub-new.txt'), 'sub untracked\n');
    writeFileSync(join(sup, 'sub', 'nested', 'n.txt'), 'nested changed\n');
    const before = [sup, join(sup, 'sub'), join(sup, 'sub', 'nested')].map(untouched);
    const head = git(sup, 'rev-parse', 'HEAD');

    const snapshot = common('bundle_host_snapshot_commit', [sup]);

    expect(snapshot).toMatch(/^[a-f0-9]{40}$/);
    expect(snapshot).not.toBe(head);
    expect(git(sup, 'rev-parse', `${snapshot}^`)).toBe(head);
    expect(git(sup, 'show', `${snapshot}:a.txt`)).toBe('a changed');
    expect(git(sup, 'show', `${snapshot}:new.txt`)).toBe('untracked');
    expect(() => git(sup, 'rev-parse', '--verify', '--quiet', `${snapshot}:ignored.txt`)).toThrow();
    const subSnapshot = git(sup, 'rev-parse', `${snapshot}:sub`);
    const subDir = join(sup, 'sub');
    expect(git(subDir, 'show', `${subSnapshot}:sub-new.txt`)).toBe('sub untracked');
    const nestedSnapshot = git(subDir, 'rev-parse', `${subSnapshot}:nested`);
    expect(git(join(subDir, 'nested'), 'show', `${nestedSnapshot}:n.txt`)).toBe('nested changed');
    // Content-addressed: the same bytes mint the same commit.
    expect(common('bundle_host_snapshot_commit', [sup])).toBe(snapshot);
    expect([sup, subDir, join(subDir, 'nested')].map(untouched)).toEqual(before);
  });

  it('labels a dirty source with the snapshot only when the route opts in', () => {
    const head = git(sup, 'rev-parse', '--short', 'HEAD');
    expect(common('bundle_host_source_sha', [sup])).toBe(`${head}+dirty`);
    const labelled = common('bundle_host_source_sha', [sup], { PAPERCUSP_BUNDLE_SNAPSHOT_DIRTY: '1' });
    expect(labelled).toMatch(/^[a-f0-9]{7,40}$/);
    expect(git(sup, 'rev-parse', `${labelled}^{commit}`)).toBe(common('bundle_host_snapshot_commit', [sup]));
  });
});
