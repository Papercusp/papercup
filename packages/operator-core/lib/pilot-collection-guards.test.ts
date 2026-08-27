import { describe, expect, it } from 'vitest';
import {
  derivePilotReceiptCostWindows,
  validatePilotGradeBindings,
  validatePilotGradeReceipt,
  type PilotCollectionBindingReceipt,
  type PilotCollectionDispatchReceipt,
  type PilotGradeBinding,
} from './pilot-collection-guards';
import type { ScorecardRow } from './scorecards';

const FP = 'a'.repeat(64);
const CLOSED = Date.parse('2026-08-27T01:00:00.000Z');

function gradeBinding(over: Partial<PilotGradeBinding> = {}): PilotGradeBinding {
  return { itemId: 'WI-1', graderOwnerId: 'su-grader', packetFingerprint: FP, ...over };
}

function card(over: Partial<ScorecardRow> = {}): ScorecardRow {
  return {
    issueId: 'EI-CARD-1',
    createdAt: '2026-08-27T01:00:01.000Z',
    createdBy: 'su-grader',
    subject: { kind: 'work-item', ref: 'WI-1' },
    rubricRef: 'pilot-quality',
    ratings: { quality: { rating: 'good', evidence: 'verified' } },
    nKeys: 1,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    gradingAudit: {
      state: 'passed',
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-08-27T01:00:02.000Z',
      auditIssueId: 'EI-AUDIT-1',
      auditor: 'su-auditor',
    },
    synthesized: false,
    score10: 8,
    linkedItems: [],
    ...over,
  };
}

function binding(over: Partial<PilotCollectionBindingReceipt> = {}): PilotCollectionBindingReceipt {
  return {
    receiptId: 'bind-1',
    itemId: 'WI-1',
    ownerId: 'su-worker',
    sessionId: 'session-1',
    role: 'solo',
    claimVersion: 4,
    bindingIssuedAtMs: CLOSED - 5_000,
    ...over,
  };
}

function dispatch(over: Partial<PilotCollectionDispatchReceipt> = {}): PilotCollectionDispatchReceipt {
  return {
    receiptId: 'dispatch-1',
    bindingReceiptId: 'bind-1',
    itemId: 'WI-1',
    ownerId: 'su-worker',
    sessionId: 'session-1',
    role: 'solo',
    dispatchedAtMs: CLOSED - 4_000,
    ...over,
  };
}

describe('pilot grade prebinding guards', () => {
  it('accepts exactly one opaque prebound independent grader per frozen item', () => {
    const result = validatePilotGradeBindings({
      itemIds: ['WI-1', 'WI-2'],
      bindings: [gradeBinding(), gradeBinding({ itemId: 'WI-2', graderOwnerId: 'su-grader-2', packetFingerprint: 'b'.repeat(64) })],
      participantOwnerIds: ['su-a', 'su-b'],
      operatorOwnerId: 'su-operator',
      runbookAuthorOwnerId: 'su-author',
    });
    expect(result.ok).toBe(true);
    expect(result.accepted).toHaveLength(2);
  });

  it.each(['su-a', 'su-operator', 'su-author'])('rejects grader %s because cohort-wide independence is mandatory', (graderOwnerId) => {
    const result = validatePilotGradeBindings({
      itemIds: ['WI-1'],
      bindings: [gradeBinding({ graderOwnerId })],
      participantOwnerIds: ['su-a'],
      operatorOwnerId: 'su-operator',
      runbookAuthorOwnerId: 'su-author',
    });
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: 'ineligible-grader' }));
  });

  it('fails closed on duplicate, missing, out-of-cohort, or non-opaque bindings', () => {
    const result = validatePilotGradeBindings({
      itemIds: ['WI-1', 'WI-2', 'WI-3'],
      bindings: [gradeBinding(), gradeBinding(), gradeBinding({ itemId: 'WI-3', packetFingerprint: 'raw grading packet' }), gradeBinding({ itemId: 'WI-X' })],
      participantOwnerIds: [],
      operatorOwnerId: 'su-operator',
      runbookAuthorOwnerId: 'su-author',
    });
    expect(result.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining([
      'duplicate-grade-binding',
      'missing-grade-binding',
      'invalid-packet-fingerprint',
      'unbound-grade-binding',
    ]));
  });
});

describe('pilot exact blind-grade receipts', () => {
  it('accepts the exact returned post-terminal card and emits a ledger-bound receipt', () => {
    const result = validatePilotGradeReceipt({
      binding: gradeBinding(),
      returnedCardId: 'EI-CARD-1',
      rubricRef: 'pilot-quality',
      closedAtMs: CLOSED,
      cards: [card()],
    });
    expect(result).toMatchObject({
      ok: true,
      receipt: {
        itemId: 'WI-1',
        cardId: 'EI-CARD-1',
        graderOwnerId: 'su-grader',
        packetFingerprint: FP,
        closedAtMs: CLOSED,
        evidenceSource: 'scorecard-ledger',
      },
    });
  });

  it('never selects the first valid card when the prebound grader emitted a duplicate', () => {
    const result = validatePilotGradeReceipt({
      binding: gradeBinding(),
      returnedCardId: 'EI-CARD-1',
      rubricRef: 'pilot-quality',
      closedAtMs: CLOSED,
      cards: [card(), card({ issueId: 'EI-CARD-2', createdAt: '2026-08-27T01:00:03.000Z' })],
    });
    expect(result.receipt).toBeNull();
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: 'duplicate-scorecard' }));
  });

  it.each([
    ['pre-terminal-scorecard', card({ createdAt: '2026-08-27T00:59:59.999Z' })],
    ['provisional-scorecard', card({ provisional: { violatableKeys: ['quality'], stampedAt: '2026-08-27T01:00:01.000Z' } })],
    ['incomplete-scorecard', card({ missingKeys: ['quality'] })],
    ['scorecard-audit-not-passed', card({ gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity', stampedAt: '2026-08-27T01:00:01.000Z' } })],
    ['unbound-scorecard', card({ createdBy: 'su-someone-else' })],
  ] as const)('returns typed %s rather than treating the event as evidence', (code, ledgerCard) => {
    const result = validatePilotGradeReceipt({
      binding: gradeBinding(),
      returnedCardId: 'EI-CARD-1',
      rubricRef: 'pilot-quality',
      closedAtMs: CLOSED,
      cards: [ledgerCard],
    });
    expect(result.receipt).toBeNull();
    expect(result.gaps).toContainEqual(expect.objectContaining({ code }));
  });
});

describe('pilot receipt-derived cost windows', () => {
  it('derives the immutable start from binding issue time and the end from canonical close', () => {
    const result = derivePilotReceiptCostWindows({
      itemId: 'WI-1',
      arm: 'A',
      closedAtMs: CLOSED,
      bindings: [binding()],
      dispatches: [dispatch()],
    });
    expect(result).toMatchObject({
      ok: true,
      windows: [{
        bindingReceiptId: 'bind-1',
        dispatchReceiptId: 'dispatch-1',
        startMs: CLOSED - 5_000,
        endMs: CLOSED,
        evidenceSource: 'binding-dispatch-receipts',
      }],
    });
  });

  it('requires two distinct, role-correct windows for arm C', () => {
    const result = derivePilotReceiptCostWindows({
      itemId: 'WI-1',
      arm: 'C',
      closedAtMs: CLOSED,
      bindings: [
        binding({ receiptId: 'bind-d', ownerId: 'su-d', sessionId: 's-d', role: 'director' }),
        binding({ receiptId: 'bind-i', ownerId: 'su-i', sessionId: 's-i', role: 'implementer' }),
      ],
      dispatches: [
        dispatch({ receiptId: 'dispatch-d', bindingReceiptId: 'bind-d', ownerId: 'su-d', sessionId: 's-d', role: 'director' }),
        dispatch({ receiptId: 'dispatch-i', bindingReceiptId: 'bind-i', ownerId: 'su-i', sessionId: 's-i', role: 'implementer' }),
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.windows.map((window) => window.role).sort()).toEqual(['director', 'implementer']);
  });

  it.each([
    ['missing-dispatch-receipt', []],
    ['pre-binding-dispatch', [dispatch({ dispatchedAtMs: CLOSED - 6_000 })]],
    ['post-terminal-dispatch', [dispatch({ dispatchedAtMs: CLOSED + 1 })]],
    ['dispatch-receipt-mismatch', [dispatch({ sessionId: 'different-session' })]],
  ] as const)('fails closed with typed %s', (code, dispatches) => {
    const result = derivePilotReceiptCostWindows({
      itemId: 'WI-1',
      arm: 'B',
      closedAtMs: CLOSED,
      bindings: [binding()],
      dispatches,
    });
    expect(result.windows).toEqual([]);
    expect(result.gaps).toContainEqual(expect.objectContaining({ code }));
  });
});
