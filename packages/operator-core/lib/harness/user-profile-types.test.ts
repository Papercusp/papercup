import { describe, expect, it } from 'vitest';
import {
  USER_PROFILE_ACTIVITY_DEFAULT_LIMIT,
  USER_PROFILE_CANONICAL_PATH_PREFIX,
  USER_PROFILE_LEGACY_PATH_PREFIX,
  buildRecentActivity,
  filterHarnessBlocksForViewer,
  gateBlocksTierCForViewer,
  isHarnessBlockVisibleToViewer,
  parseUserProfilePath,
  shouldRenderTierCForHarnessBlock,
  shouldShowUnverifiedBanner,
  userProfileLegacyPath,
  userProfilePath,
  type UserProfileActivityEntry,
  type UserProfileHarnessBlock,
} from './user-profile-types';

function makeBlock(over: Partial<UserProfileHarnessBlock> = {}): UserProfileHarnessBlock {
  return {
    harness_slug: 'papercup',
    harness_title: 'Papercup',
    harness_state: 'shared-public',
    tier_a_stats: [],
    tier_b_stats: [],
    tier_c_stats: [{ value: 5, tier: 'C' }],
    ...over,
  };
}

describe('constants', () => {
  it('USER_PROFILE_CANONICAL_PATH_PREFIX is /users/github/', () => {
    expect(USER_PROFILE_CANONICAL_PATH_PREFIX).toBe('/users/github/');
  });

  it('USER_PROFILE_LEGACY_PATH_PREFIX is /users/', () => {
    expect(USER_PROFILE_LEGACY_PATH_PREFIX).toBe('/users/');
  });

  it('USER_PROFILE_ACTIVITY_DEFAULT_LIMIT is 30 per §18', () => {
    expect(USER_PROFILE_ACTIVITY_DEFAULT_LIMIT).toBe(30);
  });
});

describe('userProfilePath', () => {
  it('builds /users/github/<id>', () => {
    expect(userProfilePath(12345)).toBe('/users/github/12345');
  });

  it('rejects non-positive or non-integer id', () => {
    expect(() => userProfilePath(0)).toThrow(TypeError);
    expect(() => userProfilePath(-1)).toThrow(TypeError);
    expect(() => userProfilePath(1.5)).toThrow(TypeError);
  });
});

describe('userProfileLegacyPath', () => {
  it('builds /users/<login>', () => {
    expect(userProfileLegacyPath('alice')).toBe('/users/alice');
  });

  it('rejects empty login', () => {
    expect(() => userProfileLegacyPath('')).toThrow(TypeError);
  });
});

describe('parseUserProfilePath', () => {
  it('parses canonical /users/github/<id>', () => {
    expect(parseUserProfilePath('/users/github/12345')).toBe(12345);
  });

  it('returns null for legacy /users/<login> form', () => {
    expect(parseUserProfilePath('/users/alice')).toBeNull();
  });

  it('returns null for malformed', () => {
    expect(parseUserProfilePath('/users/github/')).toBeNull();
    expect(parseUserProfilePath('/users/github/abc')).toBeNull();
    expect(parseUserProfilePath('/users/github/-1')).toBeNull();
    expect(parseUserProfilePath('/users/github/12345/extra')).toBeNull();
    expect(parseUserProfilePath('')).toBeNull();
  });

  it('rejects non-string', () => {
    // @ts-expect-error
    expect(parseUserProfilePath(null)).toBeNull();
  });

  it('round-trips with userProfilePath', () => {
    expect(parseUserProfilePath(userProfilePath(99999))).toBe(99999);
  });
});

describe('isHarnessBlockVisibleToViewer', () => {
  it('private NEVER visible', () => {
    expect(
      isHarnessBlockVisibleToViewer({ harness_state: 'private', viewer_is_member: true }),
    ).toBe(false);
    expect(
      isHarnessBlockVisibleToViewer({ harness_state: 'private', viewer_is_member: false }),
    ).toBe(false);
  });

  it('shared-public always visible', () => {
    expect(
      isHarnessBlockVisibleToViewer({ harness_state: 'shared-public', viewer_is_member: false }),
    ).toBe(true);
  });

  it('shared-private only when viewer is member', () => {
    expect(
      isHarnessBlockVisibleToViewer({ harness_state: 'shared-private', viewer_is_member: true }),
    ).toBe(true);
    expect(
      isHarnessBlockVisibleToViewer({ harness_state: 'shared-private', viewer_is_member: false }),
    ).toBe(false);
  });
});

describe('shouldRenderTierCForHarnessBlock', () => {
  it('false when block not visible', () => {
    expect(
      shouldRenderTierCForHarnessBlock({ harness_state: 'private', viewer_is_member: true }),
    ).toBe(false);
  });

  it('false for shared-public when viewer not member (no overlap)', () => {
    expect(
      shouldRenderTierCForHarnessBlock({
        harness_state: 'shared-public',
        viewer_is_member: false,
      }),
    ).toBe(false);
  });

  it('true for shared-public when viewer is member', () => {
    expect(
      shouldRenderTierCForHarnessBlock({
        harness_state: 'shared-public',
        viewer_is_member: true,
      }),
    ).toBe(true);
  });

  it('true for shared-private when viewer is member', () => {
    expect(
      shouldRenderTierCForHarnessBlock({
        harness_state: 'shared-private',
        viewer_is_member: true,
      }),
    ).toBe(true);
  });
});

describe('filterHarnessBlocksForViewer', () => {
  it('drops private + non-member shared-private; keeps shared-public + member shared-private', () => {
    const blocks = [
      makeBlock({ harness_slug: 'a', harness_state: 'private' }),
      makeBlock({ harness_slug: 'b', harness_state: 'shared-private' }), // viewer not member
      makeBlock({ harness_slug: 'c', harness_state: 'shared-private' }), // viewer is member
      makeBlock({ harness_slug: 'd', harness_state: 'shared-public' }),
    ];
    const memberships = new Set(['c']);
    const filtered = filterHarnessBlocksForViewer(blocks, memberships);
    expect(filtered.map((b) => b.harness_slug)).toEqual(['c', 'd']);
  });

  it('returns empty when nothing visible', () => {
    const blocks = [makeBlock({ harness_state: 'private' })];
    expect(filterHarnessBlocksForViewer(blocks, new Set())).toEqual([]);
  });
});

describe('gateBlocksTierCForViewer', () => {
  it('nulls tier_c_stats on shared-public when viewer not member', () => {
    const blocks = [makeBlock({ harness_state: 'shared-public' })];
    const out = gateBlocksTierCForViewer(blocks, new Set());
    expect(out[0]!.tier_c_stats).toBeNull();
  });

  it('keeps tier_c_stats when viewer is member', () => {
    const blocks = [makeBlock({ harness_state: 'shared-private', harness_slug: 'x' })];
    const out = gateBlocksTierCForViewer(blocks, new Set(['x']));
    expect(out[0]!.tier_c_stats).not.toBeNull();
  });

  it('does not mutate input', () => {
    const blocks = [makeBlock({ harness_state: 'shared-public' })];
    gateBlocksTierCForViewer(blocks, new Set());
    expect(blocks[0]!.tier_c_stats).not.toBeNull();
  });
});

describe('buildRecentActivity', () => {
  function makeEntry(over: Partial<UserProfileActivityEntry> = {}): UserProfileActivityEntry {
    return {
      ts: 100,
      harness_slug: 'x',
      label: 'x',
      detail_url: '/x',
      tier: 'A',
      ...over,
    };
  }

  it('sorts newest-first', () => {
    const out = buildRecentActivity([
      makeEntry({ ts: 100, label: 'old' }),
      makeEntry({ ts: 300, label: 'new' }),
      makeEntry({ ts: 200, label: 'mid' }),
    ]);
    expect(out.map((e) => e.label)).toEqual(['new', 'mid', 'old']);
  });

  it('respects default 30 limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => makeEntry({ ts: i }));
    expect(buildRecentActivity(many).length).toBe(30);
  });

  it('respects custom limit', () => {
    expect(buildRecentActivity([makeEntry(), makeEntry({ ts: 200 })], 1).length).toBe(1);
  });

  it('clamps negative limit to 0', () => {
    expect(buildRecentActivity([makeEntry()], -1)).toEqual([]);
  });

  it('empty input → empty output', () => {
    expect(buildRecentActivity([])).toEqual([]);
  });
});

describe('shouldShowUnverifiedBanner', () => {
  it('false for verified', () => {
    expect(shouldShowUnverifiedBanner('verified')).toBe(false);
  });

  it('true for pending + unverified', () => {
    expect(shouldShowUnverifiedBanner('pending')).toBe(true);
    expect(shouldShowUnverifiedBanner('unverified')).toBe(true);
  });
});
