import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';

const h = vi.hoisted(() => ({
  notifySyncInvalidate: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('./sync-sse', () => ({
  notifySyncInvalidate: h.notifySyncInvalidate,
}));

import { publishFlagChange } from './flag-bus';

beforeEach(() => {
  h.notifySyncInvalidate.mockClear();
});

describe('publishFlagChange', () => {
  it('mirrors the change onto the shared sync bus for browser consumers', async () => {
    publishFlagChange(FLAGS.TESTING);

    await vi.waitFor(() => expect(h.notifySyncInvalidate).toHaveBeenCalledTimes(1));
    expect(h.notifySyncInvalidate).toHaveBeenCalledWith(
      'flags.changed',
      expect.objectContaining({ key: FLAGS.TESTING, ts: expect.any(Number) }),
    );
  });

  it('uses a timestamp in the sync args so repeated same-key flips remain distinct', async () => {
    publishFlagChange(FLAGS.TESTING);
    await vi.waitFor(() => expect(h.notifySyncInvalidate).toHaveBeenCalledTimes(1));

    publishFlagChange(FLAGS.TESTING);

    await vi.waitFor(() => expect(h.notifySyncInvalidate).toHaveBeenCalledTimes(2));
    const first = h.notifySyncInvalidate.mock.calls[0]?.[1] as { sequence?: number; ts?: number };
    const second = h.notifySyncInvalidate.mock.calls[1]?.[1] as { sequence?: number; ts?: number };
    expect(first.ts).toEqual(expect.any(Number));
    expect(second.ts).toEqual(expect.any(Number));
    expect(second.sequence).toBeGreaterThan(first.sequence ?? -1);
  });
});
