/**
 * join-hive.test.ts — joiner-side hive symmetry (hardening P-007 / D-007) +
 * joiner-side git-sync seeding (git-sync-any-hive-2026-06-12 P-003 / B-03).
 * Per-link join + registry + git-sync seams injected — no PG, git, swarm, or
 * GitHub.
 */
import { describe, it, expect } from 'vitest';
import { joinHiveAsView, type JoinHiveDeps } from './join-hive';
import type { SeedGitSyncRoutineOpts } from './git-sync/git-sync-routine';
import type { HarnessRegistry } from '../harness-registry';

const TOPIC = 'a'.repeat(64);
const link = (repo: string, id: number) =>
  `papercusp://harness?topic=${TOPIC}&github=acme%2F${repo}&repo_id=${id}`;

function fakes(initialProjects: HarnessRegistry['projects'] = []) {
  const calls = {
    joined: [] as { slug: string; repoName: string }[],
    registry: [...initialProjects] as HarnessRegistry['projects'],
    dirs: [] as string[],
    seeded: [] as SeedGitSyncRoutineOpts[],
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
});
