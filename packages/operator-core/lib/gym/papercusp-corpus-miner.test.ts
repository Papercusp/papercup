/**
 * papercusp-corpus-miner.test.ts — mining real tasks out of this repo's history.
 *
 * The rules that matter are the ones that keep a MINED task honest: the oracle
 * must have co-changed with the implementation (otherwise nothing judges it),
 * the rewind must be short (a long one breaks the file's imports and poses the
 * wrong task — see the module doc), and retired code must never become a task.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INCLUDE_PREFIXES,
  assignPools,
  candidateToDescriptor,
  mineCandidatePairs,
  mineDescriptors,
  siblingTestPath,
  taskIdForCandidate,
  type CommitFileChange,
} from './papercusp-corpus-miner';

const PIN = '38ae7fafe0aeb59527af7419e64d4c50b30ee2c6';
const sha = (n: number) => `${String(n).padStart(2, '0')}`.repeat(20);

const commit = (n: number, paths: string[], parent: number | null = n + 1): CommitFileChange => ({
  sha: sha(n),
  parentSha: parent == null ? null : sha(parent),
  paths,
});

describe('siblingTestPath', () => {
  it('maps an implementation to its sibling oracle across the extensions in use', () => {
    expect(siblingTestPath('packages/x/lib/a.ts')).toBe('packages/x/lib/a.test.ts');
    expect(siblingTestPath('apps/y/b.tsx')).toBe('apps/y/b.test.tsx');
    expect(siblingTestPath('libs/z/c.mjs')).toBe('libs/z/c.test.mjs');
  });

  it('refuses a test file — a test is never an implementation to rewind', () => {
    expect(siblingTestPath('packages/x/lib/a.test.ts')).toBeNull();
    expect(siblingTestPath('packages/x/lib/a.spec.ts')).toBeNull();
  });

  it('ignores a non-source path', () => {
    expect(siblingTestPath('docs/readme.md')).toBeNull();
  });
});

describe('mineCandidatePairs', () => {
  it('mines a pair only when the ORACLE co-changed with the implementation', () => {
    const pairs = mineCandidatePairs([
      commit(1, ['packages/x/lib/a.ts', 'packages/x/lib/a.test.ts']),
      commit(2, ['packages/x/lib/b.ts']), // impl alone — nothing judges it
    ]);
    expect(pairs.map((p) => p.implPath)).toEqual(['packages/x/lib/a.ts']);
  });

  it('rewinds to the joint commit PARENT — the state right before the change', () => {
    const [p] = mineCandidatePairs([commit(1, ['packages/x/lib/a.ts', 'packages/x/lib/a.test.ts'], 9)]);
    expect(p.jointCommit).toBe(sha(1));
    expect(p.parentCommit).toBe(sha(9));
  });

  it('takes each file’s MOST RECENT joint commit — the shortest, safest rewind', () => {
    const pairs = mineCandidatePairs([
      commit(1, ['packages/x/lib/a.ts', 'packages/x/lib/a.test.ts']),
      commit(2, ['packages/x/lib/a.ts', 'packages/x/lib/a.test.ts']), // older, same file
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].jointCommit).toBe(sha(1));
    expect(pairs[0].rewindDistance).toBe(0);
  });

  it('bounds the rewind: a joint commit beyond maxRewindCommits is not mined', () => {
    // The incoherent-rewind failure mode — an old implementation may not even
    // compile against the pinned world, posing "repair an import" instead of
    // the real task, in a shape the validity gate cannot distinguish.
    const commits = [
      ...Array.from({ length: 5 }, (_, i) => commit(i + 1, ['packages/x/lib/other.ts'])),
      commit(20, ['packages/x/lib/a.ts', 'packages/x/lib/a.test.ts']),
    ];
    expect(mineCandidatePairs(commits, { maxRewindCommits: 3 })).toEqual([]);
    expect(mineCandidatePairs(commits, { maxRewindCommits: 10 })).toHaveLength(1);
  });

  it('never mines retired code — restoring behaviour nobody wants restored is not a task', () => {
    const pairs = mineCandidatePairs([
      commit(1, ['_retired/papercup/lib/a.ts', '_retired/papercup/lib/a.test.ts']),
      commit(2, ['libs/papercusp/_retired/b.ts', 'libs/papercusp/_retired/b.test.ts']),
    ]);
    expect(pairs).toEqual([]);
  });

  it('skips declaration files and anything outside the source roots', () => {
    const pairs = mineCandidatePairs([
      commit(1, ['packages/x/lib/a.d.ts', 'packages/x/lib/a.d.test.ts']),
      commit(2, ['scripts/tool.ts', 'scripts/tool.test.ts']),
    ]);
    expect(pairs).toEqual([]);
    expect(DEFAULT_INCLUDE_PREFIXES).toEqual(['packages/', 'libs/', 'apps/']);
  });

  it('skips a root commit — there is nothing to rewind to', () => {
    expect(mineCandidatePairs([commit(1, ['packages/x/lib/a.ts', 'packages/x/lib/a.test.ts'], null)])).toEqual([]);
  });

  it('ranks shortest rewind first', () => {
    const pairs = mineCandidatePairs([
      commit(1, ['packages/x/lib/far.ts']),
      commit(2, ['packages/x/lib/near.ts', 'packages/x/lib/near.test.ts']),
      commit(3, ['packages/x/lib/far.ts', 'packages/x/lib/far.test.ts']),
    ]);
    expect(pairs.map((p) => p.implPath)).toEqual(['packages/x/lib/near.ts', 'packages/x/lib/far.ts']);
  });
});

describe('assignPools', () => {
  const pairs = mineCandidatePairs(
    Array.from({ length: 6 }, (_, i) => commit(i + 1, [`packages/x/lib/f${i}.ts`, `packages/x/lib/f${i}.test.ts`])),
  );

  it('spreads candidates round-robin so real-anchor is not systematically the leftovers', () => {
    // real-anchor is scored but NEVER optimized — the falsifiability check. If it
    // got the weakest tasks it would answer a different question than train, and
    // a divergence between them would stop being evidence about the gym.
    const assigned = assignPools(pairs);
    expect(assigned.map((a) => a.pool)).toEqual([
      'train', 'dev-anchor', 'real-anchor', 'train', 'dev-anchor', 'real-anchor',
    ]);
  });

  it('rejects an empty pool list rather than silently dropping every task', () => {
    expect(() => assignPools(pairs, [])).toThrow(/at least one pool/);
  });
});

describe('taskIdForCandidate', () => {
  it('is stable, readable, and disambiguated by the joint commit', () => {
    const [p] = mineCandidatePairs([
      commit(1, ['packages/operator-core/lib/gym/clone.ts', 'packages/operator-core/lib/gym/clone.test.ts']),
    ]);
    expect(taskIdForCandidate(p)).toBe(`real-operator-core-lib-gym-clone-${sha(1).slice(0, 8)}`);
  });
});

describe('candidateToDescriptor', () => {
  const [p] = mineCandidatePairs([
    commit(1, ['packages/x/lib/a.ts', 'packages/x/lib/a.test.ts'], 9),
  ]);
  const d = candidateToDescriptor(p, 'train', PIN);

  it('points the agent at the real oracle and forbids editing it', () => {
    expect(d.spec).toContain('packages/x/lib/a.test.ts');
    expect(d.spec).toContain('must not be modified');
    expect(d.spec).toContain('npm run test:file -- packages/x/lib/a.test.ts');
  });

  it('pins the world at the pin and rewinds to the parent', () => {
    expect(d.pinCommit).toBe(PIN);
    expect(d.revertToCommit).toBe(sha(9));
  });

  it('carries auditable provenance naming both files and the commit', () => {
    expect(d.sourceRef).toContain(sha(1).slice(0, 12));
    expect(d.sourceRef).toContain('packages/x/lib/a.ts');
  });
});

describe('mineDescriptors', () => {
  it('produces ranked, pooled, ready-to-probe descriptors and honours limit', () => {
    const commits = Array.from({ length: 5 }, (_, i) =>
      commit(i + 1, [`packages/x/lib/f${i}.ts`, `packages/x/lib/f${i}.test.ts`]),
    );
    const ds = mineDescriptors(commits, PIN, { limit: 3 });
    expect(ds).toHaveLength(3);
    expect(ds.map((d) => d.pool)).toEqual(['train', 'dev-anchor', 'real-anchor']);
    expect(new Set(ds.map((d) => d.taskId)).size).toBe(3);
  });

  it('yields an EMPTY corpus when nothing co-changed — never a filler task', () => {
    expect(mineDescriptors([commit(1, ['packages/x/lib/a.ts'])], PIN)).toEqual([]);
  });
});
