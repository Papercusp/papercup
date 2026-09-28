/**
 * WI-10003590: an invite-link-joined entry that an older build left keyed on its
 * bare slug is repaired at boot from the clone's own shared.json. The first case
 * is the exact entry measured on the P-505 rig VM, 2026-09-28.
 */
import { describe, it, expect, vi } from 'vitest';
import { rekeyLinkJoinedRepoKeysForWorkspace } from './rekey-link-joined-repo-keys';
import type { HarnessRegistry } from '../../harness-registry';
import type { HarnessSharedConfig } from '../../harness/harness-shared-config-types';

const SHARED: HarnessSharedConfig = {
  topic: 'a'.repeat(64),
  github_remote: 'git@github.com:papercupai/hello-world-3-pot.git',
  github_repository_id: 1303510992,
  claim_status: 'unclaimed',
  privacy: 'shared-private',
  created_at: 1,
  schema_version: 1,
};

function fakes(
  projects: HarnessRegistry['projects'],
  shared: Record<string, HarnessSharedConfig | null> = { '/clone': SHARED },
) {
  const state = { stored: { projects } as HarnessRegistry, saves: 0, reads: [] as string[] };
  return {
    state,
    deps: {
      loadRegistry: async () => state.stored,
      saveRegistry: async (reg: HarnessRegistry) => {
        state.stored = reg;
        state.saves += 1;
      },
      readSharedConfig: (dir: string) => {
        state.reads.push(dir);
        return shared[dir] ?? null;
      },
    },
  };
}

/** The measured VM entry: link-joined, bare-slug local pin, no upstream coords. */
const strandedMember = (over: Record<string, unknown> = {}) => ({
  slug: 'hello-world-3-pot',
  path: '/clone',
  joined_via_link: true,
  remote_hive: true,
  self_repo: true,
  harness_kind: 'hive' as const,
  pot_repo_key: 'hello-world-3-pot',
  pot_repo_key_source: 'local' as const,
  ...over,
});

describe('rekeyLinkJoinedRepoKeysForWorkspace', () => {
  it('backfills coords from shared.json and re-keys the bare-slug pin to gh-<id> (the rig VM)', async () => {
    const { state, deps } = fakes([strandedMember()]);

    const res = await rekeyLinkJoinedRepoKeysForWorkspace('ws', deps);

    expect(res.error).toBeUndefined();
    expect(res.backfilled).toEqual([
      { slug: 'hello-world-3-pot', fields: ['github_repository_id', 'github_remote'] },
    ]);
    expect(res.rekeyed).toEqual([
      { slug: 'hello-world-3-pot', from: 'hello-world-3-pot', to: 'gh-1303510992' },
    ]);
    expect(res.wrote).toBe(true);
    expect(state.saves).toBe(1);
    const entry = state.stored.projects[0]!;
    expect(entry.pot_repo_key).toBe('gh-1303510992');
    expect(entry.pot_repo_key_source).toBe('local');
    expect(entry.github_repository_id).toBe(1303510992);
    // Normalized to the same https form upsertLinkJoinedEntry writes.
    expect(entry.github_remote).toBe('https://github.com/papercupai/hello-world-3-pot');
  });

  it('is IDEMPOTENT — a repaired entry reads nothing, writes nothing on the next boot', async () => {
    const { state, deps } = fakes([strandedMember()]);
    await rekeyLinkJoinedRepoKeysForWorkspace('ws', deps);
    state.reads = [];

    const second = await rekeyLinkJoinedRepoKeysForWorkspace('ws', deps);

    expect(second).toEqual({ backfilled: [], rekeyed: [], wrote: false });
    expect(state.saves).toBe(1);
    expect(state.reads).toEqual([]);
  });

  it('re-keys a stale local pin even when the coords are already present', async () => {
    const { state, deps } = fakes([
      strandedMember({
        github_repository_id: 1303510992,
        github_remote: 'https://github.com/papercupai/hello-world-3-pot',
      }),
    ]);

    const res = await rekeyLinkJoinedRepoKeysForWorkspace('ws', deps);

    expect(res.backfilled).toEqual([]);
    expect(res.rekeyed).toEqual([
      { slug: 'hello-world-3-pot', from: 'hello-world-3-pot', to: 'gh-1303510992' },
    ]);
    expect(state.reads).toEqual([]);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1303510992');
  });

  it('treats an unstamped legacy pin as local and re-keys it', async () => {
    const { state, deps } = fakes([strandedMember({ pot_repo_key_source: undefined })]);
    await rekeyLinkJoinedRepoKeysForWorkspace('ws', deps);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1303510992');
  });

  it('NEVER touches a peer-adopted pin — it still gains coords, but keeps its key', async () => {
    const { state, deps } = fakes([strandedMember({ pot_repo_key_source: 'peer' })]);

    const res = await rekeyLinkJoinedRepoKeysForWorkspace('ws', deps);

    expect(res.rekeyed).toEqual([]);
    const entry = state.stored.projects[0]!;
    expect(entry.pot_repo_key).toBe('hello-world-3-pot');
    expect(entry.pot_repo_key_source).toBe('peer');
    expect(entry.github_repository_id).toBe(1303510992);
  });

  it('NEVER re-keys a pot HOME (not joined_via_link) even with a bare-slug local pin and coords', async () => {
    const home = {
      slug: 'papercusp',
      path: '/clone',
      self_repo: true,
      harness_kind: 'hive' as const,
      github_repository_id: 1223568103,
      pot_repo_key: 'papercusp',
      pot_repo_key_source: 'local' as const,
    };
    const { state, deps } = fakes([home]);

    const res = await rekeyLinkJoinedRepoKeysForWorkspace('ws', deps);

    expect(res).toEqual({ backfilled: [], rekeyed: [], wrote: false });
    expect(state.saves).toBe(0);
    expect(state.reads).toEqual([]);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('papercusp');
  });

  it('leaves a local pin that is NOT one of the entry’s own rungs', async () => {
    const { state, deps } = fakes([strandedMember({ pot_repo_key: 'gh-999' })]);

    const res = await rekeyLinkJoinedRepoKeysForWorkspace('ws', deps);

    expect(res.rekeyed).toEqual([]);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-999');
  });

  it('leaves the pin alone when the clone carries no shared.json binding', async () => {
    const { state, deps } = fakes([strandedMember()], {});

    const res = await rekeyLinkJoinedRepoKeysForWorkspace('ws', deps);

    expect(res).toEqual({ backfilled: [], rekeyed: [], wrote: false });
    expect(state.saves).toBe(0);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('hello-world-3-pot');
  });

  it('only backfills coords for a never-pinned entry — the pin pass then pins the best rung', async () => {
    const { state, deps } = fakes([
      strandedMember({ pot_repo_key: undefined, pot_repo_key_source: undefined }),
    ]);

    const res = await rekeyLinkJoinedRepoKeysForWorkspace('ws', deps);

    expect(res.rekeyed).toEqual([]);
    expect(res.backfilled).toHaveLength(1);
    expect(state.stored.projects[0]!.pot_repo_key).toBeUndefined();
    expect(state.stored.projects[0]!.github_repository_id).toBe(1303510992);
  });

  it('is fail-soft: a load failure reports an error, warns, and throws nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await rekeyLinkJoinedRepoKeysForWorkspace('ws', {
        loadRegistry: async () => {
          throw new Error('pg down');
        },
      });
      expect(res).toEqual({ backfilled: [], rekeyed: [], wrote: false, error: 'pg down' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('link-joined repoKey reconcile failed (pg down)'));
    } finally {
      warn.mockRestore();
    }
  });

  it('survives a throwing shared.json reader and leaves the entry untouched', async () => {
    const { state, deps } = fakes([strandedMember()]);
    const res = await rekeyLinkJoinedRepoKeysForWorkspace('ws', {
      ...deps,
      readSharedConfig: () => {
        throw new Error('EACCES');
      },
    });
    expect(res).toEqual({ backfilled: [], rekeyed: [], wrote: false });
    expect(state.stored.projects[0]!.pot_repo_key).toBe('hello-world-3-pot');
  });
});
