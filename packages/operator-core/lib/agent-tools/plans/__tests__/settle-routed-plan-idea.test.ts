/**
 * settle-routed-plan-idea.test.ts — WI-10003894 recurrence guard.
 *
 * A plan-rail routed Blender idea used to stay `outcome=pending` for hours after
 * its plan shipped: only `wi:` routes had an eager outcome write, and `plan:`
 * routes waited for the bounded refresh sweep (25 ideas / 15 min against
 * thousands pending). The fix settles the route on the ONE plan content-write
 * chokepoint (withPlanLock's post-commit block) when a write moves the plan INTO
 * a terminal status. These pins cover that edge logic with the ledger write
 * injected, so they need no PG.
 */
import { describe, expect, it, vi } from 'vitest';

import { deriveIndexFromContent } from '../derive-index';
import { settleRoutedPlanIdeaOnTerminalEntry, type PropagatePlanOutcome } from '../with-plan-lock';

const body = (status: string) =>
  ['---', 'slug: arm-a-plan-2026-09-27', `status: ${status}`, 'title: Arm A plan', '---', '', '# Arm A plan', ''].join(
    '\n',
  );

function spy(settled = 1) {
  return vi.fn<PropagatePlanOutcome>(async () => settled);
}

describe('settleRoutedPlanIdeaOnTerminalEntry (WI-10003894)', () => {
  it('calibration: the fixture body parses to the status it declares', () => {
    // Without this, every no-op case below would pass vacuously on a body the
    // parser could not read (status null ⇒ non-terminal ⇒ no call).
    expect(deriveIndexFromContent(body('active')).status).toBe('active');
    expect(deriveIndexFromContent(body('shipped')).status).toBe('shipped');
    expect(deriveIndexFromContent(body('superseded')).status).toBe('superseded');
  });

  it.each([
    ['active', 'shipped'],
    ['awaiting-acceptance', 'shipped'],
    ['ready', 'superseded'],
  ])('propagates on the %s → %s entry edge', async (from, to) => {
    const propagate = spy();
    await expect(
      settleRoutedPlanIdeaOnTerminalEntry('ws-1', 'arm-a-plan-2026-09-27', body(from), body(to), propagate),
    ).resolves.toBe(1);
    expect(propagate).toHaveBeenCalledTimes(1);
    expect(propagate).toHaveBeenCalledWith({
      planSlug: 'arm-a-plan-2026-09-27',
      status: to,
      workspaceId: 'ws-1',
    });
  });

  it('propagates when a plan is created directly in a terminal status (no prior body)', async () => {
    const propagate = spy();
    await settleRoutedPlanIdeaOnTerminalEntry('ws-1', 'p', null, body('superseded'), propagate);
    expect(propagate).toHaveBeenCalledWith({ planSlug: 'p', status: 'superseded', workspaceId: 'ws-1' });
  });

  it('does nothing for an edit to an already-shipped plan (no entry edge)', async () => {
    const propagate = spy();
    await expect(
      settleRoutedPlanIdeaOnTerminalEntry('ws-1', 'p', body('shipped'), body('shipped'), propagate),
    ).resolves.toBe(0);
    expect(propagate).not.toHaveBeenCalled();
  });

  it.each(['draft', 'ready', 'active', 'awaiting-acceptance'])(
    'does nothing when the written status %s is non-terminal',
    async (to) => {
      const propagate = spy();
      await settleRoutedPlanIdeaOnTerminalEntry('ws-1', 'p', body('draft'), body(to), propagate);
      expect(propagate).not.toHaveBeenCalled();
    },
  );

  it('never throws into the committed write: a ledger failure returns 0', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const propagate = vi.fn<PropagatePlanOutcome>(async () => {
      throw new Error('pg down');
    });
    await expect(
      settleRoutedPlanIdeaOnTerminalEntry('ws-1', 'p', body('active'), body('shipped'), propagate),
    ).resolves.toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('routed-idea outcome propagation skipped for p'));
    warn.mockRestore();
  });
});
