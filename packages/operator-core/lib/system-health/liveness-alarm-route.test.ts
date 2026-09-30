/**
 * liveness-alarm-route.test.ts — EI-10060 Phase 1 (P-003): defaultPage resolves
 * a responsible owner for the signal and passes it as `route` on the (otherwise
 * unchanged) broadcastSevereEvent call. Uses the REAL resolveSevereEventOwner
 * (pure, no I/O) so this test exercises the actual registry, not a mock of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  notifyAttention: vi.fn(async (..._args: unknown[]) => {}),
  notifyAttentionOnce: vi.fn(async (..._args: unknown[]) => {}),
  broadcastSevereEvent: vi.fn(async (..._args: unknown[]) => true),
}));
// notifyAttentionOnce too: it is reached statically at import through
// register-system-actions → connected-apps/alert-sweep, and a hand-listed factory that
// omits it fails the whole file at collection.
vi.mock('../attention-notify', () => ({
  notifyAttention: M.notifyAttention,
  notifyAttentionOnce: M.notifyAttentionOnce,
}));
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: M.broadcastSevereEvent }));

import { defaultPage } from './liveness-alarm';
import type { AlarmSignal } from './liveness-alarm';

beforeEach(() => {
  vi.clearAllMocks();
});

function sig(key: string, summary = 'x'): AlarmSignal {
  return { key, summary, severity: 'blocker' } as AlarmSignal;
}

describe('defaultPage — EI-10060 route leg', () => {
  it('a REGISTERED signal key (dead-routines) passes route to broadcastSevereEvent', async () => {
    await defaultPage(sig('dead-routines'), 'ws-1');
    expect(M.broadcastSevereEvent).toHaveBeenCalledTimes(1);
    const [opts] = M.broadcastSevereEvent.mock.calls[0] as [Record<string, unknown>];
    expect(opts.route).toMatchObject({ ownerSelector: '@role:mug' });
    // The unchanged parts of the call stay exactly as before this feature.
    expect(opts.conditionKey).toBe('infra-liveness:dead-routines');
    expect(opts.category).toBe('severe-event');
    expect(opts.oneShot).toBe(true);
  });

  it('an UNREGISTERED signal key omits route entirely (no owner to route to)', async () => {
    await defaultPage(sig('accounts-starved'), 'ws-1');
    const [opts] = M.broadcastSevereEvent.mock.calls[0] as [Record<string, unknown>];
    expect(opts.route).toBeUndefined();
    // The broadcast itself is UNCHANGED regardless — ownership is additive, not gating.
    expect(opts.conditionKey).toBe('infra-liveness:accounts-starved');
    // accounts-starved is emitted only on the rising edge; silence while the
    // durable blocker remains open is not evidence of recovery.
    expect(opts.oneShot).toBe(true);
  });

  it('is fail-soft: a broadcastSevereEvent rejection never throws out of defaultPage', async () => {
    M.broadcastSevereEvent.mockRejectedValueOnce(new Error('down'));
    await expect(defaultPage(sig('dead-routines'), 'ws-1')).resolves.toBeUndefined();
  });
});
