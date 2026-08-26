/**
 * The arm-B gate WIRING (D-021) — as distinct from the verdict logic, which
 * `work-item-self-review.test.ts` already covers.
 *
 * What is asserted here is the part that can break the whole fleet rather than the pilot:
 * that the gate is inert outside arm B, that it refuses on exactly the three verdicts
 * meaning "the review did not happen", and that it PERMITS the zero-findings case D-020
 * explicitly protects.
 */
import { describe, it, expect } from 'vitest';

import {
  SELF_REVIEW_REFUSING_VERDICTS,
  type SelfReviewJudgement,
  type SelfReviewVerdict,
  itemIsArmB,
  judgeSelfReview,
  selfReviewRefusal,
} from './work-item-self-review.js';
import { CompletionRecordSchema } from './coord-lifecycle/records.js';
import { COMPLETION_FIELDS } from './agent-tools/work_items/completion-coerce.js';

const judgement = (over: Partial<SelfReviewJudgement>): SelfReviewJudgement => ({
  verdict: 'corroborated',
  reviewCalls: [],
  rubberStampRisk: false,
  yieldedChange: false,
  ...over,
});

/** Every verdict `judgeSelfReview` can actually emit, produced rather than hand-listed. */
const REACHABLE_VERDICTS: readonly SelfReviewVerdict[] = [
  judgeSelfReview({ evidence: undefined, ledger: [] }).verdict, // not-claimed
  judgeSelfReview({ evidence: { lookedAt: 'the diff' }, ledger: [] }).verdict, // uncorroborated
  judgeSelfReview({
    evidence: { lookedAt: 'the diff' },
    ledger: [
      { toolName: 'capability:read', invokedAtMs: 1_000 },
      { toolName: 'capability:edit', invokedAtMs: 2_000 },
    ],
  }).verdict, // stale-review
  judgeSelfReview({
    evidence: { lookedAt: 'the diff' },
    ledger: [
      { toolName: 'capability:edit', invokedAtMs: 1_000 },
      { toolName: 'capability:read', invokedAtMs: 2_000 },
    ],
  }).verdict, // corroborated
];

describe('the gate is INERT outside arm B', () => {
  it('does not fire for arm A, arm C, an unassigned item, or a null payload', () => {
    // The regression that would break every close in the fleet, not merely the pilot:
    // `work_items:complete` is the one verb no agent can route around.
    expect(itemIsArmB({ payload: { pilotArm: 'A' } })).toBe(false);
    expect(itemIsArmB({ payload: { pilotArm: 'C' } })).toBe(false);
    expect(itemIsArmB({ payload: {} })).toBe(false);
    expect(itemIsArmB({ payload: null })).toBe(false);
    expect(itemIsArmB(null)).toBe(false);
    expect(itemIsArmB(undefined)).toBe(false);
  });

  it('fires for arm B in either case', () => {
    expect(itemIsArmB({ payload: { pilotArm: 'B' } })).toBe(true);
    expect(itemIsArmB({ payload: { pilotArm: 'b' } })).toBe(true);
  });
});

describe('selfReviewRefusal', () => {
  it('refuses on exactly the three verdicts that mean the review did not happen', () => {
    for (const verdict of ['not-claimed', 'uncorroborated', 'stale-review'] as const) {
      const message = selfReviewRefusal(judgement({ verdict }), 'WI-1');
      expect(message, verdict).toBeDefined();
      expect(message).toContain('WI-1');
      expect(message).toContain(verdict);
    }
  });

  it('PERMITS a corroborated review that found nothing — D-020 protects this case', () => {
    // Refusing a zero-findings review would teach agents to invent findings, which is
    // worse than the rubber-stamping the gate targets.
    expect(
      selfReviewRefusal(
        judgement({ verdict: 'corroborated', rubberStampRisk: true }),
        'WI-1',
      ),
    ).toBeUndefined();
  });

  it('PERMITS a corroborated review regardless of whether it yielded a change', () => {
    for (const yieldedChange of [true, false]) {
      expect(
        selfReviewRefusal(judgement({ verdict: 'corroborated', yieldedChange }), 'WI-1'),
      ).toBeUndefined();
    }
  });

  it('tells the caller how to comply, and that empty findings are acceptable', () => {
    // A refusal that names the problem but not the remedy is a wall, not a gate.
    const message = selfReviewRefusal(judgement({ verdict: 'not-claimed' }), 'WI-1')!;
    expect(message).toContain('completion.selfReview');
    expect(message).toContain('lookedAt');
    expect(message).toMatch(/EMPTY findings array is accepted/i);
  });

  it('carries the judgement reason through when there is one', () => {
    const message = selfReviewRefusal(
      judgement({ verdict: 'uncorroborated', reason: 'rests on prose alone' }),
      'WI-1',
    );
    expect(message).toContain('rests on prose alone');
  });

  it('classifies EVERY verdict the judge can actually emit', () => {
    // Falsifiability control: a verdict added later must be deliberately classified
    // rather than silently defaulting to "allowed" at the call site.
    for (const verdict of REACHABLE_VERDICTS) {
      const refuses = SELF_REVIEW_REFUSING_VERDICTS.has(verdict);
      const message = selfReviewRefusal(judgement({ verdict }), 'WI-1');
      expect(Boolean(message), verdict).toBe(refuses);
    }
    // ...and the judge really does reach all four, so the loop above is not vacuous.
    expect(new Set(REACHABLE_VERDICTS).size).toBe(4);
  });
});

describe('CompletionRecordSchema.selfReview', () => {
  const base = { workItem: 'WI-1', summary: 'did the thing' };

  it('stays OPTIONAL — arms A and C, and every close outside the pilot, omit it', () => {
    // Making it required would strand every caller of work_items:complete.
    expect(CompletionRecordSchema.parse(base).selfReview).toBeUndefined();
  });

  it('round-trips a full review record', () => {
    const parsed = CompletionRecordSchema.parse({
      ...base,
      selfReview: {
        lookedAt: 'the diff for complete.ts',
        findings: ['missed a null case'],
        changedAsResult: ['added the guard'],
      },
    });
    expect(parsed.selfReview).toEqual({
      lookedAt: 'the diff for complete.ts',
      findings: ['missed a null case'],
      changedAsResult: ['added the guard'],
    });
  });

  it('accepts an EMPTY findings array as a recorded outcome', () => {
    const parsed = CompletionRecordSchema.parse({
      ...base,
      selfReview: { lookedAt: 'the diff', findings: [] },
    });
    expect(parsed.selfReview?.findings).toEqual([]);
  });

  it('is recognised as a structured completion field, not free-text residue', () => {
    expect(COMPLETION_FIELDS).toContain('selfReview');
  });
});
