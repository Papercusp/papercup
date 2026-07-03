/**
 * fleet-dag-view.test.ts — the pure DAG-filter / frontier shaper for
 * fleet:assignments { includeDag } (EI-6949). Pure — no DB.
 */
import { describe, expect, it } from 'vitest';
import { classifyDagItem, shapeDagFrontier, claimsFromCoverage, type DagFrontierItem } from './fleet-dag-view';

describe('claimsFromCoverage — item→holder from the coverage map, scoped to a plan', () => {
  const cov = [
    { ref: 'planA#P-001', workers: ['su-a', 'su-b'] }, // holder = first worker
    { ref: 'planA#P-002', workers: [] }, // covered but no worker → no claim
    { ref: 'planA#P-003' }, // no workers field → no claim
    { ref: 'planB#P-001', workers: ['su-z'] }, // other plan → excluded
    { ref: 'malformed-no-hash', workers: ['su-q'] }, // no '#' → skipped
  ];
  it('maps in-scope refs to their first worker, skipping other plans + workerless + malformed', () => {
    expect(claimsFromCoverage(cov, 'planA')).toEqual({ 'P-001': 'su-a' });
  });
  it('empty coverage ⇒ empty claims', () => {
    expect(claimsFromCoverage([], 'planA')).toEqual({});
  });
});

describe('classifyDagItem — per-item disposition precedence', () => {
  it('terminal states win over everything (even a stale claim)', () => {
    expect(classifyDagItem({ id: 'A', effectiveStatus: 'done' }, 'su-x')).toBe('done');
    expect(classifyDagItem({ id: 'A', effectiveStatus: 'dropped' }, 'su-x')).toBe('dropped');
  });
  it('a live claim shows as claimed (over wip / blocked / ready)', () => {
    expect(classifyDagItem({ id: 'A', effectiveStatus: 'todo', unresolvedBlockers: ['B'] }, 'su-x')).toBe('claimed');
    expect(classifyDagItem({ id: 'A', effectiveStatus: 'wip' }, 'su-x')).toBe('claimed');
  });
  it('wip (in-flight, unclaimed) over blocked/ready', () => {
    expect(classifyDagItem({ id: 'A', effectiveStatus: 'wip', unresolvedBlockers: ['B'] }, null)).toBe('wip');
  });
  it('unresolved blockers ⇒ blocked; none ⇒ ready (the frontier)', () => {
    expect(classifyDagItem({ id: 'A', effectiveStatus: 'todo', unresolvedBlockers: ['B'] }, null)).toBe('blocked');
    expect(classifyDagItem({ id: 'A', effectiveStatus: 'todo', unresolvedBlockers: [] }, null)).toBe('ready');
  });
  it('a null / missing effectiveStatus is treated as todo (ready if deps met)', () => {
    expect(classifyDagItem({ id: 'A' }, null)).toBe('ready');
    expect(classifyDagItem({ id: 'A', blockedBy: ['B'], unresolvedBlockers: ['B'] }, null)).toBe('blocked');
  });
  it('is case-insensitive on the status string', () => {
    expect(classifyDagItem({ id: 'A', effectiveStatus: 'DONE' }, null)).toBe('done');
  });
});

describe('shapeDagFrontier — the fleet DAG view', () => {
  const items: DagFrontierItem[] = [
    { id: 'P-001', effectiveStatus: 'done' },
    { id: 'P-002', effectiveStatus: 'wip' }, // claimed by su-a below
    { id: 'P-003', effectiveStatus: 'todo', blockedBy: ['P-002'], unresolvedBlockers: ['P-002'] },
    { id: 'P-004', effectiveStatus: 'todo', blockedBy: ['P-001'], unresolvedBlockers: [], files: ['a.ts'] },
    { id: 'P-005', effectiveStatus: 'todo' }, // ready, no deps
  ];
  const claims = { 'P-002': 'su-a', 'P-005': 'su-b' };

  it('classifies every item and preserves plan order', () => {
    const view = shapeDagFrontier(items, claims);
    expect(view.items.map((n) => [n.id, n.status])).toEqual([
      ['P-001', 'done'],
      ['P-002', 'claimed'], // wip + a live claim → claimed
      ['P-003', 'blocked'], // unresolved dep P-002
      ['P-004', 'ready'], // dep satisfied (P-001 done), unclaimed
      ['P-005', 'claimed'], // todo but a live claim
    ]);
  });

  it('rolls up counts (+ total)', () => {
    const view = shapeDagFrontier(items, claims);
    expect(view.counts).toEqual({ done: 1, dropped: 0, claimed: 2, wip: 0, ready: 1, blocked: 1, total: 5 });
  });

  it('carries blockedBy / unresolvedBlockers / claimedBy / files per node', () => {
    const view = shapeDagFrontier(items, claims);
    const p3 = view.items.find((n) => n.id === 'P-003')!;
    expect(p3).toEqual({
      id: 'P-003',
      status: 'blocked',
      blockedBy: ['P-002'],
      unresolvedBlockers: ['P-002'],
      claimedBy: null,
      files: [],
    });
    const p4 = view.items.find((n) => n.id === 'P-004')!;
    expect(p4.files).toEqual(['a.ts']);
    expect(view.items.find((n) => n.id === 'P-002')!.claimedBy).toBe('su-a');
  });

  it('an empty plan ⇒ empty view with zeroed counts', () => {
    expect(shapeDagFrontier([])).toEqual({
      items: [],
      counts: { done: 0, dropped: 0, claimed: 0, wip: 0, ready: 0, blocked: 0, total: 0 },
    });
  });

  it('does not mutate its inputs', () => {
    const src: DagFrontierItem[] = [{ id: 'X', blockedBy: ['Y'], unresolvedBlockers: ['Y'] }];
    const view = shapeDagFrontier(src, {});
    view.items[0].blockedBy.push('Z');
    expect(src[0].blockedBy).toEqual(['Y']); // the node arrays are copies
  });
});
