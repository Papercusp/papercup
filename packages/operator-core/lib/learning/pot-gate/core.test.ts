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
import { disabledPotSet, potScopeEnabled, potScopeLookup, POT_DISABLED_REASON, type PotLearningScope } from './core';

function row(potSlug: string, enabled: boolean): PotLearningScope {
  return { workspaceId: 'ws', potSlug, enabled, setBy: 'su-test', setAt: 1_700_000_000_000 };
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

describe('POT_DISABLED_REASON', () => {
  it('is the one refusal string every lane reports', () => {
    // Pinned because three independent lanes (governor P-002, gym P-003,
    // scout P-004) render it; a rename that missed one would split the
    // vocabulary the UI groups on.
    expect(POT_DISABLED_REASON).toBe('pot-disabled');
  });
});
