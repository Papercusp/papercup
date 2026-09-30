/**
 * Recurrence guard for WI-1734042.
 *
 * A retry may pass because the first attempt saw a different working tree. The
 * classifier must reject that as a FLAKE, and must also reject unreadable
 * snapshots rather than manufacturing a green attribution.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyRetryTreeProvenance,
  formatRetryTreeProvenanceNotice,
  parseRetryTreeStatus,
  snapshotRetryTree,
  RETRY_TREE_PROVENANCE_TOKEN,
} from '../../../../scripts/lib/retry-tree-provenance.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const snapshot = (over: Record<string, unknown> = {}) => ({
  known: true,
  head: 'aaa',
  digest: 'digest-a',
  changedPaths: [],
  reason: null,
  ...over,
});

describe('classifyRetryTreeProvenance', () => {
  it('accepts a retry as a flake only when HEAD and working-tree digest are stable', () => {
    expect(classifyRetryTreeProvenance(snapshot(), snapshot())).toEqual({
      classification: 'flake',
      reason: 'tree-stable',
    });
  });

  it('catches a dirty-to-dirty content change that a status-only control misses', () => {
    const before = snapshot({ changedPaths: ['scripts/subject.mjs'], digest: 'dirty-v1' });
    const after = snapshot({ changedPaths: ['scripts/subject.mjs'], digest: 'dirty-v2' });
    const statusOnlyControl = (a: typeof before, b: typeof after) =>
      a.changedPaths.join('\0') !== b.changedPaths.join('\0');

    expect(statusOnlyControl(before, after)).toBe(false);
    expect(classifyRetryTreeProvenance(before, after)).toEqual({
      classification: 'tree-changed',
      reason: 'working-tree-changed',
    });
  });

  it('catches a commit between attempts even when the dirty path set is empty', () => {
    expect(
      classifyRetryTreeProvenance(snapshot(), snapshot({ head: 'bbb' })),
    ).toEqual({ classification: 'tree-changed', reason: 'head-changed' });
  });

  it('fails closed when either snapshot is unreadable', () => {
    expect(
      classifyRetryTreeProvenance(snapshot(), snapshot({ known: false, reason: 'status-unreadable' })),
    ).toEqual({ classification: 'provenance-unknown', reason: 'snapshot-unreadable' });
    expect(classifyRetryTreeProvenance(null, snapshot()).classification).toBe('provenance-unknown');
  });

  it('formats a machine-readable notice for non-flake attribution', () => {
    expect(formatRetryTreeProvenanceNotice({
      workspace: 'operator-core',
      classification: 'provenance-unknown',
      reason: 'status-unreadable',
    })).toBe(
      `${RETRY_TREE_PROVENANCE_TOKEN} workspace="operator-core" ` +
        'classification=provenance-unknown reason=status-unreadable',
    );
  });
});

describe('snapshotRetryTree', () => {
  it('parses NUL-delimited status and retains rename source paths', () => {
    expect(parseRetryTreeStatus(Buffer.from('R  new.mjs\0old.mjs\0?? added.mjs\0'))).toEqual([
      { status: 'R ', path: 'new.mjs' },
      { status: 'R :source', path: 'old.mjs' },
      { status: '??', path: 'added.mjs' },
    ]);
  });

  it('reads a real repository snapshot without hashing the clean tree', () => {
    const current = snapshotRetryTree(REPO_ROOT);
    expect(current.known).toBe(true);
    expect(current.head).toMatch(/^[0-9a-f]{7,40}$/);
    expect(current.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * Recurrence guard for EI-24662228809776827. A dirty submodule used to be
 * fingerprinted by walking its whole directory, ignored build output
 * included — 81 s for `papercusp-desktop` on the shared tree, which timed out
 * every real-repository snapshot. It must be read through its own git state.
 */
describe('snapshotRetryTree with a dirty submodule', () => {
  let outer = '';
  let inner = '';
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=retry-tree', '-c', 'user.email=retry-tree@test', '-c', 'commit.gpgsign=false', ...args],
      { cwd, stdio: 'pipe' },
    );

  beforeAll(() => {
    outer = mkdtempSync(join(tmpdir(), 'retry-tree-submodule-'));
    git(outer, 'init', '-q');
    writeFileSync(join(outer, 'README.md'), 'outer\n');
    inner = join(outer, 'sub');
    mkdirSync(inner);
    git(inner, 'init', '-q');
    writeFileSync(join(inner, '.gitignore'), 'build/\n');
    writeFileSync(join(inner, 'tracked.txt'), 'v1\n');
    git(inner, 'add', '.');
    git(inner, 'commit', '-q', '-m', 'inner');
    // `git add` of an embedded repository records a gitlink (mode 160000).
    git(outer, 'add', 'README.md', 'sub');
    git(outer, 'commit', '-q', '-m', 'outer');
    // Dirty the submodule and give it ignored build output.
    writeFileSync(join(inner, 'tracked.txt'), 'v2\n');
    mkdirSync(join(inner, 'build'));
    writeFileSync(join(inner, 'build', 'artifact.bin'), 'a');
  });

  afterAll(() => {
    if (outer) rmSync(outer, { recursive: true, force: true });
  });

  it('reports the submodule as one changed path', () => {
    const snap = snapshotRetryTree(outer);
    expect(snap.known).toBe(true);
    expect(snap.changedPaths).toEqual(['sub']);
  });

  it('ignores ignored content inside the submodule instead of walking it', () => {
    const before = snapshotRetryTree(outer);
    writeFileSync(join(inner, 'build', 'artifact.bin'), 'b');
    const after = snapshotRetryTree(outer);
    expect(after.known).toBe(true);
    expect(after.digest).toBe(before.digest);
  });

  it('still detects a tracked content change inside the submodule', () => {
    const before = snapshotRetryTree(outer);
    writeFileSync(join(inner, 'tracked.txt'), `v-${Date.now()}\n`);
    const after = snapshotRetryTree(outer);
    expect(after.known).toBe(true);
    expect(classifyRetryTreeProvenance(before, after)).toEqual({
      classification: 'tree-changed',
      reason: 'working-tree-changed',
    });
  });

  it('still detects a new untracked file inside the submodule', () => {
    const before = snapshotRetryTree(outer);
    writeFileSync(join(inner, `untracked-${Date.now()}.txt`), 'new\n');
    const after = snapshotRetryTree(outer);
    expect(after.digest).not.toBe(before.digest);
  });

  it('still detects a commit inside the submodule', () => {
    const before = snapshotRetryTree(outer);
    git(inner, 'add', '-A');
    git(inner, 'commit', '-q', '-m', 'inner-2');
    const after = snapshotRetryTree(outer);
    expect(after.head).toBe(before.head);
    expect(after.digest).not.toBe(before.digest);
  });

  it('fails closed when the submodule git state is unreadable', () => {
    const readable = (root: string, args: string[]) => {
      try {
        return execFileSync('git', args, { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return null;
      }
    };
    const snap = snapshotRetryTree(outer, {
      git: (root, args) => (resolve(root) === resolve(inner) ? null : readable(root, args)),
    });
    expect(snap).toMatchObject({ known: false, reason: 'working-tree-unreadable' });
  });
});

describe('affected-tests.mjs wiring', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8');

  it('snapshots before task execution and compares the snapshot before retry', () => {
    expect(source).toContain('snapshotRetryTree(ROOT)');
    expect(source).toContain('classifyRetryTreeProvenance(');
    expect(source).toContain('formatRetryTreeProvenanceNotice({');
  });

  it('keeps changed or unknown retry provenance from claiming FLAKE absorption', () => {
    expect(source).toContain('classification !== "flake"');
    expect(source).toContain('retaining the initial failure');
  });
});
