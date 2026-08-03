/**
 * severe-event-broadcast — the fleet "tell every running agent" rail + the
 * WI-1444 condition lifecycle (conditionKey stamping + resolution supersede).
 * sendMessage mocked. Pins:
 *   • broadcastSevereEvent → to:['*'], default category 'severe-event';
 *   • conditionKey stamps extra.condition_key (the inbox-annotation join key);
 *   • WI-7309: extra.emitter (pid / startedAt / uptimeSec / cwd) is stamped
 *     UNCONDITIONALLY, and the body carries a rendered trailer — so "which
 *     process fired this alarm" is a field read rather than an hour of streak
 *     arithmetic cross-referenced against `ps`;
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
    expect(opts).toMatchObject({ to: ['*'], summary: 's', category: 'severe-event' });
    // The caller's body is preserved verbatim as the PREFIX; WI-7309 appends the
    // emitter trailer after it.
    expect(String(opts.body)).toMatch(/^b/);
    // No condition stamp unless the caller opts into the lifecycle — but the WI-7309
    // emitter stamp is unconditional, so `extra` itself is always present now.
    expect((opts.extra as Record<string, unknown>).condition_key).toBeUndefined();
  });

  it('stamps extra.condition_key when conditionKey is passed (WI-1444)', async () => {
    await broadcastSevereEvent({ summary: 's', conditionKey: 'git-sync-stall:papercusp' });
    const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.extra).toMatchObject({ condition_key: 'git-sync-stall:papercusp' });
  });

  // WI-7309 — the recurrence guard. Without emitter identity, a false alarm from a
  // long-lived host running frozen pre-fix code is INDISTINGUISHABLE from a real one,
  // and attribution costs hours. These pin the field so it cannot be silently dropped.
  describe('emitter identity (WI-7309)', () => {
    it('stamps extra.emitter unconditionally — no conditionKey, no route, nothing opted in', async () => {
      await broadcastSevereEvent({ summary: 's' });
      const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
      const emitter = (opts.extra as Record<string, unknown>).emitter as Record<string, unknown>;
      expect(emitter).toBeDefined();
      expect(emitter.pid).toBe(process.pid);
      expect(typeof emitter.cwd).toBe('string');
      expect(typeof emitter.uptimeSec).toBe('number');
      expect(emitter.uptimeSec as number).toBeGreaterThanOrEqual(0);
      // startedAt must be a real ISO instant, not in the future — it is THE discriminator
      // for "did this process start before the fix landed", so a malformed value is useless.
      const startedAt = Date.parse(String(emitter.startedAt));
      expect(Number.isNaN(startedAt)).toBe(false);
      expect(startedAt).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('appends a body trailer naming the pid AND the interpretation rule', async () => {
      await broadcastSevereEvent({ summary: 's', body: 'original body' });
      const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
      const body = String(opts.body);
      expect(body).toContain('original body');
      expect(body).toContain(`pid ${process.pid}`);
      // The rule is the load-bearing half: raw numbers alone did not prevent the
      // 2026-08-03 misattribution — a reader has to know what an old start time MEANS.
      expect(body).toMatch(/PREDATES/);
      expect(body).toMatch(/no hot-reload/);
    });

    it('stamps the emitter even when the caller passes no body at all', async () => {
      await broadcastSevereEvent({ summary: 's' });
      const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(String(opts.body)).toContain(`pid ${process.pid}`);
      expect(String(opts.body)).not.toContain('undefined');
    });

    it('carries the same trailer onto the directed route, not just the broadcast', async () => {
      M.sendMessage.mockImplementation(
        async (..._args: unknown[]) => ({ to: ['owner-1'] }) as unknown,
      );
      await broadcastSevereEvent({
        summary: 's',
        body: 'b',
        route: { ownerSelector: 'owner-1', reason: 'owns it' },
      });
      // call 0 = the '*' broadcast, call 1 = the directed route.
      expect(M.sendMessage).toHaveBeenCalledTimes(2);
      const [, routed] = M.sendMessage.mock.calls[1] as [unknown, Record<string, unknown>];
      expect(String(routed.body)).toContain(`pid ${process.pid}`);
    });
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
