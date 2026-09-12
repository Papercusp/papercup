import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ boundedOrgTxn: vi.fn() }));

vi.mock('./pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));

import { confirmPendingGradingAuditReservation, reservePendingGradingAudit } from './grading-integrity';
import type { ScorecardGradingAuditCurrentness } from './scorecards';

type QueryResult = Record<string, unknown>[];

function transactionHarness(options: {
  claim: boolean;
  currentState?: string;
  hasReservation?: boolean;
  backoff?: unknown;
  confirmReservation?: boolean;
}) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult> => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (text.includes('RETURNING feature_id')) {
      return options.claim ? [{ feature_id: 'EI-legacy-settled' }] : [];
    }
    if (text.includes('SELECT scorecard.feature_id') && text.includes("dispatchReservation'->>'key'")) {
      return options.confirmReservation ? [{ feature_id: 'EI-reserved' }] : [];
    }
    if (text.includes("'{observation,gradingAudit}'")) return [];
    if (text.includes("SELECT payload->'observation'->'gradingAudit'->>'state'")) {
      return [
        {
          state: options.currentState ?? 'failed',
          has_reservation: options.hasReservation ?? false,
          backoff: options.backoff ?? null,
        },
      ];
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
  it('confirms only an owned pending reservation while holding the scorecard row lock', async () => {
    const { statements } = transactionHarness({ claim: false, confirmReservation: true });

    const result = await confirmPendingGradingAuditReservation('EI-reserved', 'grading-audit:reserved', {
      workspaceId: 'ws-test',
    });

    expect(result).toBe(true);
    const confirmation = statements.find(
      (statement) =>
        statement.text.includes('SELECT scorecard.feature_id') && statement.text.includes("dispatchReservation'->>'key'"),
    );
    expect(confirmation).toBeDefined();
    expect(confirmation?.values).toEqual(['ws-test', 'EI-reserved', 'grading-audit:reserved']);
    expect(confirmation?.text).toContain("gradingAudit'->>'state' = 'pending'");
    expect(confirmation?.text).toContain("gradingAudit'->'dispatchReservation'->>'key' = ?");
    expect(confirmation?.text).toContain("scorecard.payload->'observation'->'retracted' IS NULL");
    expect(confirmation?.text).toContain('NOT EXISTS');
    expect(confirmation?.text).toContain("superseder.payload->'observation'->>'supersedes' = scorecard.feature_id");
    expect(confirmation?.text).toContain(
      "superseder.payload->'observation'->>'rubricRef' = scorecard.payload->'observation'->>'rubricRef'",
    );
    expect(confirmation?.text).toContain(
      "superseder.payload->'observation'->>'sourceHive' IS NOT DISTINCT FROM scorecard.payload->'observation'->>'sourceHive'",
    );
    expect(confirmation?.text).toContain('FOR UPDATE');
  });

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

  // EI-22978598482930667: the reset-aware quota suppression lives on the card, so
  // the reservation gate is where it has to be enforced and retired.
  describe('reset-aware quota backoff', () => {
    const now = new Date('2026-09-11T16:00:00.000Z');
    const liveBackoff = {
      until: '2026-09-11T17:00:00.000Z',
      source: 'launcher-horizon' as const,
      code: 'model_quota_exhausted',
      recordedAt: '2026-09-11T16:00:00.000Z',
      reason: 'terminal model_quota_exhausted; suppressing re-dispatch until the launcher-horizon reset',
    };

    it('refuses the claim with quota-backoff, reported AHEAD of an existing reservation', async () => {
      // has_reservation is deliberately true: a caller told 'already-reserved'
      // would wait on a dispatcher that is not in fact running, so the live
      // quota wall must win the report.
      transactionHarness({
        claim: false,
        currentState: 'pending',
        hasReservation: true,
        backoff: liveBackoff,
      });

      const result = await reservePendingGradingAudit('EI-walled', 'grading-audit:walled', {
        workspaceId: 'ws-test',
        now,
      });

      expect(result).toEqual({ status: 'quota-backoff', backoff: liveBackoff });
    });

    it('does not refuse on a SPENT backoff — an elapsed stamp falls through to the ordinary verdict', async () => {
      transactionHarness({
        claim: false,
        currentState: 'pending',
        hasReservation: true,
        backoff: { ...liveBackoff, until: '2026-09-11T15:30:00.000Z' },
      });

      const result = await reservePendingGradingAudit('EI-recovered', 'grading-audit:recovered', {
        workspaceId: 'ws-test',
        now,
      });

      expect(result).toEqual({ status: 'already-reserved' });
    });

    it('gates the claim on the stamp and CLEARS it in the same winning UPDATE', async () => {
      const { statements } = transactionHarness({ claim: true });

      const result = await reservePendingGradingAudit('EI-legacy-settled', 'grading-audit:claim', {
        workspaceId: 'ws-test',
        now,
      });

      expect(result).toMatchObject({ status: 'claimed' });
      const claim = statements.find((statement) => statement.text.includes('RETURNING feature_id'));
      expect(claim).toBeDefined();
      // A claim only succeeds once the backoff has expired, so the winning
      // UPDATE is the right place to retire the spent stamp — leaving it would
      // make the next release's freshly-written backoff ambiguous.
      expect(claim?.text).toContain("#- '{observation,gradingAudit,dispatchBackoff}'");
      expect(claim?.text).toContain("payload->'observation'->'gradingAudit'->'dispatchBackoff'->>'until' IS NULL");
      // Fail OPEN on an unparseable stamp, exactly like the reservation
      // predicate: a malformed value must never strand a card permanently.
      expect(claim?.text).toContain('ELSE TRUE');
    });
  });
});
