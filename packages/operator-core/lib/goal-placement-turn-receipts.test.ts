import { describe, expect, it, vi } from 'vitest';
import { defineAgentObligation, formatAgentObligationLine } from './agent-obligations';
import type { AgentObligationBrief } from './agent-obligation-reader';
import type { TranscriptTailTurn } from './turn-journal';
import {
  confirmGoalPlacementDelivery, deliveredGoalPlacementRows, prepareGoalPlacementDelivery,
  type GoalPlacementTurnReceiptDeps,
} from './goal-placement-turn-receipts';

const at = (n: number) => new Date(Date.UTC(2026, 8, 23, 0, n));
const row = defineAgentObligation({ ruleId: 'placement', ruleRevision: 'v1', family: 'plan-placement',
  scope: { ownerId: 'holder', workspaceId: 'workspace', goalId: 'goal', planSlug: 'plan' },
  responsibleOwnerId: 'holder', title: 'Place the plan', status: 'due', reason: 'Eligible plan has no member.',
  authority: { kind: 'policy', sourceRef: 'fixture:policy', revision: 'v1' },
  priority: 'high', causalRank: 1, evidence: [],
  sourceGeneration: 'generation-1', episode: 'fixture-episode', applicableDemand: 1,
  clearsWhen: { id: 'claimed', summary: 'A verified member claim exists.', evidenceKind: 'state', sourceRef: 'fixture:claims' },
  action: { kind: 'delegate', summary: 'Staff the eligible plan.', targetRef: 'plan:harness/plan', tool: 'fleet:launch-on-plan' },
});
const block = formatAgentObligationLine(row, 'action');
const brief = { evaluations: [row], projection: { entries: [row] } } as AgentObligationBrief;
const input = { ownerId: 'holder', workspaceId: 'workspace', token: 'delivery-1', brief, block };
const session = { sessionId: 'native-1', sourceKind: 'codex' as const, filePath: '/fixture/transcript' };
const turn = (id: string, minute: number, disposition: TranscriptTailTurn['responseDisposition'] = 'delivered'): TranscriptTailTurn => ({
  speaker: 'assistant', text: 'A native response, not an execution receipt.', ts: at(minute), requestId: id,
  responseDisposition: disposition,
});

function fixture() {
  let turns: TranscriptTailTurn[] = [turn('old', 1)];
  let now = at(2).getTime();
  const deps: GoalPlacementTurnReceiptDeps = {
    current: vi.fn(async () => session), lookup: vi.fn(async () => session),
    tail: vi.fn(async () => turns), append: vi.fn(async () => ({ id: 'record' })), now: () => now,
  };
  return { deps, setTail: (value: TranscriptTailTurn[]) => { turns = value; },
    setNow: (minute: number) => { now = at(minute).getTime(); } };
}

describe('exact delivery plus native-final receipts', () => {
  it('captures a baseline but writes nothing until exact emission and a newer native final are proven', async () => {
    const f = fixture();
    const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    expect(candidate).toMatchObject({ token: 'delivery-1', baselineTurnRef: 'codex:native-1:old',
      rows: [{ obligationId: row.id, sourceGeneration: row.sourceGeneration }] });
    expect(f.deps.append).not.toHaveBeenCalled();
    f.setTail([turn('old', 1), turn('current', 3)]); f.setNow(4);
    const result = await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps);
    expect(result.recorded).toBe(1);
    expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace', owner: 'holder',
      sessionId: 'native-1', scope: 'harness', detail: { goalPlacementTurn: expect.objectContaining({
        completedTurnRef: 'codex:native-1:current', offeredAt: at(2).toISOString(), completedAt: at(3).toISOString(),
        confirmedAt: at(4).toISOString(), atConfirmation: { status: 'due', obligationId: row.id,
          sourceGeneration: 'generation-1', ruleRevision: 'v1' },
      }) } }));
  });
  it.each(['blocked', 'in-progress', 'satisfied', 'unknown', 'not-applicable'] as const)(
    'does not offer an excluded %s row', (status) => {
      const changed = { ...row, status };
      expect(deliveredGoalPlacementRows({ ...input, brief: { ...brief, projection: { ...brief.projection, entries: [changed] } },
        block: formatAgentObligationLine(changed, 'action') })).toEqual([]);
    },
  );
  it('does not offer an omitted, clipped or foreign row', async () => {
    const f = fixture();
    for (const change of [{ block: '' }, { block: block.slice(0, -1) }, { ownerId: 'other' }, { workspaceId: 'other' }]) {
      expect(await prepareGoalPlacementDelivery({ ...input, ...change }, f.deps)).toBeNull();
    }
    expect(f.deps.current).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'another-token'])('does not treat %s confirmation as proof', async (confirmedToken) => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.setTail([turn('old', 1), turn('new', 3)]); f.setNow(4);
    expect((await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken }, f.deps)).recorded).toBe(0);
    expect(f.deps.append).not.toHaveBeenCalled();
  });
  it.each(['progress', 'interrupted', null] as const)('does not count a native %s response', async (disposition) => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.setTail([turn('old', 1), turn('new', 3, disposition)]); f.setNow(4);
    expect((await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps)).recorded).toBe(0);
  });
  it('refuses a missing native baseline instead of interpreting the retained tail as complete', async () => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.setTail([{ ...turn('new', 3), requestHistoryStatus: 'truncated' }]); f.setNow(4);
    expect(await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps))
      .toEqual({ recorded: 0, reason: 'native-window-incomplete' });
  });
  it('uses the first completed request after the offer, so replay cannot attach the token to a later turn', async () => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.setTail([turn('old', 1), turn('first', 3), turn('second', 4)]); f.setNow(5);
    await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps);
    expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({ detail: {
      goalPlacementTurn: expect.objectContaining({ completedTurnRef: 'codex:native-1:first' }),
    } }));
  });
  it('preserves a later blocked observation without asserting eligibility at completion', async () => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.setTail([turn('old', 1), turn('new', 3)]); f.setNow(4);
    await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1',
      brief: { ...brief, evaluations: [{ ...row, status: 'blocked' }] } }, f.deps);
    expect(f.deps.append).toHaveBeenCalledWith(expect.objectContaining({ detail: { goalPlacementTurn:
      expect.objectContaining({ atConfirmation: expect.objectContaining({ status: 'blocked' }) }) } }));
  });
  it('refuses a resolver result from another native session', async () => {
    const f = fixture(); const candidate = await prepareGoalPlacementDelivery(input, f.deps);
    f.deps.lookup = async () => ({ ...session, sessionId: 'other-native' });
    expect((await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps)).recorded).toBe(0);
    expect(f.deps.append).not.toHaveBeenCalled();
  });
});
