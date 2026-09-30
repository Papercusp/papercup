/**
 * core.test.ts — the per-pot learning gate's PURE decisions
 * (plan learning-pot-scope-gate-2026-08-30, P-001 / R-5).
 *
 * The property under test is one line of policy with a large blast radius:
 * **an absent row means ENABLED**. Get it backwards and applying migration 1039
 * — which ships an EMPTY table — silently stops every learning lane in the
 * fleet at once. So the fail-open default is asserted here directly, on every
 * shape a caller can hand it, rather than only implied by an integration test
 * that happens to insert rows first.
 */
import { describe, expect, it } from 'vitest';
import {
  disabledPotSet,
  isDeliberatePause,
  pauseReviewOverdue,
  potScopeEnabled,
  potScopeLookup,
  POT_DISABLED_REASON,
  type PotLearningScope,
} from './core';

function row(potSlug: string, enabled: boolean, pause: Partial<PotLearningScope> = {}): PotLearningScope {
  return {
    workspaceId: 'ws',
    potSlug,
    enabled,
    setBy: 'su-test',
    setAt: 1_700_000_000_000,
    pauseReason: null,
    ownerDirected: false,
    reviewBy: null,
    ...pause,
  };
}

describe('potScopeEnabled — the fail-open default', () => {
  it('treats an ABSENT row as enabled (null and undefined alike)', () => {
    // This is R-5. The table ships empty, so if either of these were false,
    // applying the migration would stop every learning lane in the workspace.
    expect(potScopeEnabled(null)).toBe(true);
    expect(potScopeEnabled(undefined)).toBe(true);
  });

  it('treats a stored enabled:true row as enabled', () => {
    // An explicit re-enable writes a row rather than deleting one (it carries
    // the audit stamp), so this must read identically to no row at all.
    expect(potScopeEnabled({ enabled: true })).toBe(true);
  });

  it('gates ONLY on a stored enabled:false', () => {
    expect(potScopeEnabled({ enabled: false })).toBe(false);
  });

  it('does not gate on a falsy-but-not-false row shape', () => {
    // Guards the obvious regression: `!row?.enabled` instead of `!== false`,
    // which would fail CLOSED for every pot the moment a read returned a row
    // whose boolean did not survive its mapper.
    expect(potScopeEnabled({ enabled: undefined as unknown as boolean })).toBe(true);
  });
});

describe('disabledPotSet', () => {
  it('collects only the pots that are switched off', () => {
    const set = disabledPotSet([row('a', false), row('b', true), row('c', false)]);
    expect([...set].sort()).toEqual(['a', 'c']);
  });

  it('is empty for an empty table — the no-op state', () => {
    expect(disabledPotSet([]).size).toBe(0);
  });
});

describe('potScopeLookup', () => {
  const lookup = potScopeLookup([row('off-pot', false), row('on-pot', true)]);

  it('resolves an unknown slug to enabled', () => {
    // The batch path must agree with potScopeEnabled(null): a pot nobody has
    // ever flipped is learning, whether it is resolved one-at-a-time or in bulk.
    expect(lookup('never-flipped')).toBe(true);
  });

  it('resolves a stored disabled slug to false and a stored enabled slug to true', () => {
    expect(lookup('off-pot')).toBe(false);
    expect(lookup('on-pot')).toBe(true);
  });
});

describe('isDeliberatePause — WI-10002099: "is this pot off ON PURPOSE?" is one predicate, not a string suffix', () => {
  it('is false for an absent row and for an enabled row, whatever stale provenance it carries', () => {
    expect(isDeliberatePause(null)).toBe(false);
    expect(isDeliberatePause(undefined)).toBe(false);
    expect(isDeliberatePause(row('p', true))).toBe(false);
    // The DB forbids this shape (CHECK), but the predicate must not trust that:
    // a pot that is learning is never "deliberately paused".
    expect(isDeliberatePause(row('p', true, { ownerDirected: true, pauseReason: 'stale' }))).toBe(false);
  });

  it('is true for an owner-directed pause and for any pause with a recorded reason', () => {
    expect(isDeliberatePause(row('p', false, { ownerDirected: true, pauseReason: 'owner directive #481' }))).toBe(true);
    expect(isDeliberatePause(row('p', false, { pauseReason: 'cost freeze, WI-10001478' }))).toBe(true);
  });

  it('is FALSE for a bare enabled:false — an unexplained pause must stay flaggable, not read as intentional', () => {
    // This is the row the old convention got wrong: the main pot's switch-off
    // carried no suffix, so a peer read it as an accident. The converse guard is
    // that a bare off-switch is NOT quietly promoted to "deliberate" either.
    expect(isDeliberatePause(row('p', false))).toBe(false);
  });

  it('does not treat a whitespace-only reason as a recorded reason', () => {
    expect(isDeliberatePause(row('p', false, { pauseReason: '   ' }))).toBe(false);
  });

  it('does not parse the retired set_by suffix: only the structured fields decide', () => {
    expect(isDeliberatePause(row('p', false, { setBy: 'su-x (owner directive)' }))).toBe(false);
  });
});

describe('pauseReviewOverdue', () => {
  const NOW = 1_800_000_000_000;

  it('is true only for a paused pot whose review date has arrived', () => {
    expect(pauseReviewOverdue(row('p', false, { reviewBy: NOW - 1 }), NOW)).toBe(true);
    expect(pauseReviewOverdue(row('p', false, { reviewBy: NOW }), NOW)).toBe(true);
    expect(pauseReviewOverdue(row('p', false, { reviewBy: NOW + 1 }), NOW)).toBe(false);
  });

  it('is false for an open-ended pause, an enabled pot, and no row', () => {
    expect(pauseReviewOverdue(row('p', false), NOW)).toBe(false);
    expect(pauseReviewOverdue(row('p', true, { reviewBy: NOW - 1 }), NOW)).toBe(false);
    expect(pauseReviewOverdue(null, NOW)).toBe(false);
  });
});

describe('POT_DISABLED_REASON', () => {
  it('is the one refusal string every lane reports', () => {
    // Pinned because three independent lanes (governor P-002, gym P-003,
    // scout P-004) render it; a rename that missed one would split the
    // vocabulary the UI groups on.
    expect(POT_DISABLED_REASON).toBe('pot-disabled');
  });
});
