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
      conditionKey: 'embed-exhaustion:openai_billing',
      workspaceId: 'ws',
    });
    expect(notify.mock.calls[1][0]).toMatchObject({ kind: 'daily_cap' });
  });

  it('the two kinds have INDEPENDENT cooldowns — one kind alerting never suppresses the other', () => {
    const notify = vi.fn();
    __setEmbedExhaustionNotifierForTest(notify);
    process.env.PAPERCUSP_EMBED_EXHAUSTION_ALERT_COOLDOWN_MS = '1000';

    // openai_billing alerts and enters its cooldown...
    expect(maybeEscalateEmbedExhaustion('openai_billing', { now: 10, workspaceId: 'ws' })).toBe(true);
    // ...a WHOLLY UNRELATED daily_cap exhaustion moments later must still alert (a shared
    // latch would wrongly suppress this until openai_billing's cooldown lapsed at 1010).
    expect(maybeEscalateEmbedExhaustion('daily_cap', { now: 50, workspaceId: 'ws' })).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatchObject({ kind: 'daily_cap', conditionKey: 'embed-exhaustion:daily_cap' });
  });

  it('clears the active severe condition on recovery exactly once, per kind', () => {
    const notify = vi.fn();
    const resolve = vi.fn();
    __setEmbedExhaustionNotifierForTest(notify, resolve);

    maybeEscalateEmbedExhaustion('daily_cap', { now: 1, workspaceId: 'ws' });
    expect(clearEmbedExhaustionAlertIfActive('daily_cap', { workspaceId: 'ws' })).toBe(true);
    expect(clearEmbedExhaustionAlertIfActive('daily_cap', { workspaceId: 'ws' })).toBe(false);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ conditionKey: 'embed-exhaustion:daily_cap', workspaceId: 'ws' });
  });

  it('clearing one kind never resolves an unrelated ACTIVE alert of the other kind', () => {
    const notify = vi.fn();
    const resolve = vi.fn();
    __setEmbedExhaustionNotifierForTest(notify, resolve);

    maybeEscalateEmbedExhaustion('openai_billing', { now: 1, workspaceId: 'ws' });
    maybeEscalateEmbedExhaustion('daily_cap', { now: 1, workspaceId: 'ws' });
    // Clearing openai_billing (e.g. a successful embed) must NOT also resolve the still-active
    // daily_cap condition (which recovers only via its own UTC-day rollover).
    expect(clearEmbedExhaustionAlertIfActive('openai_billing', { workspaceId: 'ws' })).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ conditionKey: 'embed-exhaustion:openai_billing', workspaceId: 'ws' });
    // daily_cap is still active — a later clear on it still fires its OWN resolve.
    expect(clearEmbedExhaustionAlertIfActive('daily_cap', { workspaceId: 'ws' })).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('uses a bounded default cooldown and accepts a positive env override', () => {
    expect(embedExhaustionAlertCooldownMs()).toBeGreaterThan(60_000);
    process.env.PAPERCUSP_EMBED_EXHAUSTION_ALERT_COOLDOWN_MS = '1234';
    expect(embedExhaustionAlertCooldownMs()).toBe(1234);
  });
});
