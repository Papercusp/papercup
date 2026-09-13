import { describe, expect, it } from 'vitest';
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { RunSummary, ToolCallEvent, TurnResult } from '@papercusp/testing-shell/llm';

import { SU_S10_CLAIM_BEFORE_WORK } from './S10-claim-before-work';
import { assertRequestedPlanItemsClaimed } from './_asserts';
import { WIDGET_EXPORT_PLAN } from './_overrides';

function turn(toolCalls: ToolCallEvent[]): TurnResult {
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

function run(turns: TurnResult[]): RunSummary {
  return {
    runId: 's10-regression',
    scenarioId: 'su-S10-claim-before-work',
    scenarioVersion: 2,
    scenarioTarget: 'su',
    identityHash: 's10-regression-hash',
    sutModel: 'test',
    judgeModel: 'test',
    personaId: 'test',
    personaTraits: {
      verbosity: 'normal',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'text',
    },
    workspaceMode: 'isolated',
    transportMode: 'in-process',
    turns,
    toolInvocations: [],
    continueChainRows: [],
    totalCostUsd: 0,
    startedAt: new Date(0),
    finishedAt: new Date(0),
    finishReason: 'completed',
    capBreaches: [],
  };
}

const META = {
  name: 's10-claims-both-items',
  claim: 'Expected both requested plan items to be claimed.',
};

describe('SU-S10 requested dependent claim regression', () => {
  it('requires the dependent item instead of accepting a partial declaration', () => {
    const assertion = assertRequestedPlanItemsClaimed(
      'widget-export-2026-06-01',
      ['P-002', 'P-003'],
      META,
    );
    const violations = assertion.eval(run([
      turn([{ name: 'coord:declare-intent', input: {
        current_plan_slug: 'widget-export-2026-06-01',
        items: ['P-002'],
      } }]),
    ]));

    expect(violations).toHaveLength(1);
    expect(violations[0].claim).toContain('P-003');
  });

  it('accepts both items when separate wip flips make the aggregate claim', () => {
    const assertion = assertRequestedPlanItemsClaimed(
      'widget-export-2026-06-01',
      ['P-002', 'P-003'],
      META,
    );
    expect(assertion.eval(run([
      turn([{ name: 'plans:set-status', input: {
        slug: 'widget-export-2026-06-01', itemId: 'P-002', status: 'wip',
      } }]),
      turn([{ name: 'plans:set-status', input: {
        slug: 'widget-export-2026-06-01', itemId: 'P-003', status: 'wip',
      } }]),
    ]))).toEqual([]);
  });

  it('accepts a many-item plan claim and rejects a decoy plan', () => {
    const assertion = assertRequestedPlanItemsClaimed(
      'widget-export-2026-06-01',
      ['P-002', 'P-003'],
      META,
    );
    expect(assertion.eval(run([
      turn([{ name: 'mcp__agentmcp__plan_items:claim', input: {
        plan: 'widget-export-2026-06-01', itemIds: ['P-002', 'P-003'],
      } }]),
    ]))).toEqual([]);
    expect(assertion.eval(run([
      turn([{ name: 'plan_items:claim', input: {
        plan: 'another-plan', itemIds: ['P-002', 'P-003'],
      } }]),
    ])).map((violation) => violation.assertKind)).toEqual(['custom:s10-claims-both-items']);
  });

  it('keeps the fixture honest about P-003 being blocked and still visible', () => {
    const result = WIDGET_EXPORT_PLAN.override('plans:get', { slug: 'widget-export-2026-06-01' });
    expect(result).not.toBe(PASS_THROUGH);
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as {
      now: { next: string };
      items: Array<{ id: string; status: string; blockedBy?: string[] }>;
    };
    const dependent = payload.items.find((item) => item.id === 'P-003');

    expect(SU_S10_CLAIM_BEFORE_WORK.version).toBe(2);
    expect(payload.now.next).toContain('blocked by P-002');
    expect(dependent).toMatchObject({ status: 'blocked', blockedBy: ['P-002'] });
  });
});
