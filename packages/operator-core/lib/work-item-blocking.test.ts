import { describe, expect, it } from 'vitest';
import {
  ALL_TERMINAL_STATUSES,
  ISSUE_TERMINAL_STATUSES,
  isReady,
  partitionReady,
  toReadinessNodes,
  type BlockingNode,
} from './work-item-blocking';

const DISPATCHABLE = new Set(['todo']);

// One scenario exercising every satisfaction case. Blockers themselves are present (so their
// status is known) but not 'todo', so they aren't candidates — only the F* items are.
const ITEMS: BlockingNode[] = [
  { id: 'F1', status: 'todo' }, // blocked by a PASSED feature -> ready
  { id: 'F-PASS', status: 'passed' },
  { id: 'F2', status: 'todo' }, // blocked by a FAILING feature -> blocked
  { id: 'F-FAIL', status: 'failing' },
  { id: 'F3', status: 'todo' }, // blocked by a RESOLVED issue (F2 cross-family) -> ready
  { id: 'I-RES', status: 'resolved' },
  { id: 'F4', status: 'todo' }, // blocked by an OPEN issue -> blocked
  { id: 'I-OPEN', status: 'open' },
  { id: 'F5', status: 'todo' }, // blocked by an ABSENT id -> satisfied (ready)
  { id: 'F6', status: 'todo' }, // blocked by a CLOSED issue -> ready
  { id: 'I-CLOSED', status: 'closed' },
];
const BLOCKERS = new Map<string, string[]>([
  ['F1', ['F-PASS']],
  ['F2', ['F-FAIL']],
  ['F3', ['I-RES']],
  ['F4', ['I-OPEN']],
  ['F5', ['ABSENT-X']],
  ['F6', ['I-CLOSED']],
]);

describe('cross-family terminal sets (F2)', () => {
  it('treats both feature and issue terminal statuses as satisfied', () => {
    expect(ISSUE_TERMINAL_STATUSES.has('resolved')).toBe(true);
    expect(ISSUE_TERMINAL_STATUSES.has('closed')).toBe(true);
    for (const s of ['passed', 'deprecated', 'resolved', 'closed']) {
      expect(ALL_TERMINAL_STATUSES.has(s)).toBe(true);
    }
    expect(ALL_TERMINAL_STATUSES.has('open')).toBe(false);
    expect(ALL_TERMINAL_STATUSES.has('failing')).toBe(false);
  });
});

describe('partitionReady', () => {
  it('partitions ready/blocked using cross-family terminal + absent-is-satisfied', () => {
    const { ready, blocked } = partitionReady(ITEMS, BLOCKERS, DISPATCHABLE);
    expect(new Set(ready.map((n) => n.id))).toEqual(new Set(['F1', 'F3', 'F5', 'F6']));
    expect(new Set(blocked.map((n) => n.id))).toEqual(new Set(['F2', 'F4']));
  });

  it('an issue blocker satisfies a feature when resolved/closed but blocks when open (F2)', () => {
    expect(isReady('F3', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(true); // I-RES resolved
    expect(isReady('F6', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(true); // I-CLOSED closed
    expect(isReady('F4', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(false); // I-OPEN open
  });

  it('a non-terminal feature blocker keeps its dependent blocked', () => {
    expect(isReady('F1', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(true);
    expect(isReady('F2', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(false);
  });

  it('an absent blocker never deadlocks (satisfied)', () => {
    expect(isReady('F5', ITEMS, BLOCKERS, DISPATCHABLE)).toBe(true);
  });

  it('an owned item is excluded from ready', () => {
    expect(isReady('F1', ITEMS, BLOCKERS, DISPATCHABLE, new Set(['F1']))).toBe(false);
  });

  it('all blockers terminal -> ready; any one non-terminal -> blocked', () => {
    const items: BlockingNode[] = [
      { id: 'X', status: 'todo' },
      { id: 'A', status: 'passed' },
      { id: 'B', status: 'resolved' },
      { id: 'C', status: 'failing' },
    ];
    expect(isReady('X', items, new Map([['X', ['A', 'B']]]), DISPATCHABLE)).toBe(true);
    expect(isReady('X', items, new Map([['X', ['A', 'C']]]), DISPATCHABLE)).toBe(false);
  });
});

describe('toReadinessNodes', () => {
  it('maps items to nodes with their blocker lists (empty when none)', () => {
    const nodes = toReadinessNodes([{ id: 'A', status: 'todo' }], new Map([['A', ['B']]]));
    expect(nodes).toEqual([{ id: 'A', status: 'todo', blockedBy: ['B'] }]);
    const none = toReadinessNodes([{ id: 'Z', status: 'todo' }], new Map());
    expect(none[0]!.blockedBy).toEqual([]);
  });
});
