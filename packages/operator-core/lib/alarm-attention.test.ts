import { describe, expect, it, vi } from 'vitest';
import { escalateAlarm, resolveAlarm } from './alarm-attention';
import { isActionableConditionKey } from './coord/actionable-conditions';
vi.mock('./severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true) }));

const request = {
  title: 'Test alarm',
  body: 'attention required',
  cooldownMs: 60_000,
  source: 'alarm-attention-test',
  conditionKey: 'alarm:test',
};

describe('escalateAlarm', () => {
  it('delivers when the durable cooldown is clear', async () => {
    const notify = vi.fn(async () => {});
    const result = await escalateAlarm(request, {
      notify,
      recentlyEscalated: async () => false,
    });

    expect(result).toBe(true);
    expect(notify).toHaveBeenCalledWith({ title: request.title, body: request.body });
  });

  it('suppresses a repeat while the durable cooldown is active', async () => {
    const notify = vi.fn(async () => {});
    const result = await escalateAlarm(request, {
      notify,
      recentlyEscalated: async () => true,
    });

    expect(result).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('fails open when the delivery rail throws without escaping the alarm tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await escalateAlarm(request, {
      notify: async () => {
        throw new Error('push rail down');
      },
      recentlyEscalated: async () => false,
    });

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[alarm-attention-test] escalation failed'));
    warn.mockRestore();
  });

  it('opens the actionable condition on every measured breach despite the owner cooldown', async () => {
    const broadcast = vi.fn(async () => true);
    const notify = vi.fn(async () => {});
    const conditionKey = 'alarm:replication-slot';
    expect(isActionableConditionKey(conditionKey)).toBe(true);
    expect(await escalateAlarm({ ...request, conditionKey }, {
      broadcast, notify, recentlyEscalated: async () => true,
    })).toBe(false);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ conditionKey }));
    expect(notify).not.toHaveBeenCalled();
    const resolve = vi.fn(async () => true);
    expect(await resolveAlarm(conditionKey, request.source, { resolve })).toBe(true);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ conditionKey }));
  });

  it('keeps owner delivery and recovery best effort when condition delivery fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notify = vi.fn(async () => {});
    const fail = async () => { throw new Error('condition rail unavailable'); };
    try {
      expect(await escalateAlarm({ ...request, conditionKey: 'alarm:test' }, {
        broadcast: fail, notify, recentlyEscalated: async () => false,
      })).toBe(true);
      expect(notify).toHaveBeenCalledOnce();
      expect(await resolveAlarm('alarm:test', request.source, { resolve: fail })).toBe(false);
    } finally { warn.mockRestore(); }
  });
});
