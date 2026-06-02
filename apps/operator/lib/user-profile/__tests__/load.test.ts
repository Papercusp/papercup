/**
 * loadUserProfile tests.
 *
 * Fakes `runQuery` so no PG is touched. Verifies:
 *   - empty PG → empty profile (defensive)
 *   - contributor rows assemble correctly
 *   - features-shipped joins by harness_slug
 *   - claimed_harnesses pulled from binding cache
 *   - privacy filter drops shared-private rows the viewer isn't in
 *   - missing-table errors don't propagate
 */

import { describe, expect, it, vi } from 'vitest';
import { loadUserProfile } from '../load';

interface QueryStub {
  match: RegExp;
  rows: unknown[] | (() => unknown[]) | (() => never);
}

type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

function makeRunQuery(stubs: QueryStub[]): RunQuery {
  const fn = vi.fn(async (query: string): Promise<unknown[]> => {
    for (const s of stubs) {
      if (s.match.test(query)) {
        const result = typeof s.rows === 'function' ? s.rows() : s.rows;
        return result;
      }
    }
    return [];
  });
  return fn as unknown as RunQuery;
}

describe('loadUserProfile', () => {
  it('returns empty profile when no contributor rows', async () => {
    const profile = await loadUserProfile({
      github_user_id: 42,
      runQuery: makeRunQuery([{ match: /FROM harness_shared\.contributors/, rows: [] }]),
    });
    expect(profile.github_user_id).toBe(42);
    expect(profile.github_login).toBe('user-42');
    expect(profile.binding_status).toBe('unverified');
    expect(profile.harnesses).toEqual([]);
    expect(profile.claimed_harnesses).toEqual([]);
  });

  it('returns empty profile when contributors table throws (missing table)', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('relation does not exist');
    });
    const profile = await loadUserProfile({
      github_user_id: 42,
      runQuery,
    });
    expect(profile.harnesses).toEqual([]);
    expect(profile.binding_status).toBe('unverified');
  });

  it('assembles header + per-harness rows from contributor rows', async () => {
    const profile = await loadUserProfile({
      github_user_id: 42,
      runQuery: makeRunQuery([
        {
          match: /FROM harness_shared\.contributors\b[\s\S]*WHERE github_user_id = \$1\b/,
          rows: [
            {
              workspace_id: 'ws-1',
              harness_slug: 'papercup',
              github_user_id: 42,
              github_username: 'alice',
              display_name: 'Alice Anderson',
              avatar_url: 'https://x/a.png',
              device_attestations: [{ verified: true }],
              joined_at: '2026-01-01',
            },
          ],
        },
        {
          match: /FROM harness_shared\.shared_repo_binding_cache\b[\s\S]*WHERE workspace_id/,
          rows: [
            {
              harness_slug: 'papercup',
              claim_status: 'claimed',
              privacy: 'shared-public',
            },
          ],
        },
        {
          match: /harness_features_consolidated/,
          rows: [{ harness_slug: 'papercup', features_shipped: '3' }],
        },
      ]),
    });
    expect(profile.github_login).toBe('alice');
    expect(profile.display_name).toBe('Alice Anderson');
    expect(profile.avatar_url).toBe('https://x/a.png');
    expect(profile.binding_status).toBe('verified');
    expect(profile.harnesses).toEqual([
      {
        harness_slug: 'papercup',
        display_title: 'papercup',
        href: '/harness/papercup',
        prs_merged: 0,
        features_shipped: 3,
        activity_events: 0,
      },
    ]);
  });

  it('picks pending binding when only unverified attestations exist', async () => {
    const profile = await loadUserProfile({
      github_user_id: 42,
      runQuery: makeRunQuery([
        {
          match: /FROM harness_shared\.contributors\b[\s\S]*WHERE github_user_id = \$1\b/,
          rows: [
            {
              workspace_id: 'ws-1',
              harness_slug: 'papercup',
              github_user_id: 42,
              github_username: 'alice',
              display_name: null,
              avatar_url: null,
              device_attestations: [{ verified: false }],
              joined_at: '2026-01-01',
            },
          ],
        },
      ]),
    });
    expect(profile.binding_status).toBe('pending');
  });

  it('drops shared-private rows the anonymous viewer is not in', async () => {
    const profile = await loadUserProfile({
      github_user_id: 42,
      runQuery: makeRunQuery([
        {
          match: /FROM harness_shared\.contributors\b[\s\S]*WHERE github_user_id = \$1\b/,
          rows: [
            {
              workspace_id: 'ws-1',
              harness_slug: 'public-one',
              github_user_id: 42,
              github_username: 'alice',
              display_name: null,
              avatar_url: null,
              device_attestations: [{ verified: true }],
              joined_at: '2026-01-01',
            },
            {
              workspace_id: 'ws-1',
              harness_slug: 'secret-one',
              github_user_id: 42,
              github_username: 'alice',
              display_name: null,
              avatar_url: null,
              device_attestations: [{ verified: true }],
              joined_at: '2026-01-02',
            },
          ],
        },
        {
          match: /FROM harness_shared\.shared_repo_binding_cache\b[\s\S]*WHERE workspace_id/,
          rows: [
            {
              harness_slug: 'public-one',
              claim_status: 'claimed',
              privacy: 'shared-public',
            },
            {
              harness_slug: 'secret-one',
              claim_status: 'claimed',
              privacy: 'shared-private',
            },
          ],
        },
      ]),
    });
    expect(profile.harnesses.map((h) => h.harness_slug)).toEqual(['public-one']);
  });

  it('keeps shared-private rows when viewer is the target user', async () => {
    const profile = await loadUserProfile({
      github_user_id: 42,
      viewer_github_user_id: 42,
      runQuery: makeRunQuery([
        {
          match: /FROM harness_shared\.contributors\b[\s\S]*WHERE github_user_id = \$1\b/,
          rows: [
            {
              workspace_id: 'ws-1',
              harness_slug: 'secret-one',
              github_user_id: 42,
              github_username: 'alice',
              display_name: null,
              avatar_url: null,
              device_attestations: [{ verified: true }],
              joined_at: '2026-01-02',
            },
          ],
        },
        {
          match: /FROM harness_shared\.shared_repo_binding_cache\b[\s\S]*WHERE workspace_id/,
          rows: [
            {
              harness_slug: 'secret-one',
              claim_status: 'claimed',
              privacy: 'shared-private',
            },
          ],
        },
      ]),
    });
    expect(profile.harnesses.map((h) => h.harness_slug)).toEqual(['secret-one']);
  });

  it('keeps shared-private rows when viewer is a member of the harness', async () => {
    let viewerQueryCount = 0;
    const runQuery = vi.fn(async (query: string, params: unknown[]) => {
      if (/FROM harness_shared\.contributors\b[\s\S]*WHERE github_user_id = \$1\b/.test(query)) {
        if (params[0] === 42) {
          return [
            {
              workspace_id: 'ws-1',
              harness_slug: 'team-only',
              github_user_id: 42,
              github_username: 'alice',
              display_name: null,
              avatar_url: null,
              device_attestations: [{ verified: true }],
              joined_at: '2026-01-01',
            },
          ];
        }
        // viewer's membership query
        viewerQueryCount += 1;
        return [{ harness_slug: 'team-only' }];
      }
      if (/shared_repo_binding_cache\b[\s\S]*WHERE workspace_id/.test(query)) {
        return [
          { harness_slug: 'team-only', claim_status: 'unclaimed', privacy: 'shared-private' },
        ];
      }
      return [];
    });
    const profile = await loadUserProfile({
      github_user_id: 42,
      viewer_github_user_id: 99,
      runQuery: runQuery as unknown as RunQuery,
    });
    expect(viewerQueryCount).toBe(1);
    expect(profile.harnesses.map((h) => h.harness_slug)).toEqual(['team-only']);
  });

  it('collects only verified-claimant (claimed) harnesses for the footer', async () => {
    // §5.1: a verified claimant holds an active GitHub repo permission —
    // i.e. claim_status='claimed'. `stale` means the claimants LOST that
    // permission, so a stale row is NOT a verified claimant and must be
    // omitted from the profile footer.
    const profile = await loadUserProfile({
      github_user_id: 42,
      runQuery: makeRunQuery([
        {
          match: /FROM harness_shared\.contributors\b[\s\S]*WHERE github_user_id = \$1\b/,
          rows: [
            {
              workspace_id: 'ws-1',
              harness_slug: 'a',
              github_user_id: 42,
              github_username: 'alice',
              display_name: null,
              avatar_url: null,
              device_attestations: [],
              joined_at: '2026-01-01',
            },
          ],
        },
        {
          match: /shared_repo_binding_cache\b[\s\S]*claim_status = 'claimed'/,
          rows: [{ harness_slug: 'a', claim_status: 'claimed' }],
        },
      ]),
    });
    expect(profile.claimed_harnesses).toEqual([
      {
        harness_slug: 'a',
        display_title: 'a',
        href: '/harness/a',
        claim_status: 'claimed',
      },
    ]);
  });

  it('computes per-harness prs_merged (tier-A) and activity_events (tier-C)', async () => {
    const profile = await loadUserProfile({
      github_user_id: 42,
      runQuery: makeRunQuery([
        {
          match: /FROM harness_shared\.contributors\b[\s\S]*WHERE github_user_id = \$1\b/,
          rows: [
            {
              workspace_id: 'ws-1',
              harness_slug: 'sheets',
              github_user_id: 42,
              github_username: 'alice',
              display_name: 'Alice',
              avatar_url: null,
              device_attestations: [{ verified: true }],
              joined_at: '2026-01-01',
            },
          ],
        },
        {
          match: /harness_features_consolidated/,
          rows: [{ harness_slug: 'sheets', features_shipped: '3' }],
        },
        {
          match: /FROM harness_shared\.auto_review_audit\b[\s\S]*GROUP BY harness_slug/,
          rows: [{ harness_slug: 'sheets', prs_merged: '7' }],
        },
        {
          match: /FROM harness_shared\.contributor_usage_events\b[\s\S]*GROUP BY harness_slug/,
          rows: [{ harness_slug: 'sheets', activity_events: '42' }],
        },
      ]),
    });
    expect(profile.harnesses).toEqual([
      {
        harness_slug: 'sheets',
        display_title: 'sheets',
        href: '/harness/sheets',
        prs_merged: 7,
        features_shipped: 3,
        activity_events: 42,
      },
    ]);
  });

  it('per-harness aggregate sources missing → zeroed, not thrown', async () => {
    const profile = await loadUserProfile({
      github_user_id: 42,
      runQuery: vi.fn(async (query: string) => {
        if (/FROM harness_shared\.contributors\b[\s\S]*WHERE github_user_id = \$1\b/.test(query)) {
          return [
            {
              workspace_id: 'ws-1',
              harness_slug: 'sheets',
              github_user_id: 42,
              github_username: 'alice',
              display_name: null,
              avatar_url: null,
              device_attestations: [],
              joined_at: '2026-01-01',
            },
          ];
        }
        if (/auto_review_audit|contributor_usage_events/.test(query)) {
          throw new Error('relation does not exist');
        }
        return [];
      }) as unknown as RunQuery,
    });
    expect(profile.harnesses).toEqual([
      {
        harness_slug: 'sheets',
        display_title: 'sheets',
        href: '/harness/sheets',
        prs_merged: 0,
        features_shipped: 0,
        activity_events: 0,
      },
    ]);
  });

  it('handles missing binding cache gracefully', async () => {
    const runQuery = vi.fn(async (query: string) => {
      if (/FROM harness_shared\.contributors\b[\s\S]*WHERE github_user_id = \$1\b/.test(query)) {
        return [
          {
            workspace_id: 'ws-1',
            harness_slug: 'papercup',
            github_user_id: 42,
            github_username: 'alice',
            display_name: null,
            avatar_url: null,
            device_attestations: [],
            joined_at: '2026-01-01',
          },
        ];
      }
      if (/shared_repo_binding_cache/.test(query)) {
        throw new Error('relation does not exist');
      }
      return [];
    });
    const profile = await loadUserProfile({
      github_user_id: 42,
      runQuery: runQuery as unknown as RunQuery,
    });
    // Default-visible when binding row missing.
    expect(profile.harnesses).toHaveLength(1);
    expect(profile.claimed_harnesses).toEqual([]);
  });

  it('normalizeClaimStatus defends against malformed claim_status strings', async () => {
    // The footer SQL filters to claim_status='claimed', but the normalizer
    // still guards against malformed rows that slip through.
    const profile = await loadUserProfile({
      github_user_id: 42,
      runQuery: makeRunQuery([
        {
          match: /FROM harness_shared\.contributors\b[\s\S]*WHERE github_user_id = \$1\b/,
          rows: [
            {
              workspace_id: 'ws-1',
              harness_slug: 'a',
              github_user_id: 42,
              github_username: 'alice',
              display_name: null,
              avatar_url: null,
              device_attestations: [],
              joined_at: '2026-01-01',
            },
          ],
        },
        {
          match: /shared_repo_binding_cache\b[\s\S]*claim_status = 'claimed'/,
          rows: [{ harness_slug: 'a', claim_status: 'mystery' }],
        },
      ]),
    });
    expect(profile.claimed_harnesses[0]?.claim_status).toBe('unclaimed');
  });
});
