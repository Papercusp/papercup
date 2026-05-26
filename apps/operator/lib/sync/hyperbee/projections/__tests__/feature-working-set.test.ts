import { describe, expect, it } from 'vitest';
import {
  buildFeatureWorkingSetProjection,
  composeFeatureWorkingSetKey,
  isFeatureWorkingSetRow,
  _testing,
  type FeatureWorkingSetRow,
} from '../feature-working-set';

function row(over: Partial<FeatureWorkingSetRow> = {}): FeatureWorkingSetRow {
  return {
    harness_slug: 'sheets',
    github_user_id: 12345,
    feature_id: 'F-001',
    started_at: 1700000000000,
    cleared_at: null,
    schema_version: 1,
    ...over,
  };
}

describe('feature_working_set projection', () => {
  it('composeKey joins github_user_id and feature_id', () => {
    expect(_testing.composeKey(row())).toBe('12345/F-001');
  });

  it('composeFeatureWorkingSetKey is the shared composer', () => {
    expect(composeFeatureWorkingSetKey(7, 'F-9')).toBe('7/F-9');
  });

  it('decodeValue accepts an active (still-working) row', () => {
    expect(_testing.decodeValue(row())).toEqual(row());
  });

  it('decodeValue accepts a cleared row (cleared_at set)', () => {
    const r = row({ cleared_at: 1700001000000 });
    expect(_testing.decodeValue(r)).toEqual(r);
  });

  it('decodeValue rejects missing harness_slug', () => {
    expect(_testing.decodeValue(row({ harness_slug: '' as never }))).toBeNull();
  });

  it('decodeValue rejects non-positive user id', () => {
    expect(_testing.decodeValue(row({ github_user_id: 0 }))).toBeNull();
    expect(_testing.decodeValue(row({ github_user_id: -1 }))).toBeNull();
  });

  it('decodeValue rejects empty feature_id', () => {
    expect(_testing.decodeValue(row({ feature_id: '' }))).toBeNull();
  });

  it('decodeValue rejects non-numeric started_at', () => {
    expect(_testing.decodeValue(row({ started_at: NaN }))).toBeNull();
  });

  it('decodeValue rejects bad cleared_at type', () => {
    expect(_testing.decodeValue(row({ cleared_at: 'soon' as never }))).toBeNull();
  });

  it('isFeatureWorkingSetRow guards non-objects', () => {
    expect(isFeatureWorkingSetRow(null)).toBe(false);
    expect(isFeatureWorkingSetRow(42)).toBe(false);
    expect(isFeatureWorkingSetRow('x')).toBe(false);
  });

  it('buildFeatureWorkingSetProjection wires tag working-set + the composer', () => {
    const p = buildFeatureWorkingSetProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    expect(p.tableTag).toBe('working-set');
    expect(p.composeKey(row())).toBe('12345/F-001');
    expect(p.decodeValue(row())).toEqual(row());
    expect(p.decodeValue({ bogus: true })).toBeNull();
  });
});
