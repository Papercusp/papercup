import { describe, expect, it, vi } from 'vitest';
import {
  buildHarnessFeaturesProjection,
  _testing,
  type HarnessFeatureRow,
} from '../harness-features';

function feature(over: Partial<HarnessFeatureRow> = {}): HarnessFeatureRow {
  return {
    harness_slug: 'sheets',
    feature_id: 'F-001',
    title: 'Auth flow',
    summary: 'JWT + session',
    status: 'in_queue',
    attempts: 0,
    claims: null,
    notes: null,
    metadata: { source: 'scoper' },
    kind: 'feature',
    project_id: null,
    expected_cost_cents: 500,
    tags: ['auth', 'security'],
    needs_human_review: false,
    ts: 1700000000000,
    created_ts: 1700000000000,
    updated_ts: 1700000010000,
    parent_id: null,
    goal_id: 'G-1',
    taken_by: null,
    taken_at: null,
    expires_at: null,
    ...over,
  };
}

describe('harness_features projection', () => {
  it('composeKey returns the feature_id', () => {
    expect(_testing.composeKey(feature())).toBe('F-001');
  });

  it('decodeValue accepts a valid row', () => {
    expect(_testing.decodeValue(feature())).toEqual(feature());
  });

  it('decodeValue accepts all nullable fields as null', () => {
    const r = feature({
      title: null, summary: null, status: null, attempts: null,
      claims: null, notes: null, kind: null, project_id: null,
      expected_cost_cents: null, needs_human_review: null,
      ts: null, created_ts: null, updated_ts: null, parent_id: null,
      goal_id: null, taken_by: null, taken_at: null, expires_at: null,
    });
    expect(_testing.decodeValue(r)).toEqual(r);
  });

  it('decodeValue rejects missing harness_slug', () => {
    const bad = { ...feature(), harness_slug: '' };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue rejects missing feature_id', () => {
    const bad = { ...feature(), feature_id: '' };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue rejects non-string status', () => {
    const bad = { ...feature(), status: 42 };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue rejects non-number attempts', () => {
    const bad = { ...feature(), attempts: '5' };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue rejects non-bool needs_human_review', () => {
    const bad = { ...feature(), needs_human_review: 'yes' };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue rejects NaN ts', () => {
    const bad = { ...feature(), ts: NaN };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue accepts arbitrary JSONB shapes for metadata + tags', () => {
    const r = feature({ metadata: null, tags: { complex: { nested: true } } });
    expect(_testing.decodeValue(r)).not.toBeNull();
    const r2 = feature({ metadata: ['array', 'of', 'strings'], tags: 'string' });
    expect(_testing.decodeValue(r2)).not.toBeNull();
  });

  it('decodeValue rejects null / non-object input', () => {
    expect(_testing.decodeValue(null)).toBeNull();
    expect(_testing.decodeValue('string')).toBeNull();
    expect(_testing.decodeValue(42)).toBeNull();
    expect(_testing.decodeValue([])).toBeNull();
  });

  it('buildHarnessFeaturesProjection exposes features-by-id tag', () => {
    const p = buildHarnessFeaturesProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
    expect(p.tableTag).toBe('features-by-id');
  });

  it('buildHarnessFeaturesProjection composeKey passes through', () => {
    const p = buildHarnessFeaturesProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
    expect(p.composeKey(feature({ feature_id: 'F-999' }))).toBe('F-999');
  });

  it('buildHarnessFeaturesProjection decodeValue passes through', () => {
    const p = buildHarnessFeaturesProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
    expect(p.decodeValue(feature())).toEqual(feature());
    expect(p.decodeValue({})).toBeNull();
  });

  it('WI-1612: writeToPg ALWAYS binds workspace_id explicitly on the INSERT — never left NULL for the incomplete fill_ws_features_trg fallback', async () => {
    const sql = Object.assign(vi.fn(async (..._a: unknown[]) => [] as unknown[]), {
      json: vi.fn((x: unknown) => ({ __json: x })),
    });
    const p = buildHarnessFeaturesProjection({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'sheets', // own-slug op — member-content guard short-circuits to 'apply'
      sql: sql as never,
    });
    await p.writeToPg(feature(), { origin: 'local' });
    expect(sql).toHaveBeenCalledTimes(1);
    const values = (sql.mock.calls[0] as unknown as unknown[]).slice(1);
    // workspace_id is the FIRST bound column in the INSERT (see writeToPg).
    expect(values[0]).toBe('papercusp-workspace');
  });
});
