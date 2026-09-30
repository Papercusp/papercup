import { describe, it, expect, vi } from 'vitest';
import {
  createLockDomainIdentity,
  mapLiveLockHoldingsForRepo,
  nestedInstallRepoPrefix,
  translateLiveLockHoldingsToRoot,
  type LockDomainIdentity,
} from './live-lock-coordinates';

// EI-24649116564770033: lock paths are relative to their own coordination domain, and
// git-sync reads every domain. These fixtures mirror the live layout that produced the bug.
describe('translateLiveLockHoldingsToRoot', () => {
  const ROOT = '/w/papercusp';
  const identity = (roots: Record<string, string[] | null>, supers: Record<string, string> = {}) => {
    const probes: string[] = [];
    const id: LockDomainIdentity = {
      rootCommits: async (dir) => {
        probes.push(`roots:${dir}`);
        return dir in roots ? roots[dir] : null;
      },
      superproject: async (dir) => {
        probes.push(`super:${dir}`);
        return supers[dir] ?? null;
      },
    };
    return { id, probes };
  };
  const lock = (path: string, coordinationDomain?: string) => ({
    path,
    owner: 'su-peer',
    intent: 'editing',
    ...(coordinationDomain ? { coordinationDomain } : {}),
  });

  it('drops a lock from an unrelated repository instead of matching a same-named file here', async () => {
    const { id } = identity({ [ROOT]: ['43662ff5'], '/h/.papercusp/apps/portal': ['6b0bbf1e'] });
    const result = await translateLiveLockHoldingsToRoot(
      [lock('package.json', '/h/.papercusp/apps/portal'), lock('package.json', ROOT)],
      ROOT,
      id,
    );
    expect(result.holdings).toEqual([{ path: 'package.json', owner: 'su-peer', intent: 'editing' }]);
    expect(result.dropped).toEqual([
      {
        path: 'package.json',
        owner: 'su-peer',
        intent: 'editing',
        coordinationDomain: '/h/.papercusp/apps/portal',
        reason: 'foreign-repo',
      },
    ]);
  });

  it('prefixes a submodule-root lock so it protects the submodule file, with no git probe', async () => {
    const { id, probes } = identity({});
    const result = await translateLiveLockHoldingsToRoot([lock('bin/x.sh', `${ROOT}/papercusp-desktop/`)], ROOT, id);
    expect(result.holdings.map((h) => h.path)).toEqual(['papercusp-desktop/bin/x.sh']);
    expect(probes).toEqual([]);
  });

  it('keeps paths from another checkout of the same history (release / staging trees)', async () => {
    const { id } = identity({ [ROOT]: ['43662ff5'], '/w/papercup-release': ['43662ff5'] });
    const result = await translateLiveLockHoldingsToRoot([lock('apps/a.ts', '/w/papercup-release')], ROOT, id);
    expect(result.holdings.map((h) => h.path)).toEqual(['apps/a.ts']);
    expect(result.dropped).toEqual([]);
  });

  it('prefixes a lock from a submodule of another checkout of this repository', async () => {
    const { id } = identity(
      { [ROOT]: ['43662ff5'], '/w/papercup-release/libs/papercusp': ['aaaa'], '/w/papercup-release': ['43662ff5'] },
      { '/w/papercup-release/libs/papercusp': '/w/papercup-release' },
    );
    const result = await translateLiveLockHoldingsToRoot(
      [lock('libs/db/sql/1.sql', '/w/papercup-release/libs/papercusp')],
      ROOT,
      id,
    );
    expect(result.holdings.map((h) => h.path)).toEqual(['libs/papercusp/libs/db/sql/1.sql']);
  });

  it('strips the root prefix when the domain contains the root, and drops rows outside it', async () => {
    const { id } = identity({});
    const result = await translateLiveLockHoldingsToRoot(
      [lock('papercusp/src/a.ts', '/w'), lock('other/b.ts', '/w')],
      ROOT,
      id,
    );
    expect(result.holdings.map((h) => h.path)).toEqual(['src/a.ts']);
    expect(result.dropped.map((d) => [d.path, d.reason])).toEqual([['other/b.ts', 'outside-root']]);
  });

  it('fails closed: keeps rows whose domain identity cannot be read, and legacy rows with no domain', async () => {
    const { id } = identity({ [ROOT]: ['43662ff5'], '/gone/repo': null });
    const result = await translateLiveLockHoldingsToRoot([lock('x.ts', '/gone/repo'), lock('y.ts')], ROOT, id);
    expect(result.holdings.map((h) => h.path)).toEqual(['x.ts', 'y.ts']);
    expect(result.dropped).toEqual([]);

    const unreadableRoot = identity({ '/other': ['6b0bbf1e'] });
    const kept = await translateLiveLockHoldingsToRoot([lock('z.ts', '/other')], ROOT, unreadableRoot.id);
    expect(kept.holdings.map((h) => h.path)).toEqual(['z.ts']);
  });

  it('probes each distinct domain once per call', async () => {
    const { id, probes } = identity({ [ROOT]: ['43662ff5'], '/other': ['6b0bbf1e'] });
    await translateLiveLockHoldingsToRoot([lock('a', '/other'), lock('b', '/other'), lock('c', '/other')], ROOT, id);
    expect(probes.filter((p) => p === 'roots:/other')).toHaveLength(1);
    expect(probes.filter((p) => p === `roots:${ROOT}`)).toHaveLength(1);
  });
});

describe('createLockDomainIdentity', () => {
  it('reads root commits and the superproject through the injected runner, memoized', async () => {
    const runGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'rev-list') return { code: 0, stdout: cwd === '/a' ? 'sha1\nsha2\n' : '' };
      if (args[1] === '--show-superproject-working-tree') return { code: 0, stdout: cwd === '/a/sub' ? '/a\n' : '\n' };
      return { code: 1, stdout: '' };
    });
    const id = createLockDomainIdentity(runGit);
    expect(await id.rootCommits('/a')).toEqual(['sha1', 'sha2']);
    expect(await id.rootCommits('/a')).toEqual(['sha1', 'sha2']);
    expect(await id.rootCommits('/empty')).toBeNull();
    expect(await id.superproject('/a/sub')).toBe('/a');
    expect(await id.superproject('/a')).toBeNull();
    expect(runGit.mock.calls.filter(([args, cwd]) => args[0] === 'rev-list' && cwd === '/a')).toHaveLength(1);
  });

  it('answers null (never throws) when git fails or throws', async () => {
    const id = createLockDomainIdentity(async (args) => {
      if (args[0] === 'rev-list') throw new Error('spawn failed');
      return { code: 128, stdout: 'fatal' };
    });
    expect(await id.rootCommits('/x')).toBeNull();
    expect(await id.superproject('/x')).toBeNull();
  });
});

// P-009 / WI-10002596: nested git-sync installs (slug `<parent>/<rel>`) sync a submodule as
// their own repo root, but the lock plane speaks in the parent's root coordinates.
describe('nestedInstallRepoPrefix', () => {
  it('is empty for a top-level install', () => {
    expect(nestedInstallRepoPrefix('papercusp', '/w/papercusp', '/w/papercusp')).toBe('');
  });

  it('derives the prefix from the parent root', () => {
    expect(nestedInstallRepoPrefix('papercusp/libs/papercusp', '/w/papercusp/libs/papercusp', '/w/papercusp')).toBe(
      'libs/papercusp',
    );
  });

  it('trusts the filesystem over the slug tail', () => {
    expect(nestedInstallRepoPrefix('papercusp/libs/x', '/w/papercusp/libs/generic/x', '/w/papercusp')).toBe(
      'libs/generic/x',
    );
  });

  it('refuses a repo that is not inside the parent root', () => {
    expect(nestedInstallRepoPrefix('papercusp/libs/x', '/elsewhere/x', '/w/papercusp')).toBe('');
  });

  it('falls back to the slug tail only when the repo path ends with it', () => {
    expect(nestedInstallRepoPrefix('papercusp/libs/agent-chat', '/w/papercusp/libs/agent-chat', null)).toBe(
      'libs/agent-chat',
    );
    expect(nestedInstallRepoPrefix('papercusp/libs/agent-chat', '/w/other/place', null)).toBe('');
  });

  it('is empty without a repo path', () => {
    expect(nestedInstallRepoPrefix('papercusp/libs/x', null, '/w/papercusp')).toBe('');
  });
});

describe('mapLiveLockHoldingsForRepo through a nested-install prefix', () => {
  it('maps the lock git-sync ignored when it committed the libs/papercusp mutant (1e553ccd)', () => {
    const probeLock = {
      path: 'libs/papercusp/packages/orchestrator/src/codex-gateway-config.ts',
      owner: 'su-1bb6850b',
      intent: 'mutation probe',
    };
    const prefix = nestedInstallRepoPrefix('papercusp/libs/papercusp', '/w/papercusp/libs/papercusp', '/w/papercusp');
    expect(
      mapLiveLockHoldingsForRepo([probeLock, { path: 'packages/x.ts', owner: 'su-peer', intent: 'other repo' }], prefix),
    ).toEqual([{ ...probeLock, path: 'packages/orchestrator/src/codex-gateway-config.ts' }]);
  });
});
