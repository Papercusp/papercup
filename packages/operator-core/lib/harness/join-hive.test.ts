/**
 * join-hive.test.ts — joiner-side hive symmetry (hardening P-007 / D-007) +
 * joiner-side git-sync seeding (git-sync-any-hive-2026-06-12 P-003 / B-03).
 * Per-link join + registry + git-sync seams injected — no PG, git, swarm, or
 * GitHub.
 */
import { describe, it, expect, vi } from 'vitest';
import { joinHiveAsView, type JoinHiveDeps } from './join-hive';
import type { SeedGitSyncRoutineOpts } from './git-sync/git-sync-routine';
import type { HarnessRegistry } from '../harness-registry';

const TOPIC = 'a'.repeat(64);
const HIVE_PUBKEY = 'p'.repeat(43) + '='; // a stand-in raw-32 base64 Ed25519 pubkey
const link = (repo: string, id: number) =>
  `papercusp://harness?topic=${TOPIC}&github=acme%2F${repo}&repo_id=${id}`;

function fakes(initialProjects: HarnessRegistry['projects'] = []) {
  const calls = {
    joined: [] as { slug: string; repoName: string }[],
    registry: [...initialProjects] as HarnessRegistry['projects'],
    dirs: [] as string[],
    seeded: [] as SeedGitSyncRoutineOpts[],
    identities: [] as Array<{
      workspaceId: string;
      homeSlug: string;
      pubkeyBase64: string;
      keychainId: string;
    }>,
  };
  const deps: JoinHiveDeps = {
    joinLink: async ({ slug, link: l }) => {
      calls.joined.push({ slug, repoName: l.repoName });
      // simulate the route registering the member (slug + path)
      calls.registry.push({ slug, path: `/joined/${slug}` });
      return { ok: true, detail: 'joined' };
    },
    loadRegistry: async () => ({ projects: calls.registry }),
    mutateRegistry: (async (fn: (r: HarnessRegistry) => HarnessRegistry) => {
      const next = fn({ projects: calls.registry });
      calls.registry = next.projects;
      return undefined as never;
    }) as never,
    ensureDir: async (p) => {
      calls.dirs.push(p);
    },
    remoteHivesRoot: '/remote-hives',
    seedGitSync: async (opts) => {
      calls.seeded.push(opts);
      return { seeded: true, active: false, push: false, pushReason: 'joiner_side', cron: '0 0 * * * *' };
    },
    resolveHivePubkey: async () => HIVE_PUBKEY,
    upsertHiveIdentity: async (input) => {
      calls.identities.push(input);
    },
  };
  return { deps, calls };
}

describe('joinHiveAsView (P-007)', () => {
  it('joins every member link and materializes the remote-hive view with coords + hive_slug', async () => {
    const { deps, calls } = fakes();
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.hiveSlug).toBe('shop-hive');
    expect(calls.joined.map((j) => j.slug)).toEqual(['shop', 'docs']);
    expect(calls.dirs).toEqual(['/remote-hives/shop-hive']);

    const view = calls.registry.find((p) => p.slug === 'shop-hive')!;
    expect(view).toMatchObject({ harness_kind: 'hive', remote_hive: true, path: '/remote-hives/shop-hive' });

    const shop = calls.registry.find((p) => p.slug === 'shop')!;
    expect(shop).toMatchObject({
      hive_slug: 'shop-hive',
      github_remote: 'https://github.com/acme/shop.git',
      github_repository_id: 100,
    });
  });

  it('a local harness owning the hive name is never clobbered — the view slug suffixes', async () => {
    const { deps, calls } = fakes([{ slug: 'shop-hive', path: '/local/own' }]);
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.hiveSlug).toBe('shop-hive-2');
    expect(calls.registry.find((p) => p.slug === 'shop-hive')!.remote_hive).toBeUndefined();
    expect(calls.registry.find((p) => p.slug === 'shop-hive-2')!).toMatchObject({ remote_hive: true });
  });

  it('idempotent re-join: reuses the existing view; already-registered repos are skipped, not re-joined', async () => {
    const { deps, calls } = fakes([
      { slug: 'shop-hive', path: '/remote-hives/shop-hive', harness_kind: 'hive', remote_hive: true },
      { slug: 'shop', path: '/joined/shop', hive_slug: 'shop-hive', github_repository_id: 100 },
    ]);
    // shop's routine already exists from the first join — the seeder reports
    // routine_exists (no clobber) instead of re-seeding.
    deps.seedGitSync = async (opts) => {
      calls.seeded.push(opts);
      return opts.installSlug === 'shop'
        ? { seeded: false, reason: 'routine_exists' }
        : { seeded: true, active: false, push: false, pushReason: 'joiner_side', cron: '0 0 * * * *' };
    };
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.hiveSlug).toBe('shop-hive');
    expect(calls.joined.map((j) => j.slug)).toEqual(['docs']); // shop skipped
    expect(res.members.find((m) => m.slug === 'shop')?.detail).toBe(
      'already_registered; git_sync:routine_exists',
    );
    expect(res.members.find((m) => m.slug === 'docs')?.detail).toBe('joined; git_sync:seeded');
    // still exactly one view entry
    expect(calls.registry.filter((p) => p.slug.startsWith('shop-hive')).length).toBe(1);
  });

  it('no member joined → no view materialized, error reported', async () => {
    const { deps, calls } = fakes();
    deps.joinLink = async () => ({ ok: false, detail: 'gh_auth_required' });
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res).toMatchObject({ ok: false, error: 'no_member_joined' });
    expect(calls.registry.find((p) => p.slug === 'shop-hive')).toBeUndefined();
  });

  it('malformed member links are rejected up front (zero side effects)', async () => {
    const { deps, calls } = fakes();
    const res = await joinHiveAsView(
      { hiveId: 'x', memberLinks: ['papercusp://harness?nope=1'], workspaceId: 'ws' },
      deps,
    );
    expect(res).toMatchObject({ ok: false, error: 'invalid_member_links' });
    expect(calls.joined).toEqual([]);
  });

  it('partial joins still materialize the view; failures reported per member', async () => {
    const { deps, calls } = fakes();
    let n = 0;
    deps.joinLink = async ({ slug, link: l }) => {
      n += 1;
      if (n === 2) return { ok: false, detail: 'clone failed' };
      calls.registry.push({ slug, path: `/joined/${slug}` });
      return { ok: true, detail: 'joined' };
    };
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.members.map((m) => m.ok)).toEqual([true, false]);
    expect(calls.registry.find((p) => p.slug === 'shop')!.hive_slug).toBe('shop-hive');
    expect(calls.registry.find((p) => p.slug === 'docs')).toBeUndefined();
    // only the SUCCESSFUL member is seeded — the failed one never reaches the seeder
    expect(calls.seeded.map((s) => s.installSlug)).toEqual(['shop']);
  });
});

describe('joiner-side git-sync seeding (git-sync-any-hive P-003 / B-03)', () => {
  it('every joined member is seeded joiner-side with a per-install-salted cron key and the post-mutate entry', async () => {
    const { deps, calls } = fakes();
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws-1' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(calls.seeded).toHaveLength(2);
    expect(calls.seeded[0]).toMatchObject({
      workspaceId: 'ws-1',
      installSlug: 'shop',
      joinerSide: true,
      // the same member slug exists on N peer boxes of a shared hive — the
      // jitter key is salted per-install so peers spread across minute offsets
      cronKey: 'shop:ws-1',
    });
    // the seeder gets the POST-mutate entry: hive_slug + upstream coords stamped
    expect(calls.seeded[0].entry).toMatchObject({
      slug: 'shop',
      path: '/joined/shop',
      hive_slug: 'shop-hive',
      github_remote: 'https://github.com/acme/shop.git',
      github_repository_id: 100,
    });
    expect(calls.seeded[1]).toMatchObject({ installSlug: 'docs', joinerSide: true, cronKey: 'docs:ws-1' });
    // outcomes fold into the per-member detail
    expect(res.members.map((m) => m.detail)).toEqual(['joined; git_sync:seeded', 'joined; git_sync:seeded']);
  });

  it('the remote_hive VIEW is never passed to the seeder — only member clones are', async () => {
    const { deps, calls } = fakes();
    await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    const seededSlugs = calls.seeded.map((s) => s.installSlug);
    expect(seededSlugs).toEqual(['shop']);
    expect(seededSlugs).not.toContain('shop-hive');
    // the view exists in the registry, so it WAS a candidate by slug — the
    // member loop simply never offers it
    expect(calls.registry.find((p) => p.slug === 'shop-hive')).toMatchObject({ remote_hive: true });
  });

  it('a seed failure (outcome OR throw) never fails the join — it folds into detail', async () => {
    const { deps } = fakes();
    deps.seedGitSync = async () => {
      throw new Error('routines table on fire');
    };
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.members[0]).toMatchObject({ ok: true, detail: 'joined; git_sync:error' });

    // error OUTCOME (the seeder's own never-throw contract) folds the same way
    const second = fakes();
    second.deps.seedGitSync = async () => ({ seeded: false, reason: 'error', message: 'pg down' });
    const res2 = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      second.deps,
    );
    expect(res2.ok).toBe(true);
    expect(res2.members[0].detail).toBe('joined; git_sync:error');
  });

  it('an ineligible entry (e.g. clone path vanished) reports git_sync:ineligible, join still ok', async () => {
    const { deps } = fakes();
    deps.seedGitSync = async () => ({ seeded: false, reason: 'ineligible', ineligibleReason: 'no_path' });
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.members[0].detail).toBe('joined; git_sync:ineligible');
  });

  it('a member reported ok by joinLink but missing from the registry is skipped, not seeded', async () => {
    const { deps, calls } = fakes();
    deps.joinLink = async () => ({ ok: true, detail: 'joined' }); // never registers
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(calls.seeded).toEqual([]);
    expect(res.members[0].detail).toBe('joined'); // no git_sync suffix — nothing to seed
  });

  // EI-681: the joiner must materialize the remote Hive's IDENTITY (owner pubkey)
  // so resolveHiveSwarmBinding re-keys its joined harnesses onto the SAME
  // Hive-pubkey topic the owner uses (else the two peers sit on different topics
  // and a write never federates).
  it('materializes the remote Hive identity row with the owner pubkey (EI-681)', async () => {
    const { deps, calls } = fakes();
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(calls.identities).toHaveLength(1);
    expect(calls.identities[0]).toMatchObject({
      workspaceId: 'ws',
      homeSlug: 'shop-hive', // the local view slug == getHiveBySlug key
      pubkeyBase64: HIVE_PUBKEY, // the OWNER's hive pubkey from discovery
      keychainId: 'remote:shop-hive', // non-signing placeholder
    });
  });

  it('join still succeeds when the owner pubkey is unavailable — no identity write', async () => {
    const { deps, calls } = fakes();
    deps.resolveHivePubkey = async () => null; // announce carried no pubkey
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(calls.identities).toEqual([]); // skipped, not crashed
  });

  it('uses an explicit owner pubkey even when the local directory cache misses', async () => {
    const { deps, calls } = fakes();
    deps.resolveHivePubkey = async () => null;
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', hivePubkey: HIVE_PUBKEY, memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(calls.identities[0]).toMatchObject({
      homeSlug: 'shop-hive',
      pubkeyBase64: HIVE_PUBKEY,
      keychainId: 'remote:shop-hive',
    });
  });

  it('an identity-write failure NEVER fails the join', async () => {
    const { deps } = fakes();
    deps.upsertHiveIdentity = async () => {
      throw new Error('pg down');
    };
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.hiveSlug).toBe('shop-hive');
  });
});

describe('self-echo guard (2026-07-01 owner split-brain: directory re-announce of an OWNED hive)', () => {
  const OWNED = { slug: 'shop-hive', path: '/local/own-hive', harness_kind: 'hive', self_repo: true };

  it('discovered hive whose pubkey matches a locally-OWNED hive → no-op self_hive, zero side effects', async () => {
    const { deps, calls } = fakes([OWNED, { slug: 'shop', path: '/local/shop', github_repository_id: 100 }]);
    deps.getLocalHive = async () => ({ pubkeyBase64: HIVE_PUBKEY });
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', hivePubkey: HIVE_PUBKEY, memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res).toMatchObject({ ok: true, hiveSlug: 'shop-hive', self_hive: true, members: [] });
    expect(calls.joined).toEqual([]); // no member re-join
    expect(calls.dirs).toEqual([]); // no view dir
    // the phantom -2 view never materializes and the member's hive_slug is untouched
    expect(calls.registry.find((p) => p.slug === 'shop-hive-2')).toBeUndefined();
    expect(calls.registry.find((p) => p.slug === 'shop')!.hive_slug).toBeUndefined();
  });

  it('pubkey resolved via the directory (announce carried none) still triggers the guard', async () => {
    const { deps, calls } = fakes([OWNED]);
    deps.getLocalHive = async () => ({ pubkeyBase64: HIVE_PUBKEY });
    // fixture resolveHivePubkey already returns HIVE_PUBKEY
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.self_hive).toBe(true);
    expect(calls.joined).toEqual([]);
  });

  it('a DISTINCT hive that merely shares the name (pubkey mismatch) still joins — suffixed view', async () => {
    const { deps, calls } = fakes([OWNED]);
    deps.getLocalHive = async () => ({ pubkeyBase64: 'x'.repeat(43) + '=' }); // different identity
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', hivePubkey: HIVE_PUBKEY, memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.self_hive).toBeUndefined();
    expect(res.hiveSlug).toBe('shop-hive-2');
    expect(calls.registry.find((p) => p.slug === 'shop-hive-2')!).toMatchObject({ remote_hive: true });
  });

  it('no pubkey resolvable anywhere → slug-equality fallback treats the OWNED hive as self', async () => {
    const { deps, calls } = fakes([OWNED]);
    deps.resolveHivePubkey = async () => null;
    deps.getLocalHive = async () => null;
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res).toMatchObject({ ok: true, hiveSlug: 'shop-hive', self_hive: true });
    expect(calls.joined).toEqual([]);
  });

  it('a remote_hive VIEW with the same name does NOT trigger the guard (idempotent re-join keeps working)', async () => {
    const { deps, calls } = fakes([
      { slug: 'shop-hive', path: '/remote-hives/shop-hive', harness_kind: 'hive', remote_hive: true },
    ]);
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', hivePubkey: HIVE_PUBKEY, memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.self_hive).toBeUndefined();
    expect(res.hiveSlug).toBe('shop-hive'); // reused view
    expect(calls.joined.map((j) => j.slug)).toEqual(['shop']);
  });
});

describe('verified hive identity coords stamped on the view (owner-bootstrap admit determinism)', () => {
  it('stamps hive_pubkey + owner_device_pubkey on a NEW view from opts', async () => {
    const { deps, calls } = fakes();
    const res = await joinHiveAsView(
      {
        hiveId: 'shop-hive', hivePubkey: HIVE_PUBKEY, ownerDevicePubkey: 'OD_announce',
        memberLinks: [link('shop', 100)], workspaceId: 'ws',
      },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(calls.registry.find((p) => p.slug === 'shop-hive')).toMatchObject({
      remote_hive: true,
      hive_pubkey: HIVE_PUBKEY,
      owner_device_pubkey: 'OD_announce',
    });
  });

  it('resolves the owner device from the directory when opts omit it', async () => {
    const { deps, calls } = fakes();
    deps.resolveOwnerDevicePubkey = async () => 'OD_directory';
    await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(calls.registry.find((p) => p.slug === 'shop-hive')).toMatchObject({
      hive_pubkey: HIVE_PUBKEY, // from the fixture resolveHivePubkey
      owner_device_pubkey: 'OD_directory',
    });
  });

  it('idempotent re-join BACKFILLS the coords onto an existing pre-stamp view', async () => {
    const { deps, calls } = fakes([
      { slug: 'shop-hive', path: '/remote-hives/shop-hive', harness_kind: 'hive', remote_hive: true },
      { slug: 'shop', path: '/joined/shop', hive_slug: 'shop-hive', github_repository_id: 100 },
    ]);
    deps.resolveOwnerDevicePubkey = async () => 'OD_backfill';
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', hivePubkey: HIVE_PUBKEY, memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
      deps,
    );
    expect(res.hiveSlug).toBe('shop-hive');
    expect(calls.registry.find((p) => p.slug === 'shop-hive')).toMatchObject({
      hive_pubkey: HIVE_PUBKEY,
      owner_device_pubkey: 'OD_backfill',
    });
  });

  it('absent values stamp nothing (no empty-string coords)', async () => {
    const { deps, calls } = fakes();
    deps.resolveHivePubkey = async () => null;
    deps.resolveOwnerDevicePubkey = async () => null;
    await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    const view = calls.registry.find((p) => p.slug === 'shop-hive')!;
    expect(view.hive_pubkey).toBeUndefined();
    expect(view.owner_device_pubkey).toBeUndefined();
  });
});

describe("2c′ home-view boot/rekey (WI-971: the joiner's hive-home drain)", () => {
  it('rekeys the HOME VIEW slug in addition to every joined member', async () => {
    const { deps } = fakes();
    const rekeyed: string[] = [];
    deps.rekeyHarness = async (_ws, slug) => {
      rekeyed.push(slug);
    };
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    // Home view FIRST (its identity/binding gates the members' hive-topic
    // resolution on a fresh boot), then each joined member.
    expect(rekeyed).toEqual(['shop-hive', 'shop', 'docs']);
  });

  it('a home-view rekey failure never fails the join and never skips the member rekeys', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { deps } = fakes();
      const rekeyed: string[] = [];
      deps.rekeyHarness = async (_ws, slug) => {
        if (slug === 'shop-hive') throw new Error('corestore locked');
        rekeyed.push(slug);
      };
      const res = await joinHiveAsView(
        { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
        deps,
      );
      expect(res.ok).toBe(true);
      expect(rekeyed).toEqual(['shop']);
      // The member's detail is untouched by the home-view failure.
      expect(res.members[0]!.detail).toContain('joined');
      expect(res.members[0]!.detail).not.toContain('rekey:failed');
      // The failure is LOUD (never a silent swallow — WI-1544 defect-E posture).
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("2c′ home-view boot/rekey FAILED"),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a member rekey failure still stamps rekey:failed (unchanged 2c contract)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { deps } = fakes();
      deps.rekeyHarness = async (_ws, slug) => {
        if (slug === 'shop') throw new Error('boom');
      };
      const res = await joinHiveAsView(
        { hiveId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
        deps,
      );
      expect(res.ok).toBe(true);
      expect(res.members[0]!.detail).toContain('rekey:failed');
    } finally {
      errSpy.mockRestore();
    }
  });
});
