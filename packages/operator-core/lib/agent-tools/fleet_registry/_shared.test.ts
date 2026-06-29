/**
 * Unit tests for the PURE fleet-registry membership-role decisions (D-002).
 * No PG: these are the role logic the create / join / take-leadership tools branch on.
 */
import { describe, it, expect } from 'vitest';
import { fleetRoleFor, shouldDemotePriorLeader } from './_shared';

describe('fleetRoleFor (ONE leader per fleet, D-002)', () => {
  it('labels the recorded leader `leader`', () => {
    expect(fleetRoleFor('su-alice', 'su-alice')).toBe('leader');
  });
  it('labels everyone else `member`', () => {
    expect(fleetRoleFor('su-alice', 'su-bob')).toBe('member');
  });
  it('labels `member` when the fleet has no leader yet', () => {
    expect(fleetRoleFor(null, 'su-bob')).toBe('member');
  });
});

describe('shouldDemotePriorLeader (take-leadership handoff, D-002)', () => {
  const target = 'rocket-fleet';
  it('demotes a distinct prior leader still labeled in this fleet', () => {
    expect(shouldDemotePriorLeader('su-alice', 'su-bob', target, target)).toBe(true);
  });
  it('does NOT demote when the caller WAS already the leader', () => {
    expect(shouldDemotePriorLeader('su-bob', 'su-bob', target, target)).toBe(false);
  });
  it('does NOT demote when there was no prior leader', () => {
    expect(shouldDemotePriorLeader(null, 'su-bob', null, target)).toBe(false);
  });
  it('does NOT demote a prior leader who has since moved to another fleet', () => {
    expect(shouldDemotePriorLeader('su-alice', 'su-bob', 'other-fleet', target)).toBe(false);
  });
  it('does NOT demote a prior leader with no presence row (null label)', () => {
    expect(shouldDemotePriorLeader('su-alice', 'su-bob', null, target)).toBe(false);
  });
});
