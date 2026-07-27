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

/**
 * EI-18798652713871439 — the REF-ANNOUNCE leg's input contract.
 *
 * Fix C was wired only into the bootstrap leg, so it never ran on the machine
 * that was actually collecting the refusal: the rig took five of these per tick
 * for hours, on a build that CONTAINED this adoption code, and healed nothing.
 * The receiver now also runs on the ref-announce receive leg — and that leg
 * hands it a DIFFERENTLY-WRAPPED string than the bootstrap leg does.
 *
 * The bootstrap leg reads `duplex.errored.message`. The ref-announce leg reads
 * the fetch result's `stderr`, which carries an extra transport prefix. If that
 * form did not parse, the new call site would be a silent no-op — the exact
 * class of "wired up but inert" this whole fix exists to remove — so it is
 * pinned here against the VERBATIM text observed in production.
 */
describe('adoptRefusedRepoKey — the ref-announce leg stderr form', () => {
  /** Verbatim from the rig's /tmp/serve-current.log, 2026-07-27T11:51:22.768Z. */
  const REF_ANNOUNCE_STDERR = 'duplex error: pot-git serve refused: superseded-repo-key:gh-1223568103';

  it('parses the production stderr text and adopts, despite the extra transport prefix', async () => {
    // The rig's real state: locally pinned to the SUPERSEDED key by the boot
    // backfill ("pinned 3 repoKey(s) so they can no longer drift"), which is a
    // local derivation — a guess — and so must lose to the peer's first-hand word.
    const { state, deps } = fakes([rigPotHome({ pot_repo_key: 'papercusp', pot_repo_key_source: 'local' })]);

    const res = await adoptRefusedRepoKey('papercusp', REF_ANNOUNCE_STDERR, deps);

    expect(res.adopted).toBe('gh-1223568103');
    expect(res.from).toBe('papercusp');
    expect(state.stored.projects[0]!.pot_repo_key).toBe('gh-1223568103');
    expect(state.stored.projects[0]!.pot_repo_key_source).toBe('peer');
  });

  it('is a clean no-op on the ordinary transport failures that share this leg', async () => {
    // Every non-refusal failure on the ref-announce leg flows through the same
    // loop, so the boring cases must stay boring — no writes, no log noise.
    const { state, deps } = fakes([rigPotHome()]);

    for (const stderr of [
      '', // the SIGKILL/ceiling path writes no stderr at all (WI-6277)
      'duplex error: pot-git serve refused: no-such-repo',
      'fatal: could not read from remote repository',
    ]) {
      const res = await adoptRefusedRepoKey('papercusp', stderr, deps);
      expect(res.adopted).toBeNull();
      expect(res.skipped).toBe('not-a-superseded-refusal');
    }
    expect(state.saves).toBe(0);
  });

  it('re-running on every later tick is idempotent once the key has landed', async () => {
    // The leg calls this on EVERY failed fetch, so a healed device must settle
    // into a no-op rather than rewriting the registry on every tick forever.
    const { state, deps } = fakes([rigPotHome({ pot_repo_key: 'gh-1223568103', pot_repo_key_source: 'peer' })]);

    const res = await adoptRefusedRepoKey('papercusp', REF_ANNOUNCE_STDERR, deps);

    expect(res).toEqual({ adopted: null, skipped: 'already-canonical' });
    expect(state.saves).toBe(0);
  });
});
