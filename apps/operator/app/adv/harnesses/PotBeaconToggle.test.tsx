// @vitest-environment jsdom
//
// PotBeaconToggle — the pot bar's live-status-beacon consent pill (moved off the
// deleted HiveHeaderStrip on 2026-07-27, owner ask). What is pinned here is the
// behavior that survived the move, because the move is exactly when it could have
// been dropped silently:
//
//   • absent consent reads as OFF (default-deny), and the label says so;
//   • a click WRITES the flipped value and adopts the SERVER's echoed consent,
//     not the optimistic guess — a server that refuses the flip must not leave
//     the pill lying;
//   • a failed write keeps the previous state and reports via toast (the strip
//     used to render an inline "failed: …" span, which does not fit a one-row
//     bar — the toast is the replacement, so it is pinned);
//   • with NO injected reader the pill reads the canonical `hive.beaconConsent`
//     sync query. This is the seam that makes the toggle agree with the publish
//     flow; an injected reader is TEST-ONLY and must not be the production path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { toastSpies } = vi.hoisted(() => ({ toastSpies: { success: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast: toastSpies }));

const syncState = vi.hoisted(() => ({
  rows: null as Array<{ potId: string; consent: boolean }> | null,
  invalidate: vi.fn(),
  lastArgs: null as unknown,
  lastEnabled: undefined as boolean | undefined,
}));
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ args, enabled }: { args?: unknown; enabled?: boolean }) => {
    syncState.lastArgs = args;
    syncState.lastEnabled = enabled;
    return {
      data: enabled ? syncState.rows : null,
      loading: false,
      error: null,
      fetching: false,
      invalidate: syncState.invalidate,
    };
  },
}));

vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import PotBeaconToggle from './PotBeaconToggle';

beforeEach(() => {
  syncState.rows = null;
  syncState.lastArgs = null;
  syncState.lastEnabled = undefined;
  syncState.invalidate.mockClear();
  toastSpies.success.mockClear();
  toastSpies.error.mockClear();
});
afterEach(cleanup);

const toggle = () => screen.getByTestId('pot-beacon-toggle');

describe('PotBeaconToggle', () => {
  it('reads absent consent as OFF and flips to ON through the write seam', async () => {
    const setBeaconConsent = vi.fn(async () => ({ ok: true, consent: true }));
    render(
      <PotBeaconToggle
        potSlug="acme"
        getBeaconConsent={async () => false}
        setBeaconConsent={setBeaconConsent}
      />,
    );

    await waitFor(() => expect(toggle().textContent).toMatch(/off/i));
    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle());

    await waitFor(() => expect(toggle().textContent).toMatch(/on/i));
    expect(setBeaconConsent).toHaveBeenCalledWith('acme', true);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('flips ON → OFF, sending the negated value', async () => {
    const setBeaconConsent = vi.fn(async () => ({ ok: true, consent: false }));
    render(
      <PotBeaconToggle
        potSlug="acme"
        getBeaconConsent={async () => true}
        setBeaconConsent={setBeaconConsent}
      />,
    );

    await waitFor(() => expect(toggle().textContent).toMatch(/on/i));
    fireEvent.click(toggle());

    await waitFor(() => expect(setBeaconConsent).toHaveBeenCalledWith('acme', false));
    await waitFor(() => expect(toggle().textContent).toMatch(/off/i));
  });

  it("adopts the SERVER's echoed consent, not the optimistic guess", async () => {
    // The server refused the flip and echoed back the unchanged value. The pill
    // must show what the server said, or it advertises a beacon that is not on.
    render(
      <PotBeaconToggle
        potSlug="acme"
        getBeaconConsent={async () => false}
        setBeaconConsent={async () => ({ ok: true, consent: false })}
      />,
    );

    await waitFor(() => expect(toggle().textContent).toMatch(/off/i));
    fireEvent.click(toggle());

    await waitFor(() => expect(toggle().getAttribute('aria-pressed')).toBe('false'));
    expect(toggle().textContent).toMatch(/off/i);
  });

  it('keeps the previous state and toasts when the write fails', async () => {
    render(
      <PotBeaconToggle
        potSlug="acme"
        getBeaconConsent={async () => true}
        setBeaconConsent={async () => ({ ok: false, error: 'not the owner' })}
      />,
    );

    await waitFor(() => expect(toggle().textContent).toMatch(/on/i));
    fireEvent.click(toggle());

    await waitFor(() => expect(toastSpies.error).toHaveBeenCalledWith('beacon: not the owner'));
    expect(toggle().textContent).toMatch(/on/i);
  });

  it('with no injected reader, reads the canonical hive.beaconConsent sync query', async () => {
    syncState.rows = [{ potId: 'acme', consent: true }];
    render(<PotBeaconToggle potSlug="acme" />);

    await waitFor(() => expect(toggle().textContent).toMatch(/on/i));
    expect(syncState.lastEnabled).toBe(true);
    expect(syncState.lastArgs).toEqual({ potId: 'acme' });
  });

  it('an injected reader DISABLES the sync query (test seam only, never a second read path)', async () => {
    syncState.rows = [{ potId: 'acme', consent: true }];
    render(<PotBeaconToggle potSlug="acme" getBeaconConsent={async () => false} />);

    await waitFor(() => expect(toggle().textContent).toMatch(/off/i));
    expect(syncState.lastEnabled).toBe(false);
  });

  it('renders nothing without a pot slug', () => {
    const { container } = render(<PotBeaconToggle potSlug="" />);
    expect(container.innerHTML).toBe('');
  });
});
