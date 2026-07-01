/**
 * severe-event-broadcast — the fleet "tell every running agent" rail + the
 * WI-1444 condition lifecycle (conditionKey stamping + resolution supersede).
 * sendMessage mocked. Pins:
 *   • broadcastSevereEvent → to:['*'], default category 'severe-event', no
 *     condition stamp unless conditionKey is passed;
 *   • conditionKey stamps extra.condition_key (the inbox-annotation join key);
 *   • broadcastSevereEventResolved → category 'severe-event-resolved' +
 *     extra.resolves_condition + extra.condition_key (same key, so a
 *     resolution row is itself queryable by condition);
 *   • both are fail-soft: a sendMessage rejection returns false, never throws
 *     (a broadcast failure must never break the watchdog sweep that calls it).
 *
 * Run: cd packages/operator-core && npx vitest run lib/severe-event-broadcast.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({}) as unknown),
}));
vi.mock('./agent-tools/coordination/messages', () => ({ sendMessage: M.sendMessage }));

import { broadcastSevereEvent, broadcastSevereEventResolved } from './severe-event-broadcast';

beforeEach(() => {
  vi.clearAllMocks();
  M.sendMessage.mockImplementation(async () => ({}) as unknown);
});

describe('broadcastSevereEvent', () => {
  it('broadcasts to every agent with the default severe-event category', async () => {
    const ok = await broadcastSevereEvent({ summary: 's', body: 'b' });
    expect(ok).toBe(true);
    expect(M.sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = M.sendMessage.mock.calls[0] as [
      { ownerId: string },
      Record<string, unknown>,
    ];
    expect(identity.ownerId).toBe('system-watchdog');
    expect(opts).toMatchObject({ to: ['*'], summary: 's', body: 'b', category: 'severe-event' });
    // No condition stamp unless the caller opts into the lifecycle.
    expect(opts.extra).toBeUndefined();
  });

  it('stamps extra.condition_key when conditionKey is passed (WI-1444)', async () => {
    await broadcastSevereEvent({ summary: 's', conditionKey: 'git-sync-stall:papercusp' });
    const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.extra).toEqual({ condition_key: 'git-sync-stall:papercusp' });
  });

  it('fail-soft: a sendMessage rejection returns false, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      M.sendMessage.mockRejectedValueOnce(new Error('pg down'));
      await expect(broadcastSevereEvent({ summary: 's' })).resolves.toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('broadcastSevereEventResolved (WI-1444)', () => {
  it('broadcasts the all-clear with resolves_condition + condition_key', async () => {
    const ok = await broadcastSevereEventResolved({
      conditionKey: 'green-stall:papercusp',
      summary: 'green-checkpoint RECOVERED on papercusp',
    });
    expect(ok).toBe(true);
    const [identity, opts] = M.sendMessage.mock.calls[0] as [
      { ownerId: string },
      Record<string, unknown>,
    ];
    expect(identity.ownerId).toBe('system-watchdog');
    expect(opts).toMatchObject({
      to: ['*'],
      category: 'severe-event-resolved',
      extra: {
        resolves_condition: 'green-stall:papercusp',
        condition_key: 'green-stall:papercusp',
      },
    });
  });

  it('fail-soft: a sendMessage rejection returns false, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      M.sendMessage.mockRejectedValueOnce(new Error('pg down'));
      await expect(
        broadcastSevereEventResolved({ conditionKey: 'k', summary: 's' }),
      ).resolves.toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
