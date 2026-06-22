/**
 * work-item-blocking-truth-table.test.ts — caching-layer-tag-eca-2026-06-22 P-019.
 *
 * The EXHAUSTIVE readiness truth-table over `partitionReady` (the dependency/readiness
 * seam in work-item-blocking.ts). Where work-item-blocking.test.ts checks a hand-picked
 * scenario, this enumerates the full cross-product of blocker shapes so no satisfaction
 * case can silently regress:
 *
 *   - every single-blocker case over the union of {feature, issue} statuses (terminal vs
 *     non-terminal in each family, plus the ABSENT-blocker case),
 *   - multi-blocker AND semantics: a dependent is ready iff EVERY blocker is satisfied,
 *     enumerated over all 2^n subsets of a representative blocker set,
 *   - owned exclusion (in-flight items are neither ready nor blocked),
 *   - non-dispatchable exclusion (a non-`todo` status is never a candidate, even unblocked).
 *
 * Pure (no IO) — `partitionReady` composes the shared `selectReady` predicate with the
 * cross-family ALL_TERMINAL_STATUSES set.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_TERMINAL_STATUSES,
  isReady,
  partitionReady,
  type BlockingNode,
} from './work-item-blocking';

const DISPATCHABLE = new Set(['todo']);

/** Every status a blocker node can carry, paired with whether it's terminal (=satisfied). */
const FEATURE_STATUSES: ReadonlyArray<readonly [status: string, terminal: boolean]> = [
  ['passed', true],
  ['deprecated', true],
  ['todo', false],
  ['wip', false],
  ['failing', false],
  ['building', false],
];
const ISSUE_STATUSES: ReadonlyArray<readonly [status: string, terminal: boolean]> = [
  ['resolved', true],
  ['closed', true],
  ['open', false],
];
const ALL_BLOCKER_STATUSES = [...FEATURE_STATUSES, ...ISSUE_STATUSES];

describe('P-019 readiness truth-table — terminal-set membership', () => {
  it('every enumerated terminal status is in ALL_TERMINAL_STATUSES and no non-terminal one is', () => {
    for (const [status, terminal] of ALL_BLOCKER_STATUSES) {
      expect(ALL_TERMINAL_STATUSES.has(status)).toBe(terminal);
    }
  });
});

describe('P-019 readiness truth-table — single blocker, every status', () => {
  // A dependent `D` (todo, dispatchable) blocked by exactly one blocker `B` of each status.
  // D is ready iff B is terminal (satisfied).
  for (const [status, terminal] of ALL_BLOCKER_STATUSES) {
    it(`D blocked by a single ${status} blocker -> ${terminal ? 'ready' : 'blocked'}`, () => {
      const items: BlockingNode[] = [
        { id: 'D', status: 'todo' },
        { id: 'B', status },
      ];
      const blockers = new Map([['D', ['B']]]);
      const { ready, blocked } = partitionReady(items, blockers, DISPATCHABLE);
      // Scope the assertion to D: a 'todo' blocker B is itself a dispatchable candidate (and
      // unblocked => ready), so it legitimately appears in the partition alongside D. We assert
      // only where D lands.
      const readyIds = new Set(ready.map((n) => n.id));
      const blockedIds = new Set(blocked.map((n) => n.id));
      expect(readyIds.has('D')).toBe(terminal);
      expect(blockedIds.has('D')).toBe(!terminal);
      expect(isReady('D', items, blockers, DISPATCHABLE)).toBe(terminal);
    });
  }

  it('D blocked by an ABSENT id (not in the node set) -> ready (absent never deadlocks)', () => {
    const items: BlockingNode[] = [{ id: 'D', status: 'todo' }];
    const blockers = new Map([['D', ['GHOST']]]);
    expect(isReady('D', items, blockers, DISPATCHABLE)).toBe(true);
  });

  it('D with no blocker edge at all -> ready', () => {
    const items: BlockingNode[] = [{ id: 'D', status: 'todo' }];
    expect(isReady('D', items, new Map(), DISPATCHABLE)).toBe(true);
  });
});

describe('P-019 readiness truth-table — multi-blocker AND semantics (exhaustive subsets)', () => {
  // Representative blocker pool spanning both families, terminal + non-terminal. A dependent
  // is ready iff EVERY one of its blockers is satisfied (terminal OR absent). We enumerate
  // all 2^n non-empty subsets of this pool as a dependent's blocker list.
  const POOL: ReadonlyArray<readonly [id: string, status: string, terminal: boolean]> = [
    ['P', 'passed', true],
    ['DEP', 'deprecated', true],
    ['R', 'resolved', true],
    ['C', 'closed', true],
    ['W', 'wip', false],
    ['F', 'failing', false],
    ['O', 'open', false],
    ['ABSENT', '', false], // not added to the node set => satisfied (absent) despite terminal=false
  ];
  const ABSENT_IDS = new Set(['ABSENT']);
  const presentBlockers = POOL.filter(([id]) => !ABSENT_IDS.has(id)).map(
    ([id, status]) => ({ id, status }) as BlockingNode,
  );

  const n = POOL.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset = POOL.filter((_, i) => (mask & (1 << i)) !== 0);
    const ids = subset.map(([id]) => id);
    // A blocker is satisfied if terminal OR absent (not in the present node set).
    const expectedReady = subset.every(([id, , terminal]) => terminal || ABSENT_IDS.has(id));
    it(`D blocked by {${ids.join(',')}} -> ${expectedReady ? 'ready' : 'blocked'}`, () => {
      const items: BlockingNode[] = [{ id: 'D', status: 'todo' }, ...presentBlockers];
      const blockers = new Map([['D', ids]]);
      expect(isReady('D', items, blockers, DISPATCHABLE)).toBe(expectedReady);
    });
  }
});

describe('P-019 readiness truth-table — owned + non-dispatchable exclusion', () => {
  // An unblocked, dispatchable item that would otherwise be ready.
  const makeItems = (status: string): BlockingNode[] => [{ id: 'D', status }];

  it('owned (in-flight) item is excluded from both ready and blocked', () => {
    const items = makeItems('todo');
    const { ready, blocked } = partitionReady(items, new Map(), DISPATCHABLE, new Set(['D']));
    expect(ready.map((n) => n.id)).toEqual([]);
    expect(blocked.map((n) => n.id)).toEqual([]);
    expect(isReady('D', items, new Map(), DISPATCHABLE, new Set(['D']))).toBe(false);
  });

  it('owned exclusion holds even when the item has only satisfied blockers', () => {
    const items: BlockingNode[] = [
      { id: 'D', status: 'todo' },
      { id: 'B', status: 'passed' },
    ];
    expect(isReady('D', items, new Map([['D', ['B']]]), DISPATCHABLE, new Set(['D']))).toBe(false);
  });

  for (const [status, terminal] of ALL_BLOCKER_STATUSES) {
    // Only 'todo' is dispatchable here; every other status (terminal or not) is excluded as a
    // candidate even with zero blockers. (terminal nodes still populate present/terminal for
    // OTHERS, but are never themselves "ready".)
    if (status === 'todo') continue;
    it(`non-dispatchable status "${status}" is never a ready candidate (even unblocked)`, () => {
      const items = makeItems(status);
      const { ready, blocked } = partitionReady(items, new Map(), DISPATCHABLE);
      expect(ready.map((n) => n.id)).toEqual([]);
      expect(blocked.map((n) => n.id)).toEqual([]);
      void terminal; // membership asserted in the terminal-set test above
    });
  }

  it('a non-dispatchable but terminal node still SATISFIES another item’s blocker', () => {
    const items: BlockingNode[] = [
      { id: 'D', status: 'todo' },
      { id: 'B', status: 'passed' }, // passed = not dispatchable, but terminal
    ];
    expect(isReady('D', items, new Map([['D', ['B']]]), DISPATCHABLE)).toBe(true);
  });
});
