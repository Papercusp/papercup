// @vitest-environment jsdom
//
// StaleOperatorIndicator (WI-5956) — renders the @papercusp/sync stale-operator
// store as a persistent sonner toast the moment a query 400s as "unknown
// queryName": the origin is reachable, but running OLDER code than this
// (rebuilt) client. Unlike OfflineIndicator, no grace/hold debounce — a
// version skew doesn't self-heal on retry, so the first report fires
// immediately and stays up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { toast } from 'sonner';

const H = vi.hoisted(() => ({ stale: false, queryNames: [] as string[] }));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncStaleOperator: () => ({ stale: H.stale, queryNames: H.queryNames }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

import StaleOperatorIndicator from './StaleOperatorIndicator';

const TOAST_ID = 'sync-stale-operator-indicator';
const errorMock = () => toast.error as ReturnType<typeof vi.fn>;

beforeEach(() => {
  H.stale = false;
  H.queryNames = [];
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe('<StaleOperatorIndicator>', () => {
  it('renders null (no DOM output)', () => {
    const { container } = render(<StaleOperatorIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('does nothing while not stale', () => {
    render(<StaleOperatorIndicator />);
    expect(errorMock()).not.toHaveBeenCalled();
  });

  it('fires the persistent toast IMMEDIATELY on the first stale report — no debounce', () => {
    H.stale = true;
    H.queryNames = ['plans.attentionItem'];
    render(<StaleOperatorIndicator />);
    expect(errorMock()).toHaveBeenCalledTimes(1);
    const [message, opts] = errorMock().mock.calls[0];
    expect(message).toBe('Your desktop operator is out of date');
    expect(opts).toMatchObject({ id: TOAST_ID, duration: Infinity });
    expect(opts.description).toContain('plans.attentionItem');
    expect(opts.description).toContain('Restart the app');
  });

  it('pluralizes the description for multiple missing queries', () => {
    H.stale = true;
    H.queryNames = ['plans.attentionItem', 'work_items.detail'];
    render(<StaleOperatorIndicator />);
    const [, opts] = errorMock().mock.calls[0];
    expect(opts.description).toContain('2 queries');
  });

  it('re-fires (same stable id) when a SECOND distinct query goes stale after mount', () => {
    H.stale = true;
    H.queryNames = ['plans.attentionItem'];
    const { rerender } = render(<StaleOperatorIndicator />);
    expect(errorMock()).toHaveBeenCalledTimes(1);

    H.queryNames = ['plans.attentionItem', 'work_items.detail'];
    rerender(<StaleOperatorIndicator />);
    expect(errorMock()).toHaveBeenCalledTimes(2);
    expect(errorMock().mock.calls[1][1]).toMatchObject({ id: TOAST_ID });
  });

  it('does not re-fire on an unrelated re-render with unchanged state', () => {
    H.stale = true;
    H.queryNames = ['plans.attentionItem'];
    const { rerender } = render(<StaleOperatorIndicator />);
    expect(errorMock()).toHaveBeenCalledTimes(1);
    rerender(<StaleOperatorIndicator />);
    expect(errorMock()).toHaveBeenCalledTimes(1);
  });
});
