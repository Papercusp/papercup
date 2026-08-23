import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@papercusp/plan-parser';
import { analyzePlanDagParallelism } from './plan-dag-parallelism';

const item = (args: {
  id: string;
  status?: PlanItem['storedStatus'];
  blockedBy?: string[];
  phase?: string | null;
  text?: string;
}): PlanItem => ({
  id: args.id,
  text: args.text ?? args.id,
  storedStatus: args.status ?? 'todo',
  importance: 'normal',
  blockedBy: args.blockedBy ?? [],
  decisionRefs: [],
  phase: args.phase ?? null,
  lineNumber: 1,
  rawLine: `- **${args.id}** \`${args.status ?? 'todo'}\` ${args.text ?? args.id}`,
});

describe('analyzePlanDagParallelism', () => {
  it('counts disjoint foundational leaves as executable width and ignores their completed root', () => {
    const result = analyzePlanDagParallelism([
      item({ id: 'P-001', status: 'done', phase: 'Phase 1' }),
      item({ id: 'P-002', blockedBy: ['P-001'], phase: 'Phase 2' }),
      item({ id: 'P-003', blockedBy: ['P-001'], phase: 'Phase 2' }),
      item({ id: 'P-004', blockedBy: ['P-001'], phase: 'Phase 2' }),
    ]);

    expect(result).toMatchObject({
      nonTerminal: 3,
      readyWidth: 3,
      readyItemIds: ['P-002', 'P-003', 'P-004'],
      criticalPathDepth: 1,
      blockingEdges: [],
    });
  });

  it('reports a serialized critical path and every currently blocking edge', () => {
    const result = analyzePlanDagParallelism([
      item({ id: 'P-001', phase: 'Phase 1' }),
      item({ id: 'P-002', blockedBy: ['P-001'], phase: 'Phase 2' }),
      item({ id: 'P-003', blockedBy: ['P-002'], phase: 'Phase 3' }),
    ]);

    expect(result.readyWidth).toBe(1);
    expect(result.criticalPathDepth).toBe(3);
    expect(result.criticalPathItemIds).toEqual(['P-001', 'P-002', 'P-003']);
    expect(result.blockingEdges.map(({ itemId, blockerId }) => `${itemId}<-${blockerId}`)).toEqual([
      'P-002<-P-001',
      'P-003<-P-002',
    ]);
  });

  it('identifies fan-in, later-phase inversions, and release gates blocking foundational work', () => {
    const result = analyzePlanDagParallelism([
      item({ id: 'P-001', phase: 'Phase 1', text: 'Implement provider foundation', blockedBy: ['P-003'] }),
      item({ id: 'P-002', phase: 'Phase 1', text: 'Build storage adapter' }),
      item({ id: 'P-003', phase: 'Phase 4', text: 'Beta distribution release gate' }),
      item({ id: 'P-004', phase: 'Phase 5', text: 'Integrate providers', blockedBy: ['P-001', 'P-002'] }),
    ]);

    expect(result.fanInChokepoints).toEqual([{ itemId: 'P-004', blockerIds: ['P-001', 'P-002'] }]);
    expect(result.phaseInversions).toEqual([{
      itemId: 'P-001',
      itemPhase: 'Phase 1',
      blockerId: 'P-003',
      blockerPhase: 'Phase 4',
    }]);
    expect(result.releaseGateBlocksBuild).toEqual([{
      itemId: 'P-001',
      itemPhase: 'Phase 1',
      blockerId: 'P-003',
      blockerPhase: 'Phase 4',
    }]);
  });

  it('terminates on cycles and reports their members as non-ready', () => {
    const result = analyzePlanDagParallelism([
      item({ id: 'P-001', blockedBy: ['P-002'] }),
      item({ id: 'P-002', blockedBy: ['P-001'] }),
    ]);

    expect(result.readyWidth).toBe(0);
    expect(result.criticalPathDepth).toBeGreaterThan(0);
    expect(result.criticalPathDepth).toBeLessThanOrEqual(2);
    expect(result.nonReadyItems).toEqual([
      expect.objectContaining({ itemId: 'P-001', reason: 'cycle' }),
      expect.objectContaining({ itemId: 'P-002', reason: 'cycle' }),
    ]);
  });
});
