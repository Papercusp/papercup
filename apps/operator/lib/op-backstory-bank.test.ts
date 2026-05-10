import { describe, it, expect, beforeEach } from 'vitest';
import { BACKSTORY_BANK, eligibleBeats } from './op-backstory-bank';
import {
  backstoryEligibleNow,
  markBeatFired,
  recentlyFiredIds,
  __resetBackstoryStateForTests,
  BACKSTORY_LIMITS,
} from './op-backstory-state';

beforeEach(() => __resetBackstoryStateForTests());

describe('BACKSTORY_BANK shape', () => {
  it('has 10 beats', () => {
    expect(BACKSTORY_BANK).toHaveLength(10);
  });
  it('every beat has a unique id', () => {
    const ids = BACKSTORY_BANK.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('every story is ≤ 240 chars (≈30 words)', () => {
    for (const b of BACKSTORY_BANK) expect(b.story.length).toBeLessThanOrEqual(240);
  });
  it('no story contains real company names', () => {
    const denylist = /\b(google|meta|stripe|openai|anthropic|apple|amazon|microsoft|netflix|uber|github|gitlab|shopify|airbnb|linkedin|tesla|nvidia|salesforce|oracle|ibm|adobe|cloudflare|vercel)\b/i;
    for (const b of BACKSTORY_BANK) {
      expect(b.story).not.toMatch(denylist);
    }
  });
  it('no story contains banned preambles', () => {
    const banned = /\b(this reminds me of|speaking of which|fun story)\b/i;
    for (const b of BACKSTORY_BANK) {
      expect(b.story).not.toMatch(banned);
    }
  });
  it('no story has a moralizing tail', () => {
    for (const b of BACKSTORY_BANK) {
      expect(b.story).not.toMatch(/and the lesson there is/i);
    }
  });
  it('every beat has at least one mode', () => {
    for (const b of BACKSTORY_BANK) {
      expect(b.modes.length).toBeGreaterThan(0);
    }
  });
});

describe('individual triggers — positive + negative', () => {
  it('migration-too-big: replan affecting >50 features', () => {
    const beat = BACKSTORY_BANK.find((b) => b.id === 'migration-too-big')!;
    expect(beat.trigger({ opKind: 'replan', featuresAffected: 51 })).toBe(true);
    expect(beat.trigger({ opKind: 'replan', featuresAffected: 49 })).toBe(false);
    expect(beat.trigger({ opKind: 'cleanup', featuresAffected: 60 })).toBe(true);
    expect(beat.trigger({ opKind: 'supervisor', featuresAffected: 60 })).toBe(false);
  });
  it('lost-work-to-replan: replan with uncommitted changes', () => {
    const beat = BACKSTORY_BANK.find((b) => b.id === 'lost-work-to-replan')!;
    expect(beat.trigger({ opKind: 'replan', uncommittedChanges: true })).toBe(true);
    expect(beat.trigger({ opKind: 'replan', uncommittedChanges: false })).toBe(false);
    expect(beat.trigger({ opKind: 'cleanup', uncommittedChanges: true })).toBe(false);
  });
  it('first-oncall-page: firstSession or sessionAgeMin < 5', () => {
    const beat = BACKSTORY_BANK.find((b) => b.id === 'first-oncall-page')!;
    expect(beat.trigger({ firstSession: true })).toBe(true);
    expect(beat.trigger({ sessionAgeMin: 3 })).toBe(true);
    expect(beat.trigger({ sessionAgeMin: 60 })).toBe(false);
    // Empty ctx: sessionAgeMin is Infinity, firstSession not set → false.
    expect(beat.trigger({})).toBe(false);
  });
});

describe('eligibleBeats', () => {
  it('filters by trigger AND mode', () => {
    const result = eligibleBeats(
      { opKind: 'replan', uncommittedChanges: true },
      ['default'],
    );
    const ids = result.map((b) => b.id);
    expect(ids).toContain('lost-work-to-replan');
    // ignored-escalation requires featureStuckLong
    expect(ids).not.toContain('ignored-escalation');
  });
  it('mode mismatch excludes a beat', () => {
    const result = eligibleBeats(
      { opKind: 'replan', uncommittedChanges: true },
      ['sober'],
    );
    expect(result.find((b) => b.id === 'lost-work-to-replan')).toBeUndefined();
  });
  it('excludeIds removes those beats', () => {
    const all = eligibleBeats({ smokeAfterIncident: true }, ['default']);
    expect(all.find((b) => b.id === 'smoke-test-lied')).toBeDefined();
    const filtered = eligibleBeats({ smokeAfterIncident: true }, ['default'], new Set(['smoke-test-lied']));
    expect(filtered.find((b) => b.id === 'smoke-test-lied')).toBeUndefined();
  });
});

describe('rate-limit state', () => {
  it('starts eligible', () => {
    expect(backstoryEligibleNow(100_000)).toBe(true);
  });
  it('caps at 3 fires per session', () => {
    markBeatFired('a', 100_000);
    markBeatFired('b', 100_000 + 31 * 60_000);
    markBeatFired('c', 100_000 + 62 * 60_000);
    expect(backstoryEligibleNow(100_000 + 93 * 60_000)).toBe(false);
  });
  it('enforces 30-min cooldown', () => {
    markBeatFired('a', 100_000);
    expect(backstoryEligibleNow(100_000 + 5 * 60_000)).toBe(false);
    expect(backstoryEligibleNow(100_000 + 31 * 60_000)).toBe(true);
  });
  it('recent ids include fresh fires, exclude old ones', () => {
    markBeatFired('a', 100_000);
    expect(recentlyFiredIds(100_000 + 60_000)).toContain('a');
    // 8 days later
    expect(recentlyFiredIds(100_000 + 8 * 24 * 60 * 60_000)).not.toContain('a');
  });
  it('eligible pool excludes recent ids', () => {
    markBeatFired('lost-work-to-replan', 100_000);
    const recent = recentlyFiredIds(100_000 + 60_000);
    const result = eligibleBeats(
      { opKind: 'replan', uncommittedChanges: true },
      ['default'],
      recent,
    );
    expect(result.find((b) => b.id === 'lost-work-to-replan')).toBeUndefined();
  });
  it('limits constants are sane', () => {
    expect(BACKSTORY_LIMITS.MAX_PER_SESSION).toBe(3);
    expect(BACKSTORY_LIMITS.COOLDOWN_MS).toBe(30 * 60_000);
    expect(BACKSTORY_LIMITS.NO_REPEAT_MS).toBe(7 * 24 * 60 * 60_000);
  });
});
