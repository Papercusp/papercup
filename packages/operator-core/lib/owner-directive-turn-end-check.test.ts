/**
 * P-007 of owner-directive-delivery-redesign-2026-09-22 — the turn-end check.
 *
 * Pins both halves of the rule: a directive the session replied to is asked
 * about ONCE (never re-bounced every turn), and an over-cap directive with no
 * summary blocks every turn end until the summary exists. Also pins the scope:
 * only the ADDRESSED session is ever asked, never a peer.
 */
import { describe, expect, it } from 'vitest';
import {
  planTurnEndDirectiveCheck,
  runTurnEndDirectiveCheck,
  TURN_END_ASKED_MEMORY,
  type TurnEndDirectiveCheckDeps,
  type TurnEndDirectiveRow,
} from './owner-directive-turn-end-check';

const ME = 'su-me-0000000000';
const PEER = 'su-peer-00000000';
const LONG = 'x'.repeat(501);

function row(over: Partial<TurnEndDirectiveRow> & { id: number }): TurnEndDirectiveRow {
  return {
    recordedBy: ME,
    verbatimText: 'fix the sidebar',
    summaryText: null,
    createdAtMs: 1_000 + over.id,
    capturedByHook: true,
    ...over,
  };
}

describe('planTurnEndDirectiveCheck', () => {
  it('asks nothing when no open directive is addressed to the session', () => {
    expect(planTurnEndDirectiveCheck({ ownerId: ME, open: [], asked: new Set() })).toBeNull();
    // A peer's directive is awareness for this session, never a question to it.
    const peer = [row({ id: 1, recordedBy: PEER }), row({ id: 2, recordedBy: PEER, verbatimText: LONG })];
    expect(planTurnEndDirectiveCheck({ ownerId: ME, open: peer, asked: new Set() })).toBeNull();
  });

  it('asks done-or-still-open about a replied-to directive exactly once', () => {
    const open = [row({ id: 7 })];
    const first = planTurnEndDirectiveCheck({ ownerId: ME, open, asked: new Set() });
    expect(first?.asking).toEqual([7]);
    expect(first?.reason).toContain('#7');
    expect(first?.reason).toContain('orders:disposition');
    expect(first?.reason).toContain('Still in progress');
    // Once asked, a directive that stays open does not bounce the next turn end.
    expect(planTurnEndDirectiveCheck({ ownerId: ME, open, asked: new Set([7]) })).toBeNull();
  });

  it('asks about every unasked directive, oldest first (owner messages queued mid-turn)', () => {
    const open = [row({ id: 9, createdAtMs: 3_000 }), row({ id: 4, createdAtMs: 1_000 }), row({ id: 6, createdAtMs: 2_000 })];
    const check = planTurnEndDirectiveCheck({ ownerId: ME, open, asked: new Set([6]) });
    expect(check?.asking).toEqual([4, 9]);
    expect(check?.reason).toContain('#4, #9');
  });

  it('does not ask about an orders:record row — only hook-captured turns were replied to', () => {
    const open = [row({ id: 3, capturedByHook: false })];
    expect(planTurnEndDirectiveCheck({ ownerId: ME, open, asked: new Set() })).toBeNull();
  });

  it('blocks on an over-cap directive with no summary every turn, asked or not', () => {
    const open = [row({ id: 5, verbatimText: LONG })];
    for (const asked of [new Set<number>(), new Set([5])]) {
      const check = planTurnEndDirectiveCheck({ ownerId: ME, open, asked });
      expect(check?.reason).toContain('orders:summarize');
      expect(check?.reason).toContain('#5');
    }
    // An agent-recorded over-cap row still owes its summary.
    const recorded = [row({ id: 8, verbatimText: LONG, capturedByHook: false })];
    expect(planTurnEndDirectiveCheck({ ownerId: ME, open: recorded, asked: new Set() })?.reason).toContain('orders:summarize');
  });

  it('stops asking for a summary once one is written', () => {
    const open = [row({ id: 5, verbatimText: LONG, summaryText: 'redo the sidebar' })];
    expect(planTurnEndDirectiveCheck({ ownerId: ME, open, asked: new Set([5]) })).toBeNull();
  });

  it('a directive at exactly the cap is verbatim and owes no summary', () => {
    const open = [row({ id: 2, verbatimText: 'y'.repeat(500) })];
    expect(planTurnEndDirectiveCheck({ ownerId: ME, open, asked: new Set([2]) })).toBeNull();
  });

  it('names at most six ids and counts the rest', () => {
    const open = Array.from({ length: 9 }, (_, i) => row({ id: i + 1 }));
    const check = planTurnEndDirectiveCheck({ ownerId: ME, open, asked: new Set() });
    expect(check?.asking).toHaveLength(9);
    expect(check?.reason).toContain('#6 (+3 more');
    expect(check?.reason).not.toContain('#7');
  });
});

function fakeDeps(open: TurnEndDirectiveRow[], asked: number[] = []) {
  const staged: number[][] = [];
  const deps: TurnEndDirectiveCheckDeps = {
    listOpen: async () => open,
    readAsked: async () => asked,
    stageAsked: async (_owner, next) => {
      staged.push(next);
    },
  };
  return { deps, staged };
}

describe('runTurnEndDirectiveCheck', () => {
  it('stages the asked set, dropping ids no longer open', async () => {
    const { deps, staged } = fakeDeps([row({ id: 10 }), row({ id: 11 })], [2, 10]);
    const reason = await runTurnEndDirectiveCheck({ ownerId: ME, workspaceId: 'ws' }, deps);
    expect(reason).toContain('#11');
    expect(staged).toEqual([[10, 11]]);
  });

  it('stages nothing when only a summary is owed', async () => {
    const { deps, staged } = fakeDeps([row({ id: 12, verbatimText: LONG })], [12]);
    expect(await runTurnEndDirectiveCheck({ ownerId: ME, workspaceId: 'ws' }, deps)).toContain('orders:summarize');
    expect(staged).toEqual([]);
  });

  it('keeps the asked set bounded', async () => {
    const asked = Array.from({ length: TURN_END_ASKED_MEMORY }, (_, i) => i + 1);
    const open = [...asked.map((id) => row({ id })), row({ id: 999 })];
    const { deps, staged } = fakeDeps(open, asked);
    await runTurnEndDirectiveCheck({ ownerId: ME, workspaceId: 'ws' }, deps);
    expect(staged[0]).toHaveLength(TURN_END_ASKED_MEMORY);
    expect(staged[0]!.at(-1)).toBe(999);
  });

  it('fails silent: a store error lets the turn end', async () => {
    const { deps } = fakeDeps([row({ id: 1 })]);
    deps.listOpen = async () => {
      throw new Error('pg down');
    };
    expect(await runTurnEndDirectiveCheck({ ownerId: ME, workspaceId: 'ws' }, deps)).toBeNull();
    const failingStage = fakeDeps([row({ id: 1 })]).deps;
    failingStage.stageAsked = async () => {
      throw new Error('cursor write failed');
    };
    expect(await runTurnEndDirectiveCheck({ ownerId: ME, workspaceId: 'ws' }, failingStage)).toBeNull();
  });
});
