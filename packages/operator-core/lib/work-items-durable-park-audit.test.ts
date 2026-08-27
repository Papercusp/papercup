import { describe, expect, it } from 'vitest';
import {
  buildDurableParkEvidenceMatrix,
  buildDurableParkAuditReport,
  classifyAuditAge,
  classifyDurableParkReleaseLiveness,
  classifyUnparkCondition,
  durableParkFingerprint,
  planDurableParkClear,
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
      schemaVersion: 'durable-park-audit-v2',
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
      releaseConditionHealth: {
        statusCounts: {
          tracked: 0,
          unverified: 2,
          unreachable: 0,
          'satisfied-still-parked': 0,
        },
        findingCounts: {
          'condition-missing': 1,
          'condition-ambiguous': 0,
          'owner-missing': 2,
          'trigger-missing': 2,
          'reachability-unverified': 2,
          'evidence-missing': 2,
          'condition-unreachable': 0,
          'condition-satisfied-still-parked': 0,
        },
        flagged: 2,
      },
      missingMetadata: {
        unattributedClaimHolds: 1,
        parkReason: 1,
        parkTimestamp: 1,
        invalidParkTimestamp: 0,
        pendingReviewTimestamp: 0,
      },
    });
    expect(report.durableParks.map(({ id }) => id)).toEqual(['WI-B', 'WI-D']);
    expect(report.durableParks[0]?.releaseLiveness).toMatchObject({
      status: 'unverified',
      condition: 'UNPARK when dependency WI-1 is done',
      owner: null,
      trigger: null,
    });
    expect(report.holdOpenLeases).toEqual([
      expect.objectContaining({ id: 'WI-B', age: { status: 'invalid', ageMs: null, bucket: 'unknown' } }),
    ]);
    expect(report.reasons).toEqual([{ reason: 'UNPARK when dependency WI-1 is done', count: 1 }]);
    expect(report.overdueReviews.rows).toEqual([expect.objectContaining({ id: 'WI-B', ageMs: 25 * 60 * 60 * 1_000 })]);
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

  it('requires reachable typed ownership and re-evaluation evidence for a healthy retained park', () => {
    expect(
      classifyDurableParkReleaseLiveness(
        {
          claim_hold_release: {
            condition: 'dependency WI-1 reaches a terminal state',
            owner: 'plan:queue-cleanup',
            trigger: 'work-item:done:WI-1',
            reachability: 'reachable',
            evidence: 'WI-1 is open, owned, and its completion event is registered',
          },
        },
        'UNPARK when WI-1 is done',
      ),
    ).toEqual({
      status: 'tracked',
      contractPresent: true,
      condition: 'dependency WI-1 reaches a terminal state',
      owner: 'plan:queue-cleanup',
      trigger: 'work-item:done:WI-1',
      reachability: 'reachable',
      evidence: 'WI-1 is open, owned, and its completion event is registered',
      findings: [],
    });

    expect(
      classifyDurableParkReleaseLiveness(
        {
          claim_hold_release: {
            condition: 'retired external service returns',
            owner: 'system:queue-audit',
            trigger: 'daily durable-park audit',
            reachability: 'unreachable',
            evidence: 'the service was permanently retired',
          },
        },
        'Release when the service returns',
      ),
    ).toMatchObject({
      status: 'unreachable',
      findings: ['condition-unreachable'],
    });

    expect(
      classifyDurableParkReleaseLiveness(
        {
          claim_hold_release: {
            condition: 'dependency WI-1 reaches a terminal state',
            owner: 'plan:queue-cleanup',
            trigger: 'work-item:done:WI-1',
            reachability: 'satisfied',
            evidence: 'WI-1 is done',
          },
        },
        'UNPARK when WI-1 is done',
      ),
    ).toMatchObject({
      status: 'satisfied-still-parked',
      findings: ['condition-satisfied-still-parked'],
    });
  });
});

describe('durable park evidence matrix and reconciliation CAS', () => {
  const parkedPayload = {
    _claimHold: true,
    claim_hold_by: 'su-parker',
    claim_hold_reason: 'UNPARK when WI-1 is done',
    claim_hold_at: '2026-08-26T12:00:00.000Z',
    keepMe: { nested: true },
  };

  it('persists every raw hold on independent axes with a deterministic control fingerprint', () => {
    const source = [
      row('WI-park', parkedPayload),
      row('WI-lease', {
        _claimHold: true,
        held_open_by: 'su-holder',
        held_open_reason: 'live validation',
        held_open_at: '2026-08-26T13:00:00.000Z',
      }),
      row(
        'WI-both',
        {
          ...parkedPayload,
          held_open_by: 'su-holder',
          held_open_reason: 'live validation',
          held_open_at: '2026-08-26T13:00:00.000Z',
        },
        { takenBy: 'su-worker' },
      ),
      row('WI-visible', {}),
    ];
    const matrix = buildDurableParkEvidenceMatrix({
      rows: source,
      runId: 'matrix-1',
      workspaceId: 'ws',
      harnessSlug: 'h',
      nowMs: NOW_MS,
    });

    expect(matrix.population).toEqual({
      rawClaimHolds: 3,
      durableParks: 2,
      holdOpenLeases: 2,
      leaseAndPark: 1,
      assigned: 1,
    });
    expect(matrix.rows.map(({ id }) => id)).toEqual(['WI-both', 'WI-lease', 'WI-park']);
    expect(matrix.rows.every((entry) => /^[0-9a-f]{64}$/.test(entry.parkFingerprint))).toBe(true);
    expect(matrix.rows.find((entry) => entry.id === 'WI-park')?.sourcePayload).toEqual(parkedPayload);
  });

  it('clears only durable-park provenance and preserves a coexisting lease plus unrelated payload', () => {
    const payload = {
      ...parkedPayload,
      held_open_by: 'su-holder',
      held_open_reason: 'live validation',
      held_open_at: '2026-08-26T13:00:00.000Z',
    };
    const expectedParkFingerprint = durableParkFingerprint({ state: 'open', takenBy: null, payload });
    const plan = planDurableParkClear(
      { id: 'WI-both', state: 'open', takenBy: null, payload },
      {
        id: 'WI-both',
        expectedParkFingerprint,
        reasonCode: 'condition-satisfied',
        evidence: 'WI-1 is terminal',
      },
    );

    expect(plan).toMatchObject({ outcome: 'cleared', preservedLease: true, takenBy: null });
    expect(plan.nextPayload).toEqual({
      _claimHold: true,
      held_open_by: 'su-holder',
      held_open_reason: 'live validation',
      held_open_at: '2026-08-26T13:00:00.000Z',
      keepMe: { nested: true },
    });
  });

  it('removes the raw hold without a lease and refuses assigned, stale, or replayed rows', () => {
    const expectedParkFingerprint = durableParkFingerprint({
      state: 'open',
      takenBy: null,
      payload: parkedPayload,
    });
    const decision = {
      id: 'WI-park',
      expectedParkFingerprint,
      reasonCode: 'operator-directed' as const,
      evidence: 'explicit audited operator disposition',
    };
    expect(
      planDurableParkClear({ id: 'WI-park', state: 'open', takenBy: null, payload: parkedPayload }, decision),
    ).toMatchObject({ outcome: 'cleared', nextPayload: { keepMe: { nested: true } } });
    expect(
      planDurableParkClear({ id: 'WI-park', state: 'open', takenBy: 'su-worker', payload: parkedPayload }, decision)
        .outcome,
    ).toBe('assigned');
    expect(
      planDurableParkClear({ id: 'WI-park', state: 'blocked', takenBy: null, payload: parkedPayload }, decision)
        .outcome,
    ).toBe('stale-fingerprint');
    expect(
      planDurableParkClear({ id: 'WI-park', state: 'open', takenBy: null, payload: { keepMe: true } }, decision)
        .outcome,
    ).toBe('already-cleared');
  });

  it('does not invalidate a park fingerprint for unrelated payload churn', () => {
    expect(durableParkFingerprint({ state: 'open', takenBy: null, payload: parkedPayload })).toBe(
      durableParkFingerprint({ state: 'open', takenBy: null, payload: { ...parkedPayload, checkpointMirror: 'new' } }),
    );
  });
});
