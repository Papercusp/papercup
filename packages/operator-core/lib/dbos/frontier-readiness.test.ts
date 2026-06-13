/**
 * Unit tests for the SHARED frontier readiness predicate (queen-wave-dispatch
 * W-01 / P-010). The DBOS orchestrator (computeFrontier) and the Queen's
 * placement survey both partition on this exact logic — "one readiness, two
 * consumers" (D-002). The orchestrator's end-to-end frontier behavior is
 * additionally pinned by orchestrator-loop.test.ts (the P-011 behavior-neutral
 * proof); these tests pin the predicate in isolation.
 */
import { describe, expect, it } from 'vitest';
import { blockerSatisfied, selectReady, TERMINAL_STATUSES, type ReadinessNode } from './frontier-readiness';

const node = (id: string, status: string, blockedBy: string[] = []): ReadinessNode => ({ id, status, blockedBy });
const NONE: ReadonlySet<string> = new Set();
const TODO: ReadonlySet<string> = new Set(['todo']);

describe('blockerSatisfied — terminal or absent', () => {
  const present = new Set(['live', 'done']);
  const terminal = new Set(['done']);
  it('satisfied when the blocker is absent from the known set (never deadlocks)', () => {
    expect(blockerSatisfied('ghost', present, terminal)).toBe(true);
  });
  it('satisfied when the blocker is present but terminal', () => {
    expect(blockerSatisfied('done', present, terminal)).toBe(true);
  });
  it('NOT satisfied when the blocker is present and non-terminal', () => {
    expect(blockerSatisfied('live', present, terminal)).toBe(false);
  });
});

describe('selectReady — partition dispatchable nodes into ready / blocked', () => {
  it('a todo lane with a non-terminal blocker is blocked; the blocker itself is ready', () => {
    const { ready, blocked } = selectReady([node('A', 'todo'), node('B', 'todo', ['A'])], NONE, TODO);
    expect(ready.map((n) => n.id)).toEqual(['A']);
    expect(blocked.map((n) => n.id)).toEqual(['B']);
  });

  it('a passed (terminal) blocker satisfies its dependent', () => {
    const { ready, blocked } = selectReady([node('A', 'passed'), node('B', 'todo', ['A'])], NONE, TODO);
    expect(ready.map((n) => n.id)).toEqual(['B']); // A isn't dispatchable (not in readiness)
    expect(blocked).toEqual([]);
  });

  it('an absent blocker never deadlocks', () => {
    const { ready } = selectReady([node('B', 'todo', ['GONE'])], NONE, TODO);
    expect(ready.map((n) => n.id)).toEqual(['B']);
  });

  it('an owned node is neither ready nor blocked, but still satisfies as a blocker only when terminal', () => {
    // C is owned + todo (in flight, non-terminal) → it blocks D and isn't itself ready.
    const { ready, blocked } = selectReady([node('C', 'todo'), node('D', 'todo', ['C'])], new Set(['C']), TODO);
    expect(ready).toEqual([]);
    expect(blocked.map((n) => n.id)).toEqual(['D']);
  });

  it('respects the dispatchable-status set', () => {
    const nodes = [node('A', 'failing'), node('B', 'todo')];
    expect(selectReady(nodes, NONE, TODO).ready.map((n) => n.id)).toEqual(['B']);
    expect(selectReady(nodes, NONE, new Set(['todo', 'failing'])).ready.map((n) => n.id).sort()).toEqual(['A', 'B']);
  });

  it('TERMINAL_STATUSES is passed/deprecated', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['deprecated', 'passed']);
  });
});
