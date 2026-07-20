/**
 * Unit tests for the write-time Pot-membership resolver (pot-membership-enforcement
 * -2026-07-20, P-005). Pure over an injected {@link PotLookup} — no PG.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveWorkItemPot,
  isWorkspaceGlobalLabel,
  canonicalPotSlug,
  PotMembershipError,
  PLATFORM_POT_SLUG,
  type PotLookup,
} from './pot-membership';

/** A lookup whose real Pots are `realPots` and whose platform Pot is `platform` (or null). */
function fakeLookup(opts: { realPots?: string[]; platform?: string | null }): PotLookup {
  const real = new Set(opts.realPots ?? []);
  return {
    async resolveRealPot(rawSlug) {
      const canon = canonicalPotSlug(rawSlug.trim());
      return real.has(canon) ? canon : null;
    },
    async platformPot() {
      return opts.platform ?? null;
    },
  };
}

const WS = 'papercusp-workspace';
const potted = { realPots: ['papercusp', 'oddsmith-hive'], platform: PLATFORM_POT_SLUG };

describe('isWorkspaceGlobalLabel', () => {
  it('treats null / blank / operator scopes as workspace-global', () => {
    expect(isWorkspaceGlobalLabel(null, WS)).toBe(true);
    expect(isWorkspaceGlobalLabel(undefined, WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('   ', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('operator', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('operator:papercusp-workspace', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('*', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('@singleton', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('all', WS)).toBe(true);
    expect(isWorkspaceGlobalLabel('hive-canary', WS)).toBe(true);
  });
  it('treats the bare workspace id as a non-Pot partition label', () => {
    expect(isWorkspaceGlobalLabel('papercusp-workspace', WS)).toBe(true);
  });
  it('treats a concrete Pot slug as NOT workspace-global', () => {
    expect(isWorkspaceGlobalLabel('papercusp', WS)).toBe(false);
    expect(isWorkspaceGlobalLabel('oddsmith-hive', WS)).toBe(false);
  });
});

describe('canonicalPotSlug', () => {
  it('folds the legacy dogfood repo name to the platform Pot', () => {
    expect(canonicalPotSlug('papercup')).toBe('papercusp');
    expect(canonicalPotSlug('papercup-hive')).toBe('papercusp');
  });
  it('leaves any other slug unchanged', () => {
    expect(canonicalPotSlug('oddsmith-hive')).toBe('oddsmith-hive');
    expect(canonicalPotSlug('papercusp')).toBe('papercusp');
  });
});

describe('resolveWorkItemPot', () => {
  it('(1) keeps an explicit slug that is a real Pot', async () => {
    const got = await resolveWorkItemPot({ rawSlug: 'oddsmith-hive', workspaceId: WS, lookup: fakeLookup(potted) });
    expect(got).toBe('oddsmith-hive');
  });

  it('(1) canonicalizes a legacy dogfood slug to the platform Pot', async () => {
    const got = await resolveWorkItemPot({ rawSlug: 'papercup', workspaceId: WS, lookup: fakeLookup(potted) });
    expect(got).toBe('papercusp');
  });

  it('(2) homes an operator/global scope to the platform Pot', async () => {
    for (const raw of [null, undefined, '', 'operator', 'operator:papercusp-workspace', '*', 'papercusp-workspace']) {
      const got = await resolveWorkItemPot({ rawSlug: raw, workspaceId: WS, lookup: fakeLookup(potted) });
      expect(got).toBe('papercusp');
    }
  });

  it('(3) REJECTS an explicit, non-global slug that is not a real Pot', async () => {
    await expect(
      resolveWorkItemPot({ rawSlug: 'made-up-pot', workspaceId: WS, lookup: fakeLookup(potted) }),
    ).rejects.toBeInstanceOf(PotMembershipError);
  });

  it('(3) the reject error carries the raw slug + workspace', async () => {
    const err = await resolveWorkItemPot({
      rawSlug: 'made-up-pot',
      workspaceId: WS,
      lookup: fakeLookup(potted),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PotMembershipError);
    expect((err as PotMembershipError).code).toBe('pot_not_found');
    expect((err as PotMembershipError).rawSlug).toBe('made-up-pot');
    expect((err as PotMembershipError).workspaceId).toBe(WS);
  });

  it('(4) FAILS OPEN for a workspace with no platform Pot — keeps a made-up explicit slug', async () => {
    const got = await resolveWorkItemPot({
      rawSlug: 'test-harness',
      workspaceId: 'generic-test',
      lookup: fakeLookup({ realPots: ['some-fixture-hive'], platform: null }),
    });
    expect(got).toBe('test-harness');
  });

  it('(4) FAILS OPEN for a workspace with no platform Pot — keeps operator scope (null)', async () => {
    const got = await resolveWorkItemPot({
      rawSlug: null,
      workspaceId: 'generic-test',
      lookup: fakeLookup({ realPots: [], platform: null }),
    });
    expect(got).toBeNull();
  });

  it('does not enforce for an unscoped (*) SU workspace — returns the raw slug', async () => {
    // lookup should never be consulted; pass one that would throw if it were.
    const explodeLookup: PotLookup = {
      resolveRealPot: async () => {
        throw new Error('should not be called for unscoped SU');
      },
      platformPot: async () => {
        throw new Error('should not be called for unscoped SU');
      },
    };
    expect(await resolveWorkItemPot({ rawSlug: 'anything', workspaceId: '*', lookup: explodeLookup })).toBe('anything');
    expect(await resolveWorkItemPot({ rawSlug: null, workspaceId: '*', lookup: explodeLookup })).toBeNull();
  });

  it('resolves a real Pot even when the workspace also has a platform Pot (no false reject)', async () => {
    const got = await resolveWorkItemPot({ rawSlug: 'oddsmith-hive', workspaceId: WS, lookup: fakeLookup(potted) });
    expect(got).toBe('oddsmith-hive');
  });
});
