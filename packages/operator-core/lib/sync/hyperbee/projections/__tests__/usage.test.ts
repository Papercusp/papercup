import { describe, expect, it } from 'vitest';
import { buildUsageProjection, _testing, type ContributorUsageEventRow } from '../usage';

function ev(over: Partial<ContributorUsageEventRow> = {}): ContributorUsageEventRow {
  return {
    harness_slug: 'sheets',
    event_id: '01HXYZ',
    github_user_id: 12345,
    device_pubkey: 'a'.repeat(64),
    kind: 'feature_shipped',
    ref_id: 'F-001',
    payload: { commit: 'abc123' },
    ts: 1700000000000,
    schema_version: 1,
    ...over,
  };
}

describe('contributor_usage_events projection', () => {
  it('composeKey joins github_user_id and event_id', () => {
    expect(_testing.composeKey(ev())).toBe('12345/01HXYZ');
  });

  it('decodeValue accepts a valid row', () => {
    expect(_testing.decodeValue(ev())).toEqual(ev());
  });

  it('decodeValue accepts ref_id=null', () => {
    expect(_testing.decodeValue(ev({ ref_id: null }))).not.toBeNull();
  });

  it('decodeValue accepts arbitrary payload (object/array/null)', () => {
    expect(_testing.decodeValue(ev({ payload: { complex: { nested: 1 } } }))).not.toBeNull();
    expect(_testing.decodeValue(ev({ payload: [1, 2, 3] }))).not.toBeNull();
    expect(_testing.decodeValue(ev({ payload: null }))).not.toBeNull();
  });

  it('decodeValue rejects empty event_id', () => {
    expect(_testing.decodeValue(ev({ event_id: '' }))).toBeNull();
  });

  it('decodeValue rejects empty harness_slug', () => {
    expect(_testing.decodeValue(ev({ harness_slug: '' }))).toBeNull();
  });

  it('decodeValue rejects non-integer github_user_id', () => {
    expect(_testing.decodeValue(ev({ github_user_id: 12.5 }))).toBeNull();
  });

  it('decodeValue rejects zero/negative github_user_id', () => {
    expect(_testing.decodeValue(ev({ github_user_id: 0 }))).toBeNull();
    expect(_testing.decodeValue(ev({ github_user_id: -1 }))).toBeNull();
  });

  it('decodeValue rejects empty device_pubkey', () => {
    expect(_testing.decodeValue(ev({ device_pubkey: '' }))).toBeNull();
  });

  it('decodeValue rejects empty kind', () => {
    expect(_testing.decodeValue(ev({ kind: '' }))).toBeNull();
  });

  it('decodeValue rejects non-finite ts', () => {
    expect(_testing.decodeValue({ ...ev(), ts: NaN })).toBeNull();
    expect(_testing.decodeValue({ ...ev(), ts: Infinity })).toBeNull();
  });

  it('decodeValue rejects non-object input', () => {
    expect(_testing.decodeValue(null)).toBeNull();
    expect(_testing.decodeValue('event')).toBeNull();
    expect(_testing.decodeValue(42)).toBeNull();
  });

  it('buildUsageProjection exposes the usage tag', () => {
    const p = buildUsageProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    expect(p.tableTag).toBe('usage');
  });

  it('deleteFromPg is a silent no-op (append-only)', async () => {
    const p = buildUsageProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    await expect(p.deleteFromPg('12345/01HXYZ')).resolves.toBeUndefined();
    await expect(p.deleteFromPg('garbage')).resolves.toBeUndefined();
  });
});
