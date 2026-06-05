/**
 * Unit tests for the pure issue-block overlay (applyPlanItemBlocks).
 *
 * The PG readers (getBlockingIssuesForPlan / getAllBlockedPlanItems / the
 * getBlockedFeatures projection) are covered against real PG in
 * issues-engineer.integration.test.ts. This file pins the I/O-free overlay
 * decision logic that the plans:get/list/items readers apply AFTER the pure
 * @papercusp/plan-parser resolver.
 */
import { describe, it, expect } from 'vitest';
import { applyPlanItemBlocks, planItemRef, featureRef, isQualifiedFeatureRef } from './issue-blocks-merge';

type Item = { id: string; effectiveStatus: string };
const items = (...xs: Item[]): Item[] => xs;
const lookupOf =
  (m: Record<string, string[]>) =>
  (id: string): string[] | undefined =>
    m[id];

describe('planItemRef', () => {
  it('joins slug and item id with #', () => {
    expect(planItemRef('myplan', 'P-003')).toBe('myplan#P-003');
  });
});

describe('featureRef + isQualifiedFeatureRef', () => {
  it('joins harness slug and feature id with #', () => {
    expect(featureRef('papercup', 'F-12')).toBe('papercup#F-12');
  });

  it('accepts a harness-qualified ref', () => {
    expect(isQualifiedFeatureRef('papercup#F-12')).toBe(true);
    expect(isQualifiedFeatureRef(featureRef('sheets', 'F-FIX-3'))).toBe(true);
  });

  it('rejects a bare feature id (the old convention) + malformed refs', () => {
    expect(isQualifiedFeatureRef('F-12')).toBe(false); // no harness
    expect(isQualifiedFeatureRef('#F-12')).toBe(false); // empty harness
    expect(isQualifiedFeatureRef('papercup#')).toBe(false); // empty feature id
    expect(isQualifiedFeatureRef('a#b#c')).toBe(false); // ambiguous (two #)
    expect(isQualifiedFeatureRef('')).toBe(false);
  });
});

describe('applyPlanItemBlocks', () => {
  it('flips a todo item with an open blocker to blocked + records the issue ids', () => {
    const { items: out, blockingIssues } = applyPlanItemBlocks(
      items({ id: 'P-001', effectiveStatus: 'todo' }, { id: 'P-002', effectiveStatus: 'todo' }),
      lookupOf({ 'P-001': ['EI-1', 'EI-2'] }),
    );
    expect(out.find((i) => i.id === 'P-001')!.effectiveStatus).toBe('blocked');
    expect(out.find((i) => i.id === 'P-002')!.effectiveStatus).toBe('todo');
    expect(blockingIssues).toEqual({ 'P-001': ['EI-1', 'EI-2'] });
  });

  it('flips a wip item too (any non-terminal status is blockable)', () => {
    const { items: out } = applyPlanItemBlocks(
      items({ id: 'P-001', effectiveStatus: 'wip' }),
      lookupOf({ 'P-001': ['EI-1'] }),
    );
    expect(out[0].effectiveStatus).toBe('blocked');
  });

  it('does NOT flip a terminal item (done/dropped) even with an open blocker', () => {
    const { items: out, blockingIssues } = applyPlanItemBlocks(
      items({ id: 'P-001', effectiveStatus: 'done' }, { id: 'P-002', effectiveStatus: 'dropped' }),
      lookupOf({ 'P-001': ['EI-1'], 'P-002': ['EI-2'] }),
    );
    expect(out[0].effectiveStatus).toBe('done');
    expect(out[1].effectiveStatus).toBe('dropped');
    expect(blockingIssues).toEqual({});
  });

  it('treats an empty issue array as no block', () => {
    const { items: out, blockingIssues } = applyPlanItemBlocks(
      items({ id: 'P-001', effectiveStatus: 'todo' }),
      lookupOf({ 'P-001': [] }),
    );
    expect(out[0].effectiveStatus).toBe('todo');
    expect(blockingIssues).toEqual({});
  });

  it('passes items through unchanged when nothing is blocked', () => {
    const input = items({ id: 'P-001', effectiveStatus: 'todo' });
    const { items: out, blockingIssues } = applyPlanItemBlocks(input, () => undefined);
    expect(out).toEqual(input);
    expect(blockingIssues).toEqual({});
  });

  it('preserves carried fields on the flipped item (spread, not replace)', () => {
    const { items: out } = applyPlanItemBlocks(
      [{ id: 'P-001', effectiveStatus: 'todo', importance: 'high', extra: 1 } as Item & Record<string, unknown>],
      lookupOf({ 'P-001': ['EI-1'] }),
    );
    expect(out[0]).toMatchObject({ id: 'P-001', effectiveStatus: 'blocked', importance: 'high', extra: 1 });
  });
});
