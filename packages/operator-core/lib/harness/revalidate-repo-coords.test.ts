/**
 * revalidate-repo-coords.test.ts — hive-from-repo-hardening-2026-06-11 P-009.
 * All deps injected (octokit, registry load/mutate); no PG, no network.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { HarnessRegistry, ProjectEntry } from '../harness-registry';
import {
  revalidateRepoCoords,
  ensureRepoCoordsRevalidatedOnce,
  __resetRepoCoordsRevalidationForTests,
  MAX_COORD_ENTRIES,
  type RepoCoordsOctokit,
  type RevalidateRepoCoordsDeps,
} from './revalidate-repo-coords';

function entry(over: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    slug: 'shop',
    path: '/tmp/shop',
    github_remote: 'https://github.com/acme/shop.git',
    github_repository_id: 100,
    github_default_branch: 'main',
    ...over,
  };
}

interface RepoData {
  full_name?: string;
  default_branch?: string;
  clone_url?: string;
}

/** Octokit fake: repo-id → data (or an Error to throw). Records calls. */
function fakeOctokit(repos: Record<number, RepoData | Error>): RepoCoordsOctokit & {
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    async request(_route, params) {
      calls.push(params.repository_id);
      const hit = repos[params.repository_id];
      if (!hit) throw Object.assign(new Error('Not Found'), { status: 404 });
      if (hit instanceof Error) throw hit;
      return { data: hit };
    },
  };
}

/** In-memory registry + injected deps; tracks mutate calls + final state. */
function harness(projects: ProjectEntry[], repos: Record<number, RepoData | Error>) {
  let reg: HarnessRegistry = { projects };
  let mutateCalls = 0;
  const octokit = fakeOctokit(repos);
  const deps: RevalidateRepoCoordsDeps = {
    getOctokit: async () => octokit,
    loadRegistry: async () => reg,
    mutateRegistry: async (mutator) => {
      mutateCalls += 1;
      reg = mutator(reg);
      return reg;
    },
  };
  return {
    deps,
    octokit,
    get registry() {
      return reg;
    },
    get mutateCalls() {
      return mutateCalls;
    },
  };
}

/** The failure paths warn on purpose; vitest-fail-on-console would fail on it. */
function muteWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('revalidateRepoCoords (P-009)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('detects an upstream rename and repairs github_remote to the canonical clone URL', async () => {
    const h = harness(
      [entry()],
      {
        100: {
          full_name: 'acme-renamed/shop-next',
          default_branch: 'main',
          clone_url: 'https://github.com/acme-renamed/shop-next.git',
        },
      },
    );
    const counts = await revalidateRepoCoords('ws-1', h.deps);
    expect(counts).toEqual({ checked: 1, renamed: 1, branchChanged: 0, failed: 0 });
    expect(h.registry.projects[0].github_remote).toBe(
      'https://github.com/acme-renamed/shop-next.git',
    );
    // The immutable id is untouched.
    expect(h.registry.projects[0].github_repository_id).toBe(100);
  });

  it('repairs default-branch drift without touching the remote', async () => {
    const h = harness(
      [entry()],
      { 100: { full_name: 'acme/shop', default_branch: 'develop' } },
    );
    const counts = await revalidateRepoCoords('ws-1', h.deps);
    expect(counts).toEqual({ checked: 1, renamed: 0, branchChanged: 1, failed: 0 });
    expect(h.registry.projects[0].github_default_branch).toBe('develop');
    expect(h.registry.projects[0].github_remote).toBe('https://github.com/acme/shop.git');
  });

  it('leaves a no-drift registry untouched — zero mutate calls', async () => {
    const h = harness(
      [
        entry(),
        // Case-only difference is NOT drift (GitHub owner/repo are case-insensitive).
        entry({
          slug: 'cased',
          github_remote: 'https://github.com/ACME/Shop.git',
          github_repository_id: 101,
        }),
      ],
      {
        100: { full_name: 'acme/shop', default_branch: 'main' },
        101: { full_name: 'acme/shop', default_branch: 'main' },
      },
    );
    const counts = await revalidateRepoCoords('ws-1', h.deps);
    expect(counts).toEqual({ checked: 2, renamed: 0, branchChanged: 0, failed: 0 });
    expect(h.mutateCalls).toBe(0);
    expect(h.registry.projects[0]).toEqual(entry());
  });

  it('counts a per-repo API failure and keeps sweeping (never throws)', async () => {
    const warn = muteWarn();
    const h = harness(
      [
        entry({ slug: 'broken', github_repository_id: 666 }),
        entry({ slug: 'fine', github_repository_id: 100 }),
      ],
      {
        666: Object.assign(new Error('boom'), { status: 500 }),
        100: { full_name: 'acme/shop', default_branch: 'main' },
      },
    );
    const counts = await revalidateRepoCoords('ws-1', h.deps);
    expect(counts).toEqual({ checked: 2, renamed: 0, branchChanged: 0, failed: 1 });
    expect(h.mutateCalls).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('skips silently with zero counts when getOctokit resolves null (unauthenticated box)', async () => {
    let loaded = false;
    const counts = await revalidateRepoCoords('ws-1', {
      getOctokit: async () => null,
      loadRegistry: async () => {
        loaded = true;
        return { projects: [entry()] };
      },
      mutateRegistry: async () => {
        throw new Error('must not be called');
      },
    });
    expect(counts).toEqual({ checked: 0, renamed: 0, branchChanged: 0, failed: 0 });
    expect(loaded).toBe(false);
  });

  it('applies EVERY repair through ONE atomic mutate call', async () => {
    const h = harness(
      [
        entry({ slug: 'a', github_repository_id: 1, github_remote: 'https://github.com/acme/a.git' }),
        entry({ slug: 'b', github_repository_id: 2, github_remote: 'https://github.com/acme/b.git' }),
        entry({ slug: 'c', github_repository_id: 3, github_remote: 'https://github.com/acme/c.git' }),
      ],
      {
        1: { full_name: 'acme/a-renamed', default_branch: 'main', clone_url: 'https://github.com/acme/a-renamed.git' },
        2: { full_name: 'acme/b', default_branch: 'trunk' },
        3: { full_name: 'acme/c', default_branch: 'main' },
      },
    );
    const counts = await revalidateRepoCoords('ws-1', h.deps);
    expect(counts).toEqual({ checked: 3, renamed: 1, branchChanged: 1, failed: 0 });
    expect(h.mutateCalls).toBe(1);
    expect(h.registry.projects[0].github_remote).toBe('https://github.com/acme/a-renamed.git');
    expect(h.registry.projects[1].github_default_branch).toBe('trunk');
    expect(h.registry.projects[2]).toMatchObject({
      github_remote: 'https://github.com/acme/c.git',
      github_default_branch: 'main',
    });
  });

  it('ignores entries without a numeric github_repository_id', async () => {
    const h = harness(
      [
        entry({ slug: 'local-only', github_remote: undefined, github_repository_id: undefined }),
        entry(),
      ],
      { 100: { full_name: 'acme/shop', default_branch: 'main' } },
    );
    const counts = await revalidateRepoCoords('ws-1', h.deps);
    expect(counts.checked).toBe(1);
    expect(h.octokit.calls).toEqual([100]);
  });

  it(`bails with zero counts above the ${MAX_COORD_ENTRIES}-entry cap`, async () => {
    const warn = muteWarn();
    const projects = Array.from({ length: MAX_COORD_ENTRIES + 1 }, (_, i) =>
      entry({ slug: `p-${i}`, github_repository_id: 1000 + i }),
    );
    const h = harness(projects, {});
    const counts = await revalidateRepoCoords('ws-1', h.deps);
    expect(warn).toHaveBeenCalledOnce();
    expect(counts).toEqual({ checked: 0, renamed: 0, branchChanged: 0, failed: 0 });
    expect(h.octokit.calls).toEqual([]);
    expect(h.mutateCalls).toBe(0);
  });

  it('repairs a missing/unparseable remote from the immutable-id fetch', async () => {
    const h = harness(
      [entry({ github_remote: undefined })],
      { 100: { full_name: 'acme/shop', default_branch: 'main', clone_url: 'https://github.com/acme/shop.git' } },
    );
    const counts = await revalidateRepoCoords('ws-1', h.deps);
    expect(counts.renamed).toBe(1);
    expect(h.registry.projects[0].github_remote).toBe('https://github.com/acme/shop.git');
  });

  it('reports repairs as failed (not renamed) when the single mutate throws', async () => {
    muteWarn();
    const octokit = fakeOctokit({
      100: { full_name: 'acme/shop-renamed', default_branch: 'main', clone_url: 'https://github.com/acme/shop-renamed.git' },
    });
    const counts = await revalidateRepoCoords('ws-1', {
      getOctokit: async () => octokit,
      loadRegistry: async () => ({ projects: [entry()] }),
      mutateRegistry: async () => {
        throw new Error('pg down');
      },
    });
    expect(counts).toEqual({ checked: 1, renamed: 0, branchChanged: 0, failed: 1 });
  });

  it('skips a repair whose slug was re-registered to a DIFFERENT repo id between load and mutate', async () => {
    let reg: HarnessRegistry = { projects: [entry()] };
    const octokit = fakeOctokit({
      100: { full_name: 'acme/shop-renamed', default_branch: 'main', clone_url: 'https://github.com/acme/shop-renamed.git' },
    });
    const counts = await revalidateRepoCoords('ws-1', {
      getOctokit: async () => octokit,
      loadRegistry: async () => reg,
      mutateRegistry: async (mutator) => {
        // Concurrent writer swapped the slug to another repo before our mutate ran.
        reg = { projects: [entry({ github_repository_id: 999 })] };
        reg = mutator(reg);
        return reg;
      },
    });
    expect(counts.renamed).toBe(1); // detected …
    expect(reg.projects[0].github_remote).toBe('https://github.com/acme/shop.git'); // … but not clobbered
  });
});

describe('ensureRepoCoordsRevalidatedOnce (P-009 boot trigger)', () => {
  afterEach(() => __resetRepoCoordsRevalidationForTests());

  it('is fire-and-forget, returns synchronously, and only fires once per process', async () => {
    let sweeps = 0;
    const deps: RevalidateRepoCoordsDeps = {
      getOctokit: async () => {
        sweeps += 1;
        return null; // zero-skip after counting the fire
      },
    };
    expect(ensureRepoCoordsRevalidatedOnce('ws-1', deps)).toBeUndefined();
    expect(ensureRepoCoordsRevalidatedOnce('ws-1', deps)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0)); // let the detached run settle
    expect(sweeps).toBe(1);
    // The reset seam re-arms the guard (next process / next test).
    __resetRepoCoordsRevalidationForTests();
    expect(ensureRepoCoordsRevalidatedOnce('ws-1', deps)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(sweeps).toBe(2);
  });
});
