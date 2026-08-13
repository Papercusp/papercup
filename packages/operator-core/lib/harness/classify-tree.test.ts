import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  readFileSync,
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
  // Gate on a property that does NOT depend on submodule materialization timing:
  // the canonical dev checkout is a real clone, so its superproject `.git` is a
  // DIRECTORY, while the release gate's papercusp-checkpoint tree is a git
  // worktree, so its `.git` is a FILE.
  //
  // Why this matters: the previous guard sampled ONE submodule
  // (libs/papercusp/.git) as a proxy for "submodules are materialized here", and
  // that extraction is NOT atomic. The checkpoint tree re-extracts submodule
  // source progressively (measured 0/39 materialized at 02:05Z and 38/39 at
  // 02:21Z on 2026-08-02), so a gate run landing mid-rebuild saw libs/papercusp
  // already present while its siblings were not, flipped this guard TRUE, and
  // then failed the hardcoded counts below — red-pinning the SHARED green gate on
  // a false alarm that never reproduces on a dev box (EI-19313251155452361; the
  // underlying archive-extraction cause is EI-19298378364087215).
  // WI-7005 / EI-19312284168967759 — the guard above was STILL too weak and the
  // gate red-pinned again on 2026-08-02 (verdict 08:29:59Z, cand bb054adbccf5,
  // `subs: 0` vs 6). Two independent holes, both from sampling ONE submodule with
  // `existsSync` as a proxy for "this tree uses gitlink submodules":
  //
  //   1. `existsSync` is TRUE for a DIRECTORY. `classify-tree` only returns
  //      'submodule' when `.git` is a FILE whose gitdir contains `/.git/modules/`;
  //      a `.git` DIRECTORY is a nested standalone clone and classifies as
  //      'standalone'. Measured against the real papercusp-checkpoint tree:
  //      submodules=0 standalone=6 plain=6 — i.e. exactly the reported `subs: 0`,
  //      with the guard's sampled path present the whole time.
  //   2. Extraction is progressive, so sampling ONE path says nothing about the
  //      other five. libs/papercusp materializing first flips the guard TRUE while
  //      its siblings are still bare (0/39 at 02:05Z, 38/39 at 02:21Z).
  //
  // So the guard now asserts the precondition the assertions below actually
  // depend on, over EVERY declared libs/* submodule rather than a sample: each
  // one must present `.git` as a FILE pointing into `/.git/modules/`. Any bare
  // dir, any nested clone, any partial extraction ⇒ this is not a gitlink
  // checkout and the layout census does not apply here.
  //
  // Deliberately fs-level and NOT expressed via walkHarnessTree: a guard derived
  // from the very oracle it guards would silently SKIP if someone genuinely broke
  // submodule classification, converting a real regression into a green run. The
  // guard checks the ENVIRONMENT; the assertions check the CLASSIFIER.
  const readDeclaredLibsSubmodules = (): string[] => {
    const gitmodules = join(papercupRoot, '.gitmodules');
    if (!existsSync(gitmodules)) return [];
    // `path = libs/<name>` entries only — nested (libs/generic/*) are not direct
    // children of libs/ and are not part of this census.
    return [...readFileSync(gitmodules, 'utf-8').matchAll(/^\s*path\s*=\s*(libs\/[^/\s]+)\s*$/gm)].map(
      (m) => m[1] as string,
    );
  };

  const isGitlinkSubmodule = (relPath: string): boolean => {
    const gitPath = join(papercupRoot, relPath, '.git');
    if (statSync(gitPath, { throwIfNoEntry: false })?.isFile() !== true) return false;
    return /^gitdir:\s*.*\/\.git\/modules\//m.test(readFileSync(gitPath, 'utf-8'));
  };

  // A declared submodule is ACCEPTABLE in one of exactly two shapes:
  //   - its directory is ABSENT entirely   ⇒ de-materialized on purpose. This is
  //     the retired `libs/zero-harness`, which is still declared in .gitmodules
  //     but deliberately not checked out (see CLAUDE.md "Zero is retired"). Its
  //     absence is why the census below is 6, not the 7 .gitmodules declares.
  //   - it is a gitlink FILE into /.git/modules/  ⇒ properly materialized.
  // Anything else — a directory present WITHOUT a gitlink (source extracted by
  // `git archive`, or extraction still in flight), or a `.git` DIRECTORY (a
  // nested standalone clone) — means this tree is not the shape the census
  // describes, so skip rather than red-pin the shared gate on a false alarm.
  const isAcceptableShape = (relPath: string): boolean =>
    !existsSync(join(papercupRoot, relPath)) || isGitlinkSubmodule(relPath);

  // WI-7047 / EI-19343787099658433 — hole #3, and the reason the two hardenings
  // above did not stop the false reds: this predicate was a `const` evaluated in
  // the DESCRIBE BODY, i.e. at COLLECTION time, while the assertions it guards run
  // at EXECUTION time. Those are different instants, and the comment at the top of
  // this block records that the gate's tree materializes PROGRESSIVELY across
  // exactly such a window (0/39 submodules at 02:05Z, 38/39 at 02:21Z). So a run
  // could evaluate the guard while the tree still qualified, then assert after a
  // concurrent reset/extraction had de-materialized it — reporting `subs: 0` and
  // red-pinning the SHARED gate on a false alarm. Measured 2026-08-02: this file
  // was SELECTED in all 14 of the day's red verdicts but FAILED in only 5 of them,
  // and all 14 tests pass at HEAD (119/119 across this file + the two other
  // recurring "blockers") — the signature of an environment race, not a defect.
  //
  // Fix: keep the collection-time check as a fast path, but RE-EVALUATE the same
  // predicate inside each test immediately before asserting. This can only turn a
  // would-be FALSE RED into a skip; it can never mask a real classifier regression,
  // because on a genuine dev checkout the predicate stays true and the assertions
  // still run (verified: 14/14 here, no skips).
  const evaluateIsPapercupCheckout = (): boolean => {
    const declared = readDeclaredLibsSubmodules();
    return (
      existsSync(join(papercupRoot, '.gitmodules')) &&
      statSync(join(papercupRoot, '.git'), { throwIfNoEntry: false })?.isDirectory() === true &&
      declared.length > 0 &&
      declared.some(isGitlinkSubmodule) &&
      declared.every(isAcceptableShape)
    );
  };

  const isPapercupCheckout = evaluateIsPapercupCheckout();

  it.skipIf(!isPapercupCheckout)(
    'matches the libs/ layout: 6 submodules + 7 plain (including papercusp-publish-auth)',
    (ctx) => {
      // The skipIf above sampled the environment at COLLECTION time. Re-sample it
      // HERE, at execution time, so a tree that de-materialized in between skips
      // instead of red-pinning the shared gate (see the guard comment above).
      if (!evaluateIsPapercupCheckout()) {
        ctx.skip();
        return;
      }
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
      // 6 direct-child submodules + 7 plain dirs (incl. `generic/`, which now
      // holds the regrouped borrowable submodules — see CLAUDE.md /
      // BORROWABLE.md). History: 9s+8p pre-regroup → 5s+9p after regroup →
      // 7s+7p once `test-config` + `testing-shell` were promoted to direct
      // libs/* submodules → 7s+6p once `export-state` was retired to
      // `_retired/snapshot-system/` (retire-snapshots-instance-spec, 2026-06-09)
      // → 6s+6p once `zero-harness` was de-materialized (retired; still in
      // .gitmodules but not checked out — see CLAUDE.md "Zero is retired")
      // → 6s+7p once the plain `papercusp-publish-auth` package joined libs/.
      expect({ subs: summary.submodules, plain: summary.plain }).toEqual({
        subs: 6,
        plain: 7,
      });
      expect(summary.worktrees).toBe(0);
      expect(summary.standalone).toBe(0);
      expect(summary.total).toBe(13);
      expect(nodes.map((node) => node.relPath)).toContain('papercusp-publish-auth');

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
    (ctx) => {
      // Execution-time re-sample — see the guard comment above (WI-7047).
      if (!evaluateIsPapercupCheckout()) {
        ctx.skip();
        return;
      }
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

// EI-19464771433863331 — recurrence guard.
//
// `.papercusp` is the operator's OWN state directory: gitignored, GENERATED,
// and known to contain real git repos (`npm run gen:lib-api` materialises
// package checkouts under `.papercusp/lib-api/<pkg>/_media/<pkg>`, each with a
// `.git` FILE pointing into `.git/modules/...` — i.e. exactly the shape rule 1
// admits as a submodule). Live on 2026-08-03 three of those artifact paths were
// registered as `harness_kind: 'sub-harness'`; each registered sub-harness boots
// a substrate whose replication-liveness detector files `severity: major` EIs,
// so the artifact count multiplies every peer-log event.
//
// This fixture reproduces the real on-disk shape byte-for-byte (same nesting
// depth, same gitdir target) and fails if `.papercusp` leaves DEFAULT_SKIP_DIRS.
describe('walkHarnessTree — generated .papercusp state dir is never walked (EI-19464771433863331)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'classify-tree-papercusp-skip-'));

    // CALIBRATION CASE: a real source submodule that MUST still be found.
    // Without this the guard below would also pass if the walker returned
    // nothing at all, which would make it certify the opposite of its intent.
    mkdirSync(join(root, 'libs', 'generic', 'cache'), { recursive: true });
    writeFileSync(
      join(root, 'libs', 'generic', 'cache', '.git'),
      'gitdir: ../../../.git/modules/libs/generic/cache\n',
    );

    // THE REGRESSION: the exact live artifact path + depth (5 levels below the
    // root, reachable under the default maxDepth of 4) and the exact gitdir
    // content observed on disk.
    const artifact = join(root, '.papercusp', 'lib-api', 'tooldef', '_media', 'tooldef-http');
    mkdirSync(artifact, { recursive: true });
    writeFileSync(
      join(artifact, '.git'),
      'gitdir: ../../../.git/modules/libs/generic/tooldef-http\n',
    );
    writeFileSync(join(artifact, 'package.json'), '{"name":"tooldef-http"}\n');
    mkdirSync(join(artifact, '.papercusp'), { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the real submodule (calibration — proves the walk actually ran)', () => {
    const nodes = walkHarnessTree(root, { parentSlug: 'papercusp' });
    const submodules = nodes.filter((n) => n.kind === 'submodule');
    expect(submodules.map((n) => n.qualifiedSlug)).toContain('papercusp/libs/generic/cache');
  });

  it('does NOT classify a repo inside .papercusp/ as a submodule', () => {
    const nodes = walkHarnessTree(root, { parentSlug: 'papercusp' });

    // `qualifiedSlug` exists only on SubmoduleNode — the registration path
    // (registerSubs) filters to `kind === 'submodule'`, so that is the set
    // that can actually reach the registry.
    const submoduleSlugs = nodes
      .filter((n): n is Extract<ClassifiedNode, { kind: 'submodule' }> => n.kind === 'submodule')
      .map((n) => n.qualifiedSlug);
    expect(submoduleSlugs).not.toContain(
      'papercusp/.papercusp/lib-api/tooldef/_media/tooldef-http',
    );

    // Nothing under the state dir at all — not the repo, not the plain dirs
    // leading to it. `relPath` is present on every node variant, so this
    // catches a leak of ANY kind. A single entry means the walk descended.
    expect(nodes.map((n) => n.relPath).filter((p) => p.startsWith('.papercusp'))).toEqual([]);
  });

  it('reaches that depth when the dir is NOT skipped — proves the guard is not passing on depth', () => {
    // Same tree, `.papercusp` removed from the skip set. If this finds nothing
    // the fixture is too deep for the default maxDepth and the guard above
    // would be vacuous, passing for the wrong reason.
    const nodes = walkHarnessTree(root, { parentSlug: 'papercusp', skipDirs: ['node_modules', '.git'] });
    const submoduleSlugs = nodes
      .filter((n): n is Extract<ClassifiedNode, { kind: 'submodule' }> => n.kind === 'submodule')
      .map((n) => n.qualifiedSlug);
    expect(submoduleSlugs).toContain(
      'papercusp/.papercusp/lib-api/tooldef/_media/tooldef-http',
    );
  });
});
