/**
 * loadRecentClaimAttempts + loadClaimAttemptStats tests.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  loadClaimAttemptStats,
  loadRecentClaimAttempts,
} from '../load-claim-attempts';

type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

function makeRunQuery(rows: unknown[] | (() => never)): RunQuery {
  return vi.fn(async () => {
    if (typeof rows === 'function') return rows();
    return rows;
  }) as unknown as RunQuery;
}

describe('loadRecentClaimAttempts', () => {
  it('returns empty array when no rows', async () => {
    const r = await loadRecentClaimAttempts({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([]),
    });
    expect(r).toEqual([]);
  });

  it('shapes raw rows into ClaimAttemptRow', async () => {
    const r = await loadRecentClaimAttempts({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          id: '7',
          feature_id: 'F-1',
          claimer_pubkey: 'aa',
          claimer_github_user_id: '42',
          ts: '2026-05-25T00:00:00Z',
          outcome: 'won',
          detail: null,
        },
      ]),
    });
    expect(r[0]).toEqual({
      id: 7,
      feature_id: 'F-1',
      claimer_pubkey: 'aa',
      claimer_github_user_id: 42,
      ts: new Date('2026-05-25T00:00:00Z').getTime(),
      outcome: 'won',
      detail: null,
    });
  });

  it('returns empty array when table is missing', async () => {
    const r = await loadRecentClaimAttempts({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery(() => {
        throw new Error('relation does not exist');
      }),
    });
    expect(r).toEqual([]);
  });

  it('uses feature_id filter when provided', async () => {
    let capturedQuery = '';
    let capturedParams: unknown[] = [];
    const runQuery = vi.fn(async (query: string, params: unknown[]) => {
      capturedQuery = query;
      capturedParams = params;
      return [];
    }) as unknown as RunQuery;
    await loadRecentClaimAttempts({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      feature_id: 'F-1',
      runQuery,
    });
    expect(capturedQuery).toContain('AND feature_id =');
    expect(capturedParams).toContain('F-1');
  });

  it('uses outcome filter when provided', async () => {
    let capturedQuery = '';
    let capturedParams: unknown[] = [];
    const runQuery = vi.fn(async (query: string, params: unknown[]) => {
      capturedQuery = query;
      capturedParams = params;
      return [];
    }) as unknown as RunQuery;
    await loadRecentClaimAttempts({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      outcome: 'won',
      runQuery,
    });
    expect(capturedQuery).toContain('AND outcome =');
    expect(capturedParams).toContain('won');
  });

  it('combines feature_id and outcome filters', async () => {
    let capturedParams: unknown[] = [];
    const runQuery = vi.fn(async (_query: string, params: unknown[]) => {
      capturedParams = params;
      return [];
    }) as unknown as RunQuery;
    await loadRecentClaimAttempts({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      feature_id: 'F-1',
      outcome: 'lost',
      limit: 10,
      runQuery,
    });
    expect(capturedParams).toContain('F-1');
    expect(capturedParams).toContain('lost');
    expect(capturedParams[capturedParams.length - 1]).toBe(10);
  });

  it('defaults limit to 50', async () => {
    let capturedParams: unknown[] = [];
    const runQuery = vi.fn(async (_query: string, params: unknown[]) => {
      capturedParams = params;
      return [];
    }) as unknown as RunQuery;
    await loadRecentClaimAttempts({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery,
    });
    expect(capturedParams[capturedParams.length - 1]).toBe(50);
  });
});

describe('loadClaimAttemptStats', () => {
  it('returns zeros when table is missing', async () => {
    const s = await loadClaimAttemptStats({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery(() => {
        throw new Error('relation does not exist');
      }),
    });
    expect(s).toEqual({ total: 0, won: 0, lost: 0, error: 0 });
  });

  it('aggregates outcome counts', async () => {
    const s = await loadClaimAttemptStats({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        { outcome: 'won', n: 7 },
        { outcome: 'lost', n: '3' },
        { outcome: 'error', n: 1 },
      ]),
    });
    expect(s).toEqual({ total: 11, won: 7, lost: 3, error: 1 });
  });

  it('ignores unknown outcome values', async () => {
    const s = await loadClaimAttemptStats({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        { outcome: 'won', n: 2 },
        { outcome: 'mystery', n: 99 },
      ]),
    });
    expect(s).toEqual({ total: 2, won: 2, lost: 0, error: 0 });
  });

  it('returns zeros when no rows', async () => {
    const s = await loadClaimAttemptStats({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([]),
    });
    expect(s).toEqual({ total: 0, won: 0, lost: 0, error: 0 });
  });
});
