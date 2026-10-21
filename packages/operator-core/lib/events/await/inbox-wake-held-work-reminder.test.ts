import { describe, expect, it, vi } from 'vitest';
import {
  INBOX_WAKE_HELD_WORK_LISTED_CAP,
  inboxWakeHeldWorkReminderText,
  prepareInboxWakeHeldWorkReminder,
} from './inbox-wake-held-work-reminder';
import type { HeldWorkItem } from './wake-source-predicate';

const item = (id: string): HeldWorkItem => ({ id, harness: 'papercusp', status: 'wip', eventBlockers: [] });

describe('inboxWakeHeldWorkReminderText (WI-6554700010018536)', () => {
  it('is empty when the recipient holds nothing, whatever its mode', () => {
    expect(inboxWakeHeldWorkReminderText({ held: [], autonomyModes: ['auto'], loopActive: false })).toBe('');
  });

  it('names the held items and says handling the mail does not finish them', () => {
    const t = inboxWakeHeldWorkReminderText({ held: [item('WI-1'), item('WI-2')], autonomyModes: [], loopActive: null });
    expect(t).toContain('you still hold 2 unfinished work-item(s) [WI-1, WI-2]');
    expect(t).toContain('does not finish them');
    // No autonomy mode ⇒ no claim about wakes.
    expect(t).not.toContain('nothing will wake you');
    expect(t).not.toContain('\n');
  });

  it('adds the no-wake sentence only for an autonomy mode with no loop armed', () => {
    const held = [item('WI-1')];
    const noLoop = inboxWakeHeldWorkReminderText({ held, autonomyModes: ['auto'], loopActive: false });
    expect(noLoop).toContain('You are in auto mode with no loop armed, so nothing will wake you after this turn');
    expect(noLoop).toContain('loop:arm');
    expect(noLoop).toContain('work_items:release');

    expect(inboxWakeHeldWorkReminderText({ held, autonomyModes: ['auto'], loopActive: true })).not.toContain(
      'nothing will wake you',
    );
    // Unknown loop state never claims "no loop".
    expect(inboxWakeHeldWorkReminderText({ held, autonomyModes: ['auto'], loopActive: null })).not.toContain(
      'nothing will wake you',
    );
  });

  it('caps the listed ids and summarises the rest', () => {
    const held = Array.from({ length: INBOX_WAKE_HELD_WORK_LISTED_CAP + 3 }, (_, i) => item(`WI-${i + 1}`));
    const t = inboxWakeHeldWorkReminderText({ held, autonomyModes: [], loopActive: null });
    expect(t).toContain(`you still hold ${held.length} unfinished`);
    expect(t).toContain(`WI-${INBOX_WAKE_HELD_WORK_LISTED_CAP}, +3 more]`);
    expect(t).not.toContain(`WI-${INBOX_WAKE_HELD_WORK_LISTED_CAP + 1},`);
  });
});

describe('prepareInboxWakeHeldWorkReminder (WI-6554700010018536)', () => {
  const base = { ownerId: 'su-x', workspaceId: 'ws-1' };

  it('reproduces the measured case: AUTO, two held items, no loop ⇒ both sentences', async () => {
    const t = await prepareInboxWakeHeldWorkReminder({
      ...base,
      deps: {
        readHeldWorkItems: vi.fn(async () => [item('WI-A'), item('WI-B')]),
        getModes: vi.fn(async () => [{ mode: 'auto' }]),
        getLoopActive: vi.fn(async () => false),
      },
    });
    expect(t).toContain('[WI-A, WI-B]');
    expect(t).toContain('nothing will wake you after this turn');
  });

  it('skips the mode and loop reads when nothing is held', async () => {
    const getModes = vi.fn(async () => [{ mode: 'auto' }]);
    const getLoopActive = vi.fn(async () => false);
    const t = await prepareInboxWakeHeldWorkReminder({
      ...base,
      deps: { readHeldWorkItems: vi.fn(async () => []), getModes, getLoopActive },
    });
    expect(t).toBe('');
    expect(getModes).not.toHaveBeenCalled();
    expect(getLoopActive).not.toHaveBeenCalled();
  });

  it('ignores non-autonomy modes', async () => {
    const t = await prepareInboxWakeHeldWorkReminder({
      ...base,
      deps: {
        readHeldWorkItems: vi.fn(async () => [item('WI-A')]),
        getModes: vi.fn(async () => [{ mode: 'ideate' }]),
        getLoopActive: vi.fn(async () => false),
      },
    });
    expect(t).toContain('[WI-A]');
    expect(t).not.toContain('nothing will wake you');
  });

  it('a failed held-work read yields empty; a failed mode read keeps the held-work sentence', async () => {
    await expect(
      prepareInboxWakeHeldWorkReminder({
        ...base,
        deps: { readHeldWorkItems: vi.fn(async () => Promise.reject(new Error('pg down'))) },
      }),
    ).resolves.toBe('');

    const t = await prepareInboxWakeHeldWorkReminder({
      ...base,
      deps: {
        readHeldWorkItems: vi.fn(async () => [item('WI-A')]),
        getModes: vi.fn(async () => Promise.reject(new Error('modes down'))),
        getLoopActive: vi.fn(async () => false),
      },
    });
    expect(t).toContain('[WI-A]');
    expect(t).not.toContain('nothing will wake you');
  });

  it('a held-work read slower than the budget yields empty instead of delaying the wake', async () => {
    const started = Date.now();
    const t = await prepareInboxWakeHeldWorkReminder({
      ...base,
      deps: {
        budgetMs: 20,
        readHeldWorkItems: vi.fn(() => new Promise<HeldWorkItem[]>(() => undefined)),
      },
    });
    expect(t).toBe('');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
