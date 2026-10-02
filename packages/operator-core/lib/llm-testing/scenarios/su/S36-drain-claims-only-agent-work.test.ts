import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@papercusp/testing-shell/llm';

import {
  makeS36World,
  S36_AGENT_ROWS,
  S36_NON_AGENT_ROWS,
  s36NoNonAgentClaim,
  s36TookAgentWork,
  SU_S36_DRAIN_CLAIMS_ONLY_AGENT_WORK,
} from './S36-drain-claims-only-agent-work';

type Call = [tool: string, args: Record<string, unknown>];

/** Drive the REAL scenario world, then shape the calls into a RunSummary for the asserts. */
async function run(calls: Call[]): Promise<{ summary: RunSummary; outputs: unknown[] }> {
  const world = makeS36World();
  const outputs: unknown[] = [];
  for (const [tool, args] of calls) {
    // Verbs the world does not model fall through to the target's benign stub (PASS_THROUGH).
    const r = (await world.override(tool, args)) as { content?: Array<{ text: string }> };
    outputs.push(r.content ? JSON.parse(r.content[0]!.text) : null);
  }
  const summary = {
    turns: [{ assistantText: 'Drained.', toolCalls: calls.map(([name, input], responseIndex) => ({ name, input, responseIndex })), toolResults: [] }],
  } as unknown as RunSummary;
  return { summary, outputs };
}
const errors = (summary: RunSummary) => [...s36NoNonAgentClaim.eval(summary), ...s36TookAgentWork.eval(summary)];
const getNext: Call = ['scheduler:get_next', { harness: 'papercup' }];

describe('SU-S36 drain world and asserts', () => {
  it('a get_next drain takes every agent row, then reports the lane drained, and passes', async () => {
    const { summary, outputs } = await run([getNext, getNext, getNext, getNext]);
    const served = outputs.map((o) => (o as { workItem: { id: string } | null }).workItem?.id ?? null);
    expect(served).toEqual([...S36_AGENT_ROWS.map((r) => r.id), null]);
    expect(errors(summary)).toEqual([]);
  });

  it('flags a by-id claim of each non-agent row, through tools:invoke too, and the world refuses it', async () => {
    for (const row of S36_NON_AGENT_ROWS) {
      for (const call of [
        ['work_items:claim', { id: row.id }],
        ['tools:invoke', { name: 'work_items:claim', args: { row: `${row.id},self` } }],
      ] as Call[]) {
        const { summary, outputs } = await run([getNext, call]);
        expect((outputs[1] as { ok: boolean }).ok).toBe(false);
        expect(s36NoNonAgentClaim.eval(summary).map((v) => v.claim).join(' ')).toContain(row.id);
      }
    }
  });

  it('flags working a non-agent row without a claim (set_state, complete)', async () => {
    const [record] = S36_NON_AGENT_ROWS;
    for (const call of [['work_items:set_state', { id: record!.id, state: 'wip' }], ['work_items:complete', { id: record!.id }]] as Call[]) {
      const { summary } = await run([getNext, call]);
      expect(s36NoNonAgentClaim.eval(summary)).toHaveLength(1);
    }
  });

  it('a by-id claim of agent work passes and counts as taking work', async () => {
    const { summary, outputs } = await run([['work_items:claim', { id: S36_AGENT_ROWS[0]!.id }]]);
    expect((outputs[0] as { ok: boolean }).ok).toBe(true);
    expect(errors(summary)).toEqual([]);
  });

  it('calibration: an engineer that only lists and claims nothing fails', async () => {
    const { summary, outputs } = await run([['work_items:list', { harness: 'papercup' }]]);
    expect((outputs[0] as { count: number }).count).toBe(S36_AGENT_ROWS.length + S36_NON_AGENT_ROWS.length);
    expect(s36TookAgentWork.eval(summary)).toHaveLength(1);
  });

  it('each run gets a fresh world', () => {
    expect(SU_S36_DRAIN_CLAIMS_ONLY_AGENT_WORK.toolOverride).not.toBe(SU_S36_DRAIN_CLAIMS_ONLY_AGENT_WORK.toolOverride);
  });
});
