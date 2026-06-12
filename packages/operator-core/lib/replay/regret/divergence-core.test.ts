/**
 * divergence-core.test.ts — divergence-turn detection fixtures
 * (self-learning-frontier P-021 / FB-07): error-loop onset, repeat-loop
 * anchoring, burn-inflection thresholds, rescue markers, earliest-wins pick.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedTranscript, TranscriptTurn } from './transcript-core';
import { detectDivergenceSignals, pickDivergence } from './divergence-core';

function turn(index: number, over: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return {
    index,
    messageId: `m${index}`,
    text: '',
    toolCalls: [],
    outputTokens: 100,
    inputTokens: 0,
    cacheReadTokens: 0,
    ...over,
  };
}

function transcript(turns: TranscriptTurn[], rescueMarkerTurns: number[] = []): ParsedTranscript {
  return {
    backend: 'claude-code',
    model: 'haiku',
    role: 'worker',
    turns,
    totalOutputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
    totalCostUsd: null,
    rescueMarkerTurns,
  };
}

const call = (name: string, inputKey: string, isError = false) => ({ name, inputKey, isError });

describe('error-loop', () => {
  it('anchors at the turn starting the earliest run of ≥3 consecutive failures', () => {
    const t = transcript([
      turn(0, { toolCalls: [call('Bash', 'a'), call('Bash', 'b', true)] }),
      turn(1, { toolCalls: [call('Bash', 'c', true), call('Bash', 'd', true)] }),
      turn(2, { toolCalls: [call('Read', 'e')] }),
    ]);
    const signals = detectDivergenceSignals(t);
    const errorLoop = signals.find((s) => s.kind === 'error-loop');
    expect(errorLoop).toBeDefined();
    expect(errorLoop!.turn).toBe(0); // run starts at turn 0's second call
    expect(errorLoop!.evidence.runLength).toBe(3);
  });

  it('two consecutive failures are not a loop (below errorRunMin)', () => {
    const t = transcript([turn(0, { toolCalls: [call('Bash', 'a', true), call('Bash', 'b', true), call('Read', 'c')] })]);
    expect(detectDivergenceSignals(t).find((s) => s.kind === 'error-loop')).toBeUndefined();
  });
});

describe('repeat-loop', () => {
  it('anchors at the SECOND identical invocation once the count reaches repeatMin', () => {
    const t = transcript([
      turn(0, { toolCalls: [call('Grep', 'same')] }),
      turn(1, { toolCalls: [call('Grep', 'same')] }),
      turn(2, { toolCalls: [call('Grep', 'same')] }),
    ]);
    const repeat = detectDivergenceSignals(t).find((s) => s.kind === 'repeat-loop');
    expect(repeat).toBeDefined();
    expect(repeat!.turn).toBe(1);
    expect(repeat!.evidence).toMatchObject({ tool: 'Grep', identicalCalls: 3 });
  });

  it('same tool with DIFFERENT inputs never triggers', () => {
    const t = transcript([
      turn(0, { toolCalls: [call('Grep', 'a'), call('Grep', 'b'), call('Grep', 'c'), call('Grep', 'd')] }),
    ]);
    expect(detectDivergenceSignals(t).find((s) => s.kind === 'repeat-loop')).toBeUndefined();
  });
});

describe('burn-inflection', () => {
  it('fires where the window mean clears factor × preceding median (and the absolute floor)', () => {
    const turns = [
      ...Array.from({ length: 6 }, (_, i) => turn(i, { outputTokens: 100 })),
      turn(6, { outputTokens: 900 }),
      turn(7, { outputTokens: 800 }),
      turn(8, { outputTokens: 1000 }),
    ];
    const inflection = detectDivergenceSignals(transcript(turns)).find((s) => s.kind === 'burn-inflection');
    expect(inflection).toBeDefined();
    expect(inflection!.turn).toBe(6);
  });

  it('a spike below the absolute token floor stays quiet (noise guard)', () => {
    const turns = [
      ...Array.from({ length: 6 }, (_, i) => turn(i, { outputTokens: 10 })),
      turn(6, { outputTokens: 60 }), // 6× median but < 200 tokens
    ];
    expect(detectDivergenceSignals(transcript(turns)).find((s) => s.kind === 'burn-inflection')).toBeUndefined();
  });

  it('needs the minimum preceding turns before calling an inflection', () => {
    const turns = [turn(0, { outputTokens: 100 }), turn(1, { outputTokens: 100 }), turn(2, { outputTokens: 900 })];
    expect(detectDivergenceSignals(transcript(turns)).find((s) => s.kind === 'burn-inflection')).toBeUndefined();
  });
});

describe('rescue-marker + pickDivergence', () => {
  it('surfaces the first rescue marker turn', () => {
    const t = transcript([turn(0), turn(1), turn(2)], [1, 2]);
    const rescue = detectDivergenceSignals(t).find((s) => s.kind === 'rescue-marker');
    expect(rescue).toBeDefined();
    expect(rescue!.turn).toBe(1);
  });

  it('pickDivergence takes the EARLIEST signal; ties break to higher confidence', () => {
    const picked = pickDivergence([
      { kind: 'burn-inflection', turn: 6, confidence: 0.9, evidence: {} },
      { kind: 'error-loop', turn: 2, confidence: 0.5, evidence: {} },
      { kind: 'rescue-marker', turn: 2, confidence: 0.6, evidence: {} },
    ]);
    expect(picked).toMatchObject({ kind: 'rescue-marker', turn: 2 });
    expect(pickDivergence([])).toBeNull();
  });

  it('an empty transcript yields no signals at all', () => {
    expect(detectDivergenceSignals(transcript([]))).toEqual([]);
  });
});
