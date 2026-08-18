/**
 * The goal TERMINAL-partition invariant (goal-dag-shared-substrate-2026-08-18
 * P-001, D-002) — the same pin work-item-blocking.test.ts holds over
 * ISSUE_SHIPPED/ISSUE_ABANDONED: SATISFYING and INVALIDATING must partition
 * GOAL_TERMINAL_STATUSES (disjoint, together exhaustive). This is what fails if
 * a future status joins GOAL_STATUSES without being classified — the
 * alternative is a new terminal status silently defaulting to one side of the
 * achieved/killed split, which is a blocking-semantics change nobody decided.
 */

import { describe, expect, it } from 'vitest';
import {
  GOAL_INVALIDATING_STATUSES,
  GOAL_SATISFYING_STATUSES,
  GOAL_STATUSES,
  GOAL_TERMINAL_STATUSES,
  goalId,
} from './_core';

describe('goal terminal partition (D-002)', () => {
  it('SATISFYING and INVALIDATING are disjoint', () => {
    for (const s of GOAL_SATISFYING_STATUSES) {
      expect(GOAL_INVALIDATING_STATUSES.has(s)).toBe(false);
    }
  });

  it('SATISFYING ∪ INVALIDATING is exactly TERMINAL', () => {
    const union = new Set([...GOAL_SATISFYING_STATUSES, ...GOAL_INVALIDATING_STATUSES]);
    expect(union).toEqual(new Set(GOAL_TERMINAL_STATUSES));
  });

  it('every terminal status is a real goal status', () => {
    for (const s of GOAL_TERMINAL_STATUSES) {
      expect(GOAL_STATUSES).toContain(s);
    }
  });

  it('the non-terminal remainder is exactly active + paused (pending statuses)', () => {
    const nonTerminal = GOAL_STATUSES.filter((s) => !GOAL_TERMINAL_STATUSES.has(s));
    expect(new Set(nonTerminal)).toEqual(new Set(['active', 'paused']));
  });

  it('achieved satisfies; killed invalidates — the split this partition exists to pin', () => {
    expect(GOAL_SATISFYING_STATUSES.has('achieved')).toBe(true);
    expect(GOAL_INVALIDATING_STATUSES.has('killed')).toBe(true);
  });
});

describe('goalId', () => {
  it('mints a bare slug-hex ref — never harness-qualified (the dep endpoint ref form)', () => {
    const id = goalId('Ship a paid app');
    expect(id).toMatch(/^ship-a-paid-app-[0-9a-f]{6}$/);
    expect(id).not.toContain('#');
  });
});
