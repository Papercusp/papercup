/**
 * _create_from_repo.test.ts — the create-Hive-from-GitHub-URL composition
 * (hive-from-github-url P-006). Every seam faked — no git, PG, swarm, GitHub.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createHiveFromRepo,
  deriveSlugs,
  type CreateHiveFromRepoDeps,
} from './_create_from_repo';
import type { RepoHiveLookup } from '../../harness/lookup-hive-for-repo';

const URL = 'https://github.com/acme/shop';

const NONE_LOOKUP: RepoHiveLookup = {
  kind: 'none',
  coords: { owner: 'acme', repo: 'shop', githubRepositoryId: 100, private: false, identityResolved: true },
  bindingUnverified: false,
};

function fakes(over: Partial<CreateHiveFromRepoDeps> = {}) {
  const calls = {
    cloned: [] as string[],
    hiveCreated: [] as string[],
    memberCreated: [] as { slug: string; hive: string; path: string }[],
    removedDirs: [] as string[],
    removedHomes: [] as string[],
    publishes: [] as Record<string, unknown>[],
    beaconWrites: [] as { hive: string; consent: boolean }[],
    gitSyncSeeds: [] as Record<string, unknown>[],
    registry: [{ slug: 'existing', path: '/x' }] as Record<string, unknown>[],
  };
  const deps: CreateHiveFromRepoDeps = {
    lookup: async () => NONE_LOOKUP,
    clone: async (url: string) => {
      calls.cloned.push(url);
      return {
        path: '/clones/shop',
        parsed: { owner: 'acme', repo: 'shop', cloneUrl: 'https://github.com/acme/shop.git' },
        defaultBranch: 'develop',
      };
    },
    buildBlueprint: async (slug) => ({ ok: true, blueprint: { id: slug, extends: 'coding' }, detection: { toolchains: ['node'] } }),
    createHive: async (o) => {
      calls.hiveCreated.push(o.slug);
      return { ok: true, slug: o.slug, path: `/hives/${o.slug}` };
    },
    createMember: async (a) => {
      calls.memberCreated.push({ slug: a.slug, hive: a.hive, path: a.path });
      return { ok: true };
    },
    publish: async (o) => {
      calls.publishes.push(o as unknown as Record<string, unknown>);
      return { announced: true, cupboard: { attempted: true, rowsCreated: 1, rowsFailed: 0 }, localBindings: { created: 1, existed: 0, failed: 0 } };
    },
    loadRegistry: async () => ({ projects: calls.registry as never }),
    mutateRegistry: (async (fn: (r: { projects: never[] }) => unknown) => {
      // apply over a snapshot so the coord-stamp step is observable
      const next = fn({ projects: calls.registry as never });
      calls.registry = (next as { projects: Record<string, unknown>[] }).projects;
      return undefined as never;
    }) as never,
    removeHiveHome: async (slug) => {
      calls.removedHomes.push(slug);
    },
    rmDir: async (p) => {
      calls.removedDirs.push(p);
    },
    setBeaconConsent: async (_ws, hive, consent) => {
      calls.beaconWrites.push({ hive, consent });
    },
    seedGitSync: async (o) => {
      calls.gitSyncSeeds.push(o as unknown as Record<string, unknown>);
      return {
        seeded: true,
        active: true,
        push: true,
        pushReason: 'github_permissions_push_true — faked',
        cron: '0 3,13,23,33,43,53 * * * *',
        branch: 'develop',
      };
    },
    ...over,
  };
  return { deps, calls };
}

describe('deriveSlugs', () => {
  it('uses the base when free; suffixes on collision', () => {
    expect(deriveSlugs('shop', new Set())).toEqual({ memberSlug: 'shop', hiveSlug: 'shop-hive' });
    expect(deriveSlugs('shop', new Set(['shop']))).toEqual({ memberSlug: 'shop-2', hiveSlug: 'shop-2-hive' });
    expect(deriveSlugs('shop', new Set(['shop-hive']))).toEqual({ memberSlug: 'shop-2', hiveSlug: 'shop-2-hive' });
  });
  it('gives up after -9', () => {
    const taken = new Set<string>(['shop']);
    for (let i = 2; i <= 9; i++) taken.add(`shop-${i}`);
    expect(deriveSlugs('shop', taken)).toBeNull();
  });
});

describe('createHiveFromRepo (P-006)', () => {
  it('returns a join offer with ZERO side effects when the repo already has a hive', async () => {
    const { deps, calls } = fakes({
      lookup: async () =>
        ({
          kind: 'hive',
          coords: { owner: 'acme', repo: 'shop', identityResolved: true },
          hive: { hiveId: 'h', title: 'H' },
          source: 'directory',
          bindingUnverified: false,
        }) as RepoHiveLookup,
    });
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('existing' in r)) throw new Error('expected existing');
    expect(r.existing.kind).toBe('hive');
    expect(calls.cloned).toEqual([]);
    expect(calls.hiveCreated).toEqual([]);
  });

  it('happy path: clone → blueprint → home → member(hive) → coords stamped → publish', async () => {
    const { deps, calls } = fakes();
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.created).toMatchObject({
      hiveSlug: 'shop-hive',
      memberSlug: 'shop',
      memberPath: '/clones/shop',
      defaultBranch: 'develop',
      githubRepositoryId: 100,
    });
    expect(calls.hiveCreated).toEqual(['shop-hive']);
    expect(calls.memberCreated).toEqual([{ slug: 'shop', hive: 'shop-hive', path: '/clones/shop' }]);
    // coord stamp landed on the member entry
    const member = calls.registry.find((p) => p.slug === 'shop');
    expect(member).toBeUndefined(); // member row is created by harness:create (faked) — stamp applies only when present
    // publish got the public default + the repo title
    expect(calls.publishes[0]).toMatchObject({ hiveSlug: 'shop-hive', visibility: 'public', title: 'acme/shop' });
    expect(r.publish).toMatchObject({ announced: true });
  });

  it('stamps github coords onto the member registry entry when present', async () => {
    const { deps, calls } = fakes();
    // harness:create registers the member row — simulate that in the fake so
    // the post-create coord stamp (step 7) has a row to land on.
    deps.createMember = async (a) => {
      calls.registry.push({ slug: a.slug, path: a.path });
      calls.memberCreated.push({ slug: a.slug, hive: a.hive, path: a.path });
      return { ok: true };
    };
    await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    const member = calls.registry.find((p) => p.slug === 'shop')!;
    expect(member).toMatchObject({
      github_remote: 'https://github.com/acme/shop.git',
      github_repository_id: 100,
      github_default_branch: 'develop',
    });
  });

  it('test-verify is OPT-IN: default runTests=false reaches detection (hardening D-001)', async () => {
    const seen: boolean[] = [];
    const { deps } = fakes({
      buildBlueprint: async (_slug, _path, o) => {
        seen.push(o.runTests);
        return { ok: true, blueprint: { id: 'x', extends: 'coding' } };
      },
    });
    await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    await createHiveFromRepo({ githubUrl: URL, slug: 'shop-x', runTests: true, workspaceId: 'ws' }, deps);
    expect(seen).toEqual([false, true]);
  });

  it('public repo (coords.private=false) → publishes with visibility:public (discoverable listing)', async () => {
    const { deps, calls } = fakes();
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(calls.publishes[0]).toMatchObject({ hiveSlug: 'shop-hive', visibility: 'public' });
    expect(r.publish).toMatchObject({ announced: true });
  });

  it('private repo (coords.private=true) → publishes with visibility:invite (hidden listing, NOT skipped)', async () => {
    const { deps, calls } = fakes({
      lookup: async () => ({
        ...NONE_LOOKUP,
        coords: { ...NONE_LOOKUP.coords, private: true },
      }),
    });
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    // a private repo still publishes — as a hidden, secret-gated invite listing
    expect(calls.publishes[0]).toMatchObject({ hiveSlug: 'shop-hive', visibility: 'invite', repoIsPrivate: true });
    expect(r.publish).toMatchObject({ announced: true });
  });

  it('blueprint failure removes the clone and reports', async () => {
    const { deps, calls } = fakes({ buildBlueprint: async () => ({ ok: false, error: 'no test cmd' }) });
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'blueprint_failed' });
    expect(calls.removedDirs).toContain('/clones/shop');
    expect(calls.hiveCreated).toEqual([]);
  });

  it('member-create failure rolls back the home + clone', async () => {
    const { deps, calls } = fakes({ createMember: async () => ({ ok: false, error: 'boom' }) });
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'member_create_failed' });
    expect(calls.removedHomes).toEqual(['shop-hive']);
    expect(calls.removedDirs).toEqual(expect.arrayContaining(['/hives/shop-hive', '/clones/shop']));
  });

  it('clone errors map to clone_<code>', async () => {
    const { deps } = fakes({
      clone: async () => ({ code: 'auth_required' as const, message: 'auth pls' }),
    });
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'clone_auth_required' });
  });

  it('slug collisions auto-suffix (OQ-1) and propagate bindingUnverified', async () => {
    const { deps, calls } = fakes({
      lookup: async () => ({ ...NONE_LOOKUP, bindingUnverified: true }),
      loadRegistry: async () => ({ projects: [{ slug: 'shop', path: '/x' }] as never }),
    });
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.created.memberSlug).toBe('shop-2');
    expect(r.created.hiveSlug).toBe('shop-2-hive');
    expect(r.bindingUnverified).toBe(true);
    expect(calls.hiveCreated).toEqual(['shop-2-hive']);
  });

  it('force creates past an existing hive, flagged duplicateOf (P-008)', async () => {
    const { deps, calls } = fakes({
      lookup: async () =>
        ({
          kind: 'hive',
          coords: { owner: 'acme', repo: 'shop', githubRepositoryId: 100, identityResolved: true },
          hive: { hiveId: 'h', title: 'H', hivePubkey: 'HPK' },
          source: 'directory',
          bindingUnverified: false,
        }) as RepoHiveLookup,
    });
    const r = await createHiveFromRepo({ githubUrl: URL, force: true, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.created.duplicateOf).toEqual({ kind: 'hive', hivePubkey: 'HPK', source: 'directory' });
    expect(calls.hiveCreated).toEqual(['shop-hive']);
  });

  it('records REAL step transitions against the progressId (P-008 hardening)', async () => {
    const recorded: string[] = [];
    const { deps } = fakes({
      recordStep: (id, step, status) => {
        recorded.push(`${id}:${step}:${status}`);
      },
    });
    await createHiveFromRepo({ githubUrl: URL, progressId: 'pid-1', workspaceId: 'ws' }, deps);
    expect(recorded).toEqual([
      'pid-1:lookup:running',
      'pid-1:lookup:done',
      'pid-1:clone:running',
      'pid-1:clone:done',
      'pid-1:detect:running',
      'pid-1:detect:done',
      'pid-1:create:running',
      'pid-1:create:done',
      'pid-1:seed:skipped', // learning-packs P-005: no learnings detected in the fake repo
      'pid-1:publish:running',
      'pid-1:publish:done',
    ]);
  });

  it('progress: a clone failure settles clone:error; no progressId = zero recording', async () => {
    const recorded: string[] = [];
    const { deps } = fakes({
      clone: async () => ({ code: 'not_found' as const, message: 'nope' }),
      recordStep: (_id, step, status) => {
        recorded.push(`${step}:${status}`);
      },
    });
    await createHiveFromRepo({ githubUrl: URL, progressId: 'pid-2', workspaceId: 'ws' }, deps);
    expect(recorded).toEqual(['lookup:running', 'lookup:done', 'clone:running', 'clone:error']);

    recorded.length = 0;
    const { deps: deps2 } = fakes({
      recordStep: (_id, step, status) => {
        recorded.push(`${step}:${status}`);
      },
    });
    await createHiveFromRepo({ githubUrl: URL, slug: 'shop-noprog', workspaceId: 'ws' }, deps2);
    expect(recorded).toEqual([]);
  });

  it('publish failure NEVER fails the create', async () => {
    const { deps } = fakes({
      publish: async () => {
        throw new Error('cupboard exploded');
      },
    });
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.publish).toMatchObject({ announced: false, error: 'cupboard exploded' });
  });

  it('into-hive mode: no new home; member joins the existing hive; republish scoped to the new repo (P-009)', async () => {
    const republishes: Record<string, unknown>[] = [];
    const { deps, calls } = fakes({
      loadRegistry: async () =>
        ({ projects: [{ slug: 'myhive', path: '/h', harness_kind: 'hive' }] }) as never,
      republish: (async (o: Record<string, unknown>) => {
        republishes.push(o);
        return { announced: true, cupboard: { attempted: true, rowsCreated: 1, rowsFailed: 0 } };
      }) as never,
    });
    const r = await createHiveFromRepo({ githubUrl: URL, intoHive: 'myhive', workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.created).toMatchObject({ hiveSlug: 'myhive', memberSlug: 'shop' });
    expect(calls.hiveCreated).toEqual([]); // no new home
    expect(calls.memberCreated).toEqual([{ slug: 'shop', hive: 'myhive', path: '/clones/shop' }]);
    expect(calls.publishes).toEqual([]); // the NEW-hive publish path is not used
    expect(republishes[0]).toMatchObject({ hiveSlug: 'myhive', onlyRepoIds: [100] });
  });

  it('into-hive mode fails fast on a non-hive scope (no clone)', async () => {
    const { deps, calls } = fakes({
      loadRegistry: async () => ({ projects: [{ slug: 'plain', path: '/p' }] }) as never,
    });
    const r = await createHiveFromRepo({ githubUrl: URL, intoHive: 'plain', workspaceId: 'ws' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'hive_not_found' });
    expect(calls.cloned).toEqual([]);
  });

  // ── B-07 / C-2: beacon-publish consent recorded in the publish flow ──────────

  it('auto-ENABLES the beacon for a NEW PUBLIC hive (no opt-in — derived from visibility)', async () => {
    const { deps, calls } = fakes();
    // Default repo is public → visibility 'public' → beacon auto-ON, no client input.
    await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(calls.beaconWrites).toEqual([{ hive: 'shop-hive', consent: true }]);
  });

  it('auto-DISABLES the beacon for a NEW PRIVATE (invite) hive (a hidden hive never broadcasts)', async () => {
    const { deps, calls } = fakes({
      lookup: async () => ({
        ...NONE_LOOKUP,
        coords: { ...NONE_LOOKUP.coords, private: true },
      }),
    });
    await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    // The hive publishes (as a hidden invite listing) but the beacon is written OFF.
    expect(calls.publishes[0]).toMatchObject({ visibility: 'invite' });
    expect(calls.beaconWrites).toEqual([{ hive: 'shop-hive', consent: false }]);
  });

  it('into-hive mode records NO beacon write (the existing home keeps its standing setting)', async () => {
    const { deps, calls } = fakes({
      loadRegistry: async () =>
        ({ projects: [{ slug: 'myhive', path: '/h', harness_kind: 'hive' }] }) as never,
      republish: (async () => ({ announced: true, cupboard: { attempted: false } })) as never,
    });
    await createHiveFromRepo({ githubUrl: URL, intoHive: 'myhive', workspaceId: 'ws' }, deps);
    expect(calls.beaconWrites).toEqual([]);
  });

  it('a beacon-consent write failure NEVER fails the create', async () => {
    const { deps } = fakes({
      setBeaconConsent: async () => {
        throw new Error('settings store down');
      },
    });
    // Public repo → the auto-beacon write fires (and throws) — the create still succeeds.
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
  });

  // ── git-sync-any-hive B-01: member routine seeding (P-001/P-008 seed side) ────

  it('seeds the member git-sync routine on the new-hive path (creator side, coords + branch threaded)', async () => {
    const { deps, calls } = fakes();
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(calls.gitSyncSeeds).toEqual([
      {
        workspaceId: 'ws',
        installSlug: 'shop',
        joinerSide: false,
        entry: {
          slug: 'shop',
          path: '/clones/shop',
          hive_slug: 'shop-hive',
          github_remote: 'https://github.com/acme/shop.git',
          github_repository_id: 100,
          github_default_branch: 'develop',
        },
      },
    ]);
    // the outcome is REPORTED on the result, next to publish
    expect(r.gitSync).toMatchObject({ seeded: true, push: true, branch: 'develop' });
  });

  it('seeds on the P-009 into-hive path too (member of the EXISTING home)', async () => {
    const { deps, calls } = fakes({
      loadRegistry: async () =>
        ({ projects: [{ slug: 'myhive', path: '/h', harness_kind: 'hive' }] }) as never,
      republish: (async () => ({ announced: true, cupboard: { attempted: false } })) as never,
    });
    const r = await createHiveFromRepo({ githubUrl: URL, intoHive: 'myhive', workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(calls.gitSyncSeeds).toEqual([
      expect.objectContaining({
        installSlug: 'shop',
        joinerSide: false,
        entry: expect.objectContaining({ slug: 'shop', hive_slug: 'myhive' }),
      }),
    ]);
    expect(r.gitSync).toMatchObject({ seeded: true });
  });

  it('a git-sync seeding failure NEVER fails the create — reported as { reason: error }', async () => {
    const { deps } = fakes({
      seedGitSync: async () => {
        throw new Error('routines pg down');
      },
    });
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok || !('created' in r)) throw new Error('expected created');
    expect(r.gitSync).toEqual({ seeded: false, reason: 'error', message: 'routines pg down' });
    expect(r.publish).toMatchObject({ announced: true }); // the rest of the create proceeded
  });

  it('a FAILED create never reaches the seeder (member-create failure)', async () => {
    const { deps, calls } = fakes({ createMember: async () => ({ ok: false, error: 'boom' }) });
    const r = await createHiveFromRepo({ githubUrl: URL, workspaceId: 'ws' }, deps);
    expect(r.ok).toBe(false);
    expect(calls.gitSyncSeeds).toEqual([]);
  });

  it('into-hive member-create failure removes only the clone (the existing home is untouched)', async () => {
    const { deps, calls } = fakes({
      loadRegistry: async () =>
        ({ projects: [{ slug: 'myhive', path: '/h', harness_kind: 'hive' }] }) as never,
      createMember: async () => ({ ok: false, error: 'nope' }),
    });
    const r = await createHiveFromRepo({ githubUrl: URL, intoHive: 'myhive', workspaceId: 'ws' }, deps);
    expect(r).toMatchObject({ ok: false, error: 'member_create_failed' });
    expect(calls.removedHomes).toEqual([]);
    expect(calls.removedDirs).toEqual(['/clones/shop']);
  });
});

/**
 * WI-1861 regression pin: defaultCreateMember must carry harness:create's
 * failure DETAIL (parseError / errors[] / missing) through into its error
 * string — the narrow `{ error }` pick swallowed the validation errors, so a
 * live 'blueprint invalid' red reached the gate artifact with the failing
 * field unnamed (undiagnosable from the smoke output alone).
 */
describe('defaultCreateMember failure-detail passthrough (WI-1861)', () => {
  const call = async (payload: unknown) => {
    vi.resetModules();
    vi.doMock('../harness/create', () => ({
      default: { handler: async () => ({ content: [{ text: JSON.stringify(payload) }] }) },
    }));
    const { defaultCreateMember } = await import('./_create_from_repo');
    return defaultCreateMember({ slug: 's', path: '/p', blueprint: { id: 's' }, hive: 'h' });
  };

  it('ok:true passes through clean', async () => {
    expect(await call({ ok: true })).toEqual({ ok: true });
  });

  it("'blueprint invalid' carries errors[] and parseError into the error string", async () => {
    const r = await call({
      ok: false,
      error: 'blueprint invalid',
      parseError: undefined,
      errors: [{ code: 'unknown-op', path: 'spine.0', message: 'op nope:x not registered' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('blueprint invalid');
    expect(r.error).toContain('unknown-op');
    expect(r.error).toContain('nope:x');
  });

  it('dependency-gate failures carry missing{} through', async () => {
    const r = await call({
      ok: false,
      error: 'blueprint tool dependencies unmet',
      missing: { tools: ['bee:spawn'] },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('bee:spawn');
  });

  it('unparseable response still fails closed', async () => {
    vi.resetModules();
    vi.doMock('../harness/create', () => ({
      default: { handler: async () => ({ content: [{ text: 'not-json' }] }) },
    }));
    const { defaultCreateMember } = await import('./_create_from_repo');
    const r = await defaultCreateMember({ slug: 's', path: '/p', blueprint: { id: 's' }, hive: 'h' });
    expect(r).toEqual({ ok: false, error: 'harness:create returned an unparseable response' });
  });
});
