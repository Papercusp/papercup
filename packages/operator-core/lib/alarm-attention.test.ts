import { describe, expect, it, vi } from 'vitest';
import { escalateAlarm } from './alarm-attention';

const request = {
  title: 'Test alarm',
  body: 'attention required',
  cooldownMs: 60_000,
  source: 'alarm-attention-test',
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
});
