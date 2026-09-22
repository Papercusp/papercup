/**
 * SU-S28's lens-tag assert must score WHAT was filed, not which dispatch door filed it.
 *
 * Regression for EI-23996297775579005 (P-015 S28 triage, 2026-09-22): with IDEATE bound, a run
 * filed `improvements:capture { kind:'feature', ideation:{ lens } }` THROUGH
 * `tools:invoke { name, args }` — the playbook's sanctioned door, which the su target forwards
 * into the same scenario world — and the assert reported "never filed a lens-tagged feature".
 * The flat-args case is the opposite guard: a top-level `lens` is NOT a lens tag, because the
 * real tool reads `ideation.lens`, so it must still fail.
 */

import { describe, expect, it } from 'vitest';
import type { RunSummary, ToolCallEvent, TurnResult } from '@papercusp/testing-shell/llm';

import { effectiveToolCall } from './_asserts';
import { SU_S28_IDEATE_PASS_CLOSES_LOOP } from './S28-ideate-pass-closes-loop';

function mkTurn(toolCalls: ToolCallEvent[]): TurnResult {
  return {
    assistantText: '',
    toolCalls,
    toolResults: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs: 0,
    finishReason: 'done',
    rawSseTape: [],
  };
}

function mkRun(toolCalls: ToolCallEvent[]): RunSummary {
  return {
    runId: 'r1',
    scenarioId: SU_S28_IDEATE_PASS_CLOSES_LOOP.id,
    scenarioVersion: SU_S28_IDEATE_PASS_CLOSES_LOOP.version,
    scenarioTarget: 'su',
    identityHash: 'h',
    sutModel: 'sonnet',
    judgeModel: 'sonnet',
    personaId: 'p',
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
    turns: [mkTurn(toolCalls)],
    toolInvocations: [],
    continueChainRows: [],
    totalCostUsd: 0,
    startedAt: new Date(0),
    finishedAt: new Date(0),
    finishReason: 'completed',
    capBreaches: [],
  };
}

function lensTagAssert() {
  const found = SU_S28_IDEATE_PASS_CLOSES_LOOP.asserts?.find(
    (a) => a.kind === 'custom' && a.name === 'files-a-lens-tagged-feature',
  );
  if (!found || found.kind !== 'custom') throw new Error('S28 lost its files-a-lens-tagged-feature assert');
  return found;
}

const NESTED = { kind: 'feature', title: 'observation-yield metrics', ideation: { lens: 'risk-first', bet: 'x' } };

describe('SU-S28 files-a-lens-tagged-feature', () => {
  it('passes a direct nested-lens capture', () => {
    expect(lensTagAssert().eval(mkRun([{ name: 'improvements:capture', input: NESTED }]))).toEqual([]);
  });

  it('passes the same capture dispatched through tools:invoke', () => {
    const call: ToolCallEvent = { name: 'tools:invoke', input: { name: 'improvements:capture', args: NESTED } };
    // Calibration: the pre-fix reading (outer name + outer input only) does NOT see a filing
    // here, so this fixture genuinely discriminates the unwrap rather than passing vacuously.
    const preFixSeesFiling = call.name === 'improvements:capture';
    expect(preFixSeesFiling).toBe(false);
    expect(lensTagAssert().eval(mkRun([call]))).toEqual([]);
  });

  it('passes an mcp-prefixed tools:invoke wrapping an mcp-prefixed nested name', () => {
    const run = mkRun([
      { name: 'mcp__agentmcp__tools:invoke', input: { name: 'mcp__agentmcp__improvements:capture', args: NESTED } },
    ]);
    expect(lensTagAssert().eval(run)).toEqual([]);
  });

  it('still fails a flat top-level lens, directly or through tools:invoke', () => {
    const flat = { kind: 'feature', title: 't', lens: 'risk-first', bet: 'x' };
    expect(lensTagAssert().eval(mkRun([{ name: 'improvements:capture', input: flat }]))).toHaveLength(1);
    expect(
      lensTagAssert().eval(mkRun([{ name: 'tools:invoke', input: { name: 'improvements:capture', args: flat } }])),
    ).toHaveLength(1);
  });

  it('still fails a tools:invoke of some other tool carrying the same args', () => {
    const run = mkRun([{ name: 'tools:invoke', input: { name: 'work_items:create', args: NESTED } }]);
    expect(lensTagAssert().eval(run)).toHaveLength(1);
  });
});

function customAssert(name: string) {
  const found = SU_S28_IDEATE_PASS_CLOSES_LOOP.asserts?.find((a) => a.kind === 'custom' && a.name === name);
  if (!found || found.kind !== 'custom') throw new Error(`S28 lost its ${name} assert`);
  return found;
}

describe('SU-S28 grounding and closing read through tools:invoke', () => {
  for (const [assertName, tool] of [
    ['grounds-on-prior-art', 'blender:ideation-feedback'],
    ['closes-the-pass-with-a-tick', 'blender:ideate-pass-record'],
  ] as const) {
    it(`${assertName}: passes direct and invoked ${tool}, fails when absent`, () => {
      const a = customAssert(assertName);
      expect(a.eval(mkRun([{ name: tool, input: {} }]))).toEqual([]);
      expect(a.eval(mkRun([{ name: 'tools:invoke', input: { name: tool, args: {} } }]))).toEqual([]);
      expect(a.eval(mkRun([{ name: 'improvements:capture', input: NESTED }]))).toHaveLength(1);
    });
  }
});

describe('effectiveToolCall', () => {
  it('returns a direct call unchanged in canonical form', () => {
    expect(effectiveToolCall({ name: 'mcp__agentmcp__plans:get', input: { slug: 's' } })).toEqual({
      name: 'plans:get',
      input: { slug: 's' },
    });
  });

  it('treats a tools:invoke with no nested name as the wrapper itself', () => {
    expect(effectiveToolCall({ name: 'tools:invoke', input: { args: {} } })).toEqual({
      name: 'tools:invoke',
      input: { args: {} },
    });
  });

  it('yields empty args when the nested args are missing or not an object', () => {
    expect(effectiveToolCall({ name: 'tools:invoke', input: { name: 'plans:get', args: ['x'] } })).toEqual({
      name: 'plans:get',
      input: {},
    });
  });
});
