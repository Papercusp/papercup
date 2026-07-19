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

  it('TERMINAL_STATUSES is the transitional legacy∪unified terminal set (work-item-status-full-unify)', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['deprecated', 'done', 'dropped', 'passed']);
  });
});

describe('selectReady — external blockers (event/gate/runtime/human)', () => {
  it('an item with active external blockers is blocked, even if all work-item blockers are satisfied', () => {
    const nodes: ReadinessNode[] = [
      { id: 'A', status: 'todo', blockedBy: [] },
      { id: 'B', status: 'todo', blockedBy: [], externalBlockers: ['event:deploy:ready:staging'] },
    ];
    const { ready, blocked } = selectReady(nodes, NONE, TODO);
    expect(ready.map((n) => n.id)).toEqual(['A']);
    expect(blocked.map((n) => n.id)).toEqual(['B']);
  });

  it('an item with multiple active external blockers is blocked', () => {
    const nodes: ReadinessNode[] = [
      { 
        id: 'C', 
        status: 'todo', 
        blockedBy: [], 
        externalBlockers: ['gate:release-green', 'runtime:dolphin:dbus', 'human:approval:deploy'] 
      },
    ];
    const { ready, blocked } = selectReady(nodes, NONE, TODO);
    expect(ready).toEqual([]);
    expect(blocked.map((n) => n.id)).toEqual(['C']);
  });

  it('an item with no external blockers but satisfied work-item blockers is ready', () => {
    const nodes: ReadinessNode[] = [
      { id: 'A', status: 'passed', blockedBy: [] },
      { id: 'B', status: 'todo', blockedBy: ['A'], externalBlockers: [] },
    ];
    const { ready } = selectReady(nodes, NONE, TODO);
    expect(ready.map((n) => n.id)).toEqual(['B']);
  });

  it('combined: both work-item blocker unsatisfied AND external blockers block readiness', () => {
    const nodes: ReadinessNode[] = [
      { id: 'X', status: 'todo', blockedBy: [] },
      { id: 'Y', status: 'todo', blockedBy: [] },
      { 
        id: 'Z', 
        status: 'todo', 
        blockedBy: ['X'], 
        externalBlockers: ['event:ready'] 
      },
    ];
    const { ready, blocked } = selectReady(nodes, NONE, TODO);
    expect(ready.map((n) => n.id).sort()).toEqual(['X', 'Y']);
    expect(blocked.map((n) => n.id)).toEqual(['Z']);
  });

  it('clearing external blockers (empty array) makes an item ready', () => {
    const nodes: ReadinessNode[] = [
      { id: 'A', status: 'passed', blockedBy: [] },
      { id: 'B', status: 'todo', blockedBy: ['A'], externalBlockers: [] }, // empty array = cleared
    ];
    const { ready } = selectReady(nodes, NONE, TODO);
    expect(ready.map((n) => n.id)).toEqual(['B']);
  });

  it('omitted externalBlockers field (undefined) means no external blockers', () => {
    const nodes: ReadinessNode[] = [
      { id: 'A', status: 'todo', blockedBy: [] }, // no externalBlockers field
    ];
    const { ready } = selectReady(nodes, NONE, TODO);
    expect(ready.map((n) => n.id)).toEqual(['A']);
  });
});
