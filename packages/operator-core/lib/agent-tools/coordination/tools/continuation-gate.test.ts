import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_CEILING_PCT,
  evaluateContinuationGate,
  continuationGateFromReads,
  countPendingInterrupts,
  isPendingInterrupt,
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

describe('isPendingInterrupt / countPendingInterrupts (WI-4179 — machinery is not an interrupt)', () => {
  it('drops CATEGORIZED system broadcasts (the watchdog severe-event[-resolved] firehose)', () => {
    expect(isPendingInterrupt({ category: 'severe-event-resolved' })).toBe(false);
    expect(isPendingInterrupt({ category: 'severe-event' })).toBe(false);
    expect(isPendingInterrupt({ category: 'service-health' })).toBe(false);
  });

  it('drops auto lifecycle chatter and peers’ intent declares', () => {
    expect(isPendingInterrupt({ auto: true, lifecycle: 'claim' })).toBe(false);
    expect(isPendingInterrupt({ lifecycle: 'intent' })).toBe(false);
  });

  it('KEEPS deliberate messages: directed peer mail, owner-directive relays, uncategorized system nags', () => {
    expect(isPendingInterrupt({})).toBe(true); // a plain peer message
    expect(isPendingInterrupt({ lifecycle: 'claim' })).toBe(true); // deliberate (not auto) lifecycle mail
    expect(isPendingInterrupt({ category: '' })).toBe(true); // an empty category is no classification
  });

  it('the live WI-4179 shape: 16 identical watchdog resolution rows + 1 real peer message ⇒ 1, not 17', () => {
    const watchdogRow = { category: 'severe-event-resolved' };
    const unread = [...Array.from({ length: 16 }, () => watchdogRow), { lifecycle: undefined }];
    expect(countPendingInterrupts(unread)).toBe(1);
    // …and the gate verdict follows the corrected count, not the raw length.
    expect(evaluateContinuationGate({ contextPct: 20, unreadInbox: countPendingInterrupts(unread.slice(0, 16)) }).shouldContinue).toBe(true);
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

  it('passes rewakeGuaranteed through to the verdict', () => {
    expect(continuationGateFromReads({ contextTokens: 40, compactionLimit: 100, unreadInbox: 0, rewakeGuaranteed: true }).rewakeGuaranteed).toBe(true);
    expect(continuationGateFromReads({ contextTokens: 40, compactionLimit: 100, unreadInbox: 0 }).rewakeGuaranteed).toBeNull();
  });
});

describe('re-wake guarantee escalation (kills the "the next wake re-opens the gate" false comfort)', () => {
  it('a CLOSED gate with NO guaranteed re-wake escalates to self-compact / arm-a-wake', () => {
    const v = evaluateContinuationGate({ contextPct: 80, unreadInbox: 0, rewakeGuaranteed: false });
    expect(v.shouldContinue).toBe(false);
    expect(v.rewakeGuaranteed).toBe(false);
    expect(v.guidance).toMatch(/SILENTLY HALT/);
    expect(v.guidance).toMatch(/session:request-compaction/);
    expect(v.guidance).toMatch(/loop:arm|events:await/);
    // and it must NOT hand back the false-comfort "the next wake re-opens the gate"
    expect(v.guidance).not.toMatch(/the next wake re-opens the gate/);
  });

  it('a CLOSED gate WITH a guarantee keeps the base settle guidance', () => {
    const v = evaluateContinuationGate({ contextPct: 80, unreadInbox: 0, rewakeGuaranteed: true });
    expect(v.shouldContinue).toBe(false);
    expect(v.guidance).toMatch(/the next wake re-opens the gate/);
    expect(v.guidance).not.toMatch(/SILENTLY HALT/);
  });

  it('unknown (null/absent) re-wake keeps the base guidance — non-breaking', () => {
    const v = evaluateContinuationGate({ contextPct: 80, unreadInbox: 0 });
    expect(v.rewakeGuaranteed).toBeNull();
    expect(v.guidance).toMatch(/the next wake re-opens the gate/);
    expect(v.guidance).not.toMatch(/SILENTLY HALT/);
  });

  it('an OPEN gate ignores rewakeGuaranteed (the wake only matters at settle)', () => {
    const v = evaluateContinuationGate({ contextPct: 30, unreadInbox: 0, rewakeGuaranteed: false });
    expect(v.shouldContinue).toBe(true);
    expect(v.guidance).toMatch(/continuation gate OPEN/);
    expect(v.guidance).not.toMatch(/SILENTLY HALT/);
  });
});

// EI-20209826138488049 / EI-20212450572990141: the escalation above used to
// prescribe session:request-compaction FIRST — to sessions that structurally
// cannot run it. A headless/autonomous member has no psu-pty host, so the call
// refuses (no_live_pty_host) and the session spends its LAST turn discovering
// that. The remedy is selected from the SAME predicate request-compaction
// itself evaluates (selfCompactionAvailability), never a proxy for "is this
// session headless".
describe('remedy selection by self-compaction availability', () => {
  const closedNoRewake = { contextPct: 80, unreadInbox: 0, rewakeGuaranteed: false as const };
  const armIndex = (g: string) => g.search(/loop:arm/);
  const compactIndex = (g: string) => g.search(/session:request-compaction/);

  it('UNAVAILABLE ⇒ never prescribes the call that would refuse', () => {
    const v = evaluateContinuationGate({ ...closedNoRewake, selfCompactionAvailable: false });
    expect(v.selfCompactionAvailable).toBe(false);
    expect(v.guidance).toMatch(/SILENTLY HALT/);
    expect(v.guidance).toMatch(/loop:arm/);
    // The whole point: the tool that CANNOT succeed here is named only to be
    // RULED OUT — never offered as a remedy the session should reach for.
    expect(v.guidance).toMatch(/NOT available to this session/);
    expect(v.guidance).toMatch(/do not spend your last turn on it/);
    expect(v.guidance).not.toMatch(/or SELF-COMPACT/);
  });

  it('AVAILABLE ⇒ offers both, and still leads with arming', () => {
    const v = evaluateContinuationGate({ ...closedNoRewake, selfCompactionAvailable: true });
    expect(v.selfCompactionAvailable).toBe(true);
    expect(v.guidance).toMatch(/session:request-compaction/);
    expect(v.guidance).toMatch(/loop:arm/);
    expect(armIndex(v.guidance)).toBeLessThan(compactIndex(v.guidance));
  });

  it('UNKNOWN ⇒ non-breaking: both remedies, arming first, with the refusal named', () => {
    const v = evaluateContinuationGate(closedNoRewake);
    expect(v.selfCompactionAvailable).toBeNull();
    expect(v.guidance).toMatch(/session:request-compaction/);
    expect(armIndex(v.guidance)).toBeLessThan(compactIndex(v.guidance));
    // unknown must WARN about the refusal rather than pretend the call is safe
    expect(v.guidance).toMatch(/no_live_pty_host/);
  });

  it('arming leads in EVERY branch — the diagnosed condition is the missing re-wake, and only loop:arm removes it', () => {
    for (const selfCompactionAvailable of [true, false, null]) {
      const g = evaluateContinuationGate({ ...closedNoRewake, selfCompactionAvailable }).guidance;
      expect(armIndex(g)).toBeGreaterThanOrEqual(0);
      if (compactIndex(g) >= 0) expect(armIndex(g)).toBeLessThan(compactIndex(g));
    }
  });

  it('availability only steers a CLOSED gate with no re-wake — never an open one', () => {
    const open = evaluateContinuationGate({ contextPct: 30, unreadInbox: 0, rewakeGuaranteed: false, selfCompactionAvailable: false });
    expect(open.shouldContinue).toBe(true);
    expect(open.guidance).toMatch(/continuation gate OPEN/);
    const guaranteed = evaluateContinuationGate({ contextPct: 80, unreadInbox: 0, rewakeGuaranteed: true, selfCompactionAvailable: false });
    expect(guaranteed.guidance).toMatch(/the next wake re-opens the gate/);
    // the verdict still REPORTS the reading it was given, in both cases
    expect(open.selfCompactionAvailable).toBe(false);
    expect(guaranteed.selfCompactionAvailable).toBe(false);
  });

  it('continuationGateFromReads passes selfCompactionAvailable through to the verdict', () => {
    const base = { contextTokens: 80, compactionLimit: 100, unreadInbox: 0, rewakeGuaranteed: false as const };
    expect(continuationGateFromReads({ ...base, selfCompactionAvailable: false }).selfCompactionAvailable).toBe(false);
    expect(continuationGateFromReads({ ...base, selfCompactionAvailable: true }).selfCompactionAvailable).toBe(true);
    expect(continuationGateFromReads(base).selfCompactionAvailable).toBeNull();
    // and the pass-through actually reaches the guidance, not just the field
    expect(continuationGateFromReads({ ...base, selfCompactionAvailable: false }).guidance).toMatch(/NOT available to this session/);
  });
});
