import { describe, expect, it } from 'vitest';
import type { RunSummary, TurnResult } from '@papercusp/testing-shell/llm';

import SU_S12_SAME_TURN_INSIGHT from './S12-same-turn-insight';

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
    scenarioId: SU_S12_SAME_TURN_INSIGHT.id,
    turns,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    addendum: undefined,
  } as unknown as RunSummary;
}

const insightAssert = SU_S12_SAME_TURN_INSIGHT.asserts.find(
  (candidate) => (candidate as { name?: string }).name === 'writes-insight-same-turn',
) as { eval: (run: RunSummary) => unknown[] } | undefined;

if (!insightAssert) throw new Error('S12 writes-insight-same-turn assert is missing');

describe('SU-S12 same-turn insight write', () => {
  it.each([0, 1])('accepts docs:author in early turn %i', (turnIndex) => {
    const turns = [mkTurn(), mkTurn()];
    turns[turnIndex] = mkTurn({
      toolCalls: [
        {
          name: 'docs:author',
          input: {
            slug: 'zombie-plan-lock-transport-drop',
            title: 'Zombie plan locks after transport drops',
            body: '## What\n...\n## Why it matters\n...\n## How to apply\n...',
          },
        },
      ],
    });
    expect(insightAssert.eval(mkRun(turns))).toEqual([]);
  });

  it('rejects a write deferred until the third assistant turn', () => {
    const run = mkRun([
      mkTurn(),
      mkTurn(),
      mkTurn({ toolCalls: [{ name: 'docs:author', input: { slug: 'late' } }] }),
    ]);
    expect(insightAssert.eval(run)).toHaveLength(1);
  });

  it('rejects prose that promises an agent-insight without performing the write', () => {
    const run = mkRun([
      mkTurn({ assistantText: 'I will add an agent-insights page during close-out.' }),
    ]);
    expect(insightAssert.eval(run)).toHaveLength(1);
  });
});
