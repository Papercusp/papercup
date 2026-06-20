/**
 * prs-report-mapping — PR-3 report-read seam (firehose insurance).
 *
 * `mapReportRow` (and its jsonb parsers) is the boundary between PR-2's stored
 * `pr_review_reports` shape and the PR-3 GUI's `PrRowReport`. PR-2 is actively
 * edited on this multi-lane tree; if its stored columns drift, this RED-goes-first
 * test catches it before the GUI silently renders an empty/wrong report. The
 * route's own DB call stays integration territory; the PURE mapping is tested here.
 */
import { describe, it, expect } from 'vitest';
import {
  mapReportRow,
  asStringArray,
  asChecksObserved,
  type ReportDbRow,
} from '../prs';

function row(over: Partial<ReportDbRow> = {}): ReportDbRow {
  return {
    pr_number: 42,
    head_sha: 'abc1234',
    feature_id: 'F-1',
    recommendation: 'approve',
    summary: 'Adds the widget.',
    rationale: 'Scoped + tested.',
    risks: ['untested path'],
    checks_observed: { checks_state: 'success', tests_touched: true },
    model: 'claude',
    reviewed_at: '2026-06-20T00:00:00.000Z',
    ...over,
  };
}

describe('mapReportRow — stored row → PrRowReport (PR-2 contract seam)', () => {
  it('maps every field through faithfully', () => {
    const m = mapReportRow(row(), 'abc1234');
    expect(m.recommendation).toBe('approve');
    expect(m.summary).toBe('Adds the widget.');
    expect(m.rationale).toBe('Scoped + tested.');
    expect(m.risks).toEqual(['untested path']);
    expect((m.checksObserved as unknown as Record<string, unknown>).checks_state).toBe('success');
    expect(m.headSha).toBe('abc1234');
    expect(m.model).toBe('claude');
    expect(m.reviewedAt).toBe('2026-06-20T00:00:00.000Z');
  });

  it('stale = head differs from the PR live head; not stale when equal/absent', () => {
    expect(mapReportRow(row({ head_sha: 'old123' }), 'new456').stale).toBe(true);
    expect(mapReportRow(row({ head_sha: 'same' }), 'same').stale).toBe(false);
    // Can't tell with a missing head on either side → not stale (no false badge).
    expect(mapReportRow(row({ head_sha: '' }), 'new456').stale).toBe(false);
    expect(mapReportRow(row({ head_sha: 'abc' }), '').stale).toBe(false);
  });

  it('coerces a Date reviewed_at to ISO + null model to empty string', () => {
    const m = mapReportRow(row({ reviewed_at: new Date('2026-06-20T01:02:03.000Z'), model: null }), 'x');
    expect(m.reviewedAt).toBe('2026-06-20T01:02:03.000Z');
    expect(m.model).toBe('');
  });
});

describe('asStringArray — defensive jsonb/text parse', () => {
  it('passes a string[] through, dropping non-strings', () => {
    expect(asStringArray(['a', 1, 'b', null])).toEqual(['a', 'b']);
  });
  it('parses a JSON-text array', () => {
    expect(asStringArray('["x","y"]')).toEqual(['x', 'y']);
  });
  it('returns [] for malformed / non-array / null', () => {
    expect(asStringArray('not json')).toEqual([]);
    expect(asStringArray('{"a":1}')).toEqual([]);
    expect(asStringArray(null)).toEqual([]);
    expect(asStringArray(42)).toEqual([]);
  });
});

describe('asChecksObserved — defensive jsonb/text parse', () => {
  it('passes an object through', () => {
    expect(asChecksObserved({ checks_state: 'failure' })).toEqual({ checks_state: 'failure' });
  });
  it('parses a JSON-text object', () => {
    expect(asChecksObserved('{"checks_state":"pending"}')).toEqual({ checks_state: 'pending' });
  });
  it('returns {} for malformed / null / non-object', () => {
    expect(asChecksObserved('nope')).toEqual({});
    expect(asChecksObserved(null)).toEqual({});
    expect(asChecksObserved(7)).toEqual({});
  });
});
