// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  loadFlags: vi.fn(async () => {}),
  listener: null as ((ev: { name: string }) => void) | null,
  unsubscribe: vi.fn(),
}));

vi.mock('@papercusp/flags', () => ({ FLAGS_CHANGED_EVENT: 'flags.changed' }));
vi.mock('@papercusp/flags/client', () => ({ loadFlags: h.loadFlags }));
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: (fn: (ev: { name: string }) => void) => {
    h.listener = fn;
    return h.unsubscribe;
  },
}));

import FlagStreamSubscriber from './FlagStreamSubscriber';

beforeEach(() => {
  h.loadFlags.mockClear();
  h.listener = null;
  h.unsubscribe.mockClear();
});
afterEach(cleanup);

describe('<FlagStreamSubscriber />', () => {
  it('refetches flags from the existing sync bus and tears down its listener', async () => {
    const { unmount } = render(<FlagStreamSubscriber />);
    expect(h.listener).toBeTypeOf('function');

    h.listener?.({ name: 'unrelated.event' });
    expect(h.loadFlags).not.toHaveBeenCalled();

    h.listener?.({ name: 'flags.changed' });
    await waitFor(() => expect(h.loadFlags).toHaveBeenCalledTimes(1));

    unmount();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
