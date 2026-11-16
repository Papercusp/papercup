// EI-28973270750407333 — affected-tests' changed-path set names a changed submodule only by its
// gitlink path. scripts/lib/submodule-changed-paths.mjs recovers the files that changed INSIDE
// it; these tests pin that expansion over real repositories with real submodules, in both
// window shapes the runner uses (the work-tree window and the `--range-from/--range-to` range).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  expandSubmoduleChanges,
  formatSubmoduleExpansion,
  gitlinksOf,
} from '../../../../scripts/lib/submodule-changed-paths.mjs';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// Every git mutation below is confined to a disposable fixture repository; the shared checkout
// and its index are never touched. protocol.file.allow lets `submodule add` clone a local path.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Expansion fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Expansion fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'submodule-expansion-'));
  roots.push(root);
  git(root, 'init', '-q');
  return root;
}

function put(root: string, path: string, source: string, tracked = true): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
  if (tracked) git(root, 'add', '--', path);
}

function commit(root: string, message: string): string {
  git(root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

/** A superproject whose `base` commit pins an initialized submodule at libs/bus. */
function fixture(files: Record<string, string> = { 'src/a.ts': 'export const a = 1;\n' }) {
  const bus = repo();
  for (const [path, source] of Object.entries(files)) put(bus, path, source);
  commit(bus, 'bus');
  const root = repo();
  put(root, 'README.md', 'root\n');
  git(root, 'submodule', 'add', '-q', bus, 'libs/bus');
  const base = commit(root, 'base');
  return { root, base, sub: join(root, 'libs/bus') };
}

describe('expandSubmoduleChanges — a moved gitlink becomes the files that changed inside it', () => {
  it('reads the work-tree window: commits since the start pointer, uncommitted edits and untracked files', () => {
    const { root, base, sub } = fixture({
      'src/a.ts': 'export const a = 1;\n',
      'src/gone.ts': 'export const g = 1;\n',
      'src/dirty.ts': 'export const d = 1;\n',
      'src/stable.ts': 'export const s = 1;\n',
    });
    put(sub, 'src/a.ts', 'export const a = 2;\n');
    put(sub, 'src/new.ts', 'export const n = 1;\n');
    git(sub, 'rm', '-q', '--', 'src/gone.ts');
    commit(sub, 'inside the submodule');
    git(root, 'add', 'libs/bus');
    commit(root, 'bump the gitlink');
    put(sub, 'src/dirty.ts', 'export const d = 2;\n', false);
    put(sub, 'src/untracked.ts', 'export const t = 1;\n', false);

    const result = expandSubmoduleChanges({ root, changed: ['libs/bus'], from: base });

    expect(result.paths).toEqual([
      'libs/bus/src/a.ts', 'libs/bus/src/dirty.ts', 'libs/bus/src/gone.ts',
      'libs/bus/src/new.ts', 'libs/bus/src/untracked.ts',
    ]);
    expect(result.paths).not.toContain('libs/bus/src/stable.ts');
    expect(result).toMatchObject({ compared: ['libs/bus'], whole: [], unexpanded: [] });
  });

  it('reads a historical range between the two recorded pointers, ignoring the work tree', () => {
    const { root, base, sub } = fixture({
      'src/a.ts': 'export const a = 1;\n',
      'src/stable.ts': 'export const s = 1;\n',
    });
    put(sub, 'src/a.ts', 'export const a = 2;\n');
    commit(sub, 'inside the submodule');
    git(root, 'add', 'libs/bus');
    const head = commit(root, 'bump the gitlink');
    put(sub, 'src/stable.ts', 'export const s = 2;\n', false);

    const result = expandSubmoduleChanges({ root, changed: ['libs/bus'], from: base, to: head });

    expect(result.paths).toEqual(['libs/bus/src/a.ts']);
    expect(result).toMatchObject({ compared: ['libs/bus'], whole: [], unexpanded: [] });
  });

  it('expands a dirty submodule whose pointer never moved (the submodule-dirty leg)', () => {
    const { root, base, sub } = fixture({
      'src/a.ts': 'export const a = 1;\n',
      'src/stable.ts': 'export const s = 1;\n',
    });
    put(sub, 'src/a.ts', 'export const a = 2;\n', false);

    const result = expandSubmoduleChanges({ root, changed: ['libs/bus'], from: base });

    expect(result.paths).toEqual(['libs/bus/src/a.ts']);
  });

  it('recurses into a nested submodule through the pointer its parent recorded', () => {
    const inner = repo();
    put(inner, 'x.ts', 'export const x = 1;\n');
    put(inner, 'y.ts', 'export const y = 1;\n');
    commit(inner, 'inner');
    const bus = repo();
    put(bus, 'src/a.ts', 'export const a = 1;\n');
    git(bus, 'submodule', 'add', '-q', inner, 'vendor/inner');
    commit(bus, 'bus with a nested submodule');
    const root = repo();
    put(root, 'README.md', 'root\n');
    git(root, 'submodule', 'add', '-q', bus, 'libs/bus');
    git(root, 'submodule', 'update', '-q', '--init', '--recursive');
    const base = commit(root, 'base');

    const sub = join(root, 'libs/bus');
    const nested = join(sub, 'vendor/inner');
    put(nested, 'x.ts', 'export const x = 2;\n');
    commit(nested, 'inside the nested submodule');
    git(sub, 'add', 'vendor/inner');
    commit(sub, 'bump the nested gitlink');
    git(root, 'add', 'libs/bus');
    const head = commit(root, 'bump the outer gitlink');

    const expected = ['libs/bus/vendor/inner', 'libs/bus/vendor/inner/x.ts'];
    const range = expandSubmoduleChanges({ root, changed: ['libs/bus'], from: base, to: head });
    expect(range.paths).toEqual(expected);
    expect(range.compared).toEqual(['libs/bus', 'libs/bus/vendor/inner']);
    expect(expandSubmoduleChanges({ root, changed: ['libs/bus'], from: base }).paths).toEqual(expected);

    // Uncommitted work two levels down, with neither gitlink moved: the outer diff ignores
    // dirty nested content (a retired submodule's missing gitdir would abort it otherwise), so
    // the nested repository is probed directly.
    put(nested, 'y.ts', 'export const y = 2;\n', false);
    expect(expandSubmoduleChanges({ root, changed: ['libs/bus'], from: head }).paths)
      .toEqual(['libs/bus/vendor/inner', 'libs/bus/vendor/inner/y.ts']);
  });

  it('leaves paths that are not gitlinks alone', () => {
    const { root, base } = fixture();
    put(root, 'README.md', 'changed\n');
    expect(expandSubmoduleChanges({ root, changed: ['README.md', 'src/app.ts'], from: base }))
      .toEqual({ paths: [], compared: [], whole: [], unexpanded: [] });
  });
});

describe('expandSubmoduleChanges — a submodule it cannot compare is listed whole or reported, never dropped', () => {
  it('lists a submodule whole when the pointer its start records is not in its object store', () => {
    const { root, sub } = fixture({ 'src/a.ts': '1\n', 'src/b.ts': '1\n' });
    const busHead = git(sub, 'rev-parse', 'HEAD');
    git(root, 'update-index', '--cacheinfo', `160000,${'f'.repeat(40)},libs/bus`);
    const base = commit(root, 'base pins a commit the submodule never fetched');
    git(root, 'update-index', '--cacheinfo', `160000,${busHead},libs/bus`);
    const head = commit(root, 'restore the gitlink');

    for (const to of [null, head]) {
      const result = expandSubmoduleChanges({ root, changed: ['libs/bus'], from: base, to });
      expect(result.whole).toEqual([{ path: 'libs/bus', reason: 'start-not-local' }]);
      expect(result.paths).toEqual(['libs/bus/src/a.ts', 'libs/bus/src/b.ts']);
      expect(result.compared).toEqual([]);
    }
  });

  it('lists a submodule added inside the window whole', () => {
    const root = repo();
    put(root, 'README.md', 'root\n');
    const base = commit(root, 'base');
    const bus = repo();
    put(bus, 'src/a.ts', '1\n');
    commit(bus, 'bus');
    git(root, 'submodule', 'add', '-q', bus, 'libs/bus');
    const head = commit(root, 'add the submodule');

    for (const to of [null, head]) {
      const result = expandSubmoduleChanges({ root, changed: ['.gitmodules', 'libs/bus'], from: base, to });
      expect(result.whole).toEqual([{ path: 'libs/bus', reason: 'added' }]);
      expect(result.paths).toEqual(['libs/bus/src/a.ts']);
    }
  });

  it('reports an uninitialized submodule instead of running git in the parent repository', () => {
    const { root, base, sub } = fixture();
    put(sub, 'src/a.ts', '2\n');
    commit(sub, 'inside the submodule');
    git(root, 'add', 'libs/bus');
    commit(root, 'bump the gitlink');
    git(root, 'submodule', 'deinit', '-q', '-f', '--', 'libs/bus');
    // A parent-repository edit makes the failure mode observable: git run in the empty
    // directory would answer for the parent and report README.md under libs/bus/.
    put(root, 'README.md', 'parent edit\n', false);

    const result = expandSubmoduleChanges({ root, changed: ['libs/bus'], from: base });

    expect(result.unexpanded).toEqual([{ path: 'libs/bus', reason: 'not-initialized' }]);
    expect(result.paths).toEqual([]);
  });

  it('reports a submodule removed inside the window', () => {
    const { root, base } = fixture();
    git(root, 'rm', '-q', 'libs/bus');
    const head = commit(root, 'remove the submodule');

    for (const to of [null, head]) {
      const result = expandSubmoduleChanges({ root, changed: ['.gitmodules', 'libs/bus'], from: base, to });
      expect(result.unexpanded).toEqual([{ path: 'libs/bus', reason: 'removed' }]);
      expect(result.paths).toEqual([]);
    }
  });

  it('reports a range whose end pointer the submodule does not have', () => {
    const { root, base } = fixture();
    git(root, 'update-index', '--cacheinfo', `160000,${'e'.repeat(40)},libs/bus`);
    const head = commit(root, 'pin a commit the submodule never fetched');

    const result = expandSubmoduleChanges({ root, changed: ['libs/bus'], from: base, to: head });

    expect(result.unexpanded).toEqual([{ path: 'libs/bus', reason: 'end-not-local' }]);
    expect(result.paths).toEqual([]);
  });

  it('names every omission on its own line', () => {
    expect(formatSubmoduleExpansion({
      paths: ['libs/a/x.ts'],
      compared: ['libs/a'],
      whole: [{ path: 'libs/b', reason: 'added' }],
      unexpanded: [{ path: 'libs/c', reason: 'not-initialized' }],
    })).toEqual([
      'SUBMODULE_EXPANSION paths=1 compared=1 whole=1 unexpanded=1',
      'SUBMODULE_EXPANSION_WHOLE path=libs/b reason=added',
      'SUBMODULE_EXPANSION_UNEXPANDED path=libs/c reason=not-initialized (only its gitlink path represents it)',
    ]);
  });
});

describe('gitlinksOf', () => {
  it('reads gitlinks from a commit and from the index', () => {
    const { root, base, sub } = fixture();
    const pinned = git(sub, 'rev-parse', 'HEAD');
    expect([...gitlinksOf(root, base)]).toEqual([['libs/bus', pinned]]);
    expect([...gitlinksOf(root, null)]).toEqual([['libs/bus', pinned]]);
    unlinkSync(join(root, 'README.md'));
    expect([...gitlinksOf(root, null)]).toEqual([['libs/bus', pinned]]);
  });
});
