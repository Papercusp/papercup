import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAgentObligation, formatAgentObligationLine } from './agent-obligations';
import type { AgentObligationBrief } from './agent-obligation-reader';
import { readVerbatimTail, type TranscriptTailTurn } from './turn-journal';
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

describe('native transcript parser to goal delivery receipt', () => {
  // These are native-format transcripts, not preclassified delivered turns.
  // Only session discovery and the final activity sink are substituted here.
  function lines(kind: 'claude' | 'codex' | 'omp', id: string, minute: number, final: boolean) {
    const timestamp = at(minute).toISOString();
    if (kind === 'claude') return [
      { type: 'user', uuid: id, parentUuid: null, timestamp,
        message: { role: 'user', content: 'Work on the plan' } },
      { type: 'assistant', uuid: `${id}-answer`, parentUuid: id, timestamp,
        message: { role: 'assistant', stop_reason: final ? 'end_turn' : 'tool_use',
          content: [{ type: 'text', text: 'Native response' }] } },
    ];
    if (kind === 'omp') return [
      { type: 'message', id, parentId: null, timestamp,
        message: { role: 'user', content: [{ type: 'text', text: 'Work on the plan' }] } },
      { type: 'message', id: `${id}-answer`, parentId: id, timestamp,
        message: { role: 'assistant', stopReason: final ? 'stop' : 'toolUse',
          content: [{ type: 'text', text: 'Native response' }] } },
    ];
    return [
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'user',
        internal_chat_message_metadata_passthrough: { turn_id: id }, content: [{ type: 'input_text', text: 'Work on the plan' }] } },
      { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', phase: 'commentary',
        internal_chat_message_metadata_passthrough: { turn_id: id }, content: [{ type: 'output_text', text: 'Native response' }] } },
      ...(final ? [{ type: 'event_msg', timestamp,
        payload: { type: 'task_complete', turn_id: id, error: null, last_agent_message: 'Native response' } }] : []),
    ];
  }

  it.each(['claude', 'codex', 'omp'] as const)('%s progress cannot count; its native terminal boundary can', async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'goal-receipt-native-'));
    try {
      const native = { sessionId: 'native-parser', sourceKind: kind, filePath: join(directory, 'session.jsonl') };
      const prior = lines(kind, 'prior', 1, true);
      const write = async (rows: unknown[]) => writeFile(native.filePath, rows.map((line) => JSON.stringify(line)).join('\n') + '\n');
      await write(prior);
      const f = fixture();
      f.deps.current = async () => native;
      f.deps.lookup = async () => native;
      f.deps.tail = (source) => readVerbatimTail(source.filePath, source.sourceKind, 50);
      const candidate = await prepareGoalPlacementDelivery(input, f.deps);
      expect(candidate?.baselineTurnRef).toBe(`${kind}:native-parser:prior`);
      f.setNow(4);
      await write([...prior, ...lines(kind, 'next', 3, false)]);
      expect((await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps)).recorded).toBe(0);
      expect(f.deps.append).not.toHaveBeenCalled();
      await write([...prior, ...lines(kind, 'next', 3, true)]);
      expect((await confirmGoalPlacementDelivery({ ...input, candidate, confirmedToken: 'delivery-1' }, f.deps)).recorded).toBe(1);
      expect(f.deps.append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: {
        goalPlacementTurn: expect.objectContaining({ completedTurnRef: `${kind}:native-parser:next`, completedAt: at(3).toISOString() }),
      } }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
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
