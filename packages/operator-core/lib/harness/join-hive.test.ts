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
    // This unit suite is hermetic: the real default rekeyHarness lazily boots
    // the substrate and reaches the org-admin database. Integration coverage
    // that exercises that boot/rekey chain supplies its own real seam.
    rekeyHarness: async () => {},
    resolveHivePubkey: async () => HIVE_PUBKEY,
    // Normal announced links carry the verified owner binding. Tests that
    // exercise the degraded partial-stamp path override this seam to null.
    resolveOwnerDevicePubkey: async () => 'OD_directory',
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.potSlug).toBe('shop-hive');
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

  // ── A3: the joiner ADOPTS the owner's repoKey (EI-18788176839043286) ──────
  // Pinning alone only froze each device's own derivation, which makes a key
  // stable but not SHARED. These cases pin down the half that makes two devices
  // actually agree.
  describe('A3 — pot-git repoKey adoption', () => {
    const keyedLink = (repo: string, id: number, repoKey: string) =>
      `${link(repo, id)}&repo_key=${repoKey}`;

    it("adopts the repoKey the OWNER announced instead of deriving its own", async () => {
      const { deps, calls } = fakes();
      // The owner's store is named `papercusp` (the pot was created local-first,
      // before it was ever published). Deriving locally from the link's coords
      // would produce `gh-1223568103` — a different store and a different wire
      // key, i.e. the silent total federation failure this fixes.
      const res = await joinHiveAsView(
        {
          potId: 'shop-hive',
          memberLinks: [keyedLink('shop', 1223568103, 'papercusp')],
          workspaceId: 'ws',
        },
        deps,
      );
      expect(res.ok).toBe(true);

      const shop = calls.registry.find((p) => p.slug === 'shop')!;
      expect(shop.pot_repo_key).toBe('papercusp');
      expect(shop.pot_repo_key_source).toBe('peer');
      // The coords still land — adoption changes the KEY, not the upstream.
      expect(shop.github_repository_id).toBe(1223568103);
    });

    it('falls back to its own derivation when the owner build announces no repo_key', async () => {
      const { deps, calls } = fakes();
      await joinHiveAsView(
        { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
        deps,
      );
      const shop = calls.registry.find((p) => p.slug === 'shop')!;
      expect(shop.pot_repo_key).toBe('gh-100');
      expect(shop.pot_repo_key_source).toBe('local');
    });

    it('RE-KEYS a member already pinned locally to the wrong value — the repair path', async () => {
      // The live rig/tower shape: this device pinned the bare slug from its own
      // registry while the owner's store is gh-1223568103. An ESTABLISHED member
      // re-joining takes the `already_registered` path (matched on repo id), so
      // this also proves the repair reaches a member that is not re-cloned.
      const { deps, calls } = fakes([
        {
          slug: 'shop',
          path: '/joined/shop',
          hive_slug: 'shop-hive',
          github_repository_id: 1223568103,
          pot_repo_key: 'shop',
          pot_repo_key_source: 'local',
        },
      ]);
      await joinHiveAsView(
        {
          potId: 'shop-hive',
          memberLinks: [keyedLink('shop', 1223568103, 'gh-1223568103')],
          workspaceId: 'ws',
        },
        deps,
      );
      const shop = calls.registry.find((p) => p.slug === 'shop')!;
      expect(shop.pot_repo_key).toBe('gh-1223568103');
      expect(shop.pot_repo_key_source).toBe('peer');
    });

    it('ignores a malformed announced key rather than writing it into a store path', async () => {
      const { deps, calls } = fakes();
      await joinHiveAsView(
        { potId: 'shop-hive', memberLinks: [`${link('shop', 100)}&repo_key=..`], workspaceId: 'ws' },
        deps,
      );
      const shop = calls.registry.find((p) => p.slug === 'shop')!;
      expect(shop.pot_repo_key).toBe('gh-100');
      expect(shop.pot_repo_key_source).toBe('local');
    });
  });

  it('a local harness owning the hive name is never clobbered — the view slug suffixes', async () => {
    const { deps, calls } = fakes([{ slug: 'shop-hive', path: '/local/own' }]);
    const res = await joinHiveAsView(
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.potSlug).toBe('shop-hive-2');
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.potSlug).toBe('shop-hive');
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res).toMatchObject({ ok: false, error: 'no_member_joined' });
    expect(calls.registry.find((p) => p.slug === 'shop-hive')).toBeUndefined();
  });

  it('malformed member links are rejected up front (zero side effects)', async () => {
    const { deps, calls } = fakes();
    const res = await joinHiveAsView(
      { potId: 'x', memberLinks: ['papercusp://harness?nope=1'], workspaceId: 'ws' },
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws-1' },
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.members[0]).toMatchObject({ ok: true, detail: 'joined; git_sync:error' });

    // error OUTCOME (the seeder's own never-throw contract) folds the same way
    const second = fakes();
    second.deps.seedGitSync = async () => ({ seeded: false, reason: 'error', message: 'pg down' });
    const res2 = await joinHiveAsView(
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      second.deps,
    );
    expect(res2.ok).toBe(true);
    expect(res2.members[0].detail).toBe('joined; git_sync:error');
  });

  it('an ineligible entry (e.g. clone path vanished) reports git_sync:ineligible, join still ok', async () => {
    const { deps } = fakes();
    deps.seedGitSync = async () => ({ seeded: false, reason: 'ineligible', ineligibleReason: 'no_path' });
    const res = await joinHiveAsView(
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.members[0].detail).toBe('joined; git_sync:ineligible');
  });

  it('a member reported ok by joinLink but missing from the registry is skipped, not seeded', async () => {
    const { deps, calls } = fakes();
    deps.joinLink = async () => ({ ok: true, detail: 'joined' }); // never registers
    const res = await joinHiveAsView(
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(calls.identities).toEqual([]); // skipped, not crashed
  });

  it('uses an explicit owner pubkey even when the local directory cache misses', async () => {
    const { deps, calls } = fakes();
    deps.resolveHivePubkey = async () => null;
    const res = await joinHiveAsView(
      { potId: 'shop-hive', hivePubkey: HIVE_PUBKEY, memberLinks: [link('shop', 100)], workspaceId: 'ws' },
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
    deps.findHiveByPubkey = async () => null;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await joinHiveAsView(
        { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
        deps,
      );
      expect(res.ok).toBe(true);
      expect(res.potSlug).toBe('shop-hive');
    } finally {
      warn.mockRestore();
    }
  });

  // WI-10003237: a swallowed step-2b failure left NO pots row at (workspace, potSlug),
  // so every federated pot_members apply failed pot_members_pot_fkey and the only
  // trace was that FK storm downstream. The failure must be LOGGED, naming the row
  // that already holds the pubkey (a same-workspace slug race) or its absence (the
  // pubkey lives in another workspace).
  it('a pubkey-collision identity failure is logged with the row already holding the pubkey', async () => {
    const { deps } = fakes();
    deps.upsertHiveIdentity = async () => {
      throw new Error('duplicate key value violates unique constraint "pots_public_key_key"');
    };
    const lookups: [string, string][] = [];
    deps.findHiveByPubkey = async (ws, pk) => {
      lookups.push([ws, pk]);
      return { homeSlug: 'shop', canonicalHomeSlug: 'shop', keychainId: `remote:${pk}` };
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await joinHiveAsView(
        { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
        deps,
      );
      expect(res.ok).toBe(true);
      expect(lookups).toEqual([['ws', HIVE_PUBKEY]]);
      const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('[join-hive] step 2b'));
      expect(line).toBeDefined();
      expect(line).toContain('ws/shop-hive');
      expect(line).toContain('pots_public_key_key');
      expect(line).toContain('same-workspace slug=shop canonical=shop');
    } finally {
      warn.mockRestore();
    }
  });

  it('an identity failure with no same-workspace pubkey holder says so', async () => {
    const { deps } = fakes();
    deps.upsertHiveIdentity = async () => {
      throw new Error('pots_public_key_key');
    };
    deps.findHiveByPubkey = async () => null;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await joinHiveAsView({ potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' }, deps);
      const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('[join-hive] step 2b'));
      expect(line).toContain('pubkey holder: none-in-this-workspace');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('self-echo guard (2026-07-01 owner split-brain: directory re-announce of an OWNED hive)', () => {
  const OWNED = { slug: 'shop-hive', path: '/local/own-hive', harness_kind: 'hive', self_repo: true };

  it('discovered hive whose pubkey matches a locally-OWNED hive → no-op self_hive, zero side effects', async () => {
    const { deps, calls } = fakes([OWNED, { slug: 'shop', path: '/local/shop', github_repository_id: 100 }]);
    deps.getLocalHive = async () => ({ pubkeyBase64: HIVE_PUBKEY });
    const res = await joinHiveAsView(
      { potId: 'shop-hive', hivePubkey: HIVE_PUBKEY, memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res).toMatchObject({ ok: true, potSlug: 'shop-hive', self_hive: true, members: [] });
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.self_hive).toBe(true);
    expect(calls.joined).toEqual([]);
  });

  it('a DISTINCT hive that merely shares the name (pubkey mismatch) still joins — suffixed view', async () => {
    const { deps, calls } = fakes([OWNED]);
    deps.getLocalHive = async () => ({ pubkeyBase64: 'x'.repeat(43) + '=' }); // different identity
    const res = await joinHiveAsView(
      { potId: 'shop-hive', hivePubkey: HIVE_PUBKEY, memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.self_hive).toBeUndefined();
    expect(res.potSlug).toBe('shop-hive-2');
    expect(calls.registry.find((p) => p.slug === 'shop-hive-2')!).toMatchObject({ remote_hive: true });
  });

  it('no pubkey resolvable anywhere → slug-equality fallback treats the OWNED hive as self', async () => {
    const { deps, calls } = fakes([OWNED]);
    deps.resolveHivePubkey = async () => null;
    deps.getLocalHive = async () => null;
    const res = await joinHiveAsView(
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res).toMatchObject({ ok: true, potSlug: 'shop-hive', self_hive: true });
    expect(calls.joined).toEqual([]);
  });

  it('a remote_hive VIEW with the same name does NOT trigger the guard (idempotent re-join keeps working)', async () => {
    const { deps, calls } = fakes([
      { slug: 'shop-hive', path: '/remote-hives/shop-hive', harness_kind: 'hive', remote_hive: true },
    ]);
    const res = await joinHiveAsView(
      { potId: 'shop-hive', hivePubkey: HIVE_PUBKEY, memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    expect(res.self_hive).toBeUndefined();
    expect(res.potSlug).toBe('shop-hive'); // reused view
    expect(calls.joined.map((j) => j.slug)).toEqual(['shop']);
  });
});

describe('verified hive identity coords stamped on the view (owner-bootstrap admit determinism)', () => {
  it('stamps hive_pubkey + owner_device_pubkey on a NEW view from opts', async () => {
    const { deps, calls } = fakes();
    const res = await joinHiveAsView(
      {
        potId: 'shop-hive', hivePubkey: HIVE_PUBKEY, ownerDevicePubkey: 'OD_announce',
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
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
      { potId: 'shop-hive', hivePubkey: HIVE_PUBKEY, memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
      deps,
    );
    expect(res.potSlug).toBe('shop-hive');
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
      deps,
    );
    const view = calls.registry.find((p) => p.slug === 'shop-hive')!;
    expect(view.hive_pubkey).toBeUndefined();
    expect(view.owner_device_pubkey).toBeUndefined();
  });

  it('reports a partial identity stamp as degraded when the hive key lacks the owner binding', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { deps, calls } = fakes();
      deps.resolveOwnerDevicePubkey = async () => null;
      const res = await joinHiveAsView(
        { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
        deps,
      );

      expect(res).toMatchObject({ ok: false, potSlug: 'shop-hive', error: 'partial_identity_stamp' });
      expect(calls.registry.find((p) => p.slug === 'shop-hive')).toMatchObject({
        remote_hive: true,
        hive_pubkey: HIVE_PUBKEY,
      });
      expect(calls.registry.find((p) => p.slug === 'shop-hive')).not.toHaveProperty('owner_device_pubkey');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('degraded join'));
    } finally {
      errorSpy.mockRestore();
    }
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
      { potId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
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
        { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
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
        { potId: 'shop-hive', memberLinks: [link('shop', 100)], workspaceId: 'ws' },
        deps,
      );
      expect(res.ok).toBe(true);
      expect(res.members[0]!.detail).toContain('rekey:failed');
    } finally {
      errSpy.mockRestore();
    }
  });
});
