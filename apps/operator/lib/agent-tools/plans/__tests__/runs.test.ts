/**
 * Unit coverage for the pure row-mapper in `runs.ts`
 * (plan-agent-launch-2026-05-21, Phase 3).
 *
 * `mapPlanRunRow` is pure. The DAL functions around it (`insertPlanRun`,
 * `getPlanRun`, `listPlanRuns`, …) are heavy IO — exercised live in
 * P-027 / P-028.
 */

import { describe, expect, it } from 'vitest';
import { mapPlanRunRow, type RawPlanRunRow } from '../runs';

const rawRow: RawPlanRunRow = {
  id: 7,
  plan_slug: 'plan-agent-launch-2026-05-21',
  plan_content_hash: 'deadbeef',
  session_id: '11111111-2222-3333-4444-555555555555',
  note: 'advance phase 3',
  launched_by: 'pus-abcdefab-cdef',
  launched_at: 1_716_000_000_000,
  status: 'idle',
  title: 'advance phase 3',
  updated_at: 1_716_000_005_000,
};

describe('mapPlanRunRow', () => {
  it('maps snake_case columns to the camelCased PlanRunRow', () => {
    const row = mapPlanRunRow(rawRow);
    expect(row).toEqual({
      id: 7,
      planSlug: 'plan-agent-launch-2026-05-21',
      planContentHash: 'deadbeef',
      sessionId: '11111111-2222-3333-4444-555555555555',
      note: 'advance phase 3',
      launchedBy: 'pus-abcdefab-cdef',
      launchedAt: 1_716_000_000_000,
      status: 'idle',
      title: 'advance phase 3',
      updatedAt: 1_716_000_005_000,
    });
  });

  it('coerces BIGINT columns delivered as strings into numbers', () => {
    // PG returns BIGSERIAL / BIGINT columns as strings — the mapper's
    // Number() coercion is load-bearing.
    const row = mapPlanRunRow({
      ...rawRow,
      id: '42',
      launched_at: '1716000000000',
      updated_at: '1716000005000',
    });
    expect(row.id).toBe(42);
    expect(row.launchedAt).toBe(1_716_000_000_000);
    expect(row.updatedAt).toBe(1_716_000_005_000);
    expect(typeof row.id).toBe('number');
  });

  it('preserves a null note and null title', () => {
    const row = mapPlanRunRow({ ...rawRow, note: null, title: null });
    expect(row.note).toBeNull();
    expect(row.title).toBeNull();
  });
});
