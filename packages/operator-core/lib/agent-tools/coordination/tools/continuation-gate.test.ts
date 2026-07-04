import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_CEILING_PCT,
  evaluateContinuationGate,
  continuationGateFromReads,
} from './continuation-gate';
import { COMPACTION_HINT_PCT } from './inbox-context-usage';
import { FLUSH_GATE_PCT } from './inbox-flush-gate';

describe('evaluateContinuationGate (P-005 continuation gate)', () => {
  it('OPENS when context has headroom and the inbox is empty', () => {
    const v = evaluateContinuationGate({ contextPct: 40, unreadInbox: 0 });
    expect(v.shouldContinue).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.contextHeadroom).toBe(true);
    expect(v.guidance).toMatch(/continuation gate OPEN/);
    expect(v.guidance).toMatch(/flush/i); // still tells the agent to checkpoint first
  });

  it('CLOSES at/above the context ceiling', () => {
    const v = evaluateContinuationGate({ contextPct: CONTINUATION_CEILING_PCT, unreadInbox: 0 });
    expect(v.shouldContinue).toBe(false);
    expect(v.contextHeadroom).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/60% continuation ceiling/);
    expect(v.guidance).toMatch(/continuation gate CLOSED/);
  });

  it('stays OPEN just below the ceiling', () => {
    const v = evaluateContinuationGate({ contextPct: CONTINUATION_CEILING_PCT - 1, unreadInbox: 0 });
    expect(v.shouldContinue).toBe(true);
  });

  it('CLOSES on a pending inbox interrupt (singular vs plural wording)', () => {
    const one = evaluateContinuationGate({ contextPct: 30, unreadInbox: 1 });
    expect(one.shouldContinue).toBe(false);
    expect(one.reasons.join(' ')).toMatch(/1 unread inbox message /);
    const many = evaluateContinuationGate({ contextPct: 30, unreadInbox: 3 });
    expect(many.reasons.join(' ')).toMatch(/3 unread inbox messages/);
  });

  it('fails SAFE toward settle when context is unknown (null)', () => {
    const v = evaluateContinuationGate({ contextPct: null, unreadInbox: 0 });
    expect(v.shouldContinue).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/context usage unknown/);
  });

  it('fails SAFE toward settle when the inbox could not be evaluated (null)', () => {
    const v = evaluateContinuationGate({ contextPct: 20, unreadInbox: null });
    expect(v.shouldContinue).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/inbox not evaluated/);
  });

  it('reports BOTH blocking legs when both fail', () => {
    const v = evaluateContinuationGate({ contextPct: 90, unreadInbox: 5 });
    expect(v.shouldContinue).toBe(false);
    expect(v.reasons).toHaveLength(2);
  });

  it('honors a custom ceiling', () => {
    expect(evaluateContinuationGate({ contextPct: 50, unreadInbox: 0, ceilingPct: 40 }).shouldContinue).toBe(false);
    expect(evaluateContinuationGate({ contextPct: 50, unreadInbox: 0, ceilingPct: 70 }).shouldContinue).toBe(true);
  });

  it('the continuation ceiling sits BELOW the flush gate and the compaction hint', () => {
    // You stop STARTING new units (60%) well before the flush gate (75%) and the
    // compaction-urgent zone (85%) — the layering the spec fixes.
    expect(CONTINUATION_CEILING_PCT).toBeLessThan(FLUSH_GATE_PCT);
    expect(FLUSH_GATE_PCT).toBeLessThan(COMPACTION_HINT_PCT);
  });
});

describe('continuationGateFromReads (raw presence + inbox reads)', () => {
  it('derives contextPct from tokens/limit then delegates', () => {
    const v = continuationGateFromReads({ contextTokens: 40, compactionLimit: 100, unreadInbox: 0 });
    expect(v.contextPct).toBe(40);
    expect(v.shouldContinue).toBe(true);
  });

  it('null tokens ⇒ unknown context ⇒ settle', () => {
    const v = continuationGateFromReads({ contextTokens: null, compactionLimit: 100, unreadInbox: 0 });
    expect(v.contextPct).toBeNull();
    expect(v.shouldContinue).toBe(false);
  });

  it('a zero/absent limit ⇒ unknown context ⇒ settle (no divide-by-zero)', () => {
    const v = continuationGateFromReads({ contextTokens: 100, compactionLimit: 0, unreadInbox: 0 });
    expect(v.contextPct).toBeNull();
    expect(v.shouldContinue).toBe(false);
  });
});
