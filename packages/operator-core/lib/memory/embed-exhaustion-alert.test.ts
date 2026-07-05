import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetEmbedExhaustionAlertForTest,
  __setEmbedExhaustionNotifierForTest,
  clearEmbedExhaustionAlertIfActive,
  embedExhaustionAlertCooldownMs,
  maybeEscalateEmbedExhaustion,
} from './embed-exhaustion-alert';

afterEach(() => {
  __resetEmbedExhaustionAlertForTest();
  delete process.env.PAPERCUSP_EMBED_EXHAUSTION_ALERT_COOLDOWN_MS;
});

describe('embed exhaustion owner alert', () => {
  it('alerts once per cooldown window, then allows a later outage reminder', () => {
    const notify = vi.fn();
    __setEmbedExhaustionNotifierForTest(notify);
    process.env.PAPERCUSP_EMBED_EXHAUSTION_ALERT_COOLDOWN_MS = '1000';

    expect(maybeEscalateEmbedExhaustion('openai_billing', { now: 10, workspaceId: 'ws' })).toBe(true);
    expect(maybeEscalateEmbedExhaustion('openai_billing', { now: 20, workspaceId: 'ws' })).toBe(false);
    expect(maybeEscalateEmbedExhaustion('daily_cap', { now: 1011, workspaceId: 'ws' })).toBe(true);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0][0]).toMatchObject({
      kind: 'openai_billing',
      conditionKey: 'embed-exhaustion',
      workspaceId: 'ws',
    });
    expect(notify.mock.calls[1][0]).toMatchObject({ kind: 'daily_cap' });
  });

  it('clears the active severe condition on recovery exactly once', () => {
    const notify = vi.fn();
    const resolve = vi.fn();
    __setEmbedExhaustionNotifierForTest(notify, resolve);

    maybeEscalateEmbedExhaustion('daily_cap', { now: 1, workspaceId: 'ws' });
    expect(clearEmbedExhaustionAlertIfActive({ workspaceId: 'ws' })).toBe(true);
    expect(clearEmbedExhaustionAlertIfActive({ workspaceId: 'ws' })).toBe(false);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ conditionKey: 'embed-exhaustion', workspaceId: 'ws' });
  });

  it('uses a bounded default cooldown and accepts a positive env override', () => {
    expect(embedExhaustionAlertCooldownMs()).toBeGreaterThan(60_000);
    process.env.PAPERCUSP_EMBED_EXHAUSTION_ALERT_COOLDOWN_MS = '1234';
    expect(embedExhaustionAlertCooldownMs()).toBe(1234);
  });
});
