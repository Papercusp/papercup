/**
 * What a close does next for a fleet member (close-follow-up.ts): who is handed an item, through
 * which door, and what each outcome of the pull and of the carry tells the caller to do.
 *
 * The pull's dispatcher and the two readers are passed in, so every case here runs the real rule
 * with no database and no host.
 */
import { describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { handNextAfterClose, itemBoundaryNote, releaseDeclaredEditLocks, HAND_OFF_SUMMARY_CAP, type CloseHandOffDeps } from './close-follow-up';

const CLAIM = {
  ok: true,
  workItem: { id: 'WI-10', title: 'AC2 polygon area', summary: 'Build `src/geo_polygon.py` with its tests.', state: 'wip' },
  claimReceipt: { committed: true, workItemId: 'WI-10' },
};

function setup(over: {
  pull?: unknown;
  pullThrows?: Error;
  structured?: unknown;
  member?: boolean;
  freshContext?: boolean;
  carry?: { queued: boolean; error?: string };
  ctx?: Partial<UnifiedToolContext>;
  noDispatcher?: boolean;
} = {}) {
  const dispatchTool = vi.fn(async () => {
    if (over.pullThrows) throw over.pullThrows;
    return {
      content: [
        { type: 'text', text: '⚠ an advisory line that is not the payload' },
        { type: 'text', text: JSON.stringify(over.pull ?? CLAIM) },
      ],
      ...(over.structured !== undefined ? { structuredContent: over.structured } : {}),
    };
  });
  const deps = {
    isFleetMember: vi.fn<CloseHandOffDeps['isFleetMember']>(async () => over.member ?? true),
    freshContextOn: vi.fn<CloseHandOffDeps['freshContextOn']>(async () => over.freshContext ?? true),
    requestCarry: vi.fn<CloseHandOffDeps['requestCarry']>(async () => over.carry ?? { queued: true }),
  };
  const ctx = { ...(over.noDispatcher ? {} : { dispatchTool }), ...over.ctx } as unknown as UnifiedToolContext;
  const run = (input: { handNext?: boolean; closedIds?: string[]; everyResultOk?: boolean } = {}) =>
    handNextAfterClose(
      {
        ctx,
        ownerId: 'su-member',
        workspaceId: 'ws-1',
        handNext: input.handNext,
        closedIds: input.closedIds ?? ['WI-9'],
        everyResultOk: input.everyResultOk ?? true,
      },
      deps,
    );
  return { run, dispatchTool, deps };
}

describe('who a close hands an item to', () => {
  it('hands a fleet member its next item through scheduler:get_next, with no arguments of its own', async () => {
    const { run, dispatchTool, deps } = setup();
    const next = await run();
    expect(dispatchTool).toHaveBeenCalledExactlyOnceWith('scheduler:get_next', {});
    expect(deps.isFleetMember).toHaveBeenCalledExactlyOnceWith('ws-1', 'su-member');
    expect(next).toMatchObject({ handed: true, workItem: { id: 'WI-10' } });
  });

  it('hands nothing to a caller that is not a fleet member, and makes no pull', async () => {
    const { run, dispatchTool } = setup({ member: false });
    expect(await run()).toBeNull();
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('hands a non-member an item when it asks outright, without reading its membership', async () => {
    const { run, dispatchTool, deps } = setup({ member: false });
    expect(await run({ handNext: true })).toMatchObject({ handed: true });
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(deps.isFleetMember).not.toHaveBeenCalled();
  });

  it.each([
    ['handNext: false', { handNext: false }],
    ['a call that closed nothing', { closedIds: [] }],
    ['a call with a failed item', { everyResultOk: false }],
  ])('does nothing at all for %s', async (_label, input) => {
    const { run, dispatchTool, deps } = setup();
    expect(await run(input)).toBeNull();
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(deps.isFleetMember).not.toHaveBeenCalled();
    expect(deps.requestCarry).not.toHaveBeenCalled();
  });

  it('hands a script nothing it did not ask for', async () => {
    const { run, dispatchTool } = setup({ ctx: { codeMode: true } });
    expect(await run()).toBeNull();
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('stays out of the way when membership cannot be read', async () => {
    const { run, deps, dispatchTool } = setup();
    deps.isFleetMember.mockRejectedValueOnce(new Error('pool exhausted'));
    expect(await run()).toBeNull();
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('on a transport with no dispatcher: silent by default, and says so when asked outright', async () => {
    expect(await setup({ noDispatcher: true }).run()).toBeNull();
    expect(await setup({ noDispatcher: true }).run({ handNext: true })).toEqual({
      handed: false,
      reason: 'this transport cannot make the pull for you',
      instruction: 'Pull your next item with scheduler:get_next.',
    });
  });
});

describe('the fresh context for the handed item', () => {
  it('asks for a carry whose note names what was closed, the item held, and its text', async () => {
    const { run, deps } = setup();
    const next = await run({ closedIds: ['WI-8', 'WI-9'] });
    const note = deps.requestCarry.mock.calls[0]![1].note;
    expect(note).toBe(itemBoundaryNote(['WI-8', 'WI-9'], CLAIM.workItem));
    expect(note).toContain('You closed WI-8, WI-9');
    expect(note).toContain('You hold WI-10: AC2 polygon area');
    expect(note).toContain('Build `src/geo_polygon.py` with its tests.');
    expect(note).toContain('do not pull an item');
    // The note names no tool: a session's own instructions say which file tools it has.
    expect(note).toContain('Change files with your file tools only');
    expect(note).toContain('a write through the shell is refused');
    expect(note).not.toMatch(/\bEdit\b|\bWrite\b/);
    // The context that reads this result is about to be dropped: it gets the id, not the text.
    expect(next).toEqual({
      handed: true,
      workItem: { id: 'WI-10', title: 'AC2 polygon area' },
      freshContext: 'queued',
      instruction: expect.stringContaining('End this turn now'),
    });
  });

  it('gives the item in full, to build in the same context, when no carry was queued', async () => {
    const { run } = setup({ carry: { queued: false, error: 'wake_mode_manual' } });
    expect(await run()).toEqual({
      handed: true,
      workItem: { id: 'WI-10', title: 'AC2 polygon area', summary: 'Build `src/geo_polygon.py` with its tests.' },
      freshContextRefused: 'wake_mode_manual',
      instruction: 'You hold WI-10: build it next. Do not call scheduler:get_next; this close made that pull for you.',
    });
  });

  it('does not call a kept context a refusal for a session that is not on an outside plan', async () => {
    const { run } = setup({ carry: { queued: false, error: 'not_on_an_outside_plan' } });
    const next = await run();
    expect(next).toMatchObject({ handed: true, workItem: { id: 'WI-10', summary: expect.any(String) } });
    expect(next).not.toHaveProperty('freshContextRefused');
    expect(next).not.toHaveProperty('freshContext');
  });

  it('with the fresh context switched off, hands the item in full and asks for no carry', async () => {
    const { run, deps } = setup({ freshContext: false });
    const next = await run();
    expect(deps.freshContextOn).toHaveBeenCalledExactlyOnceWith('su-member');
    expect(deps.requestCarry).not.toHaveBeenCalled();
    expect(next).toEqual({
      handed: true,
      workItem: { id: 'WI-10', title: 'AC2 polygon area', summary: 'Build `src/geo_polygon.py` with its tests.' },
      instruction: 'You hold WI-10: build it next. Do not call scheduler:get_next; this close made that pull for you.',
    });
  });

  it('keeps the hand-off when the carry request throws', async () => {
    const { run, deps } = setup();
    deps.requestCarry.mockRejectedValueOnce(new Error('host socket gone'));
    expect(await run()).toMatchObject({ handed: true, workItem: { id: 'WI-10' }, freshContextRefused: 'host socket gone' });
  });

  it('cuts an over-long item text in the note and in the hand-off, and says where the rest is', async () => {
    const long = 'x'.repeat(HAND_OFF_SUMMARY_CAP + 500);
    const claim = { ...CLAIM, workItem: { ...CLAIM.workItem, summary: long } };
    const marker = '[cut short here: read the rest with work_items:get]';
    const queued = setup({ pull: claim });
    await queued.run();
    const note = queued.deps.requestCarry.mock.calls[0]![1].note;
    expect(note).toContain('x'.repeat(HAND_OFF_SUMMARY_CAP) + '\n' + marker);
    expect(note).not.toContain('x'.repeat(HAND_OFF_SUMMARY_CAP + 1));
    const kept = await setup({ pull: claim, carry: { queued: false, error: 'no_live_pty_host' } }).run();
    expect(kept?.workItem?.summary).toBe('x'.repeat(HAND_OFF_SUMMARY_CAP) + '\n' + marker);
  });
});

describe('a pull that claims nothing', () => {
  it('tells a member whose lane is finished to end its turn, and asks for no carry', async () => {
    const { run, deps } = setup({ pull: { ok: false, windDown: true, reason: 'spec_matches_nothing', error: 'nothing left in your lane' } });
    expect(await run()).toEqual({
      handed: false,
      reason: 'nothing left in your lane',
      windDown: true,
      instruction: 'Nothing was handed to you and your lane is finished: end your turn.',
    });
    expect(deps.requestCarry).not.toHaveBeenCalled();
  });

  it('reports a miss that is not a wind-down in the pull\'s own words, cut to a line', async () => {
    const { run } = setup({ pull: { ok: false, error: 'blocked: '.padEnd(900, 'y') } });
    const next = await run();
    expect(next?.handed).toBe(false);
    expect(next?.reason).toMatch(/^blocked: y{391}… \[scheduler:get_next gives the whole of it\]$/);
    expect(next?.instruction).toContain('Call scheduler:get_next for the whole reason');
    expect(next).not.toHaveProperty('windDown');
  });

  it('names what the caller already holds when the pull stopped at its claim cap, and keeps its context', async () => {
    const { run, deps } = setup({
      pull: { ok: false, error: 'claim cap reached: you already hold 1/1', diagnosis: { concurrencyBlocked: true, heldIds: ['WI-10'] } },
    });
    expect(await run()).toEqual({
      handed: false,
      held: ['WI-10'],
      instruction: 'You already hold WI-10: build that next. Do not call scheduler:get_next.',
    });
    expect(deps.requestCarry).not.toHaveBeenCalled();
  });

  it('survives a pull that throws or returns nothing readable', async () => {
    expect(await setup({ pullThrows: new Error('deadline exceeded') }).run()).toEqual({
      handed: false,
      reason: 'deadline exceeded',
      instruction: 'Pull your next item with scheduler:get_next.',
    });
    const unreadable = setup();
    unreadable.dispatchTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }] } as never);
    expect(await unreadable.run()).toEqual({ handed: false, instruction: 'Pull your next item with scheduler:get_next.' });
  });

  it('reads the structured form of the pull when the dispatcher returns one', async () => {
    const { run } = setup({ pull: { ok: false, error: 'the text form' }, structured: CLAIM });
    expect(await run()).toMatchObject({ handed: true, workItem: { id: 'WI-10' } });
  });
});

describe('a close frees the edit locks left on the files it declares', () => {
  const log = vi.fn();
  const ctx = { log } as unknown as UnifiedToolContext;

  it('asks for the declared files once each, and says what it freed', async () => {
    const release = vi.fn(async () => ({ released: ['src/inv_money.py'], heldBefore: 1 }));
    await releaseDeclaredEditLocks({ ctx, ownerId: 'su-member', files: ['src/inv_money.py', 'tests/test_inv_money.py', 'src/inv_money.py', '', 7] }, release);
    expect(release).toHaveBeenCalledExactlyOnceWith({ ownerId: 'su-member', paths: ['src/inv_money.py', 'tests/test_inv_money.py'] });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('released 1 of 1 edit lock(s)'));
  });

  it('is silent when no lock was left, and asks nothing when no file was declared', async () => {
    log.mockClear();
    const release = vi.fn(async () => ({ released: [], heldBefore: 0 }));
    await releaseDeclaredEditLocks({ ctx, ownerId: 'su-member', files: ['src/a.py'] }, release);
    await releaseDeclaredEditLocks({ ctx, ownerId: 'su-member', files: [] }, release);
    expect(release).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('reports a release that failed and never throws: the close has landed', async () => {
    log.mockClear();
    const release = vi.fn(async () => { throw new Error('lock plane unreachable'); });
    await expect(releaseDeclaredEditLocks({ ctx, ownerId: 'su-member', files: ['src/a.py'] }, release)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('NOT released: lock plane unreachable'));
  });
});
