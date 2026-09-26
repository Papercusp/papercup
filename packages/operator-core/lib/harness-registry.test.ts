import { describe, it, expect, vi } from 'vitest';
import {
  canonicalizeLegacyPapercup,
  hiveMemberHarnessScopes,
  resolveHarnessContentPath,
  isEphemeralForeignProject,
  ephemeralForeignHarnessSlug,
  sweepOrphanedEphemeralForeignHarnesses,
  upsertLinkJoinedEntry,
  healLinkJoinedEntries,
  type ProjectEntry,
} from './harness-registry';

/**
 * canonicalizeLegacyPapercup (WI-3168) — the store-boundary guard that keeps the
 * pre-rename `papercup` dogfood identity from surfacing as a phantom pot in the
 * harness selector. `papercup` is the repo NAME (github.com/Papercusp/papercup);
 * the product/hive slug is `papercusp`. A bare clone registers under the repo name
 * and appears alongside the real `papercusp` hive (seen on the owner dev box AND
 * the packaged Mac install). Applied on registry read + write so every existing
 * install cleans immediately and no registration path can re-persist it.
 */
describe('canonicalizeLegacyPapercup', () => {
  it('DROPS a stale papercup entry when the canonical papercusp entry exists', () => {
    const projects: ProjectEntry[] = [
      { slug: 'papercusp', path: '/repos/papercusp', harness_kind: 'hive', self_repo: true },
      { slug: 'papercup', path: '/clones/papercup' },
      { slug: 'oddsmith', path: '/clones/oddsmith' },
    ];
    const out = canonicalizeLegacyPapercup(projects);
    expect(out.map((p) => p.slug)).toEqual(['papercusp', 'oddsmith']);
    expect(out.some((p) => p.slug === 'papercup')).toBe(false);
  });

  it('DROPS a stale papercup even when papercusp is a repo-less remote hive (the Mac VM shape)', () => {
    // On a joined-member install papercusp is remote_hive (repo-less, filtered
    // from the selector); the bare papercup clone is the ONLY selectable pot,
    // which is exactly the "papercup pot" the owner reported. It must be dropped.
    const projects: ProjectEntry[] = [
      { slug: 'papercusp', path: '/remote-hives/papercusp', harness_kind: 'hive', remote_hive: true },
      { slug: 'papercup', path: '/clones/papercup' },
    ];
    const out = canonicalizeLegacyPapercup(projects);
    expect(out.map((p) => p.slug)).toEqual(['papercusp']);
  });

  it('RENAMES papercup→papercusp when no canonical entry exists (identity preserved, never lost)', () => {
    const projects: ProjectEntry[] = [{ slug: 'papercup', path: '/clones/papercup' }];
    const out = canonicalizeLegacyPapercup(projects);
    expect(out).toEqual([{ slug: 'papercusp', path: '/clones/papercup' }]);
  });

  it('is a no-op (same reference) when there is no papercup entry', () => {
    const projects: ProjectEntry[] = [
      { slug: 'papercusp', path: '/repos/papercusp', harness_kind: 'hive', self_repo: true },
      { slug: 'oddsmith', path: '/clones/oddsmith' },
    ];
    expect(canonicalizeLegacyPapercup(projects)).toBe(projects);
  });

  it('is idempotent — a second pass over the result changes nothing', () => {
    const projects: ProjectEntry[] = [
      { slug: 'papercusp', path: '/repos/papercusp', harness_kind: 'hive', self_repo: true },
      { slug: 'papercup', path: '/clones/papercup' },
    ];
    const once = canonicalizeLegacyPapercup(projects);
    const twice = canonicalizeLegacyPapercup(once);
    expect(twice).toBe(once);
    expect(once.map((p) => p.slug)).toEqual(['papercusp']);
  });
});

/**
 * hiveMemberHarnessScopes (per-hive-learning-loops-2026-06-14 P-040, D-008 — the
 * Hive is the tenancy unit). Pure mapping over the registry projects: a Hive's
 * member-harness improvement/work scopes = the home harness + every project whose
 * `hive_slug` points at it, each as a `harness:<slug>` scope. Pinned without PG.
 */
describe('hiveMemberHarnessScopes', () => {
  it('includes the home + every hive_slug member, prefixed harness:', () => {
    const projects = [
      { slug: 'my-hive', hive_slug: undefined },
      { slug: 'member-a', hive_slug: 'my-hive' },
      { slug: 'member-b', hive_slug: 'my-hive' },
      { slug: 'other-hive', hive_slug: undefined },
      { slug: 'other-member', hive_slug: 'other-hive' },
    ];
    const scopes = hiveMemberHarnessScopes(projects, 'my-hive');
    expect(scopes.sort()).toEqual(['harness:member-a', 'harness:member-b', 'harness:my-hive']);
  });

  it('returns just the home scope for a Hive with no joined members', () => {
    const scopes = hiveMemberHarnessScopes([{ slug: 'lonely-hive' }], 'lonely-hive');
    expect(scopes).toEqual(['harness:lonely-hive']);
  });

  it('includes the home scope even when the home is absent from the registry (defensive)', () => {
    // The home should always be a member of its own Hive even if its registry
    // row is missing — the feed must never silently exclude the home harness.
    const scopes = hiveMemberHarnessScopes([{ slug: 'member-a', hive_slug: 'my-hive' }], 'my-hive');
    expect(scopes.sort()).toEqual(['harness:member-a', 'harness:my-hive']);
  });

  it('de-duplicates (a project listed once, the home counted once)', () => {
    const scopes = hiveMemberHarnessScopes(
      [{ slug: 'my-hive' }, { slug: 'my-hive', hive_slug: 'my-hive' }],
      'my-hive',
    );
    expect(scopes).toEqual(['harness:my-hive']);
  });
});

/**
 * resolveHarnessContentPath — a `harness_kind:'hive'` home normally borrows its
 * MEMBER repo's checkout, EXCEPT a `self_repo` hive (papercusp) which IS its own
 * checkout and must use its own path. Regression: a stray member (hive-canary,
 * hive_slug='papercusp') was hijacking papercusp's docs/tests reads, emptying the
 * Tests tab and nulling every doc body. Pure over the registry projects.
 */
describe('resolveHarnessContentPath', () => {
  it('a self_repo hive uses its OWN path, never a stray member (papercusp/hive-canary regression)', () => {
    const reg = {
      projects: [
        { slug: 'papercusp', path: '/repos/papercusp', harness_kind: 'hive', self_repo: true },
        // a stray project that set hive_slug to the self_repo hive must NOT hijack it
        { slug: 'hive-canary', path: '/repos/hive-canary', hive_slug: 'papercusp' },
      ],
    };
    expect(resolveHarnessContentPath(reg, 'papercusp')).toBe('/repos/papercusp');
  });

  it('a repo-less hive home borrows its member checkout', () => {
    const reg = {
      projects: [
        { slug: 'coding-hive', path: '/state/coding-hive', harness_kind: 'hive' },
        { slug: 'member', path: '/repos/member', hive_slug: 'coding-hive' },
      ],
    };
    expect(resolveHarnessContentPath(reg, 'coding-hive')).toBe('/repos/member');
  });

  it('a self_repo hive with no member still uses its own path', () => {
    const reg = {
      projects: [
        { slug: 'papercusp', path: '/repos/papercusp', harness_kind: 'hive', self_repo: true },
      ],
    };
    expect(resolveHarnessContentPath(reg, 'papercusp')).toBe('/repos/papercusp');
  });

  it('a plain (non-hive) harness uses its own path', () => {
    const reg = { projects: [{ slug: 'oddsmith', path: '/repos/oddsmith' }] };
    expect(resolveHarnessContentPath(reg, 'oddsmith')).toBe('/repos/oddsmith');
  });

  it('returns undefined for an unregistered slug', () => {
    expect(resolveHarnessContentPath({ projects: [] }, 'nope')).toBeUndefined();
  });
});

/**
 * WI-1937 D-001 option B: ephemeral P-104 foreign-clone registry rows. Pure
 * helper coverage + the orchestration of the orphan sweep (leader-required
 * test (c) — deps injected so this stays unit-testable without PG, mirroring
 * `checkLive`'s existing injection).
 */
describe('isEphemeralForeignProject / ephemeralForeignHarnessSlug', () => {
  it('isEphemeralForeignProject is true only for a row with ephemeral_foreign:true', () => {
    expect(isEphemeralForeignProject({ ephemeral_foreign: true })).toBe(true);
    expect(isEphemeralForeignProject({ ephemeral_foreign: false })).toBe(false);
    expect(isEphemeralForeignProject({})).toBe(false);
  });

  it('ephemeralForeignHarnessSlug derives a stable, offer-scoped slug', () => {
    expect(ephemeralForeignHarnessSlug('offer-42')).toBe('foreign-offer-42');
    // one row per offer — the slug IS the per-offer claim (registry slug uniqueness).
    expect(ephemeralForeignHarnessSlug('offer-42')).toBe(ephemeralForeignHarnessSlug('offer-42'));
    expect(ephemeralForeignHarnessSlug('offer-99')).not.toBe(ephemeralForeignHarnessSlug('offer-42'));
  });
});

describe('sweepOrphanedEphemeralForeignHarnesses (WI-1937 leader-required test (c): catches a simulated leak)', () => {
  const ephemeralRow = (offerId: string): ProjectEntry => ({
    slug: ephemeralForeignHarnessSlug(offerId),
    path: `/tmp/foreign/${offerId}/repo`,
    ephemeral_foreign: true,
    foreign_offer_id: offerId,
  });

  it('removes a row whose p2p_foreign_workspaces record is GONE (checkLive → null)', async () => {
    const loadRegistry = vi.fn(async () => ({ projects: [ephemeralRow('offer-1')] }) as never);
    const deregister = vi.fn(async () => true);
    const checkLive = vi.fn(async () => null);
    const res = await sweepOrphanedEphemeralForeignHarnesses(undefined, checkLive, { loadRegistry, deregister });
    expect(res).toEqual({ swept: 1, removed: ['offer-1'] });
    expect(deregister).toHaveBeenCalledWith('offer-1', undefined);
  });

  it('removes a row whose p2p_foreign_workspaces record is already REAPED', async () => {
    const loadRegistry = vi.fn(async () => ({ projects: [ephemeralRow('offer-2')] }) as never);
    const deregister = vi.fn(async () => true);
    const checkLive = vi.fn(async () => ({ state: 'reaped' }));
    const res = await sweepOrphanedEphemeralForeignHarnesses(undefined, checkLive, { loadRegistry, deregister });
    expect(res).toEqual({ swept: 1, removed: ['offer-2'] });
  });

  it('leaves a LIVE (active/provisioning) row alone — not every ephemeral row is a leak', async () => {
    const loadRegistry = vi.fn(async () => ({ projects: [ephemeralRow('offer-3')] }) as never);
    const deregister = vi.fn(async () => true);
    const checkLive = vi.fn(async () => ({ state: 'active' }));
    const res = await sweepOrphanedEphemeralForeignHarnesses(undefined, checkLive, { loadRegistry, deregister });
    expect(res).toEqual({ swept: 1, removed: [] });
    expect(deregister).not.toHaveBeenCalled();
  });

  it('skips a malformed row with no foreign_offer_id rather than guessing', async () => {
    const malformed: ProjectEntry = { slug: 'foreign-mystery', path: '/tmp/x', ephemeral_foreign: true };
    const loadRegistry = vi.fn(async () => ({ projects: [malformed] }) as never);
    const deregister = vi.fn(async () => true);
    const checkLive = vi.fn(async () => null);
    const res = await sweepOrphanedEphemeralForeignHarnesses(undefined, checkLive, { loadRegistry, deregister });
    expect(res).toEqual({ swept: 1, removed: [] });
    expect(deregister).not.toHaveBeenCalled();
  });

  it('ignores non-ephemeral rows entirely', async () => {
    const loadRegistry = vi.fn(async () => ({ projects: [{ slug: 'real-harness', path: '/repos/real' }] }) as never);
    const deregister = vi.fn(async () => true);
    const checkLive = vi.fn(async () => null);
    const res = await sweepOrphanedEphemeralForeignHarnesses(undefined, checkLive, { loadRegistry, deregister });
    expect(res).toEqual({ swept: 0, removed: [] });
    expect(checkLive).not.toHaveBeenCalled();
  });
});

/**
 * upsertLinkJoinedEntry / healLinkJoinedEntries (WI-10003277) — the one shape for
 * an invite-link-joined checkout. The P-202 rig carried the short pre-boot row
 * (joined_via_link + github coords, no hive stamp) and never counted its hive as
 * shared, so its seat offers were skipped hive_not_shared.
 */
describe('upsertLinkJoinedEntry / healLinkJoinedEntries', () => {
  const FULL = {
    slug: 'papercusp',
    path: '/clones/papercup',
    github_remote: 'https://github.com/Papercusp/papercup',
    github_repository_id: 12345,
    joined_via_link: true,
    harness_kind: 'hive',
    remote_hive: true,
    self_repo: true,
  };
  const UPSTREAM = { github: 'Papercusp/papercup', repoId: 12345 };

  it('inserts the full link-joined shape', () => {
    const next = upsertLinkJoinedEntry({ projects: [] }, { slug: 'papercusp', path: '/clones/papercup', ...UPSTREAM });
    expect(next.projects).toEqual([FULL]);
  });

  it('completes the short pre-boot row in place (the rig shape) — no duplicate', () => {
    const short = {
      slug: 'papercusp',
      path: '/clones/papercup',
      github_remote: 'https://github.com/Papercusp/papercup',
      github_repository_id: 12345,
      joined_via_link: true,
    };
    const next = upsertLinkJoinedEntry({ projects: [short] }, { slug: 'papercusp', path: '/clones/papercup', ...UPSTREAM });
    expect(next.projects).toEqual([FULL]);
  });

  it('returns the same registry when the entry is already complete', () => {
    const reg = { projects: [FULL] };
    expect(upsertLinkJoinedEntry(reg, { slug: 'papercusp', path: '/clones/papercup', ...UPSTREAM })).toBe(reg);
  });

  it('control: leaves a same-slug entry for a DIFFERENT, non-link checkout alone', () => {
    const owned: ProjectEntry = { slug: 'papercusp', path: '/home/me/papercusp' };
    const reg = { projects: [owned] };
    expect(upsertLinkJoinedEntry(reg, { slug: 'papercusp', path: '/clones/papercup', ...UPSTREAM })).toBe(reg);
  });

  it('never overwrites divergent existing coords', () => {
    const divergent = { ...FULL, github_remote: 'https://github.com/someone/else', github_repository_id: 777, harness_kind: undefined };
    const next = upsertLinkJoinedEntry({ projects: [divergent] }, { slug: 'papercusp', path: '/clones/papercup', ...UPSTREAM });
    expect(next.projects[0]).toEqual({ ...divergent, harness_kind: 'hive' });
  });

  it('heal completes only joined_via_link rows and names them', () => {
    const short = { slug: 'papercusp', path: '/clones/papercup', joined_via_link: true };
    const owned: ProjectEntry = { slug: 'mine', path: '/r/mine' };
    const { registry, healed } = healLinkJoinedEntries({ projects: [short, owned] });
    expect(healed).toEqual(['papercusp']);
    expect(registry.projects).toEqual([
      { ...short, harness_kind: 'hive', remote_hive: true, self_repo: true },
      owned,
    ]);
  });

  it('heal returns the same registry when nothing is short', () => {
    const reg = { projects: [FULL, { slug: 'mine', path: '/r/mine' }] };
    const { registry, healed } = healLinkJoinedEntries(reg);
    expect(healed).toEqual([]);
    expect(registry).toBe(reg);
  });
});
