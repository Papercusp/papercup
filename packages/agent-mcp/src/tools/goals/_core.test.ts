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
  insertGoalRow,
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

/**
 * The STANDING flag on the shared row write
 * (work-on-everything-goal-2026-08-23 P-001, migration 913).
 *
 * `insertGoalRow` is the ONE place either writer builds the row, so this is
 * where the flag's default is decidable at all. The property that matters is
 * that OMITTING it writes `false` rather than SQL NULL: the column is
 * `NOT NULL DEFAULT false`, so a NULL parameter would make every existing
 * caller — none of which knows anything about standing — fail its insert
 * outright.
 * Pinning the default here is what lets the flag be added without touching
 * them.
 */
describe('insertGoalRow — the standing flag (P-001)', () => {
  /** A postgres-js-shaped tagged template that just records its parameters. */
  function makeTx() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const tx = (strings: TemplateStringsArray, ...params: unknown[]) => {
      calls.push({ sql: strings.join('?'), params });
      return Promise.resolve([] as unknown[]);
    };
    return { tx, calls };
  }

  const ROW = {
    id: 'g-1',
    installSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    title: 'a goal',
  };

  /**
   * Read the flag back out POSITIONALLY rather than by matching the SQL text:
   * the column list and the VALUES list are written by hand in `_core.ts` and
   * a reordering that desynchronised them would leave the SQL still looking
   * correct. Anchoring on `status` — the parameter immediately before it —
   * means this test fails if `standing` stops being written where the column
   * list says it is.
   */
  const standingParam = (params: unknown[]) => {
    const statusAt = params.indexOf('active');
    expect(statusAt).toBeGreaterThan(-1);
    return params[statusAt + 1];
  };

  it('omitted ⇒ writes false, never null (the NOT NULL column would reject null)', async () => {
    const { tx, calls } = makeTx();
    await insertGoalRow(tx as never, ROW);
    const p = standingParam(calls[0].params);
    expect(p).toBe(false);
    expect(p).not.toBeNull();
  });

  it('standing:true is written through — the goal-package start door is the one caller with an opinion', async () => {
    const { tx, calls } = makeTx();
    await insertGoalRow(tx as never, { ...ROW, standing: true });
    expect(standingParam(calls[0].params)).toBe(true);
  });

  it('standing:false stays false — an explicit ordinary goal is not silently upgraded', async () => {
    const { tx, calls } = makeTx();
    await insertGoalRow(tx as never, { ...ROW, standing: false });
    expect(standingParam(calls[0].params)).toBe(false);
  });

  it('the column list actually names standing — so the positional read above is anchored to a real column', async () => {
    const { tx, calls } = makeTx();
    await insertGoalRow(tx as never, ROW);
    expect(calls[0].sql).toMatch(/\bstanding\b/);
  });
});
