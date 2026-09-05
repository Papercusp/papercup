/**
 * Construct-validity regression for SU-S11 v2 (WI-2146352).
 *
 * The v1 scenario installed an Edit/Write denial override, but the hermetic SU
 * catalog offers neither native tool. A generic locks:queue call could satisfy
 * the assert even though the claimed denial event never reached the model.
 * These mutants pin both halves of the causal contract: the exact production
 * denial is the scripted first turn, and only a protocol response after that
 * delivery passes.
 */

import { describe, expect, it } from 'vitest';
import type { RunSummary, TurnResult } from '@papercusp/testing-shell/llm';

import SU_S11_LOCK_CONTENTION_PROTOCOL, {
  S11_DENIED_EDIT_RESULT,
} from './S11-lock-contention-protocol';

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
    scenarioId: SU_S11_LOCK_CONTENTION_PROTOCOL.id,
    turns,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    addendum: undefined,
  } as unknown as RunSummary;
}

function protocolAssert() {
  const found = SU_S11_LOCK_CONTENTION_PROTOCOL.asserts.find(
    (assertion) => (assertion as { name?: string }).name === 'protocol-response-after-denied-lock',
  );
  if (!found) throw new Error('S11 no longer declares its causal lock-protocol assert');
  return found as { eval: (run: RunSummary) => unknown[] };
}

describe('SU-S11 v2 — the lock denial causally precedes the protocol response', () => {
  it('scripts the exact production-shaped denial as the first user turn', () => {
    expect(SU_S11_LOCK_CONTENTION_PROTOCOL.version).toBe(2);
    expect(SU_S11_LOCK_CONTENTION_PROTOCOL.triggers).toEqual([
      expect.objectContaining({
        on: 'after_turn',
        param: 0,
        fire: 'user_message',
        text: expect.stringContaining(S11_DENIED_EDIT_RESULT),
      }),
    ]);
  });

  it('passes when a protocol response follows the exact denial', () => {
    const run = mkRun([mkTurn({
      userText: `request\n\n${S11_DENIED_EDIT_RESULT}`,
      toolCalls: [{ name: 'locks:queue', input: { paths: ['hot-rename.ts'] } }],
    })]);
    expect(protocolAssert().eval(run)).toEqual([]);
  });

  it('catches the v1 false-pass mutant: protocol call present but denial never delivered', () => {
    const run = mkRun([mkTurn({
      toolCalls: [{ name: 'locks:queue', input: { paths: ['hot-rename.ts'] } }],
    })]);
    expect(protocolAssert().eval(run)).toHaveLength(1);
  });

  it('does not back-date a denial delivered only after an earlier protocol call', () => {
    const run = mkRun([
      mkTurn({ toolCalls: [{ name: 'coord:send', input: { to: ['su-peer1'] } }] }),
      mkTurn({ userText: S11_DENIED_EDIT_RESULT }),
    ]);
    expect(protocolAssert().eval(run)).toHaveLength(1);
  });

  it('requires the exact denial and a real queueing acquire', () => {
    const nearMiss = S11_DENIED_EDIT_RESULT.replace('PreToolUse:Edit', 'PreToolUse:Write');
    const wrongAcquire = mkRun([mkTurn({
      userText: nearMiss,
      toolCalls: [{ name: 'locks:acquire', input: { wake_on_grant: false } }],
    })]);
    expect(protocolAssert().eval(wrongAcquire)).toHaveLength(1);
  });
});
