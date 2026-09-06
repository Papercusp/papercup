import type { RunSummary, TurnResult } from '@papercusp/testing-shell/llm';
import { describe, expect, it } from 'vitest';

import { SU_S23_DELTA_MERGE_BASE_PRESENT } from './S23-delta-merge-base-present';
import { SU_S25_DELTA_WRONG_MERGE_DETECTOR } from './S25-delta-wrong-merge-detector';

function mkTurn(partial: Partial<TurnResult> = {}): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs: 0,
    finishReason: 'done',
    rawSseTape: [],
    ...partial,
  };
}

function mkRun(turns: TurnResult[]): RunSummary {
  return {
    scenarioId: SU_S23_DELTA_MERGE_BASE_PRESENT.id,
    turns,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    addendum: undefined,
  } as unknown as RunSummary;
}

function s23GroundingGuard() {
  const found = SU_S23_DELTA_MERGE_BASE_PRESENT.asserts.find(
    (assertion) => (assertion as { name?: string }).name ===
      'does-not-falsely-retract-grounded-base-snapshot',
  );
  if (!found || found.kind !== 'custom') throw new Error('S23 grounding guard is missing');
  return found;
}

describe('SU S23/S25 two-turn delta construct', () => {
  it('ends both scenarios after the requested merged-list answer', () => {
    expect(SU_S23_DELTA_MERGE_BASE_PRESENT.version).toBe(3);
    expect(SU_S23_DELTA_MERGE_BASE_PRESENT.caps.maxTurns).toBe(2);
    expect(SU_S25_DELTA_WRONG_MERGE_DETECTOR.version).toBe(2);
    expect(SU_S25_DELTA_WRONG_MERGE_DETECTOR.caps.maxTurns).toBe(2);
  });

  it('catches the observed S23 false-retraction mutant', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'Here are the five rows from work_items:list.' }),
      mkTurn({
        assistantText:
          'Here is the updated list, with what changed since my previous (fabricated) list. ' +
          'My previous list was not retrieved from a live tool call.',
      }),
    ]);
    expect(s23GroundingGuard().eval(run)).toHaveLength(1);
  });

  it('accepts a grounded description of the real base and merged delta', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'Here are the five rows returned by work_items:list.' }),
      mkTurn({
        assistantText:
          'Using that real base snapshot, the wrapper merged the delta. The current list includes EROFS.',
      }),
    ]);
    expect(s23GroundingGuard().eval(run)).toEqual([]);
  });
});
