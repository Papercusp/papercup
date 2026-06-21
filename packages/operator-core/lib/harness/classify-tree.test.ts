import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  classifyDir,
  walkHarnessTree,
  summarize,
  type ClassifiedNode,
} from './classify-tree';

describe('classifyDir — unit (synthetic tmp dirs, all 5 rules)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'classify-tree-unit-'));

    // Rule 1: submodule — .git is a FILE pointing into .git/modules/
    mkdirSync(join(root, 'submodule-dir'));
    writeFileSync(
      join(root, 'submodule-dir', '.git'),
      'gitdir: /home/x/parent/.git/modules/libs/sync\n',
    );

    // Rule 2: worktree — .git is a FILE pointing into .git/worktrees/
    mkdirSync(join(root, 'worktree-dir'));
    writeFileSync(
      join(root, 'worktree-dir', '.git'),
      'gitdir: /home/x/parent/.git/worktrees/F-015-1-5abusqq9\n',
    );

    // Rule 3: standalone — .git is a DIRECTORY
    mkdirSync(join(root, 'standalone-dir'));
    mkdirSync(join(root, 'standalone-dir', '.git'));

    // Rule 4: plain — no .git at all
    mkdirSync(join(root, 'plain-dir'));

    // Edge: .git file with malformed body
    mkdirSync(join(root, 'malformed-dir'));
    writeFileSync(join(root, 'malformed-dir', '.git'), 'not a gitdir line\n');

    // Edge: .git file with unrecognized target shape
    mkdirSync(join(root, 'unknown-target-dir'));
    writeFileSync(
      join(root, 'unknown-target-dir', '.git'),
      'gitdir: /somewhere/else/entirely\n',
    );

    // Edge: path that isn't a directory at all
    writeFileSync(join(root, 'just-a-file.txt'), 'hello');
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('rule 1: classifies a submodule (.git → .git/modules/<name>)', () => {
    const node = classifyDir(root, join(root, 'submodule-dir'), 'mypkg');
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('submodule');
    if (node?.kind === 'submodule') {
      expect(node.relPath).toBe('submodule-dir');
      expect(node.gitDirTarget).toContain('/.git/modules/libs/sync');
      // Rule 5: qualified slug
      expect(node.qualifiedSlug).toBe('mypkg/submodule-dir');
    }
  });

  it('rule 2: classifies a worktree (.git → .git/worktrees/<name>)', () => {
    const node = classifyDir(root, join(root, 'worktree-dir'), 'mypkg');
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('worktree');
    if (node?.kind === 'worktree') {
      expect(node.relPath).toBe('worktree-dir');
      expect(node.worktreeName).toBe('F-015-1-5abusqq9');
    }
  });

  it('rule 3: classifies a standalone repo (.git is a directory)', () => {
    const node = classifyDir(root, join(root, 'standalone-dir'), 'mypkg');
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('standalone');
    if (node?.kind === 'standalone') {
      expect(node.relPath).toBe('standalone-dir');
    }
  });

  it('rule 4: classifies a plain dir (no .git)', () => {
    const node = classifyDir(root, join(root, 'plain-dir'), 'mypkg');
    expect(node).not.toBeNull();
    expect(node!.kind).toBe('plain');
  });

  it('returns null for a path that is not a directory', () => {
    const node = classifyDir(root, join(root, 'just-a-file.txt'), 'mypkg');
    expect(node).toBeNull();
  });

  it('returns null for a path that does not exist', () => {
    const node = classifyDir(root, join(root, 'does-not-exist'), 'mypkg');
    expect(node).toBeNull();
  });

  it('treats a malformed .git file as plain (conservative)', () => {
    const node = classifyDir(root, join(root, 'malformed-dir'), 'mypkg');
    expect(node?.kind).toBe('plain');
  });

  it('treats an unrecognized .git target as plain (conservative)', () => {
    const node = classifyDir(root, join(root, 'unknown-target-dir'), 'mypkg');
    expect(node?.kind).toBe('plain');
  });

  it('builds qualifiedSlug for nested submodule paths', () => {
    // Create a deeper submodule path
    const deep = join(root, 'lib', 'a', 'b');
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      join(deep, '.git'),
      'gitdir: /elsewhere/.git/modules/lib/a/b\n',
    );
    const node = classifyDir(root, deep, 'mypkg');
    expect(node?.kind).toBe('submodule');
    if (node?.kind === 'submodule') {
      expect(node.qualifiedSlug).toBe('mypkg/lib/a/b');
    }
  });
});

describe('walkHarnessTree + summarize — synthetic mini-tree', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'classify-tree-walk-'));

    mkdirSync(join(root, 'libs'));
    // libs/sub-a — submodule
    mkdirSync(join(root, 'libs', 'sub-a'));
    writeFileSync(
      join(root, 'libs', 'sub-a', '.git'),
      'gitdir: /home/x/.git/modules/libs/sub-a\n',
    );
    // libs/sub-b — submodule
    mkdirSync(join(root, 'libs', 'sub-b'));
    writeFileSync(
      join(root, 'libs', 'sub-b', '.git'),
      'gitdir: /home/x/.git/modules/libs/sub-b\n',
    );
    // libs/plain-c — plain
    mkdirSync(join(root, 'libs', 'plain-c'));
    // libs/plain-c/inner — plain (descended into)
    mkdirSync(join(root, 'libs', 'plain-c', 'inner'));
    // top-level worktree
    mkdirSync(join(root, 'wt-foo'));
    writeFileSync(
      join(root, 'wt-foo', '.git'),
      'gitdir: /home/x/.git/worktrees/wt-foo\n',
    );
    // top-level standalone repo
    mkdirSync(join(root, 'standalone-x'));
    mkdirSync(join(root, 'standalone-x', '.git'));
    // node_modules should be skipped
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'node_modules', 'some-pkg'));
    writeFileSync(
      join(root, 'node_modules', 'some-pkg', '.git'),
      'gitdir: /something/.git/modules/some-pkg\n',
    );
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('walks and classifies all descendants, respects skipDirs', () => {
    const nodes = walkHarnessTree(root, { parentSlug: 'tinyrepo' });
    // Expected:
    //   libs                  → plain
    //   libs/sub-a            → submodule
    //   libs/sub-b            → submodule
    //   libs/plain-c          → plain
    //   libs/plain-c/inner    → plain
    //   wt-foo                → worktree
    //   standalone-x          → standalone
    // (node_modules and its children skipped)
    const summary = summarize(nodes);
    expect(summary.submodules).toBe(2);
    expect(summary.worktrees).toBe(1);
    expect(summary.standalone).toBe(1);
    // libs, libs/plain-c, libs/plain-c/inner = 3 plain
    expect(summary.plain).toBe(3);
    expect(summary.total).toBe(7);
  });

  it('respects maxDepth (depth 1 stops before libs/sub-a)', () => {
    const nodes = walkHarnessTree(root, { parentSlug: 'tinyrepo', maxDepth: 0 });
    // depth=0: only top-level entries (libs, wt-foo, standalone-x).
    // node_modules is skipped.
    const summary = summarize(nodes);
    expect(summary.submodules).toBe(0);
    expect(summary.worktrees).toBe(1);
    expect(summary.standalone).toBe(1);
    expect(summary.plain).toBe(1); // just 'libs' itself
  });

  it('worktrees are not recursed into (even if they have nested dirs)', () => {
    // Add a phantom nested submodule inside the worktree — should NOT appear.
    mkdirSync(join(root, 'wt-foo', 'nested-submod'));
    writeFileSync(
      join(root, 'wt-foo', 'nested-submod', '.git'),
      'gitdir: /elsewhere/.git/modules/nested-submod\n',
    );
    const nodes = walkHarnessTree(root, { parentSlug: 'tinyrepo' });
    const found = nodes.find((n) => n.relPath.includes('nested-submod'));
    expect(found).toBeUndefined();
  });
});

describe('walkHarnessTree — integration against papercup`s real libs/', () => {
  // Integration check against the REAL libs/ tree. `walkHarnessTree`
  // classifies from disk (a `.git` gitdir pointer), so this asserts what is
  // actually materialized, not merely what `.gitmodules` lists. Current real
  // layout: 6 direct libs/* submodules + 6 plain dirs (incl. `generic/`, which
  // holds the regrouped borrowable submodules). If a direct libs/* submodule is
  // added, removed, or (de)materialized, update the counts + the submodule-name
  // list below in sync.
  const papercupRoot = resolve(__dirname, '../../../..'); // apps/operator/lib/harness/../../../.. → papercup root
  // "Real" checkout = .gitmodules AND materialized submodules (a .git gitdir
  // pointer inside one). The release-gate checkpoint/release trees carry
  // .gitmodules but extract submodule SOURCE via `git archive` (no .git), so
  // walkHarnessTree correctly sees plain dirs there — skip these
  // integration-against-the-real-tree assertions in such trees.
  const isPapercupCheckout =
    existsSync(join(papercupRoot, '.gitmodules')) &&
    existsSync(join(papercupRoot, 'libs', 'papercusp', '.git'));

  it.skipIf(!isPapercupCheckout)(
    'matches the libs/ layout: 6 submodules + 6 plain (borrowable submodules regrouped under libs/generic/)',
    () => {
      // Walk just libs/ — not the whole repo — to keep the test fast and
      // scoped to the documented assertion.
      const libsRoot = join(papercupRoot, 'libs');
      // We want depth 0 so we only see direct children of libs/.
      // walkHarnessTree treats depth 0 as "top-level entries only".
      const nodes = walkHarnessTree(libsRoot, {
        parentSlug: 'papercup',
        maxDepth: 0,
        recurseIntoSubmodules: false,
      });
      const summary = summarize(nodes);
      // Note: we don't assert on `worktrees` or `standalone` here because
      // libs/ isn't expected to contain either; if one shows up that's a
      // signal worth investigating (and this test will catch it).
      // 6 direct-child submodules + 6 plain dirs (incl. `generic/`, which now
      // holds the regrouped borrowable submodules — see CLAUDE.md /
      // BORROWABLE.md). History: 9s+8p pre-regroup → 5s+9p after regroup →
      // 7s+7p once `test-config` + `testing-shell` were promoted to direct
      // libs/* submodules → 7s+6p once `export-state` was retired to
      // `_retired/snapshot-system/` (retire-snapshots-instance-spec, 2026-06-09)
      // → 6s+6p once `zero-harness` was de-materialized (retired; still in
      // .gitmodules but not checked out — see CLAUDE.md "Zero is retired").
      expect({ subs: summary.submodules, plain: summary.plain }).toEqual({
        subs: 6,
        plain: 6,
      });
      expect(summary.worktrees).toBe(0);
      expect(summary.standalone).toBe(0);
      expect(summary.total).toBe(12);

      // Sanity: each submodule has a qualified slug rooted at papercup.
      for (const n of nodes) {
        if (n.kind === 'submodule') {
          expect(n.qualifiedSlug.startsWith('papercup/')).toBe(true);
        }
      }
    },
  );

  it.skipIf(!isPapercupCheckout)(
    'every expected libs/* submodule (from .gitmodules) is present',
    () => {
      const libsRoot = join(papercupRoot, 'libs');
      const nodes = walkHarnessTree(libsRoot, {
        parentSlug: 'papercup',
        maxDepth: 0,
        recurseIntoSubmodules: false,
      });
      const submoduleRelPaths = nodes
        .filter((n): n is ClassifiedNode & { kind: 'submodule' } => n.kind === 'submodule')
        .map((n) => n.relPath)
        .sort();
      // The materialized .gitmodules entries DIRECTLY under libs/. The
      // borrowable submodules (git-graph, papergrid, sync, ui-primitives, +
      // others) were regrouped under libs/generic/* (CLAUDE.md / BORROWABLE.md),
      // so they are no longer direct children of libs/ and `generic/` shows up
      // as a plain dir above. `zero-harness` is retired — still listed in
      // .gitmodules but not checked out — so it does not appear here. If a
      // direct libs/* submodule is added, removed, or (de)materialized, update
      // this list in sync.
      expect(submoduleRelPaths).toEqual(
        [
          'agent-chat',
          'papercusp-db',
          'papercusp-shared',
          'papercusp',
          'test-config',
          'testing-shell',
        ].sort(),
      );
    },
  );
});
