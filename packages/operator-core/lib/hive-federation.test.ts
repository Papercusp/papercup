/**
 * hive-federation.test.ts — the swarm-binding re-key for shared Hives
 * (shared-hive-federation-2026-06-08 P-004). PG-free: the Hive identity read
 * (hive-store), the share-gate read (hive-directory-meta), and the membership
 * read (harness-registry) are mocked.
 *
 * Asserts the federation gate + membership resolution: a Hive HOME federates over
 * its Hive pubkey topic so owner-authored Hive-state rows drain; a MEMBER harness
 * (hive_slug → home) federates over that topic only when the Hive is shared
 * (public/invite) or is a joined remote_hive view. A non-hive, an un-backfilled
 * Hive, or a member of a private owned Hive returns null (the caller falls back
 * to the gh/local binding → unchanged behavior).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBKEY = Buffer.alloc(32, 7).toString('base64');
type Vis = 'public' | 'invite' | 'private';

let hives: Map<string, { homeSlug: string; pubkeyBase64: string }>;
let metas: Map<string, { visibility: Vis }>;
let projects: Array<{
  slug: string;
  hive_slug?: string;
  remote_hive?: boolean;
  harness_kind?: string;
  self_repo?: boolean;
}>;
/** hive pubkey → the OWNER-authored home slug carried by its signed announce (WI-559). */
let announces: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  hives = new Map();
  metas = new Map();
  projects = [];
  vi.doMock('./hive-store', () => ({
    getHiveBySlug: async (_ws: string, slug: string) => hives.get(slug) ?? null,
  }));
  vi.doMock('./hive-directory-meta', () => ({
    getOwnedHiveMeta: async (potId: string) => metas.get(potId) ?? null,
  }));
  vi.doMock('./harness-registry', () => ({
    loadHarnessRegistry: async () => ({ projects }),
  }));
  // WI-559: the owner's signed directory announce, keyed by HIVE PUBKEY — the only
  // sound key, since the joiner's local view slug is a naming affordance that can
  // legitimately differ from the owner's home slug.
  announces = new Map();
  vi.doMock('./hive-membership-store', () => ({
    loadAnnouncedHiveHomeSlug: async (_ws: string, pubkey: string) =>
      announces.get(pubkey) ?? null,
  }));
});

afterEach(() => {
  vi.doUnmock('./hive-store');
  vi.doUnmock('./hive-directory-meta');
  vi.doUnmock('./harness-registry');
  vi.doUnmock('./hive-membership-store');
});

/** Register a Hive home with the given visibility. */
function publishHive(slug: string, visibility: Vis) {
  hives.set(slug, { homeSlug: slug, pubkeyBase64: PUBKEY });
  metas.set(slug, { visibility });
}

async function resolve(slug: string) {
  const { resolveHiveSwarmBinding } = await import('./hive-federation');
  return resolveHiveSwarmBinding('ws', slug);
}

describe('resolveHiveSwarmBinding — Hive home', () => {
  it('null for a non-hive harness (no identity, no membership)', async () => {
    expect(await resolve('a-harness')).toBeNull();
  });

  it('federates the Hive HOME with no directory meta so owner Hive-state rows drain', async () => {
    hives.set('myhive', { homeSlug: 'myhive', pubkeyBase64: PUBKEY });
    expect(await resolve('myhive')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });

  it('federates the private Hive HOME so hive_settings/hive_members reach joiners', async () => {
    publishHive('myhive', 'private');
    expect(await resolve('myhive')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });

  it('federates a PUBLIC Hive home over its pubkey topic', async () => {
    publishHive('myhive', 'public');
    expect(await resolve('myhive')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });

  it('federates an INVITE Hive home over its pubkey topic', async () => {
    publishHive('myhive', 'invite');
    expect(await resolve('myhive')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });
});

describe('resolveHiveSwarmBinding — member harness (hive_slug)', () => {
  it('a member of a PUBLIC Hive federates over the HIVE topic', async () => {
    publishHive('myhive', 'public');
    projects = [{ slug: 'member-a', hive_slug: 'myhive' }];
    expect(await resolve('member-a')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });

  it('a member of a PRIVATE Hive stays local-only', async () => {
    publishHive('myhive', 'private');
    projects = [{ slug: 'member-a', hive_slug: 'myhive' }];
    expect(await resolve('member-a')).toBeNull();
  });

  it('a member whose Hive has no identity yet (un-backfilled) → null', async () => {
    metas.set('myhive', { visibility: 'public' }); // published but no identity row
    projects = [{ slug: 'member-a', hive_slug: 'myhive' }];
    expect(await resolve('member-a')).toBeNull();
  });

  it('a harness with no hive_slug is not a member → null', async () => {
    publishHive('myhive', 'public');
    projects = [{ slug: 'loner' }];
    expect(await resolve('loner')).toBeNull();
  });
});

describe('resolveHiveSwarmBinding — JOINED (remote) Hive (EI-681)', () => {
  it('a member of a JOINED hive federates over the hive-pubkey topic even with NO owned meta', async () => {
    // The joiner has the remote identity row (pubkey) + a remote_hive view home,
    // but NO owned directory meta (it never published — it joined). It must STILL
    // re-key to the hive-pubkey topic to share the OWNER's topic.
    hives.set('remotehive', { homeSlug: 'remotehive', pubkeyBase64: PUBKEY }); // no metas entry
    projects = [
      { slug: 'remotehive', remote_hive: true },
      { slug: 'joined-member', hive_slug: 'remotehive' },
    ];
    expect(await resolve('joined-member')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
    // The remote view home itself also re-keys (consistency).
    expect(await resolve('remotehive')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });

  it('an UN-PUBLISHED OWNED hive home federates, but its member harness stays local-only', async () => {
    // Same "no meta" shape as a joined hive, but NOT remote_hive → the owner HOME
    // joins the Hive topic to drain Hive-state rows; its ordinary member harness
    // still stays local unless the Hive is published/shared.
    hives.set('ownedhive', { homeSlug: 'ownedhive', pubkeyBase64: PUBKEY });
    projects = [
      { slug: 'ownedhive' }, // no remote_hive flag
      { slug: 'member-x', hive_slug: 'ownedhive' },
    ];
    expect(await resolve('member-x')).toBeNull();
    expect(await resolve('ownedhive')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });
});

// A-003 (shared-pot-release-testing Brief I): the joiner-rebind GATE. Boot uses
// this to decide whether a member harness must bind its hive_members/hive_settings
// projections to the HIVE-HOME slug — true (the home slug) ONLY in the joiner
// topology (the home is a `remote_hive` VIEW), null for an owner's own hive (whose
// home harness owns the write side) or a non-hive harness.
describe('joinerPotHomeSlug — the member-projection rebind gate', () => {
  async function joinerHome(slug: string) {
    const { joinerPotHomeSlug } = await import('./hive-federation');
    return joinerPotHomeSlug('ws', slug);
  }

  it('a member of a JOINED (remote_hive) hive → the HIVE-HOME slug (rebind)', async () => {
    hives.set('remotehive', { homeSlug: 'remotehive', pubkeyBase64: PUBKEY });
    projects = [
      { slug: 'remotehive', remote_hive: true },
      { slug: 'joined-member', hive_slug: 'remotehive' },
    ];
    expect(await joinerHome('joined-member')).toBe('remotehive');
    // The remote_hive home VIEW itself resolves to its own slug (harmless no-op rebind).
    expect(await joinerHome('remotehive')).toBe('remotehive');
  });

  it('a member of an OWNED hive → null (the owner home owns the write side; no rebind)', async () => {
    hives.set('ownedhive', { homeSlug: 'ownedhive', pubkeyBase64: PUBKEY });
    publishHive('ownedhive', 'public'); // even a PUBLISHED owned hive must not rebind its members
    projects = [
      { slug: 'ownedhive' }, // owned home — not remote_hive
      { slug: 'member-x', hive_slug: 'ownedhive' },
    ];
    expect(await joinerHome('member-x')).toBeNull();
    expect(await joinerHome('ownedhive')).toBeNull();
  });

  it('a non-hive harness → null', async () => {
    projects = [{ slug: 'loner' }];
    expect(await joinerHome('loner')).toBeNull();
  });
});

// WI-559 — the joiner's LOCAL view slug is not the federation demux key.
//
// Live failure (2-machine rig, 2026-07-27): owner fed-a and joiner fed-b held the SAME
// hive pubkey but different `pots.pot_home_slug` — 'spoon-knife-pot' vs
// 'octocat-spoon-knife'. That column IS the demux key, so fed-b dropped EVERY inbound row
// for the hive across ~12 hive-home-grained projections (pot_members, pot_settings,
// agent_facts, memories, gym elites, policy, reports, epoch keys, p2p tags) — a whole-hive
// federation blackout that surfaced only as "presence is one-directional". Observed
// end-to-end in one boot: `hive-members-drop own=octocat-spoon-knife
// row.hive_home=spoon-knife-pot` (x20+) → `NO admitted devices for topic 726696c069e9`.
//
// TWO independent causes produce the disagreement, which is why the demux key must be
// derived from the PUBKEY rather than either side's slug:
//   (a) lookup-hive-for-repo leg 3 fabricated `potId` from a display TITLE —
//       kebab('octocat/Spoon-Knife') === 'octocat-spoon-knife';
//   (b) STRUCTURAL and unfixable at the origin: join-hive.ts:265 derives the view slug
//       `freeSlug(kebab(potId), taken)`, which SUFFIXES on a local name collision. Two
//       joiners of the same hive, or one joiner that already owns the name locally, get
//       'spoon-knife-pot-2' on a perfectly healthy join.
describe('canonicalHiveHomeSlug — the federation demux key (WI-559)', () => {
  async function canonical(slug: string) {
    const { canonicalHiveHomeSlug } = await import('./hive-federation');
    return canonicalHiveHomeSlug('ws', slug);
  }
  async function joinerHome(slug: string) {
    const { joinerPotHomeSlug } = await import('./hive-federation');
    return joinerPotHomeSlug('ws', slug);
  }

  /** The live rig's topology: a joined view whose local slug != the owner's home slug. */
  function pollutedJoiner() {
    hives.set('octocat-spoon-knife', {
      homeSlug: 'octocat-spoon-knife',
      pubkeyBase64: PUBKEY,
    });
    projects = [
      { slug: 'octocat-spoon-knife', remote_hive: true },
      { slug: 'joined-member', hive_slug: 'octocat-spoon-knife' },
    ];
    announces.set(PUBKEY, 'spoon-knife-pot');
  }

  it('a JOINED view resolves the OWNER-authored slug from the announce, not its local slug', async () => {
    pollutedJoiner();
    expect(await canonical('joined-member')).toBe('spoon-knife-pot');
    expect(await canonical('octocat-spoon-knife')).toBe('spoon-knife-pot');
  });

  it('joinerPotHomeSlug (the projection WRITE scope) returns the canonical slug', async () => {
    pollutedJoiner();
    // This is the value boot.ts binds hive_members/hive_settings projections to. Before
    // the fix it returned 'octocat-spoon-knife' and every owner row was demux-dropped.
    expect(await joinerHome('joined-member')).toBe('spoon-knife-pot');
  });

  it('an OWNED hive is byte-for-byte unchanged — the announce is never consulted', async () => {
    hives.set('ownedhive', { homeSlug: 'ownedhive', pubkeyBase64: PUBKEY });
    publishHive('ownedhive', 'public');
    projects = [{ slug: 'ownedhive' }, { slug: 'member-x', hive_slug: 'ownedhive' }];
    // An announce for this very pubkey exists and must be IGNORED: the owner is the
    // authority for its own slug, and rebinding would re-apply its own rows as remote.
    announces.set(PUBKEY, 'someone-elses-slug');
    expect(await canonical('member-x')).toBe('ownedhive');
    expect(await canonical('ownedhive')).toBe('ownedhive');
  });

  it('fails OPEN to the local slug when no announce matches the hive pubkey', async () => {
    pollutedJoiner();
    announces.clear(); // never heard the owner's announce (cold, pre-discovery)
    expect(await canonical('joined-member')).toBe('octocat-spoon-knife');
    expect(await joinerHome('joined-member')).toBe('octocat-spoon-knife');
  });

  it('ignores an announce for a DIFFERENT hive pubkey', async () => {
    pollutedJoiner();
    announces.clear();
    announces.set(Buffer.alloc(32, 9).toString('base64'), 'unrelated-hive');
    expect(await canonical('joined-member')).toBe('octocat-spoon-knife');
  });

  it('fails OPEN when the joined view has no identity row to match a pubkey on', async () => {
    projects = [
      { slug: 'octocat-spoon-knife', remote_hive: true },
      { slug: 'joined-member', hive_slug: 'octocat-spoon-knife' },
    ];
    announces.set(PUBKEY, 'spoon-knife-pot'); // unreachable without a pubkey to match
    expect(await canonical('joined-member')).toBe('octocat-spoon-knife');
  });

  it('a non-hive harness → null (no home to canonicalize)', async () => {
    projects = [{ slug: 'loner' }];
    expect(await canonical('loner')).toBeNull();
  });

  // The hole this fix could otherwise have OPENED. The D-007 join-link seed
  // (defaultSeedOwnerBinding) writes a descriptor with a VERIFIED hivePubkey but a
  // DERIVED potId (`${repoName}-pot`), add-if-absent, so it can outlive the real
  // beacon. Trusting that guess as the demux key could rebind a joiner whose local slug
  // was already CORRECT onto a wrong one — turning a repair into a regression. Skipped
  // via `potIdSynthetic`; loadAnnouncedHiveHomeSlug enforces it (mocked out here, so
  // this asserts the CONTRACT the resolver depends on).
  it('a SYNTHETIC seed slug is never treated as the owner-authored answer', async () => {
    pollutedJoiner();
    announces.clear(); // the announce store yields nothing for a synthetic-only entry
    expect(await canonical('joined-member')).toBe('octocat-spoon-knife');
  });

  it('survives the collision case the origin fix can never reach (freeSlug suffix)', async () => {
    // A local name collision suffixed the view slug at join time — the potId was CORRECT
    // and the slugs still disagree. Only pubkey-keyed resolution fixes this.
    hives.set('spoon-knife-pot-2', {
      homeSlug: 'spoon-knife-pot-2',
      pubkeyBase64: PUBKEY,
    });
    projects = [
      { slug: 'spoon-knife-pot' }, // an unrelated LOCAL harness already owns the name
      { slug: 'spoon-knife-pot-2', remote_hive: true },
      { slug: 'joined-member', hive_slug: 'spoon-knife-pot-2' },
    ];
    announces.set(PUBKEY, 'spoon-knife-pot');
    expect(await canonical('joined-member')).toBe('spoon-knife-pot');
  });
});

// Regression: WI-3891 stamps a link-joined MEMBER clone entry harness_kind:'hive'
// + remote_hive:true + self_repo:true (so pot:get/probe:emit recognize it). That
// member must STILL resolve its declared hive_slug home — resolving to ITSELF
// bound the A-003 joiner rebind to the member slug and dropped every home-scoped
// op on the joiner (live-federation-gate content-matrix RED 2026-07-13..16:
// pot_settings/pot_members never applied; empty roster dropped member content).
describe('WI-3891-stamped member entry (harness_kind:hive + remote_hive on the MEMBER)', () => {
  async function joinerHome(slug: string) {
    const { joinerPotHomeSlug } = await import('./hive-federation');
    return joinerPotHomeSlug('ws', slug);
  }

  it('joinerPotHomeSlug resolves the declared hive_slug home, never the member itself', async () => {
    hives.set('hello-world-pot', { homeSlug: 'hello-world-pot', pubkeyBase64: PUBKEY });
    projects = [
      // The exact polluted joiner-registry shape observed live (gate run 2026-07-16):
      {
        slug: 'hello-world',
        hive_slug: 'hello-world-pot',
        harness_kind: 'hive',
        remote_hive: true,
        self_repo: true,
      },
      { slug: 'hello-world-pot', harness_kind: 'hive', remote_hive: true },
    ];
    expect(await joinerHome('hello-world')).toBe('hello-world-pot');
  });

  it('resolveHiveSwarmBinding for the stamped member joins the HOME hive topic', async () => {
    hives.set('hello-world-pot', { homeSlug: 'hello-world-pot', pubkeyBase64: PUBKEY });
    projects = [
      {
        slug: 'hello-world',
        hive_slug: 'hello-world-pot',
        harness_kind: 'hive',
        remote_hive: true,
        self_repo: true,
      },
      { slug: 'hello-world-pot', harness_kind: 'hive', remote_hive: true },
    ];
    expect(await resolve('hello-world')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });

  it('a true HOME (kind hive, no hive_slug) still resolves to itself', async () => {
    hives.set('myhive', { homeSlug: 'myhive', pubkeyBase64: PUBKEY });
    projects = [{ slug: 'myhive', harness_kind: 'hive' }];
    expect(await resolve('myhive')).toEqual({ kind: 'hive', hive_pubkey: PUBKEY });
  });
});
