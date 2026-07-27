/**
 * Unit tests for the boot repoKey pin pass (EI-18788176839043286).
 *
 * The property that matters: pinning is a NO-OP today (it writes down the key
 * the entry is already using) and permanently prevents the drift that
 * disconnected the P-302 rig from the papercusp pot for 7 days while every
 * health signal stayed green.
 */
import { describe, expect, it, vi } from 'vitest';
import { pinRepoKeysForWorkspace } from './pin-repo-keys';
import { canonicalRepoKey } from './repo-identity';
import type { HarnessRegistry } from '../../harness-registry';

const reg = (projects: HarnessRegistry['projects']): HarnessRegistry =>
  ({ projects }) as HarnessRegistry;

/** A registry + a save spy that mutates nothing the caller can observe twice. */
function harness(projects: HarnessRegistry['projects']) {
  let stored = reg(projects);
  const saveRegistry = vi.fn(async (next: HarnessRegistry) => {
    stored = next;
  });
  return {
    saveRegistry,
    loadRegistry: async () => stored,
    get stored() {
      return stored;
    },
  };
}

describe('pinRepoKeysForWorkspace', () => {
  it('pins each unpinned entry to the key canonicalRepoKey is ALREADY returning (a behavioural no-op)', async () => {
    const before = [
      { slug: 'papercusp', path: '/p' },
      { slug: 'hello-world', path: '/h', github_repository_id: 1296269 },
      { slug: 'x', path: '/x', github_remote: 'https://github.com/octocat/Hello-World.git' },
    ] as HarnessRegistry['projects'];
    // Capture what each entry resolves to BEFORE the pass touches anything.
    const keysBefore = before.map((p) => canonicalRepoKey(p));

    const h = harness(before);
    const res = await pinRepoKeysForWorkspace('ws', h);

    expect(res.wrote).toBe(true);
    expect(res.pinned.map((p) => p.repoKey)).toEqual(keysBefore);
    // and resolution is UNCHANGED after pinning — that is the whole point.
    expect(h.stored.projects.map((p) => canonicalRepoKey(p))).toEqual(keysBefore);
    expect(h.stored.projects.map((p) => p.pot_repo_key)).toEqual([
      'papercusp',
      'gh-1296269',
      'gh-octocat--hello-world',
    ]);
  });

  it('THE REGRESSION IT PREVENTS: a pinned pot does not re-key when it later gains a github id', async () => {
    const h = harness([{ slug: 'papercusp', path: '/p' }] as HarnessRegistry['projects']);
    await pinRepoKeysForWorkspace('ws', h);

    // Later: the pot publishes to GitHub and the coords get stamped on the entry.
    const entry = h.stored.projects[0]!;
    entry.github_repository_id = 1223568103;
    entry.github_remote = 'https://github.com/Papercusp/papercup.git';

    // Unpinned, this is the moment the store path and wire key silently moved.
    expect(canonicalRepoKey(entry)).toBe('papercusp');
  });

  it('is idempotent — a second pass pins nothing and does not write', async () => {
    const h = harness([
      { slug: 'a', path: '/a' },
      { slug: 'b', path: '/b', github_repository_id: 42 },
    ] as HarnessRegistry['projects']);

    const first = await pinRepoKeysForWorkspace('ws', h);
    expect(first.pinned).toHaveLength(2);
    expect(first.wrote).toBe(true);

    const second = await pinRepoKeysForWorkspace('ws', h);
    expect(second.pinned).toHaveLength(0);
    expect(second.alreadyPinned).toBe(2);
    expect(second.wrote).toBe(false);
    expect(h.saveRegistry).toHaveBeenCalledTimes(1);
  });

  it('never overwrites an existing pin, even when the coords now derive something else', async () => {
    const h = harness([
      { slug: 's', path: '/s', github_repository_id: 999, pot_repo_key: 'pinned-earlier' },
    ] as HarnessRegistry['projects']);

    const res = await pinRepoKeysForWorkspace('ws', h);

    expect(res.pinned).toHaveLength(0);
    expect(res.alreadyPinned).toBe(1);
    expect(h.stored.projects[0]!.pot_repo_key).toBe('pinned-earlier');
    expect(h.saveRegistry).not.toHaveBeenCalled();
  });

  it('does not write when there is nothing to pin', async () => {
    const h = harness([] as HarnessRegistry['projects']);
    const res = await pinRepoKeysForWorkspace('ws', h);
    expect(res.wrote).toBe(false);
    expect(h.saveRegistry).not.toHaveBeenCalled();
  });

  it('is fail-soft on the boot path: a load failure never throws and leaves the registry untouched', async () => {
    // The failure path warns by design (a silent boot-path failure is worse) —
    // assert on the warning rather than letting fail-on-console reject it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const saveRegistry = vi.fn();
      const res = await pinRepoKeysForWorkspace('ws', {
        loadRegistry: async () => {
          throw new Error('pg down');
        },
        saveRegistry,
      });
      expect(res.error).toContain('pg down');
      expect(res.pinned).toHaveLength(0);
      expect(res.wrote).toBe(false);
      expect(saveRegistry).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain('pg down');
    } finally {
      warn.mockRestore();
    }
  });

  it('is fail-soft on a SAVE failure too — reported, not thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await pinRepoKeysForWorkspace('ws', {
        loadRegistry: async () => reg([{ slug: 'a', path: '/a' }] as HarnessRegistry['projects']),
        saveRegistry: async () => {
          throw new Error('write conflict');
        },
      });
      expect(res.error).toContain('write conflict');
      expect(res.wrote).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
