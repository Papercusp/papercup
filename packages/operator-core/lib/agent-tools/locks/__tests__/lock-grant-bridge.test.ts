/**
 * lock-grant-bridge.test.ts — grant→wake bridging, pure (injected deps)
 * (await-event-primitive-2026-06-05 P-007, D-005/D-009).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  LOCK_GRANT_KEY_PREFIX,
  lockGrantKey,
  reconcileLockGrantAwaits,
  reconcileLockTicket,
  ticketFromLockGrantKey,
} from '../lock-grant-bridge';
import type { AwaitRow } from '../../../events/await/types';

const awaitRow = (eventKey: string): AwaitRow => ({
  id: 1,
  workspaceId: 'ws',
  subscriberId: 'su-b',
  eventKey,
  policy: 'wake',
  note: null,
  wakeHandle: null,
  timeoutBehavior: 'wake',
  expiresTs: null,
  createdAt: new Date().toISOString(),
  firedAt: null,
  firedReason: null,
  cancelledAt: null,
  once: true,
  minSleepSec: null,
  urgency: false,
});

describe('key helpers', () => {
  it('round-trips a ticket through the grant key', () => {
    const k = lockGrantKey('t-123');
    expect(k).toBe(`${LOCK_GRANT_KEY_PREFIX}t-123`);
    expect(ticketFromLockGrantKey(k)).toBe('t-123');
    expect(ticketFromLockGrantKey('not-a-lock-key')).toBeNull();
  });
});

describe('reconcileLockTicket', () => {
  it('waiting → no emit, await stays armed', async () => {
    const emit = vi.fn();
    const out = await reconcileLockTicket('t-1', 'ws', {
      readStatus: async () => ({ status: 'waiting' as const }),
      emit: emit as never,
    });
    expect(out).toBe('waiting');
    expect(emit).not.toHaveBeenCalled();
  });

  it('granted → targeted emit carrying lock_id + TTL + paths', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 1, notified: [], msgId: null }));
    const expires = new Date(Date.now() + 60_000);
    const out = await reconcileLockTicket('t-2', 'ws', {
      readStatus: async () => ({
        status: 'granted' as const,
        granted_lock_id: 'lock-9',
        granted_expires_ts: expires,
        paths: ['lib/foo.ts'],
      }),
      emit: emit as never,
    });
    expect(out).toBe('fired-granted');
    const arg = (emit.mock.calls[0] as unknown as [{ key: string; payload: Record<string, unknown>; summary: string }])[0];
    expect(arg.key).toBe(lockGrantKey('t-2'));
    expect(arg.payload).toMatchObject({ granted: true, lock_id: 'lock-9', paths: ['lib/foo.ts'] });
    expect(arg.summary).toContain('GRANTED');
  });

  it('expired/cancelled/missing → fires granted:false (the waiter decides re-queue vs pivot)', async () => {
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 1, notified: [], msgId: null }));
    const out = await reconcileLockTicket('t-3', 'ws', {
      readStatus: async () => ({ status: 'expired' as const }),
      emit: emit as never,
    });
    expect(out).toBe('fired-terminal');
    const arg = (emit.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0];
    expect(arg.payload).toMatchObject({ granted: false, ticket_status: 'expired' });
  });
});

describe('reconcileLockGrantAwaits', () => {
  it('re-derives every outstanding lock await from waiter truth; one failure does not stop the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => ({ ok: true as const, key: '', woken: 1, notified: [], msgId: null }));
    const statuses: Record<string, { status: 'granted' | 'waiting'; granted_lock_id?: string; paths?: string[] }> = {
      't-a': { status: 'granted', granted_lock_id: 'l-a', paths: ['a.ts'] },
      't-c': { status: 'waiting' },
    };
    await reconcileLockGrantAwaits('ws', {
      listAwaits: async () => [awaitRow(lockGrantKey('t-a')), awaitRow(lockGrantKey('t-b')), awaitRow(lockGrantKey('t-c'))],
      readStatus: async (tid: string) => {
        const s = statuses[tid];
        if (!s) throw new Error('boom');
        return s as never;
      },
      emit: emit as never,
    });
    // t-a fired, t-b threw (logged, skipped), t-c still waiting.
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
