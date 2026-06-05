import { describe, expect, it } from 'vitest';
import { buildIssuesProjection, _testing, type HarnessIssueRow } from '../issues';

function issue(over: Partial<HarnessIssueRow> = {}): HarnessIssueRow {
  return {
    harness_slug: 'sheets',
    issue_id: 'I-001',
    title: 'Auth crash on empty token',
    severity: 'high',
    source: 'user-report',
    status: 'open',
    found_at: 1700000000000,
    found_during: 'F-012',
    repro: 'POST /api/auth with no Authorization header',
    evidence: 'stack trace',
    suggested_fix: 'guard token before parsing',
    code_pointer: 'apps/operator/lib/auth.ts:42',
    linked_feature_id: 'F-FIX-007',
    attempts: 0,
    notes: [],
    created_ts: 1700000000000,
    updated_ts: 1700000010000,
    ...over,
  };
}

describe('issues projection', () => {
  it('composeKey returns issue_id', () => {
    expect(_testing.composeKey(issue())).toBe('I-001');
  });

  it('decodeValue accepts a valid row', () => {
    expect(_testing.decodeValue(issue())).toEqual(issue());
  });

  it('decodeValue accepts all nullable fields as null', () => {
    const r = issue({
      found_during: null, repro: null, evidence: null,
      suggested_fix: null, code_pointer: null, linked_feature_id: null,
    });
    expect(_testing.decodeValue(r)).toEqual(r);
  });

  it('decodeValue accepts arbitrary JSONB notes', () => {
    expect(_testing.decodeValue(issue({ notes: [{ at: 1, by: 'alice' }] }))).not.toBeNull();
    expect(_testing.decodeValue(issue({ notes: {} }))).not.toBeNull();
    expect(_testing.decodeValue(issue({ notes: null }))).not.toBeNull();
  });

  it('decodeValue rejects empty title', () => {
    expect(_testing.decodeValue(issue({ title: '' }))).toBeNull();
  });

  it('decodeValue rejects empty issue_id', () => {
    expect(_testing.decodeValue(issue({ issue_id: '' }))).toBeNull();
  });

  it('decodeValue rejects empty harness_slug', () => {
    expect(_testing.decodeValue(issue({ harness_slug: '' }))).toBeNull();
  });

  it('decodeValue rejects non-string severity / source / status', () => {
    expect(_testing.decodeValue({ ...issue(), severity: 1 })).toBeNull();
    expect(_testing.decodeValue({ ...issue(), source: null })).toBeNull();
    expect(_testing.decodeValue({ ...issue(), status: 0 })).toBeNull();
  });

  it('decodeValue rejects non-finite timestamps', () => {
    expect(_testing.decodeValue({ ...issue(), found_at: NaN })).toBeNull();
    expect(_testing.decodeValue({ ...issue(), created_ts: Infinity })).toBeNull();
  });

  it('decodeValue rejects non-number attempts', () => {
    expect(_testing.decodeValue({ ...issue(), attempts: '5' })).toBeNull();
  });

  it('decodeValue rejects non-object input', () => {
    expect(_testing.decodeValue(null)).toBeNull();
    expect(_testing.decodeValue('issue')).toBeNull();
    expect(_testing.decodeValue(42)).toBeNull();
  });

  it('buildIssuesProjection exposes the issues tag', () => {
    const p = buildIssuesProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    expect(p.tableTag).toBe('issues');
  });
});
