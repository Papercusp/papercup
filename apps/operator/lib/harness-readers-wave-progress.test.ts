/**
 * harness-readers-wave-progress.test.ts — unit coverage for getWaveProgress
 * (promote-policy-and-waves P-011).
 *
 * getWaveProgress reads harness_features_consolidated for one plan and groups
 * the rows by `wave`, counting per-status totals. The org-PG `sql` tagged
 * template is mocked to return canned rows so the pure aggregation + the
 * status→counter mapping are exercised without a real database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: { rows: unknown[]; throwErr: Error | null } = { rows: [], throwErr: null };
  // A `sql` tagged template: called as sql`...` → sql(strings, ...values).
  const sql = (..._args: unknown[]) =>
    state.throwErr ? Promise.reject(state.throwErr) : Promise.resolve(state.rows);
  return { sql, state };
});

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: H.sql }) };
});

import { getWaveProgress } from './harness-readers';

beforeEach(() => {
  H.state.rows = [];
  H.state.throwErr = null;
});

describe('getWaveProgress (P-011)', () => {
  it('groups features by wave and counts per-status + totals', async () => {
    H.state.rows = [
      { wave: 'w1', status: 'passed', created_ts: 1 },
      { wave: 'w1', status: 'failing', created_ts: 2 },
      { wave: 'w2', status: 'in_progress', created_ts: 3 },
      { wave: 'w2', status: 'validating', created_ts: 4 },
      { wave: 'w2', status: 'blocked', created_ts: 5 },
    ];
    const res = await getWaveProgress('myharn', 'plan-x');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.planSlug).toBe('plan-x');
    expect(res.data.waves).toEqual(['w1', 'w2']);
    expect(res.data.byWave.w1).toEqual({ total: 2, passed: 1, failing: 1, inProgress: 0, blocked: 0 });
    // validating + in_progress both fold into inProgress.
    expect(res.data.byWave.w2).toEqual({ total: 3, passed: 0, failing: 0, inProgress: 2, blocked: 1 });
    expect(res.data.totals).toEqual({ total: 5, passed: 1, failing: 1, inProgress: 2, blocked: 1 });
  });

  it('buckets a null wave under "(no wave)" and orders waves by first appearance', async () => {
    H.state.rows = [
      { wave: null, status: 'passed', created_ts: 1 },
      { wave: 'w1', status: 'passed', created_ts: 2 },
      { wave: null, status: 'failing', created_ts: 3 },
    ];
    const res = await getWaveProgress('h', 'p');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.waves).toEqual(['(no wave)', 'w1']);
    expect(res.data.byWave['(no wave)'].total).toBe(2);
    expect(res.data.byWave['w1'].total).toBe(1);
  });

  it('returns zeroed totals and empty waves for a plan with no features', async () => {
    H.state.rows = [];
    const res = await getWaveProgress('h', 'p');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.waves).toEqual([]);
    expect(res.data.byWave).toEqual({});
    expect(res.data.totals).toEqual({ total: 0, passed: 0, failing: 0, inProgress: 0, blocked: 0 });
  });

  it('counts an unrecognized status toward total only', async () => {
    H.state.rows = [{ wave: 'w1', status: 'todo', created_ts: 1 }];
    const res = await getWaveProgress('h', 'p');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.byWave.w1).toEqual({ total: 1, passed: 0, failing: 0, inProgress: 0, blocked: 0 });
  });

  it('returns ok:false with status 404 when the query throws', async () => {
    H.state.throwErr = new Error('connection refused');
    const res = await getWaveProgress('h', 'p');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    expect(res.error).toContain('connection refused');
  });
});
