import { describe, it, expect } from 'vitest';
import {
  assessBlockerLiveness,
  formatWaitDuration,
  BLOCKER_WAIT_SURFACE_MS,
  type LoopBlockedOnRecord,
  type BlockerLiveness,
} from './loop-blocker-liveness';

const NOW = Date.parse('2026-09-05T14:20:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The measured incident: blocked on a peer that went suspect, then ended. */
const agentBlocker = (over: Partial<LoopBlockedOnRecord> = {}): LoopBlockedOnRecord => ({
  reason: 'freeze imposed by su-d6ae254f, cannot touch the tree until it lifts',
  kind: 'agent',
  ref: 'su-d6ae254f',
  since: iso(2.5 * HOUR),
  ...over,
});

const live = (over: Partial<BlockerLiveness> = {}): BlockerLiveness => ({
  sessionState: 'live',
  lastActiveMsAgo: 30_000,
  ...over,
});

describe('assessBlockerLiveness — silence discipline', () => {
  it('says nothing when the loop declared no blocker', () => {
    expect(assessBlockerLiveness(null, live(), NOW)).toEqual({ note: null, trigger: null });
    expect(assessBlockerLiveness(undefined, live(), NOW)).toEqual({ note: null, trigger: null });
  });

  it('says nothing when the reason is blank — a blocker with no stated reason is not a blocker', () => {
    expect(assessBlockerLiveness(agentBlocker({ reason: '   ' }), live({ sessionState: 'ended' }), NOW).note).toBeNull();
  });

  it('NEVER ANNOUNCES WHAT WAS NOT MEASURED: an unresolved sessionState yields no line, not a reassuring one', () => {
    // The oracle's explicit unknown. The wait is young, so the clock branch is silent
    // too — leaving exactly one reason this could speak, and it must not.
    const v = assessBlockerLiveness(agentBlocker({ since: iso(5 * MIN) }), { sessionState: null }, NOW);
    expect(v).toEqual({ note: null, trigger: null });
  });

  it('says nothing for a healthy blocker inside the clock — a reassurance every wake would become scenery', () => {
    const v = assessBlockerLiveness(agentBlocker({ since: iso(10 * MIN) }), live(), NOW);
    expect(v).toEqual({ note: null, trigger: null });
  });
});

describe('assessBlockerLiveness — a DEAD blocker is stamped immediately', () => {
  it("stamps 'ended' with the id, the state and the wait, and directs a RELAUNCH not a wake", () => {
    const v = assessBlockerLiveness(agentBlocker(), live({ sessionState: 'ended', lastActiveMsAgo: 30 * MIN }), NOW);
    expect(v.trigger).toBe('blocker-dead');
    expect(v.note).toContain('su-d6ae254f');
    expect(v.note).toContain("sessionState='ended'");
    expect(v.note).toContain('2h 30m');
    expect(v.note).toMatch(/RELAUNCH/);
    expect(v.note).toMatch(/OWN THE UNBLOCK/);
  });

  it("treats 'recorded' as dead too", () => {
    expect(assessBlockerLiveness(agentBlocker(), live({ sessionState: 'recorded' }), NOW).trigger).toBe('blocker-dead');
  });

  it('does NOT wait for the elapsed clock — a dead blocker on a brand-new wait still speaks', () => {
    // The whole point: waiting an hour to report a wait that is ALREADY invalid would
    // rebuild the delay this module removes.
    const v = assessBlockerLiveness(
      agentBlocker({ since: iso(1 * MIN) }),
      live({ sessionState: 'ended' }),
      NOW,
    );
    expect(v.trigger).toBe('blocker-dead');
  });

  it('still speaks when `since` is missing entirely, just without a duration', () => {
    const v = assessBlockerLiveness(agentBlocker({ since: null }), live({ sessionState: 'ended' }), NOW);
    expect(v.trigger).toBe('blocker-dead');
    expect(v.note).not.toMatch(/waiting\s+\d/);
  });
});

describe('assessBlockerLiveness — SUSPECT is the last defensible wake', () => {
  it("stamps 'suspect' and asks for direct evidence of progress rather than another interval", () => {
    const v = assessBlockerLiveness(agentBlocker(), live({ sessionState: 'suspect' }), NOW);
    expect(v.trigger).toBe('blocker-suspect');
    expect(v.note).toContain("sessionState='suspect'");
    expect(v.note).toMatch(/STRANDED/);
  });
});

describe('assessBlockerLiveness — the CLOCK', () => {
  it('speaks once the wait crosses the threshold even though the blocker is perfectly alive', () => {
    const v = assessBlockerLiveness(agentBlocker({ since: iso(BLOCKER_WAIT_SURFACE_MS + MIN) }), live(), NOW);
    expect(v.trigger).toBe('wait-exceeded-clock');
    expect(v.note).toMatch(/CLOCK/);
  });

  it('is silent one minute BELOW the threshold and speaks one minute above — the boundary is real', () => {
    const below = assessBlockerLiveness(agentBlocker({ since: iso(BLOCKER_WAIT_SURFACE_MS - MIN) }), live(), NOW);
    const above = assessBlockerLiveness(agentBlocker({ since: iso(BLOCKER_WAIT_SURFACE_MS + MIN) }), live(), NOW);
    expect(below.trigger).toBeNull();
    expect(above.trigger).toBe('wait-exceeded-clock');
  });

  it('applies to a NON-agent blocker, which has no liveness oracle at all', () => {
    // A 'process'/'owner'/'other' blocker gets no liveness verdict by design, but the
    // elapsed clock needs no oracle — so the one branch that can still help, does.
    const v = assessBlockerLiveness(
      { reason: 'waiting on the owner to fund the account', kind: 'owner', ref: 'WI-1', since: iso(3 * HOUR) },
      { sessionState: null },
      NOW,
    );
    expect(v.trigger).toBe('wait-exceeded-clock');
  });

  it('does not fabricate a duration from an unparseable or future `since`', () => {
    const bad = assessBlockerLiveness(agentBlocker({ since: 'not-a-date' }), live(), NOW);
    const future = assessBlockerLiveness(agentBlocker({ since: iso(-5 * HOUR) }), live(), NOW);
    expect(bad.trigger).toBeNull();
    expect(future.trigger).toBeNull();
  });
});

describe('assessBlockerLiveness — LIVENESS IS NOT CLEARANCE (D-003 boundary)', () => {
  it('never claims a blocker CLEARED, even when the agent is dead', () => {
    const v = assessBlockerLiveness(agentBlocker(), live({ sessionState: 'ended' }), NOW);
    expect(v.note).not.toMatch(/cleared/i);
    expect(v.note).not.toMatch(/resolved/i);
  });

  it('gives NO liveness verdict for a kind that has no oracle, even with a live-looking reading', () => {
    // kind:'process' must not borrow the agent branch: a process's liveness is not
    // answerable from sessionState, and a guessed verdict is worse than none.
    const v = assessBlockerLiveness(
      { reason: 'the migration job is running', kind: 'process', ref: 'task-9', since: iso(2 * MIN) },
      live({ sessionState: 'ended' }),
      NOW,
    );
    expect(v.trigger).toBeNull();
  });

  it('gives no agent verdict when the ref is missing — prose alone is not diffable', () => {
    const v = assessBlockerLiveness(
      { reason: 'blocked on whoever holds the freeze', kind: 'agent', ref: null, since: iso(2 * MIN) },
      live({ sessionState: 'ended' }),
      NOW,
    );
    expect(v.trigger).toBeNull();
  });
});

describe('formatWaitDuration', () => {
  it('renders the way a reader reasons about a wait', () => {
    expect(formatWaitDuration(30_000)).toBe('under a minute');
    expect(formatWaitDuration(14 * MIN)).toBe('14m');
    expect(formatWaitDuration(2 * HOUR)).toBe('2h');
    expect(formatWaitDuration(2 * HOUR + 39 * MIN)).toBe('2h 39m');
  });

  it('does not invent a duration from a nonsense input', () => {
    expect(formatWaitDuration(Number.NaN)).toBe('an unknown time');
    expect(formatWaitDuration(-1)).toBe('an unknown time');
  });
});
