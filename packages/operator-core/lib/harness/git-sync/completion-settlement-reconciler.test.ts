import { describe, expect, it } from 'vitest';
import { residualPathsForCommit } from './completion-settlement-reconciler';

const SHA = 'a'.repeat(40);
const manifest = {
  version: 1 as const,
  generation: 2,
  evidenceHash: 'b'.repeat(64),
  repositoryRoot: '/repo',
  headSha: 'c'.repeat(40),
  normalizedPaths: ['a.ts', 'nested/b.ts'],
  contentIdentity: [
    { path: 'a.ts', workingTreeBlobSha: 'd'.repeat(40), headBlobSha: null },
    { path: 'nested/b.ts', workingTreeBlobSha: 'e'.repeat(40), headBlobSha: null },
  ],
};

describe('residualPathsForCommit', () => {
  it('settles only when every close-time blob is present in the exact commit', () => {
    expect(residualPathsForCommit(manifest, SHA, () => new Map([
      ['a.ts', 'd'.repeat(40)],
      ['nested/b.ts', 'e'.repeat(40)],
    ]))).toEqual([]);
  });

  it('persists deterministic residue for partial and mismatched commits', () => {
    expect(residualPathsForCommit(manifest, SHA, () => new Map([
      ['a.ts', 'f'.repeat(40)],
    ]))).toEqual([
      { path: 'a.ts', reason: 'content-mismatch' },
      { path: 'nested/b.ts', reason: 'missing-from-commit' },
    ]);
  });

  it('fails closed when the exact-tree lookup is unavailable', () => {
    expect(residualPathsForCommit(manifest, SHA, () => undefined)).toEqual([
      { path: 'a.ts', reason: 'identity-unavailable' },
      { path: 'nested/b.ts', reason: 'identity-unavailable' },
    ]);
  });
});
