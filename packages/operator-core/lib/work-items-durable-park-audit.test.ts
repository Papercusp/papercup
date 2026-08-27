import { describe, expect, it } from 'vitest';
import {
  buildDurableParkAuditReport,
  classifyAuditAge,
  classifyUnparkCondition,
  type DurableParkAuditSourceRow,
} from './work-items-durable-park-audit';

const NOW_MS = Date.parse('2026-08-27T00:00:00.000Z');

function row(
  id: string,
  payload: Record<string, unknown>,
  overrides: Partial<DurableParkAuditSourceRow> = {},
): DurableParkAuditSourceRow {
  return {
    id,
    title: `title ${id}`,
    state: 'open',
    takenBy: null,
    takenAt: null,
    updatedAtMs: NOW_MS,
    payload,
    reviewRoutedAtMs: null,
    ...overrides,
  };
}

describe('durable park audit classification', () => {
  it('keeps the queue-control axes independent and leaves its source rows untouched', () => {
    const rows = [
      row(
        'WI-B',
        {
          _claimHold: true,
          claim_hold_by: 'su-parker',
          claim_hold_reason: 'UNPARK when dependency WI-1 is done',
          claim_hold_at: '2026-08-26T12:00:00.000Z',
          held_open_by: 'su-lease',
          held_open_reason: 'validation in progress',
          held_open_at: 'not-a-date',
          agentReview: {
            status: 'pending',
            submittedBy: 'su-reviewer',
            ledgerIdeaId: 'WI-B',
            round: 2,
          },
        },
        {
          takenBy: 'su-active',
          takenAt: '2026-08-26T23:00:00.000Z',
          reviewRoutedAtMs: NOW_MS - 25 * 60 * 60 * 1_000,
        },
      ),
      row('WI-A', { _claimHold: true }),
      row('WI-C', {
        agentReview: {
          status: 'revision-requested',
          submittedBy: 'su-author',
          ledgerIdeaId: 'WI-C',
          round: 1,
        },
      }),
      row('WI-D', {
        _claimHold: true,
        claim_hold_by: 'su-parker-2',
      }),
    ];
    const before = structuredClone(rows);

    const report = buildDurableParkAuditReport({
      rows,
      runId: 'audit-run-1',
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      nowMs: NOW_MS,
      reviewOverdueHours: 24,
    });

    expect(rows).toEqual(before);
    expect(report).toMatchObject({
      schemaVersion: 'durable-park-audit-v1',
      reportOnly: true,
      modelCalled: false,
      population: {
        nonTerminal: 4,
        axes: {
          activeClaims: 1,
          rawClaimHolds: 3,
          holdOpenLeases: 1,
          durableParks: 2,
          pendingAgentReview: 1,
          revisionRequestedAgentReview: 1,
        },
      },
      parkAgeBuckets: {
        'under-1d': 1,
        '1-7d': 0,
        '7-30d': 0,
        '30d-plus': 0,
        unknown: 1,
      },
      unparkConditions: { stated: 1, missing: 1, unresolved: 0 },
      missingMetadata: {
        unattributedClaimHolds: 1,
        parkReason: 1,
        parkTimestamp: 1,
        invalidParkTimestamp: 0,
        pendingReviewTimestamp: 0,
      },
    });
    expect(report.durableParks.map(({ id }) => id)).toEqual(['WI-B', 'WI-D']);
    expect(report.holdOpenLeases).toEqual([
      expect.objectContaining({ id: 'WI-B', age: { status: 'invalid', ageMs: null, bucket: 'unknown' } }),
    ]);
    expect(report.reasons).toEqual([
      { reason: 'UNPARK when dependency WI-1 is done', count: 1 },
    ]);
    expect(report.overdueReviews.rows).toEqual([
      expect.objectContaining({ id: 'WI-B', ageMs: 25 * 60 * 60 * 1_000 }),
    ]);
  });

  it('classifies age and condition text without treating vague prose as a release condition', () => {
    expect(classifyAuditAge('2026-07-20T00:00:00.000Z', NOW_MS)).toEqual({
      status: 'known',
      ageMs: 38 * 24 * 60 * 60 * 1_000,
      bucket: '30d-plus',
    });
    expect(classifyAuditAge('invalid', NOW_MS)).toEqual({
      status: 'invalid',
      ageMs: null,
      bucket: 'unknown',
    });
    expect(classifyUnparkCondition('waiting on a decision')).toEqual({
      status: 'unresolved',
      text: 'waiting on a decision',
    });
    expect(classifyUnparkCondition('Release after WI-1 is done')).toEqual({
      status: 'stated',
      text: 'Release after WI-1 is done',
    });
  });
});
