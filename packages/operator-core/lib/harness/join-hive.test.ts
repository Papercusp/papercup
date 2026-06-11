/**
 * join-hive.test.ts — joiner-side hive symmetry (hardening P-007 / D-007).
 * Per-link join + registry seams injected — no PG, git, swarm, or GitHub.
 */
import { describe, it, expect } from 'vitest';
import { joinHiveAsView, type JoinHiveDeps } from './join-hive';
import type { HarnessRegistry } from '../harness-registry';

const TOPIC = 'a'.repeat(64);
const link = (repo: string, id: number) =>
  `papercusp://harness?topic=${TOPIC}&github=acme%2F${repo}&repo_id=${id}`;

function fakes(initialProjects: HarnessRegistry['projects'] = []) {
  const calls = {
    joined: [] as { slug: string; repoName: string }[],
    registry: [...initialProjects] as HarnessRegistry['projects'],
    dirs: [] as string[],
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
    const res = await joinHiveAsView(
      { hiveId: 'shop-hive', memberLinks: [link('shop', 100), link('docs', 200)], workspaceId: 'ws' },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.hiveSlug).toBe('shop-hive');
    expect(calls.joined.map((j) => j.slug)).toEqual(['docs']); // shop skipped
    expect(res.members.find((m) => m.slug === 'shop')?.detail).toBe('already_registered');
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
  });
});
