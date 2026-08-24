/** Recurrence guard for WI-41203's terminal-state push gap. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ notifySyncInvalidate: vi.fn() }));

vi.mock('../sync-sse', () => ({ notifySyncInvalidate: h.notifySyncInvalidate }));

import {
  BULK_RUN_SYNC_QUERY,
  notifyBulkRunAndAttentionChanged,
  notifyBulkRunChanged,
} from './bulk-run-sync';

beforeEach(() => {
  vi.clearAllMocks();
  h.notifySyncInvalidate.mockResolvedValue(undefined);
});

describe('bulk-run sync invalidation', () => {
  it('bypasses the first-wins 90s bus window for every persisted run transition', async () => {
    await notifyBulkRunChanged();
    await notifyBulkRunChanged();

    expect(h.notifySyncInvalidate).toHaveBeenCalledTimes(2);
    for (const call of h.notifySyncInvalidate.mock.calls) {
      expect(call).toEqual([BULK_RUN_SYNC_QUERY, undefined, undefined, { dedupeWindowMs: 0 }]);
    }
  });

  it('also delivers each Attention-feed change from bounded terminal actions', async () => {
    await notifyBulkRunAndAttentionChanged();

    expect(h.notifySyncInvalidate).toHaveBeenCalledWith(
      BULK_RUN_SYNC_QUERY,
      undefined,
      undefined,
      { dedupeWindowMs: 0 },
    );
    expect(h.notifySyncInvalidate).toHaveBeenCalledWith(
      'plans.attention',
      undefined,
      undefined,
      { dedupeWindowMs: 0 },
    );
  });
});
