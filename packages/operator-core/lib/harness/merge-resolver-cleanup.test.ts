import { describe, expect, it, vi } from 'vitest';
import {
  cleanupMergeResolverAfterFailure,
  type MergeResolverCleanupDeps,
  type MergeResolverGitResult,
  __test,
} from './merge-resolver-cleanup';

const RELEASED = {
  released: ['resolver-lock'],
  heldBefore: 1,
  crossDomainReleased: [],
  granularReleased: 0,
  resourcesReleased: 0,
};

const conflictExtra = (
  scopes: string[],
  files: string,
): string[] => [
  '--git-sync-conflict',
  JSON.stringify({ scopes, files, authorship: [] }),
];

function scriptedGit(
  responses: Record<string, MergeResolverGitResult>,
): { runGit: NonNullable<MergeResolverCleanupDeps['runGit']>; calls: string[][] } {
  const calls: string[][] = [];
  const runGit = vi.fn(async (args: string[], cwd: string) => {
    calls.push([cwd, ...args]);
    return responses[`${cwd}:${args.join(' ')}`] ?? { code: 0, stdout: '', stderr: '' };
  });
  return { runGit, calls };
}

function releaseDeps(over: Partial<MergeResolverCleanupDeps> = {}): MergeResolverCleanupDeps {
  return {
    releaseLocks: vi.fn(async () => RELEASED),
    lockDomain: vi.fn(() => '/lock-domain'),
    ...over,
  };
}

describe('merge-resolver cleanup parser seams', () => {
  it('parses the scoped conflict wire format and rejects unknown or duplicate segments', () => {
    const parse = __test.parseConflictPayload;
    const parsed = parse(conflictExtra(['superproject'], 'superproject: src/a.ts'));
    expect(parsed).toEqual({
      scopes: ['superproject'],
      files: 'superproject: src/a.ts',
    });
    expect(__test.parseDeclaredFiles(parsed!)).toEqual(
      new Map([['superproject', new Set(['src/a.ts'])]]),
    );
    const unknown = parse(conflictExtra(['superproject'], 'other: src/a.ts'));
    expect(unknown).not.toBeNull();
    expect(__test.parseDeclaredFiles(unknown!)).toBeNull();
    const duplicate = parse(
      conflictExtra(['superproject'], 'superproject: src/a.ts; superproject: src/b.ts'),
    );
    expect(duplicate).not.toBeNull();
    expect(__test.parseDeclaredFiles(duplicate!)).toBeNull();
  });

  it('parses porcelain -z paths, including both sides of a rename', () => {
    expect(__test.parseStatusPaths('UU src/merge.ts\0R  src/new.ts\0src/old.ts\0')).toEqual([
      'src/merge.ts',
      'src/new.ts',
      'src/old.ts',
    ]);
    expect(__test.parseStatusPaths(' M ../outside.ts\0')).toBeNull();
  });
});

describe('cleanupMergeResolverAfterFailure', () => {
  it('aborts only allowlisted dirty paths in every declared repository scope and releases the exact owner', async () => {
    const { runGit, calls } = scriptedGit({
      '/repo:rev-parse --show-toplevel': { code: 0, stdout: '/repo\n', stderr: '' },
      '/repo:rev-parse --verify --quiet MERGE_HEAD': { code: 0, stdout: 'merge-sha\n', stderr: '' },
      '/repo:status --porcelain=v1 -z -uall': { code: 0, stdout: 'UU packages/a.ts\0', stderr: '' },
      '/repo/libs/papercusp:rev-parse --show-superproject-working-tree': {
        code: 0,
        stdout: '/repo\n',
        stderr: '',
      },
      '/repo/libs/papercusp:rev-parse --verify --quiet MERGE_HEAD': {
        code: 0,
        stdout: 'sub-merge-sha\n',
        stderr: '',
      },
      '/repo/libs/papercusp:status --porcelain=v1 -z -uall': {
        code: 0,
        stdout: 'UU packages/x.ts\0',
        stderr: '',
      },
      '/repo:merge --abort': { code: 0, stdout: '', stderr: '' },
      '/repo/libs/papercusp:merge --abort': { code: 0, stdout: '', stderr: '' },
    });
    const deps = releaseDeps({ runGit });

    const result = await cleanupMergeResolverAfterFailure(
      {
        projectPath: '/repo',
        ownerId: 's-invoke-resolver',
        extra: conflictExtra(
          ['superproject', 'libs/papercusp'],
          'superproject: packages/a.ts; libs/papercusp: packages/x.ts',
        ),
      },
      deps,
    );

    expect(result).toMatchObject({
      parsed: true,
      scopes: [
        { scope: 'superproject', outcome: 'aborted' },
        { scope: 'libs/papercusp', outcome: 'aborted' },
      ],
      released: true,
      release: RELEASED,
    });
    expect(calls).toContainEqual(['/repo', 'merge', '--abort']);
    expect(calls).toContainEqual(['/repo/libs/papercusp', 'merge', '--abort']);
    expect(deps.releaseLocks).toHaveBeenCalledWith({
      ownerId: 's-invoke-resolver',
      primaryCoordinationDomain: '/lock-domain',
    });
  });

  it('protects peer-dirty paths by skipping merge abort while still releasing the child owner', async () => {
    const { runGit, calls } = scriptedGit({
      '/repo:rev-parse --show-toplevel': { code: 0, stdout: '/repo\n', stderr: '' },
      '/repo:rev-parse --verify --quiet MERGE_HEAD': { code: 0, stdout: 'merge-sha\n', stderr: '' },
      '/repo:status --porcelain=v1 -z -uall': { code: 0, stdout: 'UU peer-owned.ts\0', stderr: '' },
    });
    const deps = releaseDeps({ runGit });

    const result = await cleanupMergeResolverAfterFailure(
      {
        projectPath: '/repo',
        ownerId: 's-invoke-resolver',
        extra: conflictExtra(['superproject'], 'superproject: resolver-owned.ts'),
      },
      deps,
    );

    expect(result.released).toBe(true);
    expect(result.scopes).toEqual([
      {
        scope: 'superproject',
        outcome: 'skipped',
        reason: 'dirty path is outside the declared conflict allowlist',
      },
    ]);
    expect(calls).not.toContainEqual(['/repo', 'merge', '--abort']);
    expect(deps.releaseLocks).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an invalid payload and still releases the exact owner', async () => {
    const runGit = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const deps = releaseDeps({ runGit });

    const result = await cleanupMergeResolverAfterFailure(
      {
        projectPath: '/repo',
        ownerId: 's-invoke-resolver',
        extra: ['--git-sync-conflict', '{bad-json'],
      },
      deps,
    );

    expect(result).toMatchObject({
      parsed: false,
      released: true,
      scopes: [
        {
          scope: 'merge-resolver',
          outcome: 'skipped',
          reason: 'missing or invalid --git-sync-conflict allowlist',
        },
      ],
    });
    expect(runGit).not.toHaveBeenCalled();
    expect(deps.releaseLocks).toHaveBeenCalledTimes(1);
  });

  it('releases the owner when git inspection throws and reports the inspection failure', async () => {
    const runGit = vi.fn(async () => {
      throw new Error('checkout vanished');
    });
    const deps = releaseDeps({ runGit });

    const result = await cleanupMergeResolverAfterFailure(
      {
        projectPath: '/repo',
        ownerId: 's-invoke-resolver',
        extra: conflictExtra(['superproject'], 'superproject: resolver-owned.ts'),
      },
      deps,
    );

    expect(result.parsed).toBe(true);
    expect(result.released).toBe(true);
    expect(result.scopes[0]).toMatchObject({
      outcome: 'failed',
      reason: 'cleanup inspection failed: checkout vanished',
    });
    expect(deps.releaseLocks).toHaveBeenCalledTimes(1);
  });
});
