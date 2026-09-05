import { describe, expect, it } from 'vitest';
import type { RunSummary, TurnResult } from '@papercusp/testing-shell/llm';

import { SU_S08_COMPACT_READ } from './S08-compact-read';

function mkTurn(assistantText: string): TurnResult {
  return {
    assistantText,
    toolCalls: [],
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs: 0,
    finishReason: 'done',
    rawSseTape: [],
  };
}

function mkRun(assistantText: string): RunSummary {
  return {
    runId: 's08-regression',
    scenarioId: SU_S08_COMPACT_READ.id,
    scenarioVersion: SU_S08_COMPACT_READ.version,
    identityHash: 'identity',
    sutModel: 'sut',
    judgeModel: 'judge',
    personaId: 'admin',
    personaTraits: {
      verbosity: 'normal',
      politeness: 'neutral',
      clarification: 'sometimes',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'voice',
    },
    workspaceMode: 'isolated',
    transportMode: 'in-process',
    turns: [mkTurn(assistantText)],
    toolInvocations: [],
    continueChainRows: [],
    totalCostUsd: 0,
    startedAt: new Date(0),
    finishedAt: new Date(0),
    finishReason: 'completed',
    capBreaches: [],
  };
}

const decoyActorAssert = SU_S08_COMPACT_READ.asserts.find(
  (candidate) => candidate.kind === 'custom' && candidate.name === 'no-column-shift-misread',
);

if (!decoyActorAssert || decoyActorAssert.kind !== 'custom') {
  throw new Error('S08 no-column-shift-misread assert is missing');
}

describe('SU-S08 compact-read actor association', () => {
  it('accepts the live-observed correct answer even when its audit table includes the decoy rows', () => {
    const text = [
      '| ID | Timestamp | Actor | Action | Subject |',
      '|---|---|---|---|---|',
      '| au-1 | 1717 | alice | `plans:set-status` | P-001 |',
      '| **au-2** | **1718** | **bob** | **`locks:acquire`** | **harness-fs-watcher.ts** |',
      '| au-3 | 1719 | carol | `work_items:complete` | WI-9 |',
      '',
      'Only one audit event matches:',
      '- **Actor:** `bob`',
      '- **Action:** `locks:acquire`',
    ].join('\n');

    expect(decoyActorAssert.eval(mkRun(text))).toEqual([]);
  });

  it.each([
    'The actor was Alice.',
    'Carol performed `locks:acquire`.',
    '`locks:acquire` was performed by alice.',
    'The answer is carol.',
  ])('rejects an explicit decoy-actor claim: %s', (text) => {
    expect(decoyActorAssert.eval(mkRun(text))).toHaveLength(1);
  });

  it('allows an explicit correction that names a decoy under negation', () => {
    expect(decoyActorAssert.eval(mkRun('The actor was bob, not alice or carol.'))).toEqual([]);
  });
});
