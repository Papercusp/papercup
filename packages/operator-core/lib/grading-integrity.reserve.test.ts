import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ boundedOrgTxn: vi.fn() }));

vi.mock('./pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));

import { reservePendingGradingAudit } from './grading-integrity';
import type { ScorecardGradingAuditCurrentness } from './scorecards';

type QueryResult = Record<string, unknown>[];

function transactionHarness(options: { claim: boolean; currentState?: string }) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult> => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (text.includes('RETURNING feature_id')) {
      return options.claim ? [{ feature_id: 'EI-legacy-settled' }] : [];
    }
    if (text.includes("'{observation,gradingAudit}'")) return [];
    if (text.includes("SELECT payload->'observation'->'gradingAudit'->>'state'")) {
      return [{ state: options.currentState ?? 'failed', has_reservation: false }];
    }
    if (text.trim() === 'FALSE' || text.includes("gradingAudit'->>'state' IN ('passed', 'failed')")) return [];
    throw new Error(`unexpected query: ${text}`);
  }) as never;
  h.boundedOrgTxn.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  return { statements };
}

beforeEach(() => {
  h.boundedOrgTxn.mockReset();
});

describe('reservePendingGradingAudit', () => {
  it('executes the legacy identity reopen writer with the current rubric identity', async () => {
    const now = new Date('2026-09-09T15:00:00.000Z');
    const currentness: ScorecardGradingAuditCurrentness = {
      state: 'unknown',
      reason: 'recorded-identity-missing',
      recordedRevision: null,
      currentRevision: 6,
      recordedCriteriaHash: null,
      currentCriteriaHash: 'hash-current',
    };
    const { statements } = transactionHarness({ claim: true });

    const result = await reservePendingGradingAudit('EI-legacy-settled', 'grading-audit:legacy', {
      workspaceId: 'ws-test',
      now,
      currentness,
    });

    expect(result).toEqual({
      status: 'claimed',
      reservation: { key: 'grading-audit:legacy', reservedAt: now.toISOString() },
    });
    const reopen = statements.find((statement) => statement.text.includes("'{observation,gradingAudit}'"));
    const reopenedStamp = JSON.parse(
      String(reopen?.values.find((value) => typeof value === 'string' && value.includes('"state":"pending"'))),
    );
    expect(reopenedStamp).toEqual({
      state: 'pending',
      metaRubricRef: 'grading-integrity',
      rubricRevision: 6,
      criteriaHash: 'hash-current',
      stampedAt: now.toISOString(),
      dispatchReservation: { key: 'grading-audit:legacy', reservedAt: now.toISOString() },
    });
  });

  it('does not enter the reopen writer when the live rubric identity is missing', async () => {
    const currentness: ScorecardGradingAuditCurrentness = {
      state: 'unknown',
      reason: 'live-identity-missing',
      recordedRevision: 5,
      currentRevision: null,
      recordedCriteriaHash: 'hash-recorded',
      currentCriteriaHash: null,
    };
    const { statements } = transactionHarness({ claim: false, currentState: 'failed' });

    const result = await reservePendingGradingAudit('EI-unreopenable', 'grading-audit:unreopenable', {
      workspaceId: 'ws-test',
      currentness,
    });

    expect(result).toEqual({ status: 'not-pending' });
    expect(statements.some((statement) => statement.text.includes("'{observation,gradingAudit}'"))).toBe(false);
  });
});
