/**
 * WI-6364 (fix C, joiner half): a peer that refuses our fetch as
 * `superseded-repo-key:<K>` is telling us, first-hand, what its own store is
 * named. These cover the adoption that turns that refusal into a repair.
 *
 * The precedence cases are the ones that matter most: this is a THIRD adoption
 * channel layered under A3's two, and it must stay subordinate to them — a
 * member device that has itself diverged must never be able to drag a correctly
 * adopted joiner back off the owner's key.
 */
import { describe, it, expect } from 'vitest';
import { adoptRefusedRepoKey } from './adopt-refused-repo-key';
import type { HarnessRegistry } from '../../harness-registry';

/** The full destroy-error text a requester actually holds — serve-wiring's
 *  handleRefuse wraps every reason like this and `runBootstrapLeg` reads it off
 *  `duplex.errored.message`. Tests must go through the wrapped form. */
const refusal = (key: string) => `pot-git serve refused: superseded-repo-key:${key}`;

function fakes(projects: HarnessRegistry['projects']) {
  const state = { stored: { projects } as HarnessRegistry, saves: 0 };
  return {
    state,
    deps: {
      loadRegistry: async () => state.stored,
      saveRegistry: async (reg: HarnessRegistry) => {
        state.stored = reg;
        state.saves += 1;
      },
    },
  };
}

/** The live P-302 rig shape: a pot home minted locally, never pinned, that has
 *  been fetching the tower's abandoned `papercusp.git` for 7 days. */
const rigPotHome = (over: Record<string, unknown> = {}) => ({
  slug: 'papercusp',
  path: '/p',
  self_repo: true,
  ...over,
});

describe('adoptRefusedRepoKey', () => {
  it('THE LIVE REPAIR: an unpinned joiner adopts the key the peer named', async () => {
    const { state, deps } = fakes([rigPotHome()]);

    const res = await adoptRefusedRepoKey('papercusp', refusal('gh-1223568103'), deps);

    expect(res.adopted).toBe('gh-1223568103');
    expect(res.from).toBeUndefined(); // never pinned
    const entry = state.stored.projects[0]!;
    expect(entry.pot_repo_key).toBe('gh-1223568103');
    // Stamped 'peer' — NOT this device's own derivation, so a later boot
    // backfill (pinRepoKeysForWorkspace) cannot re-derive over it.
    expect(entry.pot_repo_key_source).toBe('peer');
    expect(state.saves).toBe(1);
  });

  it('overrides a LOCAL pin — a local pin is a guess, and this is first-hand', async () => {
    const { state, deps } = fakes([
      rigPotHome({ pot_repo_key: 'papercusp', pot_repo_key_source: 'local' }),
    ]);

    const res = await adoptRefusedRepoKey('papercusp', refusal('gh-1223568103'), deps);

    expect(res).toEqual({ adopted: 'gh-1223568103', from: 'papercusp' });
    expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1223568103');
  });

  it('overrides an UNSTAMPED legacy pin (every pin minted before adoption existed)', async () => {
    const { deps, state } = fakes([rigPotHome({ pot_repo_key: 'papercusp' })]);
    const res = await adoptRefusedRepoKey('papercusp', refusal('gh-1223568103'), deps);
    expect(res.adopted).toBe('gh-1223568103');
    expect(state.stored.projects[0]!.pot_repo_key_source).toBe('peer');
  });

  it("PRECEDENCE: the OWNER's adopted pin outranks a member's report of its disk", async () => {
    // The guard that keeps this channel subordinate to A3. A member device that
    // has itself diverged must not be able to un-repair a correct joiner.
    const { state, deps } = fakes([
      rigPotHome({ pot_repo_key: 'gh-1223568103', pot_repo_key_source: 'peer' }),
    ]);

    const res = await adoptRefusedRepoKey('papercusp', refusal('some-other-key'), deps);

    expect(res).toEqual({ adopted: null, skipped: 'owner-pin-wins' });
    expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1223568103');
    expect(state.saves).toBe(0);
  });

  it('is a TRUE NO-OP once the key is already canonical — this runs on every refused dial', async () => {
    const { state, deps } = fakes([
      rigPotHome({ pot_repo_key: 'gh-1223568103', pot_repo_key_source: 'local' }),
    ]);

    const res = await adoptRefusedRepoKey('papercusp', refusal('gh-1223568103'), deps);

    expect(res).toEqual({ adopted: null, skipped: 'already-canonical' });
    expect(state.saves).toBe(0);
  });

  it('IDEMPOTENT: a second identical refusal writes nothing further', async () => {
    const { state, deps } = fakes([rigPotHome()]);
    await adoptRefusedRepoKey('papercusp', refusal('gh-1223568103'), deps);
    // The second pass now hits `owner-pin-wins` (the first stamped it 'peer'),
    // which is the correct latch either way: no second write.
    await adoptRefusedRepoKey('papercusp', refusal('gh-1223568103'), deps);
    expect(state.saves).toBe(1);
  });

  it('ignores every OTHER refusal reason — no registry read, no write', async () => {
    for (const other of [
      'pot-git serve refused: no-such-repo',
      'pot-git serve refused: mode-legacy',
      'serve channel closed',
      undefined,
    ]) {
      const { state, deps } = fakes([rigPotHome()]);
      const res = await adoptRefusedRepoKey('papercusp', other, deps);
      expect(res).toEqual({ adopted: null, skipped: 'not-a-superseded-refusal' });
      expect(state.saves).toBe(0);
    }
  });

  it('REFUSES an unsafe key from the wire — it becomes a path and a ref component', async () => {
    const { state, deps } = fakes([rigPotHome()]);
    const res = await adoptRefusedRepoKey(
      'papercusp',
      'pot-git serve refused: superseded-repo-key:../../etc/passwd',
      deps,
    );
    expect(res.adopted).toBeNull();
    expect(state.stored.projects[0]!.pot_repo_key).toBeUndefined();
    expect(state.saves).toBe(0);
  });

  it('touches ONLY the named entry — a pot serves many repos under one directory', async () => {
    const { state, deps } = fakes([rigPotHome(), { slug: 'hive-canary', path: '/c' }]);
    await adoptRefusedRepoKey('papercusp', refusal('gh-1223568103'), deps);
    expect(state.stored.projects[1]!.pot_repo_key).toBeUndefined();
  });

  it('an unknown slug is a clean no-op', async () => {
    const { state, deps } = fakes([rigPotHome()]);
    const res = await adoptRefusedRepoKey('not-here', refusal('gh-1'), deps);
    expect(res).toEqual({ adopted: null, skipped: 'no-such-entry' });
    expect(state.saves).toBe(0);
  });

  it('FAIL-SOFT: a throwing registry never escapes into the git-sync tick', async () => {
    const res = await adoptRefusedRepoKey('papercusp', refusal('gh-1'), {
      loadRegistry: async () => {
        throw new Error('registry unreadable');
      },
    });
    expect(res).toEqual({ adopted: null, skipped: 'registry-error' });
  });

  it('FAIL-SOFT: a throwing SAVE is reported, not thrown', async () => {
    const res = await adoptRefusedRepoKey('papercusp', refusal('gh-1223568103'), {
      loadRegistry: async () => ({ projects: [rigPotHome()] }) as HarnessRegistry,
      saveRegistry: async () => {
        throw new Error('disk full');
      },
    });
    expect(res).toEqual({ adopted: null, skipped: 'registry-error' });
  });
});
