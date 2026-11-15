import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completionMaintenancePaths, completionTreeStampForEvidence, completionSettlementManifest } from './completion-freshness';
import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';

// The real canonical classifier, with only Git object I/O injected. No alternate ownership rules.
const repo = '/fixture/repo';
const stamp: typeof completionTreeStampForEvidence = (evidence, roots) => completionTreeStampForEvidence(evidence, roots, {
  readFile: (path) => path === `${repo}/.git/HEAD` ? 'a'.repeat(40) : undefined,
  exists: (path) => path === `${repo}/src/a.ts`,
  isCheckoutRoot: (path) => path === repo,
  readBytes: () => Buffer.from('source'),
  headBlobs: async (_root, _head, paths) => new Map(paths.map((path) => [path, { status: 'absent' as const }])),
});

describe('maintenance uses canonical completion identity', () => {
  it.each(['src/a.ts', `${repo}/src/a.ts`, 'repo/src/a.ts'])(
    'keeps %s repository-backed', async (path) => {
      const evidence = { filesChanged: [path] };
      const tree = await stamp(evidence, [repo]);
      expect(await completionMaintenancePaths(evidence, [repo], tree, { stamp })).toEqual({
        external: [], repository: [path], unknown: [],
      });
    },
  );
  it('retains exact external changed/deleted paths and excludes them from Git settlement', async () => {
    const evidence = { filesChanged: ['/data/copy', 'src/a.ts'], filesDeleted: ['/data/old'] };
    const tree = await stamp(evidence, [repo]);
    expect(await completionMaintenancePaths(evidence, [repo], tree, { stamp, realPath: (path) => path })).toEqual({
      external: [{ path: '/data/copy', realPath: '/data/copy' }, { path: '/data/old', realPath: '/data/old' }],
      repository: ['src/a.ts'], unknown: [],
    });
    const manifest = completionSettlementManifest({ ...evidence, treeStamp: tree });
    expect(manifest?.normalizedPaths).toEqual(['src/a.ts']);
    expect(tree?.contentIdentity?.filter((entry) => entry.outOfRepoArtifact)).toEqual([
      { path: '/data/copy', workingTreeBlobSha: null, headBlobSha: null, outOfRepoArtifact: true },
      { path: '/data/old', workingTreeBlobSha: null, headBlobSha: null, deletion: true, outOfRepoArtifact: true },
    ]);
  });
  it('keeps a symlink target into a checkout repository-backed', async () => {
    const evidence = { filesChanged: ['/external/alias'] };
    const tree = await stamp(evidence, [repo]);
    expect(await completionMaintenancePaths(evidence, [repo], tree, {
      stamp, realPath: () => `${repo}/src/a.ts`,
    })).toEqual({ external: [], repository: ['/external/alias'], unknown: [] });
  });
  it('persists resolved source identity and Git settlement for an external alias into a checkout', async () => {
    const evidence = { filesChanged: ['/external/alias'] };
    const tree = await completionTreeStampForEvidence(evidence, [repo], {
      readFile: (path) => path === `${repo}/.git/HEAD` ? 'a'.repeat(40) : undefined,
      exists: (path) => path === `${repo}/src/a.ts`, isCheckoutRoot: (path) => path === repo,
      readBytes: () => Buffer.from('source'),
      headBlobs: async (_root, _head, paths) => new Map(paths.map((path) => [path, { status: 'absent' as const }])),
      realPath: (path) => path === '/external/alias' ? `${repo}/src/a.ts` : path,
    });
    expect(tree?.contentIdentity).toHaveLength(1);
    expect(tree?.contentIdentity?.[0]).toMatchObject({ path: 'src/a.ts', repositoryRoot: repo });
    expect(tree?.contentIdentity?.[0]?.outOfRepoArtifact).toBeUndefined();
    expect(completionSettlementManifest({ ...evidence, treeStamp: tree })?.normalizedPaths).toEqual(['src/a.ts']);
  });
  it('fails closed on missing/truncated stamps, unreadable paths and relative escapes', async () => {
    const evidence = { filesChanged: ['/data/copy'] };
    const tree = await stamp(evidence, [repo]);
    expect((await completionMaintenancePaths(evidence, [repo], undefined)).unknown).toEqual(['/data/copy']);
    expect((await completionMaintenancePaths(evidence, [repo], tree, {
      stamp, realPath: () => { throw new Error('EACCES'); },
    })).unknown).toEqual(['/data/copy']);
    expect((await completionMaintenancePaths(evidence, [repo], tree, {
      stamp: async () => undefined, realPath: (path) => path,
    })).unknown).toEqual(['/data/copy']);
    const escaped = { filesChanged: ['../../data/copy'] };
    expect((await completionMaintenancePaths(escaped, [repo], await stamp(escaped, [repo]))).unknown).toEqual(['../../data/copy']);
  });
  it('resolves a removed target through an existing symlinked parent with real filesystem reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'completion-maintenance-path-'));
    try {
      mkdirSync(join(dir, 'data'));
      symlinkSync(join(dir, 'data'), join(dir, 'alias'));
      const path = join(dir, 'alias', 'removed');
      const evidence: CompletionVerificationEvidence = { filesDeleted: [path] };
      const tree = await stamp(evidence, [repo]);
      expect((await completionMaintenancePaths(evidence, [repo], tree, { stamp })).external).toEqual([
        { path, realPath: join(realpathSync(join(dir, 'data')), 'removed') },
      ]);
      // A symlink loop is unknown, rather than a valid preserved external target.
      symlinkSync('loop', join(dir, 'loop'));
      const loop = { filesChanged: [join(dir, 'loop')] };
      expect((await completionMaintenancePaths(loop, [repo], await stamp(loop, [repo]), { stamp })).unknown).toEqual(loop.filesChanged);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
