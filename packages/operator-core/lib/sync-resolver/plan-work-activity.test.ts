/**
 * planWorkActivity.list unit tests (plan-visibility-revamp-2026-08-23 P-001).
 *
 * Three seams:
 *   1. the pure row mapping (coercion + drop rules),
 *   2. the query leg via a stub Sql (workspace scoping, observation-lane
 *      exclusion, aggregate shape — the properties D-003 specifies),
 *   3. the wiring: registry entry declares its backing table AND the
 *      table-to-query-names bridge maps work_items back to this name, so the
 *      invalidation chain cannot be half-wired (the accounts.pool failure
 *      class, EI-19304902443341820).
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  coerceEpochMs,
  listPlanWorkActivity,
  mapPlanWorkActivityRows,
} from './plan-work-activity';
import { getRegistryEntryV2 } from './index';
import { TABLE_TO_QUERY_NAMES } from './table-to-query-names';

describe('coerceEpochMs', () => {
  it('accepts the driver string form of a bigint aggregate', () => {
    expect(coerceEpochMs('1787510510047')).toBe(1787510510047);
  });
  it('accepts number and bigint', () => {
    expect(coerceEpochMs(1787510510047)).toBe(1787510510047);
    expect(coerceEpochMs(1787510510047n)).toBe(1787510510047);
  });
  it('rejects null, blanks, non-numeric junk, zero and negatives', () => {
    expect(coerceEpochMs(null)).toBeNull();
    expect(coerceEpochMs(undefined)).toBeNull();
    expect(coerceEpochMs('')).toBeNull();
    expect(coerceEpochMs('  ')).toBeNull();
    expect(coerceEpochMs('not-a-number')).toBeNull();
    expect(coerceEpochMs(0)).toBeNull();
    expect(coerceEpochMs(-5)).toBeNull();
    expect(coerceEpochMs({})).toBeNull();
  });
});

describe('mapPlanWorkActivityRows', () => {
  it('maps well-formed rows and drops unusable ones', () => {
    const rows = mapPlanWorkActivityRows([
      { slug: 'plan-a', last_work_at_ms: '1787500000001' },
      { slug: 'plan-b', last_work_at_ms: 1787500000002 },
      // dropped: empty / whitespace slug, null / junk timestamp, non-objects
      { slug: '', last_work_at_ms: '1787500000003' },
      { slug: '   ', last_work_at_ms: '1787500000003' },
      { slug: 'plan-c', last_work_at_ms: null },
      { slug: 'plan-d', last_work_at_ms: 'zzz' },
      null,
      'garbage',
    ]);
    expect(rows).toEqual([
      { slug: 'plan-a', lastWorkAtMs: 1787500000001 },
      { slug: 'plan-b', lastWorkAtMs: 1787500000002 },
    ]);
  });

  it('returns empty for an empty result set', () => {
    expect(mapPlanWorkActivityRows([])).toEqual([]);
  });
});

describe('listPlanWorkActivity', () => {
  function stubSql(rows: unknown[]) {
    const calls: Array<{ query: string; params: unknown[] }> = [];
    const sql = {
      unsafe: async (query: string, params: unknown[]) => {
        calls.push({ query, params });
        return rows;
      },
    } as unknown as Sql;
    return { sql, calls };
  }

  it('runs ONE workspace-scoped aggregate and maps its rows', async () => {
    const { sql, calls } = stubSql([
      { slug: 'plan-a', last_work_at_ms: '1787500000000' },
      { slug: '', last_work_at_ms: '1787500000000' },
      { slug: 'plan-b', last_work_at_ms: null },
    ]);
    const rows = await listPlanWorkActivity({ workspaceId: 'ws-1', sql });
    expect(rows).toEqual([{ slug: 'plan-a', lastWorkAtMs: 1787500000000 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(['ws-1']);
  });

  it('query carries the D-003 semantics: scope, lane exclusion, per-plan max', async () => {
    const { sql, calls } = stubSql([]);
    await listPlanWorkActivity({ workspaceId: 'ws-1', sql });
    const q = calls[0].query;
    // workspace-scoped, never a cross-tenant read
    expect(q).toContain('workspace_id = $1');
    // observation-lane reflection notes are NOT plan work
    expect(q).toContain(`lane IS DISTINCT FROM 'observation'`);
    // one row per plan, only plans that HAVE attributed items
    expect(q).toContain('GROUP BY source_plan_slug');
    expect(q).toContain(`source_plan_slug IS NOT NULL AND source_plan_slug <> ''`);
    // last-work = max of GREATEST(edit-ts, progress-ts), normalized to epoch ms
    expect(q).toMatch(/max\(GREATEST\(updated_ts,\s*\(extract\(epoch FROM last_progress_at\) \* 1000\)::bigint\)\)/);
    // an all-NULL group must not ship a timestamp-less row
    expect(q).toMatch(/HAVING max\(GREATEST\(/);
  });
});

describe('planWorkActivity.list wiring', () => {
  it('registry entry exists and declares harness_shared.work_items as backing', () => {
    const entry = getRegistryEntryV2('planWorkActivity.list');
    expect(entry).toBeTruthy();
    expect(entry?.backingTables).toContain('harness_shared.work_items');
  });

  it('work_items bridge maps back to this query name (invalidation chain closed)', () => {
    const targets = (TABLE_TO_QUERY_NAMES['harness_shared.work_items'] ?? []).map((t) =>
      typeof t === 'string' ? t : t.name,
    );
    expect(targets).toContain('planWorkActivity.list');
  });
});
