/**
 * Acceptance for the outreach send-approval gate (fundraise-automation-2026-08-23 P-004 / P-015).
 *
 * ── Why the positive controls are not filler ─────────────────────────────────
 * Almost every test in this file asserts a REFUSAL, and a gate that simply returned
 * `{ allowed: false }` for everything would pass all of them while being completely broken — it
 * would also block the one path the design depends on (a human-approved send actually going out).
 * The `allows the send` cases are therefore the calibration: they prove the deny-tests are
 * measuring a discriminating gate rather than a stuck one. Any future edit that makes the gate
 * unconditionally strict fails here, which is the point.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateOutreach,
  assertOutreachAllowed,
  OUTREACH_APPROVAL_MAX_AGE_MS,
  type OutreachDealView,
} from './outreach-approval';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();
const DRAFT = 'draft-abc123';

function deal(overrides: Partial<OutreachDealView> = {}): OutreachDealView {
  return {
    counterparty: 'Example Capital',
    stage: 'contacted',
    outreachApproval: {
      state: 'approved',
      scope: 'thread',
      approvedBy: 'owner@example.com',
      approvedAt: FRESH,
      draftRef: DRAFT,
    },
    ...overrides,
  };
}

const send = { kind: 'send', draftRef: DRAFT, isFirstTouch: false } as const;

describe('outreach approval gate — drafting', () => {
  it('always allows drafting, even with no approval at all', () => {
    const decision = evaluateOutreach(
      { counterparty: 'X', stage: 'sourced' },
      { kind: 'draft' },
      NOW,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('draft-always-allowed');
  });

  it('allows drafting even when the deal record is unreadable', () => {
    expect(evaluateOutreach(null, { kind: 'draft' }, NOW).allowed).toBe(true);
    expect(evaluateOutreach('nonsense', { kind: 'draft' }, NOW).allowed).toBe(true);
  });

  it('allows drafting on a passed deal (the pass acknowledgement is itself a draft)', () => {
    expect(evaluateOutreach(deal({ stage: 'lost' }), { kind: 'draft' }, NOW).allowed).toBe(true);
  });
});

describe('outreach approval gate — positive control', () => {
  it('allows the send when a fresh, in-scope, content-bound approval is present', () => {
    const decision = evaluateOutreach(deal(), send, NOW);
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('approved');
    expect(decision.reason).toContain('owner@example.com');
  });

  it('allows a first touch under a first-touch approval that has not been used', () => {
    const decision = evaluateOutreach(
      deal({
        outreachApproval: {
          state: 'approved',
          scope: 'first-touch',
          approvedBy: 'owner@example.com',
          approvedAt: FRESH,
          draftRef: DRAFT,
        },
        lastOutboundAt: undefined,
      }),
      { kind: 'send', draftRef: DRAFT, isFirstTouch: true },
      NOW,
    );
    expect(decision.allowed).toBe(true);
  });

  it('allows a subsequent send under an `all` scope', () => {
    const decision = evaluateOutreach(
      deal({
        outreachApproval: {
          state: 'approved',
          scope: 'all',
          approvedBy: 'owner@example.com',
          approvedAt: FRESH,
          draftRef: DRAFT,
        },
        lastOutboundAt: FRESH,
      }),
      send,
      NOW,
    );
    expect(decision.allowed).toBe(true);
  });

  it('assertOutreachAllowed stays silent on an allowed action', () => {
    expect(() => assertOutreachAllowed(deal(), send, NOW)).not.toThrow();
  });
});

describe('outreach approval gate — fails closed on unknowns', () => {
  it('denies a send when the deal record is unreadable', () => {
    expect(evaluateOutreach(null, send, NOW)).toMatchObject({
      allowed: false,
      code: 'malformed-approval',
    });
  });

  it('denies a send with no approval record', () => {
    expect(
      evaluateOutreach({ counterparty: 'X', stage: 'contacted' }, send, NOW),
    ).toMatchObject({ allowed: false, code: 'no-approval-record' });
  });

  it('denies a send when the approval is not an object', () => {
    expect(
      evaluateOutreach({ stage: 'contacted', outreachApproval: 'approved' }, send, NOW),
    ).toMatchObject({ allowed: false, code: 'malformed-approval' });
  });

  it('denies a send on an unrecognised approval state', () => {
    expect(
      evaluateOutreach(
        { stage: 'contacted', outreachApproval: { state: 'yes-obviously' } },
        send,
        NOW,
      ),
    ).toMatchObject({ allowed: false, code: 'malformed-approval' });
  });

  it.each(['not-requested', 'pending'] as const)('denies a send while approval is %s', (state) => {
    expect(
      evaluateOutreach(
        deal({ outreachApproval: { state, scope: 'all', approvedAt: FRESH, draftRef: DRAFT } }),
        send,
        NOW,
      ),
    ).toMatchObject({ allowed: false, code: 'not-approved' });
  });

  it('denies a send once approval is revoked', () => {
    expect(
      evaluateOutreach(
        deal({
          outreachApproval: { state: 'revoked', scope: 'all', approvedAt: FRESH, draftRef: DRAFT },
        }),
        send,
        NOW,
      ),
    ).toMatchObject({ allowed: false, code: 'revoked' });
  });
});

describe('outreach approval gate — approval binds to content', () => {
  it('denies a send whose draft differs from the approved one', () => {
    const decision = evaluateOutreach(
      deal(),
      { kind: 'send', draftRef: 'draft-something-else', isFirstTouch: false },
      NOW,
    );
    expect(decision).toMatchObject({ allowed: false, code: 'draft-ref-mismatch' });
    expect(decision.reason).toContain('Re-approve');
  });

  it('denies a send when the approval names no draft', () => {
    expect(
      evaluateOutreach(
        deal({
          outreachApproval: {
            state: 'approved',
            scope: 'all',
            approvedAt: FRESH,
            approvedBy: 'owner@example.com',
          },
        }),
        send,
        NOW,
      ),
    ).toMatchObject({ allowed: false, code: 'draft-ref-missing' });
  });

  it('denies a send that names no draft of its own', () => {
    expect(
      evaluateOutreach(deal(), { kind: 'send', draftRef: '', isFirstTouch: false }, NOW),
    ).toMatchObject({ allowed: false, code: 'draft-ref-missing' });
  });
});

describe('outreach approval gate — freshness', () => {
  it('denies a send under an approval older than the permitted window', () => {
    const stale = new Date(NOW.getTime() - OUTREACH_APPROVAL_MAX_AGE_MS - 1000).toISOString();
    expect(
      evaluateOutreach(deal({ outreachApproval: { ...deal().outreachApproval!, approvedAt: stale } }), send, NOW),
    ).toMatchObject({ allowed: false, code: 'approval-expired' });
  });

  it('allows a send just inside the permitted window (boundary calibration)', () => {
    const edge = new Date(NOW.getTime() - OUTREACH_APPROVAL_MAX_AGE_MS + 1000).toISOString();
    expect(
      evaluateOutreach(deal({ outreachApproval: { ...deal().outreachApproval!, approvedAt: edge } }), send, NOW),
    ).toMatchObject({ allowed: true });
  });

  it('denies a send under a future-dated approval', () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(
      evaluateOutreach(deal({ outreachApproval: { ...deal().outreachApproval!, approvedAt: future } }), send, NOW),
    ).toMatchObject({ allowed: false, code: 'malformed-approval' });
  });

  it('denies a send when approvedAt is unparseable', () => {
    expect(
      evaluateOutreach(
        deal({ outreachApproval: { ...deal().outreachApproval!, approvedAt: 'last tuesday' } }),
        send,
        NOW,
      ),
    ).toMatchObject({ allowed: false, code: 'malformed-approval' });
  });
});

describe('outreach approval gate — scope is never widened by inference', () => {
  it('denies a send when the approval declares no scope', () => {
    const { scope: _dropped, ...rest } = deal().outreachApproval!;
    expect(evaluateOutreach(deal({ outreachApproval: rest }), send, NOW)).toMatchObject({
      allowed: false,
      code: 'scope-missing',
    });
  });

  it('denies a subsequent send under a first-touch approval', () => {
    expect(
      evaluateOutreach(
        deal({ outreachApproval: { ...deal().outreachApproval!, scope: 'first-touch' } }),
        send,
        NOW,
      ),
    ).toMatchObject({ allowed: false, code: 'scope-insufficient' });
  });

  it('denies a first touch when one has already been sent on the deal', () => {
    expect(
      evaluateOutreach(
        deal({
          outreachApproval: { ...deal().outreachApproval!, scope: 'first-touch' },
          lastOutboundAt: FRESH,
        }),
        { kind: 'send', draftRef: DRAFT, isFirstTouch: true },
        NOW,
      ),
    ).toMatchObject({ allowed: false, code: 'first-touch-already-used' });
  });
});

/**
 * Falsifiability control (tier 2: the subject is a module we import, so the deliberately-wrong
 * implementations live here permanently rather than being mutated into the shared tree).
 *
 * These assert that the suite above DISCRIMINATES. Two plausible-looking broken gates are run
 * against the same expectations the real gate satisfies, and each must fail at least one of them.
 * Without this, "27 passing" would be equally true of a gate wired shut in either direction.
 */
describe('outreach approval gate — falsifiability control', () => {
  const alwaysAllow = () => ({ allowed: true, code: 'approved' as const, reason: 'stub' });
  const alwaysDeny = () => ({ allowed: false, code: 'not-approved' as const, reason: 'stub' });

  it('a gate that always allows would be caught by the refusal expectations', () => {
    // The real gate refuses a mismatched draft; the broken one does not.
    expect(evaluateOutreach(deal(), { kind: 'send', draftRef: 'other', isFirstTouch: false }, NOW).allowed)
      .toBe(false);
    expect(alwaysAllow().allowed).toBe(true);
  });

  it('a gate that always denies would be caught by the positive controls', () => {
    // The real gate permits a fully valid approved send; the broken one does not.
    expect(evaluateOutreach(deal(), send, NOW).allowed).toBe(true);
    expect(alwaysDeny().allowed).toBe(false);
  });

  it('the real gate returns BOTH verdicts across the corpus, so it is discriminating', () => {
    const verdicts = new Set([
      evaluateOutreach(deal(), send, NOW).allowed,
      evaluateOutreach(deal({ stage: 'lost' }), send, NOW).allowed,
      evaluateOutreach(deal(), { kind: 'draft' }, NOW).allowed,
      evaluateOutreach(null, send, NOW).allowed,
    ]);
    expect([...verdicts].sort()).toEqual([false, true]);
  });
});

describe('outreach approval gate — stage overrides a stale approval', () => {
  it.each(['lost', 'dormant'] as const)('denies a send on a %s deal despite valid approval', (stage) => {
    const decision = evaluateOutreach(deal({ stage }), send, NOW);
    expect(decision).toMatchObject({ allowed: false, code: 'deal-stage-forbids-contact' });
    expect(decision.reason).toContain(stage);
  });

  it('assertOutreachAllowed throws a coded error on a blocked action', () => {
    expect(() => assertOutreachAllowed(deal({ stage: 'lost' }), send, NOW)).toThrow(
      /outreach_blocked:deal-stage-forbids-contact/,
    );
  });
});
