import { describe, expect, it } from 'vitest';
import { buildPrsProjection, _testing, type HarnessFeaturePrRow } from '../prs';

function pr(over: Partial<HarnessFeaturePrRow> = {}): HarnessFeaturePrRow {
  return {
    harness_slug: 'sheets',
    feature_id: 'F-001',
    pr_url: 'https://github.com/owner/repo/pull/42',
    pr_state: 'open',
    opened_ts: 1700000000000,
    updated_ts: 1700000300000,
    ...over,
  };
}

describe('prs projection', () => {
  it('composeKey returns feature_id', () => {
    expect(_testing.composeKey(pr())).toBe('F-001');
  });

  it('decodeValue accepts a valid row', () => {
    expect(_testing.decodeValue(pr())).toEqual(pr());
  });

  it('decodeValue accepts various pr_state strings', () => {
    expect(_testing.decodeValue(pr({ pr_state: 'merged' }))).not.toBeNull();
    expect(_testing.decodeValue(pr({ pr_state: 'closed' }))).not.toBeNull();
    expect(_testing.decodeValue(pr({ pr_state: 'unknown' }))).not.toBeNull();
  });

  it('decodeValue accepts opened_ts=0 (unknown)', () => {
    expect(_testing.decodeValue(pr({ opened_ts: 0 }))).not.toBeNull();
  });

  it('decodeValue rejects empty pr_url', () => {
    expect(_testing.decodeValue(pr({ pr_url: '' }))).toBeNull();
  });

  it('decodeValue rejects empty harness_slug', () => {
    expect(_testing.decodeValue(pr({ harness_slug: '' }))).toBeNull();
  });

  it('decodeValue rejects empty feature_id', () => {
    expect(_testing.decodeValue(pr({ feature_id: '' }))).toBeNull();
  });

  it('decodeValue rejects non-finite timestamps', () => {
    expect(_testing.decodeValue({ ...pr(), opened_ts: NaN })).toBeNull();
    expect(_testing.decodeValue({ ...pr(), updated_ts: Infinity })).toBeNull();
  });

  it('decodeValue rejects non-string pr_state', () => {
    expect(_testing.decodeValue({ ...pr(), pr_state: 42 })).toBeNull();
  });

  it('decodeValue rejects non-object input', () => {
    expect(_testing.decodeValue(null)).toBeNull();
    expect(_testing.decodeValue('x')).toBeNull();
    expect(_testing.decodeValue([])).toBeNull();
  });

  it('buildPrsProjection exposes the prs tag', () => {
    const p = buildPrsProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    expect(p.tableTag).toBe('prs');
  });

  it('buildPrsProjection composeKey passes through', () => {
    const p = buildPrsProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    expect(p.composeKey(pr({ feature_id: 'F-99' }))).toBe('F-99');
  });
});
