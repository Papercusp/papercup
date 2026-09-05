import { describe, expect, it } from 'vitest';
import type { RunSummary, TurnResult } from '@papercusp/testing-shell/llm';

import SU_S12_SAME_TURN_INSIGHT, {
  S12_PROVEN_CONTEXT_PROMPT,
} from './S12-same-turn-insight';

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
  it('seeds turn 0 with the proven cause and recurrence marker without naming the action under test', () => {
    expect(SU_S12_SAME_TURN_INSIGHT.version).toBe(3);
    expect(SU_S12_SAME_TURN_INSIGHT.triggers).toEqual([
      {
        on: 'after_turn',
        param: 0,
        fire: 'user_message',
        text: S12_PROVEN_CONTEXT_PROMPT,
      },
    ]);
    expect(S12_PROVEN_CONTEXT_PROMPT).toMatch(/dropped MCP transport/i);
    expect(S12_PROVEN_CONTEXT_PROMPT).toMatch(/Postgres backend holding the plan advisory lock/i);
    expect(S12_PROVEN_CONTEXT_PROMPT).toMatch(/agents keep hitting this exact failure/i);
    expect(S12_PROVEN_CONTEXT_PROMPT).not.toMatch(/docs:author|insight page/i);
  });

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
