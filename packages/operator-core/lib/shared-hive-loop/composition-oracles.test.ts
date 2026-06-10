/**
 * composition-oracles.test.ts — pure unit coverage for the 2-swarm composition
 * oracle evaluation (shared-hive-loop-e2e-testing-2026-06-10). The integration
 * rigs feed real evidence; these prove the judge itself: each oracle family
 * fires on exactly its violation and stays quiet on clean evidence.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateCompositionOracles,
  executionsByItem,
  type BacklogRow,
  type CompositionEvidence,
  type SideEffectRow,
} from './composition-oracles';

const row = (id: string, status = 'passed', extra: Partial<BacklogRow> = {}): BacklogRow => ({
  feature_id: id,
  status,
  taken_by: extra.taken_by ?? null,
  feature_order: extra.feature_order ?? null,
  item_kind: extra.item_kind ?? 'feature',
  origin: extra.origin ?? 'local',
});

const fx = (item: string, by: string, at = 1): SideEffectRow => ({
  work_item_id: item,
  executed_by: by,
  executed_at_ms: at,
});

function cleanEvidence(): CompositionEvidence {
  return {
    backlogIds: ['F-1', 'F-2'],
    terminalStatus: 'passed',
    featuresByCell: {
      a: [row('F-1'), row('F-2')],
      b: [row('F-1', 'passed', { origin: 'remote' }), row('F-2', 'passed', { origin: 'remote' })],
    },
    sideEffectsByCell: { a: [fx('F-1', 'a')], b: [fx('F-2', 'b')] },
    fixedPoint: true,
  };
}

describe('executionsByItem', () => {
  it('groups executing cells per item across cells', () => {
    const m = executionsByItem({ a: [fx('F-1', 'a'), fx('F-2', 'a')], b: [fx('F-2', 'b')] });
    expect([...m.get('F-1')!]).toEqual(['a']);
    expect([...m.get('F-2')!].sort()).toEqual(['a', 'b']);
  });
});

describe('evaluateCompositionOracles', () => {
  it('passes on clean evidence', () => {
    const v = evaluateCompositionOracles(cleanEvidence());
    expect(v.failures).toEqual([]);
    expect(v.pass).toBe(true);
  });

  it('exactly-once: flags an item executed on both cells', () => {
    const ev = cleanEvidence();
    ev.sideEffectsByCell.b.push(fx('F-1', 'b'));
    const v = evaluateCompositionOracles(ev);
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.startsWith('exactly-once: F-1'))).toBe(true);
  });

  it('exactly-once: flags an item executed nowhere', () => {
    const ev = cleanEvidence();
    ev.sideEffectsByCell.a = [];
    const v = evaluateCompositionOracles(ev);
    expect(v.failures.some((f) => f.includes('F-1 executed on 0 cell(s)'))).toBe(true);
  });

  it('exactly-once: a declared reconciled duplicate must HAVE duplicated and its winner must have executed', () => {
    const ev = cleanEvidence();
    // Declared duplicate that never duplicated → the test rig lied.
    ev.reconciledDuplicates = [{ workItemId: 'F-1', winnerCell: 'a' }];
    let v = evaluateCompositionOracles(ev);
    expect(v.failures.some((f) => f.includes('declared reconciled-duplicate but ran on 1'))).toBe(true);

    // A real duplicate with the winner among the executors → accepted.
    ev.sideEffectsByCell.b.push(fx('F-1', 'b'));
    v = evaluateCompositionOracles(ev);
    expect(v.failures.filter((f) => f.startsWith('exactly-once: F-1'))).toEqual([]);

    // Winner that never executed → flagged.
    ev.reconciledDuplicates = [{ workItemId: 'F-1', winnerCell: 'zz' }];
    v = evaluateCompositionOracles(ev);
    expect(v.failures.some((f) => f.includes('winner zz never executed'))).toBe(true);
  });

  it('convergence: flags diverged backlog views and a missing fixed point', () => {
    const ev = cleanEvidence();
    ev.featuresByCell.b = [row('F-1', 'in-progress'), row('F-2')];
    ev.fixedPoint = false;
    const v = evaluateCompositionOracles(ev);
    expect(v.failures.some((f) => f.startsWith('convergence: cell b'))).toBe(true);
    expect(v.failures.some((f) => f.includes('fixed point'))).toBe(true);
  });

  it('liveness: flags items missing or non-terminal on any cell', () => {
    const ev = cleanEvidence();
    ev.featuresByCell.a = [row('F-1', 'todo')]; // F-2 missing, F-1 not terminal
    const v = evaluateCompositionOracles(ev);
    expect(v.failures.some((f) => f.includes("F-1 on cell a ended 'todo'"))).toBe(true);
    expect(v.failures.some((f) => f.includes('F-2 missing from cell a'))).toBe(true);
  });

  it('steering monotonicity: flags a next-turn view blind to remote completions', () => {
    const ev = cleanEvidence();
    ev.steering = {
      nextTurnView: [row('F-1'), row('F-2', 'todo')],
      remoteCompletedIds: ['F-2'],
    };
    const v = evaluateCompositionOracles(ev);
    expect(v.failures.some((f) => f.includes("steering: Queen's next turn sees F-2 as 'todo'"))).toBe(true);

    ev.steering.nextTurnView = [row('F-1'), row('F-2')];
    expect(evaluateCompositionOracles(ev).pass).toBe(true);
  });
});
