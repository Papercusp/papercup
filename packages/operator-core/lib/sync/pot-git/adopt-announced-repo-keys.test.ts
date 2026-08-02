/**
 * A3 boot reconcile (EI-18788176839043286 / WI-6359): a pot home minted LOCALLY
 * is never join-hive'd, so it never adopts the owner's key from a join link.
 * These tests cover the pass that repairs it from the announce instead.
 */
import { describe, it, expect, vi } from 'vitest';
import { adoptAnnouncedRepoKeysForWorkspace } from './adopt-announced-repo-keys';
import type { HarnessRegistry } from '../../harness-registry';

function fakes(projects: HarnessRegistry['projects'], announced: unknown[] = []) {
  const state = { stored: { projects } as HarnessRegistry, saves: 0 };
  return {
    state,
    deps: {
      loadRegistry: async () => state.stored,
      saveRegistry: async (reg: HarnessRegistry) => {
        state.stored = reg;
        state.saves += 1;
      },
      listAnnounced: () => announced as never,
    },
  };
}

/** The live rig shape: a pot home minted locally with no upstream at all. */
const localPotHome = (over: Record<string, unknown> = {}) => ({
  slug: 'papercusp',
  path: '/p',
  self_repo: true,
  ...over,
});

describe('adoptAnnouncedRepoKeysForWorkspace', () => {
  it('adopts the owner-announced homeRepoKey over a locally-derived pin (the rig repair)', async () => {
    const { state, deps } = fakes(
      [localPotHome({ pot_repo_key: 'papercusp', pot_repo_key_source: 'local' })],
      [{ potId: 'papercusp', homeRepoKey: 'gh-1223568103' }],
    );

    const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);

    expect(res.adopted).toEqual([
      { slug: 'papercusp', from: 'papercusp', to: 'gh-1223568103' },
    ]);
    expect(res.wrote).toBe(true);
    const entry = state.stored.projects[0]!;
    expect(entry.pot_repo_key).toBe('gh-1223568103');
    expect(entry.pot_repo_key_source).toBe('peer');
  });

  it('adopts onto an entry that was never pinned at all', async () => {
    const { state, deps } = fakes(
      [localPotHome()],
      [{ potId: 'papercusp', homeRepoKey: 'gh-1223568103' }],
    );
    await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1223568103');
  });

  it('is IDEMPOTENT — a second pass adopts nothing and writes nothing', async () => {
    const { state, deps } = fakes(
      [localPotHome({ pot_repo_key: 'papercusp', pot_repo_key_source: 'local' })],
      [{ potId: 'papercusp', homeRepoKey: 'gh-1223568103' }],
    );
    const first = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
    expect(first.adopted).toHaveLength(1);

    const savesAfterFirst = state.saves;
    const second = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);

    expect(second.adopted).toEqual([]);
    expect(second.wrote).toBe(false);
    expect(state.saves).toBe(savesAfterFirst);
  });

  it('NEVER touches a joiner-side remote_hive VIEW — join-hive owns those', async () => {
    const { state, deps } = fakes(
      [
        {
          slug: 'papercusp',
          path: '/v',
          harness_kind: 'hive',
          remote_hive: true,
          pot_repo_key: 'papercusp',
          pot_repo_key_source: 'local',
        },
      ],
      [{ potId: 'papercusp', homeRepoKey: 'gh-1223568103' }],
    );
    const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
    expect(res.adopted).toEqual([]);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('papercusp');
  });

  it('never adopts from a SYNTHETIC potId — that slug is a local guess, not the owner’s', async () => {
    // DiscoveredHive.potIdSynthetic marks a descriptor minted from a join-link
    // seed with no announce; its slug is derived, so matching on it would adopt
    // a key for the wrong pot.
    const { state, deps } = fakes(
      [localPotHome({ pot_repo_key: 'papercusp', pot_repo_key_source: 'local' })],
      [{ potId: 'papercusp', potIdSynthetic: true, homeRepoKey: 'gh-999' }],
    );
    const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
    expect(res.adopted).toEqual([]);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('papercusp');
  });

  it('does not re-derive a key already adopted from a peer', async () => {
    const { state, deps } = fakes(
      [localPotHome({ pot_repo_key: 'gh-1223568103', pot_repo_key_source: 'peer' })],
      [],
    );
    const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
    expect(res.adopted).toEqual([]);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1223568103');
  });

  it('is a clean no-op when no announce carries a home key', async () => {
    const { state, deps } = fakes(
      [localPotHome({ pot_repo_key: 'papercusp', pot_repo_key_source: 'local' })],
      [{ potId: 'papercusp' }, { potId: 'other', homeRepoKey: 'gh-1' }],
    );
    const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
    expect(res).toMatchObject({ adopted: [], wrote: false });
    expect(state.stored.projects[0]!.pot_repo_key).toBe('papercusp');
  });

  it('ignores a malformed announced key rather than writing it into a store path', async () => {
    const { state, deps } = fakes(
      [localPotHome({ pot_repo_key: 'papercusp', pot_repo_key_source: 'local' })],
      [{ potId: 'papercusp', homeRepoKey: '../../etc/passwd' }],
    );
    const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
    expect(res.adopted).toEqual([]);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('papercusp');
  });

  it('FAIL-SOFT on the boot path: a registry failure never throws', async () => {
    // The failure path warns by design, so spy rather than let
    // vitest-fail-on-console read the deliberate warn as a test failure.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await adoptAnnouncedRepoKeysForWorkspace('ws', {
        loadRegistry: async () => {
          throw new Error('pg down');
        },
        listAnnounced: () => [{ potId: 'papercusp', homeRepoKey: 'gh-1' }],
      });
      expect(res.error).toBe('pg down');
      expect(res.adopted).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('NEVER adopts into an entry with its own federated identity, even when a peer announces a different value for the same potId (live regression, 2026-08-02)', async () => {
    // The tower's own shape: self_repo home WITH real github coords. A weaker
    // peer (the rig, with no coords) announces ITS OWN bare-slug guess under
    // the SAME potId — `byPotId` is last-write-wins, so this is exactly the
    // announce the tower's own adopt pass could see.
    const { state, deps } = fakes(
      [
        localPotHome({
          github_repository_id: 1223568103,
          pot_repo_key: 'gh-1223568103',
          pot_repo_key_source: 'local',
        }),
      ],
      [{ potId: 'papercusp', homeRepoKey: 'papercusp' }],
    );
    const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
    expect(res.adopted).toEqual([]);
    expect(res.restoredOwnIdentity).toEqual([]);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1223568103');
    expect(state.stored.projects[0]!.pot_repo_key_source).toBe('local');
  });

  it('RESTORES a federated-identity entry already corrupted by a prior (buggy) adopt — the live tower incident', async () => {
    // Exactly the corrupted state found live on the tower 2026-08-02: its own
    // papercusp entry (id 1223568103) had been flipped to the rig's bare
    // 'papercusp', stamped 'peer' — which `adoptRepoKey`'s own
    // never-re-derive-a-peer-pin rule would otherwise freeze forever.
    const { state, deps } = fakes(
      [
        localPotHome({
          github_repository_id: 1223568103,
          pot_repo_key: 'papercusp',
          pot_repo_key_source: 'peer',
        }),
      ],
      [{ potId: 'papercusp', homeRepoKey: 'papercusp' }],
    );
    const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
    expect(res.adopted).toEqual([]);
    expect(res.restoredOwnIdentity).toEqual([
      { slug: 'papercusp', from: 'papercusp', to: 'gh-1223568103' },
    ]);
    expect(res.wrote).toBe(true);
    const entry = state.stored.projects[0]!;
    expect(entry.pot_repo_key).toBe('gh-1223568103');
    expect(entry.pot_repo_key_source).toBe('local');
  });

  it('a federated-identity entry already correct is a true no-op (steady state)', async () => {
    const { state, deps } = fakes(
      [
        localPotHome({
          github_repository_id: 1223568103,
          pot_repo_key: 'gh-1223568103',
          pot_repo_key_source: 'local',
        }),
      ],
      [{ potId: 'papercusp', homeRepoKey: 'gh-1223568103' }],
    );
    const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
    expect(res.adopted).toEqual([]);
    expect(res.restoredOwnIdentity).toEqual([]);
    expect(res.wrote).toBe(false);
    expect(state.saves).toBe(0);
    expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1223568103');
  });

  it('FAIL-SOFT when the hive directory is unavailable', async () => {
    const res = await adoptAnnouncedRepoKeysForWorkspace('ws', {
      loadRegistry: async () => ({ projects: [localPotHome()] }) as HarnessRegistry,
      listAnnounced: () => {
        throw new Error('no directory');
      },
    });
    expect(res).toMatchObject({ adopted: [], wrote: false });
    expect(res.error).toBeUndefined();
  });

  // ⚠ The restore half is PURELY LOCAL, so it must not be gated on the announce
  // set. It used to sit behind two early returns ("the directory threw" /
  // "nothing announced a home key") that fired before the registry was even
  // loaded — making this module's documented guarantee false in exactly the
  // states where it is load-bearing, and leaving the corruption PERMANENT
  // (canonicalRepoKey treats any pin as authoritative forever). Live on the
  // tower 2026-08-02: `papercusp` stayed pinned to the rig's bare
  // `papercusp`/'peer' despite carrying github_repository_id 1223568103.
  describe('restores a corrupted federated identity WITHOUT any announcement', () => {
    /** The tower's exact live shape at 2026-08-02T07:35Z. */
    const corruptedTower = () =>
      localPotHome({
        harness_kind: 'hive',
        github_repository_id: 1223568103,
        github_remote: 'https://github.com/Papercusp/papercup.git',
        pot_repo_key: 'papercusp',
        pot_repo_key_source: 'peer',
      });

    it('THE REGRESSION: nothing announced at all still restores gh-<id>', async () => {
      const { state, deps } = fakes([corruptedTower()], []);

      const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);

      expect(res.restoredOwnIdentity).toEqual([
        { slug: 'papercusp', from: 'papercusp', to: 'gh-1223568103' },
      ]);
      expect(res.wrote).toBe(true);
      const entry = state.stored.projects[0]!;
      expect(entry.pot_repo_key).toBe('gh-1223568103');
      // back to its OWN derivation — it never adopted this from anyone
      expect(entry.pot_repo_key_source).toBe('local');
    });

    it('a THROWING directory still restores (nothing to adopt from ≠ nothing to repair)', async () => {
      const state = { stored: { projects: [corruptedTower()] } as HarnessRegistry, saves: 0 };
      const res = await adoptAnnouncedRepoKeysForWorkspace('ws', {
        loadRegistry: async () => state.stored,
        saveRegistry: async (reg: HarnessRegistry) => {
          state.stored = reg;
          state.saves += 1;
        },
        listAnnounced: () => {
          throw new Error('no directory');
        },
      });

      expect(res.restoredOwnIdentity).toHaveLength(1);
      expect(res.wrote).toBe(true);
      expect(state.saves).toBe(1);
      expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1223568103');
    });

    it('announces that carry NO home key (or a synthetic potId) still let the restore run', async () => {
      const { state, deps } = fakes(
        [corruptedTower()],
        [
          { potId: 'papercusp', potIdSynthetic: true, homeRepoKey: 'papercusp' },
          { potId: 'other-pot' },
        ],
      );
      const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
      expect(res.restoredOwnIdentity).toHaveLength(1);
      expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1223568103');
    });

    it('still a true no-op with no announcements when the entry is already correct', async () => {
      const { state, deps } = fakes(
        [
          localPotHome({
            github_repository_id: 1223568103,
            pot_repo_key: 'gh-1223568103',
            pot_repo_key_source: 'local',
          }),
        ],
        [],
      );
      const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
      expect(res.restoredOwnIdentity).toEqual([]);
      expect(res.wrote).toBe(false);
      expect(state.saves).toBe(0);
    });

    it('a NON-federated entry with no announcements is untouched (nothing to restore FROM)', async () => {
      const { state, deps } = fakes(
        [localPotHome({ pot_repo_key: 'papercusp', pot_repo_key_source: 'local' })],
        [],
      );
      const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
      expect(res.restoredOwnIdentity).toEqual([]);
      expect(res.adopted).toEqual([]);
      expect(res.wrote).toBe(false);
      expect(state.saves).toBe(0);
      expect(state.stored.projects[0]!.pot_repo_key).toBe('papercusp');
    });

    it('restores the federated entry AND adopts a different non-federated one in one pass', async () => {
      const { state, deps } = fakes(
        [
          corruptedTower(),
          localPotHome({ slug: 'canary', pot_repo_key: 'canary', pot_repo_key_source: 'local' }),
        ],
        [{ potId: 'canary', homeRepoKey: 'gh-999' }],
      );
      const res = await adoptAnnouncedRepoKeysForWorkspace('ws', deps);
      expect(res.restoredOwnIdentity).toEqual([
        { slug: 'papercusp', from: 'papercusp', to: 'gh-1223568103' },
      ]);
      expect(res.adopted).toEqual([{ slug: 'canary', from: 'canary', to: 'gh-999' }]);
      expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1223568103');
      expect(state.stored.projects[1]!.pot_repo_key).toBe('gh-999');
    });
  });
});
