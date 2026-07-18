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
  sendMessage: vi.fn(async (..._args: unknown[]) => ({ to: [] }) as unknown),
  wakeRecipients: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock('./agent-tools/coordination/messages', () => ({ sendMessage: M.sendMessage }));
vi.mock('./agent-tools/coordination/inbox-wake', () => ({ wakeRecipients: M.wakeRecipients }));

import {
  broadcastSevereEvent,
  broadcastSevereEventResolved,
  broadcastSevereEventResolvedMany,
} from './severe-event-broadcast';

beforeEach(() => {
  vi.clearAllMocks();
  M.sendMessage.mockImplementation(async (..._args: unknown[]) => ({ to: [] }) as unknown);
  M.wakeRecipients.mockImplementation(async (..._args: unknown[]) => ({}) as unknown);
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

describe('broadcastSevereEvent — EI-10060 route leg (additive, opt-in)', () => {
  it('no route ⇒ only the broadcast fires; no directed send, no wake', async () => {
    await broadcastSevereEvent({ summary: 's' });
    expect(M.sendMessage).toHaveBeenCalledTimes(1); // the broadcast alone
    expect(M.wakeRecipients).not.toHaveBeenCalled();
  });

  it('a route ⇒ a SEPARATE directed send to the owner selector, in ADDITION to the unchanged broadcast', async () => {
    M.sendMessage
      .mockImplementationOnce(async () => ({ to: ['*'] })) // the broadcast call
      .mockImplementationOnce(async () => ({ to: ['su-mug-1'] })); // the directed route call

    await broadcastSevereEvent({
      summary: 'health tick frozen',
      route: { ownerSelector: '@role:mug', reason: 'fleet-health role' },
    });

    expect(M.sendMessage).toHaveBeenCalledTimes(2);
    const [, broadcastOpts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(broadcastOpts).toMatchObject({ to: ['*'], summary: 'health tick frozen' }); // untouched
    const [, routeOpts] = M.sendMessage.mock.calls[1] as [unknown, Record<string, unknown>];
    expect(routeOpts).toMatchObject({
      to: ['@role:mug'],
      expectsReply: true,
    });
    expect(routeOpts.summary).toContain('fleet-health role');
    expect(routeOpts.summary).toContain('health tick frozen');
  });

  it('wakes whoever the route resolved to LIVE (env.to from sendMessage), not the raw selector', async () => {
    M.sendMessage
      .mockImplementationOnce(async () => ({ to: ['*'] }))
      .mockImplementationOnce(async () => ({ to: ['su-live-mug-session'] }));

    await broadcastSevereEvent({
      summary: 's',
      route: { ownerSelector: '@role:mug', reason: 'r' },
    });

    expect(M.wakeRecipients).toHaveBeenCalledTimes(1);
    const [recipients] = M.wakeRecipients.mock.calls[0] as [string[]];
    expect(recipients).toEqual(['su-live-mug-session']);
  });

  it('a role slot with NO live holder (env.to empty — durable park only) skips the wake, no error', async () => {
    M.sendMessage
      .mockImplementationOnce(async () => ({ to: ['*'] }))
      .mockImplementationOnce(async () => ({ to: [] })); // parked, nobody live

    await expect(
      broadcastSevereEvent({ summary: 's', route: { ownerSelector: '@role:mug', reason: 'r' } }),
    ).resolves.toBe(true);
    expect(M.wakeRecipients).not.toHaveBeenCalled();
  });

  it('a route delivery failure is fail-soft: the broadcast itself still reports success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      M.sendMessage
        .mockImplementationOnce(async () => ({ to: ['*'] })) // the broadcast succeeds
        .mockImplementationOnce(async () => {
          throw new Error('route send failed');
        });
      await expect(
        broadcastSevereEvent({ summary: 's', route: { ownerSelector: '@role:mug', reason: 'r' } }),
      ).resolves.toBe(true);
      expect(warn).toHaveBeenCalled();
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

describe('broadcastSevereEventResolvedMany (EI-9030b — one coalesced all-clear)', () => {
  it('sends ONE message carrying every condition key (plural) + the singular first-key stamp', async () => {
    const keys = ['git-sync-stall:x', 'git-sync-stall:y', 'git-sync-stall:z'];
    const ok = await broadcastSevereEventResolvedMany({
      conditionKeys: keys,
      summary: 'git-sync RECOVERED on 3 harnesses',
    });
    expect(ok).toBe(true);
    expect(M.sendMessage).toHaveBeenCalledTimes(1); // ONE message, not one per harness
    const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts).toMatchObject({
      to: ['*'],
      category: 'severe-event-resolved',
      extra: {
        resolves_conditions: keys,
        resolves_condition: 'git-sync-stall:x',
        condition_key: 'git-sync-stall:x',
      },
    });
  });

  it('a 0-key call is a no-op (no message sent) and returns true', async () => {
    const ok = await broadcastSevereEventResolvedMany({ conditionKeys: [], summary: 's' });
    expect(ok).toBe(true);
    expect(M.sendMessage).not.toHaveBeenCalled();
  });

  it('fail-soft: a sendMessage rejection returns false, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      M.sendMessage.mockRejectedValueOnce(new Error('pg down'));
      await expect(
        broadcastSevereEventResolvedMany({ conditionKeys: ['k'], summary: 's' }),
      ).resolves.toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
