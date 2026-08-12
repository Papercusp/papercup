/**
 * EI-20202324455243251 — scheduler:get_next must deliver governing decisions
 * before the bulky work-item echo. The result-door keeps the serialized prefix,
 * so this test exercises the real scheduler assembly with the real door and
 * proves the decision list survives in context rather than only in the spill.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE } from '../../context-doors';

const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('../../context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import { applyResultDoor, RESULT_DOOR_TOKENS } from '../../result-door';
import { assembleSchedulerClaimResult } from './get_next';

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const RUN_ID = '11111111-2222-4333-8444-555555555557';
const DECISION_MARKER = 'EI-20202324455243251-GOVERNING-DECISION-SURVIVED';

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
    id: 'EI-20202324455243251',
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
  }));
}

describe('scheduler:get_next claim-time decisions survive the result-door', () => {
  it('keeps the complete governing decision window ahead of the bulky work-item echo', () => {
    const assembled = assembleSchedulerClaimResult({
      planDecisions: decisions(),
      planDecisionsNote: 'Showing the 8 MOST RECENT of 8 governing decision(s).',
      workItem: bulkyWorkItem(),
      claimedUnder: { specId: 'nonp2p-bug-drain-luna-max-0811', revision: 1 },
    });

    expect(Object.keys(assembled).slice(0, 4)).toEqual([
      'ok',
      'planDecisions',
      'planDecisionsNote',
      'workItem',
    ]);

    const doored = doorify(assembled);
    expect(doored.content).toHaveLength(2); // the bulky echo still exercises the door
    const kept = (doored.content[0] as { text: string }).text;
    expect(kept).toContain(DECISION_MARKER);
    expect(kept).toContain('planDecisionsNote');
  });

  it('distinguishes the pre-fix tail placement, where the same decision was cut away', () => {
    const preFixOrder = {
      ok: true,
      workItem: bulkyWorkItem(),
      claimedUnder: { specId: 'nonp2p-bug-drain-luna-max-0811', revision: 1 },
      planDecisions: decisions(),
      planDecisionsNote: 'Showing the 8 MOST RECENT of 8 governing decision(s).',
    };

    const doored = doorify(preFixOrder);
    const kept = (doored.content[0] as { text: string }).text;
    expect(kept).not.toContain(DECISION_MARKER);
  });
});
