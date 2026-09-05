import { describe, it, expect } from 'vitest';
import {
  assessBlockerLiveness,
  formatWaitDuration,
  resolveBlockedSince,
  suggestBlockerRef,
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

describe('resolveBlockedSince — the clock must survive a re-arm', () => {
  const NOW_ISO = new Date(NOW).toISOString();

  it('CARRIES the origin forward across a re-arm of the same blocker — without this the elapsed-wait branch is unreachable', () => {
    // The defect this guards is silent and total. An AUTO loop re-arms every wake, and a
    // blocked agent re-arms while still blocked on the very same thing — so a restamped
    // `since` would reset the measured wait to ~0 forever, and 'wait-exceeded-clock'
    // would never once fire while looking entirely implemented.
    const prior = agentBlocker({ since: iso(2.5 * HOUR) });
    const next = agentBlocker({ since: undefined });
    expect(resolveBlockedSince(next, prior, NOW_ISO)).toBe(prior.since);

    // ...and here is that reachability, shown rather than asserted: ONE record, both
    // origins, opposite verdicts. This is the assertion that fails if anyone "simplifies"
    // the carry-forward away.
    const carried = { ...next, since: resolveBlockedSince(next, prior, NOW_ISO) };
    const restamped = { ...next, since: NOW_ISO };
    expect(assessBlockerLiveness(carried, live({ sessionState: 'live' }), NOW).trigger).toBe(
      'wait-exceeded-clock',
    );
    expect(assessBlockerLiveness(restamped, live({ sessionState: 'live' }), NOW).trigger).toBeNull();
  });

  it('RESETS when the blocker genuinely changes — a new wait is a new clock', () => {
    const prior = agentBlocker({ ref: 'su-d6ae254f', since: iso(2.5 * HOUR) });
    expect(resolveBlockedSince(agentBlocker({ ref: 'su-other' }), prior, NOW_ISO)).toBe(NOW_ISO);
  });

  it('identifies a ref-less blocker by its reason, since it has nothing else to be identified by', () => {
    const prior: LoopBlockedOnRecord = { reason: 'green gate red', since: iso(3 * HOUR) };
    expect(resolveBlockedSince({ reason: '  GREEN GATE RED  ' }, prior, NOW_ISO)).toBe(prior.since);
    expect(resolveBlockedSince({ reason: 'a different wait' }, prior, NOW_ISO)).toBe(NOW_ISO);
  });

  it('never carries an origin between a ref-less and a ref-bearing blocker', () => {
    const priorNoRef: LoopBlockedOnRecord = { reason: 'same words', since: iso(3 * HOUR) };
    const nextWithRef = { reason: 'same words', kind: 'agent' as const, ref: 'su-abc' };
    expect(resolveBlockedSince(nextWithRef, priorNoRef, NOW_ISO)).toBe(NOW_ISO);
    expect(resolveBlockedSince({ reason: 'same words' }, nextWithRef, NOW_ISO)).toBe(NOW_ISO);
  });

  it('stamps now when there is no prior, or its origin is missing or unparseable', () => {
    expect(resolveBlockedSince(agentBlocker(), null, NOW_ISO)).toBe(NOW_ISO);
    expect(resolveBlockedSince(agentBlocker(), agentBlocker({ since: null }), NOW_ISO)).toBe(NOW_ISO);
    expect(resolveBlockedSince(agentBlocker(), agentBlocker({ since: 'not-a-date' }), NOW_ISO)).toBe(
      NOW_ISO,
    );
  });
});

describe('suggestBlockerRef — closing the adoption gap that would make the liveness branch unreachable', () => {
  it('finds the id a caller named in prose while passing no ref — the measured 127-of-1014 case', () => {
    expect(
      suggestBlockerRef({ reason: 'freeze imposed by su-d6ae254f, cannot touch the tree' }),
    ).toBe('su-d6ae254f');
    expect(suggestBlockerRef({ reason: 'waiting on cup-9f3a1b2c to finish the migration' })).toBe(
      'cup-9f3a1b2c',
    );
  });

  it('says nothing when the blocker is ALREADY structured — the nudge is for the gap, not for everyone', () => {
    expect(
      suggestBlockerRef({ reason: 'freeze imposed by su-d6ae254f', ref: 'su-d6ae254f' }),
    ).toBeNull();
  });

  it('says nothing when no agent id is named, so a gate or deploy blocker is never nagged', () => {
    expect(suggestBlockerRef({ reason: 'green gate red 8h, blocking every deploy' })).toBeNull();
    expect(suggestBlockerRef({ reason: 'waiting on WI-2145833 to land' })).toBeNull();
    expect(suggestBlockerRef(null)).toBeNull();
    expect(suggestBlockerRef({})).toBeNull();
  });
});
