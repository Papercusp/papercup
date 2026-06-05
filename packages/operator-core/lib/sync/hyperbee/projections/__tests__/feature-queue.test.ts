import { describe, expect, it } from 'vitest';
import { buildFeatureQueueProjection, _testing, type FeatureQueueRow } from '../feature-queue';

function row(over: Partial<FeatureQueueRow> = {}): FeatureQueueRow {
  return {
    harness_slug: 'sheets',
    github_user_id: 12345,
    feature_id: 'F-001',
    queued_at: 1700000000000,
    removed_at: null,
    schema_version: 1,
    ...over,
  };
}

describe('feature_queue projection', () => {
  it('composeKey joins github_user_id and feature_id', () => {
    expect(_testing.composeKey(row())).toBe('12345/F-001');
  });

  it('decodeValue accepts an active (still-queued) row', () => {
    expect(_testing.decodeValue(row())).toEqual(row());
  });

  it('decodeValue accepts a soft-deleted row (removed_at set)', () => {
    const r = row({ removed_at: 1700001000000 });
    expect(_testing.decodeValue(r)).toEqual(r);
  });

  it('decodeValue rejects missing harness_slug', () => {
    expect(_testing.decodeValue({ ...row(), harness_slug: '' })).toBeNull();
  });

  it('decodeValue rejects non-integer github_user_id', () => {
    expect(_testing.decodeValue({ ...row(), github_user_id: 12.5 })).toBeNull();
  });

  it('decodeValue rejects zero/negative github_user_id', () => {
    expect(_testing.decodeValue({ ...row(), github_user_id: 0 })).toBeNull();
    expect(_testing.decodeValue({ ...row(), github_user_id: -1 })).toBeNull();
  });

  it('decodeValue rejects missing feature_id', () => {
    expect(_testing.decodeValue({ ...row(), feature_id: '' })).toBeNull();
  });

  it('decodeValue rejects non-finite queued_at', () => {
    expect(_testing.decodeValue({ ...row(), queued_at: NaN })).toBeNull();
    expect(_testing.decodeValue({ ...row(), queued_at: Infinity })).toBeNull();
  });

  it('decodeValue rejects non-number removed_at (other than null)', () => {
    expect(_testing.decodeValue({ ...row(), removed_at: '2026-05-25' })).toBeNull();
  });

  it('decodeValue rejects non-object input', () => {
    expect(_testing.decodeValue(null)).toBeNull();
    expect(_testing.decodeValue('string')).toBeNull();
    expect(_testing.decodeValue(42)).toBeNull();
  });

  it('buildFeatureQueueProjection exposes the queue tag', () => {
    const p = buildFeatureQueueProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
    expect(p.tableTag).toBe('queue');
  });

  it('buildFeatureQueueProjection composeKey passes through', () => {
    const p = buildFeatureQueueProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
    expect(p.composeKey(row({ github_user_id: 99, feature_id: 'F-X' }))).toBe('99/F-X');
  });

  it('deleteFromPg parses key gracefully — bad keys are no-op', async () => {
    const p = buildFeatureQueueProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    // No throw on missing separator
    await expect(p.deleteFromPg('not-a-key')).resolves.toBeUndefined();
    // No throw on empty
    await expect(p.deleteFromPg('')).resolves.toBeUndefined();
    // No throw on non-numeric user id
    await expect(p.deleteFromPg('abc/F-1')).resolves.toBeUndefined();
  });
});
