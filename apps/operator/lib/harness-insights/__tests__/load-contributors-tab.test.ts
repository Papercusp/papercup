import { describe, expect, it } from 'vitest';
import {
  loadContributorsTab,
  bindingStatusFromAttestations,
  compareContributors,
  type ContributorTabRow,
} from '../load-contributors-tab';

// A runQuery that dispatches on the table named in the SQL.
function makeRunQuery(data: {
  contributors: unknown[];
  prs?: Array<{ github_user_id: number; n: number }>;
  shipped?: Array<{ github_user_id: number; n: number }>;
  activity?: Array<{ github_user_id: number; n: number }>;
}) {
  return async <T = unknown>(query: string): Promise<T[]> => {
    if (/FROM harness_shared\.contributors\b/.test(query)) return data.contributors as T[];
    if (/auto_review_audit/.test(query)) return (data.prs ?? []) as T[];
    if (/harness_features_consolidated/.test(query)) return (data.shipped ?? []) as T[];
    if (/contributor_usage_events/.test(query)) return (data.activity ?? []) as T[];
    return [] as T[];
  };
}

const verifiedAtt = [{ verified: true }];
const pendingAtt = [{ verified: false }];

describe('bindingStatusFromAttestations', () => {
  it('verified when any device is verified', () => {
    expect(bindingStatusFromAttestations([{ verified: false }, { verified: true }])).toBe('verified');
  });
  it('pending when present-but-none-verified', () => {
    expect(bindingStatusFromAttestations(pendingAtt)).toBe('pending');
  });
  it('unverified when empty / not an array', () => {
    expect(bindingStatusFromAttestations([])).toBe('unverified');
    expect(bindingStatusFromAttestations(null)).toBe('unverified');
    expect(bindingStatusFromAttestations('x')).toBe('unverified');
  });
});

describe('loadContributorsTab', () => {
  it('enriches verified contributors with tier counts + device count + joined epoch', async () => {
    const rows = await loadContributorsTab({
      workspace_id: 'ws',
      harness_slug: 'h',
      runQuery: makeRunQuery({
        contributors: [
          {
            github_user_id: 42,
            github_username: 'alice',
            display_name: 'Alice',
            avatar_url: 'a.png',
            joined_at: 1700000000000,
            device_attestations: verifiedAtt,
          },
        ],
        prs: [{ github_user_id: 42, n: 3 }],
        shipped: [{ github_user_id: 42, n: 5 }],
        activity: [{ github_user_id: 42, n: 9 }],
      }),
    });
    expect(rows).toEqual([
      {
        github_user_id: 42,
        login: 'alice',
        display_name: 'Alice',
        avatar_url: 'a.png',
        binding_status: 'verified',
        joined_at: 1700000000000,
        device_count: 1,
        prs_merged: 3,
        features_shipped: 5,
        activity_events: 9,
      } satisfies ContributorTabRow,
    ]);
  });

  it('ZEROES tier stats for unverified + pending bindings (P-048d), but keeps identity fields', async () => {
    const rows = await loadContributorsTab({
      workspace_id: 'ws',
      harness_slug: 'h',
      runQuery: makeRunQuery({
        contributors: [
          { github_user_id: 7, github_username: 'bob', display_name: null, avatar_url: null, joined_at: 1, device_attestations: pendingAtt },
          { github_user_id: 8, github_username: 'cara', display_name: null, avatar_url: null, joined_at: 2, device_attestations: [] },
        ],
        prs: [{ github_user_id: 7, n: 4 }, { github_user_id: 8, n: 2 }],
        shipped: [{ github_user_id: 7, n: 1 }],
        activity: [{ github_user_id: 8, n: 6 }],
      }),
    });
    const bob = rows.find((r) => r.github_user_id === 7)!;
    const cara = rows.find((r) => r.github_user_id === 8)!;
    expect(bob.binding_status).toBe('pending');
    expect([bob.prs_merged, bob.features_shipped, bob.activity_events]).toEqual([0, 0, 0]);
    expect(cara.binding_status).toBe('unverified');
    expect([cara.prs_merged, cara.features_shipped, cara.activity_events]).toEqual([0, 0, 0]);
  });

  it('returns [] when there are no contributors', async () => {
    const rows = await loadContributorsTab({
      workspace_id: 'ws',
      harness_slug: 'h',
      runQuery: makeRunQuery({ contributors: [] }),
    });
    expect(rows).toEqual([]);
  });
});

describe('compareContributors', () => {
  const mk = (login: string, joined: number, prs: number, feats: number, act: number): ContributorTabRow => ({
    github_user_id: 1,
    login,
    display_name: null,
    avatar_url: null,
    binding_status: 'verified',
    joined_at: joined,
    device_count: 0,
    prs_merged: prs,
    features_shipped: feats,
    activity_events: act,
  });

  it('joined → newest first', () => {
    expect(compareContributors(mk('a', 1, 0, 0, 0), mk('b', 2, 0, 0, 0), 'joined')).toBeGreaterThan(0);
  });
  it('prs/features/activity → highest first', () => {
    expect(compareContributors(mk('a', 0, 9, 0, 0), mk('b', 0, 1, 0, 0), 'prs')).toBeLessThan(0);
    expect(compareContributors(mk('a', 0, 0, 9, 0), mk('b', 0, 0, 1, 0), 'features')).toBeLessThan(0);
    expect(compareContributors(mk('a', 0, 0, 0, 9), mk('b', 0, 0, 0, 1), 'activity')).toBeLessThan(0);
  });
  it('ties break by login (stable)', () => {
    expect(compareContributors(mk('alice', 5, 2, 2, 2), mk('bob', 5, 2, 2, 2), 'prs')).toBeLessThan(0);
  });
});
