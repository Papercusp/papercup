/**
 * EI-21003383555793967 — an explicit inbox-wake cancellation is a deliberate
 * opt-out for the current session. The activity self-heal may repair a lost
 * SessionStart arm, but must not recreate a row the owner just cancelled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: { kind: 'adv-session' }, note: 'resumable' })),
}));
vi.mock('./store', () => ({
  upsertInboxWakeAwait: vi.fn(async () => ({ id: 7, eventKey: 'coord:inbox-wake:owner' })),
}));
vi.mock('./engine', () => ({ startAwaitSweeper: vi.fn() }));

const h = vi.hoisted(() => {
  const state = {
    armed: [] as unknown[],
    live: [] as unknown[],
    cancelled: [] as Array<{ cancel_reason: string | null }>,
  };
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (text.includes('fired_at IS NULL')) return Promise.resolve(state.armed);
    if (text.includes('ORDER BY started_at DESC')) return Promise.resolve(state.live);
    if (text.includes('bool_or')) {
      const lifecycleReason = values[3];
      return Promise.resolve([{
        opted_out: state.cancelled.some((row) => row.cancel_reason !== lifecycleReason),
        lifecycle_cancelled: state.cancelled.some((row) => row.cancel_reason === lifecycleReason),
      }]);
    }
    if (text.includes('cancelled_at IS NOT NULL')) return Promise.resolve(state.cancelled);
    if (text.includes('event_awaits')) return Promise.resolve(state.armed);
    return Promise.resolve([] as unknown[]);
  };
  return { state, sql };
});

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

import { ensureInboxWakeArmedForActiveSession } from './inbox-wake-arm';
import { upsertInboxWakeAwait } from './store';

beforeEach(() => {
  h.state.armed = [];
  h.state.live = [];
  h.state.cancelled = [];
  vi.clearAllMocks();
});

describe('explicit inbox-wake cancellation and self-heal', () => {
  it('does not recreate a standing wake cancelled during the current live session', async () => {
    h.state.live = [{ started_at: '2026-08-21T03:00:00.000Z' }];
    h.state.cancelled = [{ cancel_reason: 'operator' }];

    await expect(ensureInboxWakeArmedForActiveSession({ ownerId: 'su-ended-loop' })).resolves.toBe(false);
    expect(upsertInboxWakeAwait).not.toHaveBeenCalled();
  });

  it('still repairs a genuinely missing SessionStart arm when no cancellation marker exists', async () => {
    h.state.live = [{ started_at: '2026-08-21T03:00:00.000Z' }];

    await expect(ensureInboxWakeArmedForActiveSession({ ownerId: 'su-lost-arm' })).resolves.toBe(true);
    expect(upsertInboxWakeAwait).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: 'su-lost-arm', eventKey: 'coord:inbox-wake:su-lost-arm' }),
    );
  });
});
