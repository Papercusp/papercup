import { describe, it, expect } from 'vitest';
import { resetToRemoteMain, type ResetToRemoteMainDeps } from './git-reset-to-remote-main';

/** Fake git: records command args, returns canned output, optional throw. rev-parse
 *  returns OLDHEAD first (pre-reset) then NEWHEAD (post-reset). */
function makeDeps(
  over: Partial<ResetToRemoteMainDeps> = {},
  opts: { stash?: string; throwOn?: (args: string[]) => boolean } = {},
): { deps: ResetToRemoteMainDeps; calls: string[][] } {
  const calls: string[][] = [];
  let revParse = 0;
  const runGit = (_cwd: string, args: string[]): string => {
    calls.push(args);
    if (opts.throwOn?.(args)) throw new Error(`git ${args.join(' ')} boom`);
    if (args[0] === 'rev-parse') return (++revParse === 1 ? 'OLDHEAD' : 'NEWHEAD') + '\n';
    if (args[0] === 'stash' && args[1] === 'create') return (opts.stash ?? 'STASH123') + '\n';
    return '';
  };
  const deps: ResetToRemoteMainDeps = {
    resolvePath: async () => '/checkout/papercusp',
    runGit,
    withGitSyncLock: async (_s, fn) => fn(),
    now: () => 1730000000000,
    ...over,
  };
  return { deps, calls };
}

describe('resetToRemoteMain (P-015 — remote-main recovery)', () => {
  it('snapshots THEN resets, in order, returning the recovery refs', async () => {
    const { deps, calls } = makeDeps();
    const res = await resetToRemoteMain({ slug: 'papercusp' }, deps);
    expect(res.ok).toBe(true);
    expect(res.previousHead).toBe('OLDHEAD');
    expect(res.newHead).toBe('NEWHEAD');
    expect(res.recoveryBranch).toBe('papercusp-backup/pre-remote-main-reset-1730000000000');
    expect(res.stashSha).toBe('STASH123');
    expect(res.remote).toBe('origin/main');
    // Recovery snapshot is created BEFORE the destructive fetch/reset.
    expect(calls).toEqual([
      ['rev-parse', 'HEAD'],
      ['branch', '-f', 'papercusp-backup/pre-remote-main-reset-1730000000000', 'OLDHEAD'],
      ['stash', 'create'],
      ['fetch', 'origin', 'main'],
      ['reset', '--hard', 'origin/main'],
      ['rev-parse', 'HEAD'],
    ]);
  });

  it('a clean working tree yields a null stashSha', async () => {
    const { deps } = makeDeps({}, { stash: '' });
    const res = await resetToRemoteMain({ slug: 'papercusp' }, deps);
    expect(res.ok).toBe(true);
    expect(res.stashSha).toBeNull();
  });

  it('unknown project → ok:false, no git run', async () => {
    let ran = false;
    const { deps } = makeDeps({
      resolvePath: async () => null,
      runGit: () => {
        ran = true;
        return '';
      },
    });
    const res = await resetToRemoteMain({ slug: 'nope' }, deps);
    expect(res).toEqual({ ok: false, slug: 'nope', error: 'unknown_project' });
    expect(ran).toBe(false);
  });

  it('git-sync busy → ok:false git_sync_busy, never resets', async () => {
    let ran = false;
    const { deps } = makeDeps({
      withGitSyncLock: async () => ({ busy: true as const }),
      runGit: () => {
        ran = true;
        return '';
      },
    });
    const res = await resetToRemoteMain({ slug: 'papercusp' }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('git_sync_busy');
    expect(ran).toBe(false);
  });

  it('a git failure (e.g. reset) returns git_failed:* and never throws', async () => {
    const { deps } = makeDeps({}, { throwOn: (a) => a[0] === 'reset' });
    const res = await resetToRemoteMain({ slug: 'papercusp' }, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^git_failed:/);
    expect(res.path).toBe('/checkout/papercusp');
  });

  it('honors a custom remote/branch (canonical upstream, not a fork)', async () => {
    const { deps, calls } = makeDeps();
    const res = await resetToRemoteMain({ slug: 'papercusp', remote: 'upstream', branch: 'release' }, deps);
    expect(res.remote).toBe('upstream/release');
    expect(calls).toContainEqual(['fetch', 'upstream', 'release']);
    expect(calls).toContainEqual(['reset', '--hard', 'upstream/release']);
  });
});
