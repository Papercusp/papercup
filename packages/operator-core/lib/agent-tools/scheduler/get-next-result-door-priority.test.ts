/**
 * EI-20243251614343957 — scheduler:get_next must deliver a committed claim
 * receipt and governing decisions alongside the bulky work-item echo. This test
 * exercises the real scheduler assembly with the real result door and proves the
 * caller receives one parseable, structurally bounded JSON object that preserves
 * the reconciliation-critical fields regardless of their legacy key order.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE } from '../../context-doors';

const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('../../context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import { applyResultDoor, beginResultDoorAggregate, RESULT_DOOR_TOKENS } from '../../result-door';
import { assembleSchedulerClaimResult } from './get_next';

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const RUN_ID = '11111111-2222-4333-8444-555555555557';
const DECISION_MARKER = 'EI-20202324455243251-GOVERNING-DECISION-SURVIVED';
const CLAIM_MARKER = 'EI-20243251614343957';
const RETRACTION_MARKER = 'EI-20027532687512023-RETRACTION-ADVISORY-SURVIVED';
const AFFECTS_WARNING = '⚠ CROSS-PLAN AUTHORITY CONFLICT/SUPERSESSION WARNING: source-plan#D-009';

let sandbox: string;
let previousScratchRoot: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-get-next-result-door-test-'));
  previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
});

afterEach(() => {
  if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

function filler(chars: number): string {
  return 'bulky-work-item-echo-'.repeat(Math.ceil(chars / 22)).slice(0, chars);
}

function doorify(result: Record<string, unknown>) {
  return applyResultDoor(
    { content: [{ type: 'text' as const, text: JSON.stringify(result) }] },
    { toolName: 'scheduler:get_next', workspaceId: 'ws-1', runId: RUN_ID },
  );
}

function bulkyWorkItem() {
  return {
    id: CLAIM_MARKER,
    title: 'The result-door truncates scheduler:get_next planDecisions',
    summary: filler(BUDGET_CHARS * 2),
    payload: { evidence: filler(BUDGET_CHARS / 2) },
  };
}

function decisions() {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `D-${String(index + 1).padStart(3, '0')}`,
    title: index === 5 ? DECISION_MARKER : `ordinary ruling ${index + 1}`,
    snippet: 'Read this ruling before acting on the claimed item.',
    ...(index === 0
      ? { sourcePlanSlug: 'source-plan', ref: 'source-plan#D-009', relation: 'affects' }
      : {}),
  }));
}

describe('scheduler:get_next claim-time decisions survive the result-door', () => {
  it('keeps the complete governing decision window ahead of the bulky work-item echo', () => {
    const assembled = assembleSchedulerClaimResult({
      planDecisions: decisions(),
      planDecisionsNote: AFFECTS_WARNING,
      retractionWarning: RETRACTION_MARKER,
      checkpoint: 'plan-local checkpoint prose',
      workItem: bulkyWorkItem(),
      claimedUnder: { specId: 'nonp2p-bug-drain-luna-max-0811', revision: 1 },
    });

    expect(Object.keys(assembled).slice(0, 5)).toEqual([
      'ok',
      'claimReceipt',
      'retractionWarning',
      'planDecisions',
      'planDecisionsNote',
    ]);
    expect(Object.keys(assembled).indexOf('planDecisionsNote')).toBeLessThan(
      Object.keys(assembled).indexOf('checkpoint'),
    );

    const doored = doorify(assembled);
    expect(doored.content).toHaveLength(1); // structural JSON replaces the old kept-head + footer pair
    const kept = (doored.content[0] as { text: string }).text;
    const parsed = JSON.parse(kept) as {
      claimReceipt: Record<string, unknown>;
      _projection: Record<string, unknown>;
    };
    expect(parsed._projection).toMatchObject({
      kind: 'bounded-payload',
      cursor: { tool: 'capability:read' },
    });
    expect(parsed.claimReceipt).toMatchObject({
      committed: true,
      workItemId: 'EI-20243251614343957',
    });
    expect(kept).toContain(RETRACTION_MARKER);
    expect(kept).toContain(DECISION_MARKER);
    expect(kept).toContain('planDecisionsNote');
    expect(kept).toContain(AFFECTS_WARNING);
    expect(kept).toContain('plan-local checkpoint prose');
    expect(kept.indexOf(AFFECTS_WARNING)).toBeLessThan(kept.indexOf('plan-local checkpoint prose'));
  });

  it('preserves the governing decision even in the legacy tail placement', () => {
    const preFixOrder = {
      ok: true,
      workItem: bulkyWorkItem(),
      claimedUnder: { specId: 'nonp2p-bug-drain-luna-max-0811', revision: 1 },
      planDecisions: decisions(),
      planDecisionsNote: 'Showing the 8 MOST RECENT of 8 governing decision(s).',
    };

    const doored = doorify(preFixOrder);
    const kept = (doored.content[0] as { text: string }).text;
    expect(() => JSON.parse(kept)).not.toThrow();
    expect(kept).toContain(DECISION_MARKER);
  });

  it.each([
    { toolName: 'scheduler:get_next', nestedTargetToolName: undefined },
    { toolName: 'tools:invoke', nestedTargetToolName: 'scheduler:get_next' },
  ])('recovers an ordinary failed spill through the committed item ($toolName)', ({
    toolName,
    nestedTargetToolName,
  }) => {
    writeFileSync(join(sandbox, 'scratch'), 'not a directory');
    const assembled = assembleSchedulerClaimResult({
      planDecisions: decisions(),
      workItem: { ...bulkyWorkItem(), harness: 'papercusp' },
    });
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: JSON.stringify(assembled) }] },
      { toolName, nestedTargetToolName, workspaceId: 'ws-1', runId: RUN_ID },
    );
    const output = JSON.parse((doored.content[0] as { text: string }).text);

    expect(output.claimReceipt).toMatchObject({ committed: true, workItemId: CLAIM_MARKER });
    expect(output._projection.cursor).toMatchObject({
      kind: 'committed-claim',
      tool: 'work_items:get',
      args: { id: CLAIM_MARKER, harness: 'papercusp' },
    });
    expect(output._projection.next).toContain('Do not retry scheduler:get_next');
    expect(output._projection.next).not.toContain('Re-call');
    expect(doored._meta?.resultDoor).toMatchObject({ structural: true, spillFailed: true });
    expect(doored._meta?.resultDoor).not.toHaveProperty('aggregate');
  });

  it('does not manufacture a committed claim from an uncommitted receipt', () => {
    writeFileSync(join(sandbox, 'scratch'), 'not a directory');
    const doored = doorify({
      ok: false,
      claimReceipt: { committed: false, workItemId: CLAIM_MARKER },
      workItem: bulkyWorkItem(),
    });
    const output = JSON.parse((doored.content[0] as { text: string }).text);

    expect(output._projection.cursor).toMatchObject({ kind: 'unavailable', reason: 'spill-write-failed' });
    expect(output._projection.next).not.toContain('is committed');
    expect(output._projection.next).not.toContain('Read work_items:get');
  });

  it.each([
    { toolName: 'scheduler:get_next', nestedTargetToolName: undefined, failSpill: false },
    { toolName: 'tools:invoke', nestedTargetToolName: 'scheduler:get_next', failSpill: true },
  ])('keeps a committed claim receipt visible through aggregate hard spill ($toolName)', ({
    toolName,
    nestedTargetToolName,
    failSpill,
  }) => {
    const scope = () => beginResultDoorAggregate({
      sessionKey: `scheduler-claim-receipt-${toolName}`,
      outputGroupId: 'turn-1',
    });
    const medium = () => ({ content: [{ type: 'text' as const, text: 'x'.repeat(5_000) }] });
    applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
    applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
    if (failSpill) writeFileSync(join(sandbox, 'scratch'), 'not a directory');

    const assembled = assembleSchedulerClaimResult({
      planDecisions: decisions(),
      planDecisionsNote: AFFECTS_WARNING,
      retractionWarning: RETRACTION_MARKER,
      checkpoint: 'plan-local checkpoint prose',
      workItem: { ...bulkyWorkItem(), harness: 'papercusp' },
      claimedUnder: { specId: 'nonp2p-bug-drain-luna-max-0811', revision: 1 },
    });
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: JSON.stringify(assembled) }] },
      {
        toolName,
        ...(nestedTargetToolName ? { nestedTargetToolName } : {}),
        workspaceId: 'ws-1',
        runId: RUN_ID,
        aggregateScope: scope(),
      },
    );
    const output = JSON.parse((doored.content[0] as { text: string }).text) as {
      ok: boolean;
      claimReceipt: Record<string, unknown>;
      _projection: { truncated: boolean; cursor: { tool: string; args: Record<string, unknown> }; next: string };
    };

    expect(output).toMatchObject({
      ok: true,
      claimReceipt: { committed: true, workItemId: CLAIM_MARKER },
      _projection: {
        truncated: true,
        cursor: { tool: 'work_items:get', args: { id: CLAIM_MARKER, harness: 'papercusp' } },
      },
    });
    expect(output._projection.next).toContain('Do not retry scheduler:get_next');
    expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
      reason: 'aggregate-output-budget-exceeded',
      spillFailed: failSpill,
    });
  });
});
