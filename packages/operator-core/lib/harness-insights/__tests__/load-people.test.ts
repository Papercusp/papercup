/**
 * loadHarnessPeople tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadHarnessPeople } from '../load-people';

type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

function makeRunQuery(rows: unknown[]): RunQuery {
  return vi.fn(async () => rows) as unknown as RunQuery;
}

function throwingRunQuery(): RunQuery {
  return vi.fn(async () => {
    throw new Error('relation does not exist');
  }) as unknown as RunQuery;
}

describe('loadHarnessPeople', () => {
  it('returns empty when no rows', async () => {
    const out = await loadHarnessPeople({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([]),
    });
    expect(out).toEqual([]);
  });

  it('returns empty when contributors table is missing', async () => {
    const out = await loadHarnessPeople({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: throwingRunQuery(),
    });
    expect(out).toEqual([]);
  });

  it('shapes rows into PeopleCardPerson', async () => {
    const out = await loadHarnessPeople({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          github_user_id: 42,
          github_username: 'alice',
          display_name: 'Alice A',
          avatar_url: 'https://x/a.png',
          device_attestations: [{ verified: true }],
        },
      ]),
    });
    expect(out).toEqual([
      {
        github_user_id: 42,
        login: 'alice',
        display_name: 'Alice A',
        avatar_url: 'https://x/a.png',
        binding_status: 'verified',
      },
    ]);
  });

  it('coerces string github_user_id to number', async () => {
    const out = await loadHarnessPeople({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          github_user_id: '42',
          github_username: 'alice',
          display_name: null,
          avatar_url: null,
          device_attestations: [],
        },
      ]),
    });
    expect(out[0]?.github_user_id).toBe(42);
  });

  it('picks pending binding when only false attestations exist', async () => {
    const out = await loadHarnessPeople({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          github_user_id: 1,
          github_username: 'a',
          display_name: null,
          avatar_url: null,
          device_attestations: [{ verified: false }],
        },
      ]),
    });
    expect(out[0]?.binding_status).toBe('pending');
  });

  it('picks unverified when device_attestations is empty/missing', async () => {
    const out = await loadHarnessPeople({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          github_user_id: 1,
          github_username: 'a',
          display_name: null,
          avatar_url: null,
          device_attestations: [],
        },
        {
          github_user_id: 2,
          github_username: 'b',
          display_name: null,
          avatar_url: null,
          device_attestations: null,
        },
      ]),
    });
    expect(out[0]?.binding_status).toBe('unverified');
    expect(out[1]?.binding_status).toBe('unverified');
  });

  it('prefers verified when both verified and pending attestations exist', async () => {
    const out = await loadHarnessPeople({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          github_user_id: 1,
          github_username: 'a',
          display_name: null,
          avatar_url: null,
          device_attestations: [
            { verified: false },
            { verified: true },
          ],
        },
      ]),
    });
    expect(out[0]?.binding_status).toBe('verified');
  });
});
