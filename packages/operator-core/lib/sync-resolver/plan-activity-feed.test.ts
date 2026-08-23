/**
 * planActivity.list unit tests (plan-visibility-revamp-2026-08-23 P-004).
 * Same seams as plan-work-activity.test.ts: pure row mapping + merge, the
 * query leg via a stub Sql, and the registry/bridge wiring guard.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  PLAN_ACTIVITY_DEFAULT_LIMIT,
  PLAN_ACTIVITY_MAX_LIMIT,
  listPlanActivity,
  mapEditRows,
  mapWorkRows,
  mergeActivityRows,
  type PlanActivityRow,
} from './plan-activity-feed';
import { getRegistryEntryV2 } from './index';
import { TABLE_TO_QUERY_NAMES } from './table-to-query-names';

describe('mapEditRows', () => {
  it('maps a revision with a rationale to its first line', () => {
    const rows = mapEditRows([
      { seq: 7, rationale: 'Scope narrowed to two lanes\nlong detail', author_id: 'su-76a83', created_at: '1787500000000' },
    ]);
    expect(rows).toEqual([
      { kind: 'edit', tsMs: 1787500000000, text: 'Scope narrowed to two lanes', who: 'su-76a83', ref: 'rev:7' },
    ]);
  });
  it('falls back to a generic line when rationale is absent', () => {
    const rows = mapEditRows([{ seq: 3, rationale: null, author_id: '', created_at: 1787500000001 }]);
    expect(rows).toEqual([{ kind: 'edit', tsMs: 1787500000001, text: 'Plan edited (rev 3)', ref: 'rev:3' }]);
  });
  it('drops rows without a usable timestamp, and non-objects', () => {
    expect(mapEditRows([{ seq: 1, created_at: null }, null, 'junk'])).toEqual([]);
  });
});

describe('mapWorkRows', () => {
  it('maps an item to id + status + title with holder and ref', () => {
    const rows = mapWorkRows([
      { feature_id: 'WI-41008', title: 'planWorkActivity.list sync query', status: 'done', taken_by: null, ts_ms: '1787510880100' },
      { feature_id: 'WI-41015', title: 'Activity feed', status: 'open', taken_by: 'su-5ae5f', ts_ms: 1787511356353 },
    ]);
    expect(rows).toEqual([
      { kind: 'work', tsMs: 1787510880100, text: 'WI-41008 done — planWorkActivity.list sync query', ref: 'WI-41008' },
      { kind: 'work', tsMs: 1787511356353, text: 'WI-41015 open — Activity feed', who: 'su-5ae5f', ref: 'WI-41015' },
    ]);
  });
  it('drops rows missing id or timestamp', () => {
    expect(
      mapWorkRows([
        { feature_id: '', ts_ms: 1787500000000 },
        { feature_id: 'WI-1', ts_ms: null },
      ]),
    ).toEqual([]);
  });
});

describe('mergeActivityRows', () => {
  const row = (kind: 'edit' | 'work', tsMs: number): PlanActivityRow => ({ kind, tsMs, text: `${kind}@${tsMs}` });
  it('interleaves both legs newest-first and caps at limit', () => {
    const merged = mergeActivityRows(
      [row('edit', 30), row('edit', 10)],
      [row('work', 40), row('work', 20)],
      3,
    );
    expect(merged.map((r) => r.tsMs)).toEqual([40, 30, 20]);
  });
  it('bounds are sane', () => {
    expect(PLAN_ACTIVITY_DEFAULT_LIMIT).toBeLessThanOrEqual(PLAN_ACTIVITY_MAX_LIMIT);
  });
});

describe('listPlanActivity', () => {
  function stubSql(bySnippet: Array<{ match: string; rows: unknown[] }>) {
    const calls: Array<{ query: string; params: unknown[] }> = [];
    const sql = {
      unsafe: async (query: string, params: unknown[]) => {
        calls.push({ query, params });
        return bySnippet.find((s) => query.includes(s.match))?.rows ?? [];
      },
    } as unknown as Sql;
    return { sql, calls };
  }

  it('runs both plan-scoped legs and merges newest-first', async () => {
    const { sql, calls } = stubSql([
      {
        match: 'plan_revisions',
        rows: [{ seq: 2, rationale: 'Decision D-001 added', author_id: 'su-a', created_at: 2_000 }],
      },
      {
        match: 'work_items',
        rows: [{ feature_id: 'WI-9', title: 'T', status: 'wip', taken_by: 'su-b', ts_ms: 3_000 }],
      },
    ]);
    const rows = await listPlanActivity({ planSlug: 'my-plan', workspaceId: 'ws-1', sql });
    expect(rows.map((r) => [r.kind, r.tsMs])).toEqual([
      ['work', 3_000],
      ['edit', 2_000],
    ]);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.params.slice(0, 2)).toEqual(['ws-1', 'my-plan']);
    }
    const workQuery = calls.find((c) => c.query.includes('work_items'))!.query;
    expect(workQuery).toContain(`lane IS DISTINCT FROM 'observation'`);
    expect(workQuery).toContain('source_plan_slug = $2');
    const editQuery = calls.find((c) => c.query.includes('plan_revisions'))!.query;
    expect(editQuery).toContain('plan_slug = $2');
    expect(editQuery).toContain('ORDER BY seq DESC');
  });

  it('clamps the limit into [1, MAX]', async () => {
    const { sql, calls } = stubSql([]);
    await listPlanActivity({ planSlug: 'p', workspaceId: 'ws-1', limit: 10_000, sql });
    for (const c of calls) expect(c.params[2]).toBe(PLAN_ACTIVITY_MAX_LIMIT);
  });
});

describe('planActivity.list wiring', () => {
  it('registry entry declares BOTH backing tables', () => {
    const entry = getRegistryEntryV2('planActivity.list');
    expect(entry).toBeTruthy();
    expect(entry?.backingTables).toContain('harness_shared.plan_revisions');
    expect(entry?.backingTables).toContain('harness_shared.work_items');
  });
  it('both bridges map back to this query name', () => {
    for (const table of ['harness_shared.plan_revisions', 'harness_shared.work_items'] as const) {
      const targets = (TABLE_TO_QUERY_NAMES[table] ?? []).map((t) => (typeof t === 'string' ? t : t.name));
      expect(targets, table).toContain('planActivity.list');
    }
  });
});
