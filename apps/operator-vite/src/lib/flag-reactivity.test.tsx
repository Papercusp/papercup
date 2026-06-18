// @vitest-environment jsdom
/**
 * flag-reactivity (flag-reactivity 2026-06-18) — encodes the user-reported bug
 * fix: toggling a feature flag re-renders gated UI WITHOUT a full reload.
 *
 *   1. useFlag re-renders its consumer when the shared store flips
 *      (setFlagPayload) — the reactivity fix in @papercusp/flags/client. Before
 *      it, useFlag was a plain non-subscribing read, so a toggle never reached
 *      the gated UI until a reload (e.g. disabling testing features in the dev
 *      rail left them visible).
 *   2. useFlagStreamSync opens /api/flags/stream on mount + closes on unmount —
 *      the wiring that delivers live toggles into the shared store (which was
 *      otherwise frozen at the window.__PAPERCUSP_FLAGS__ bootstrap snapshot).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useFlag, setFlagPayload, subscribeToFlagStream } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { useFlagStreamSync } from './use-flag-stream-sync';

// Keep the REAL store (useFlag / setFlagPayload / subscribe share module state)
// but stub the SSE opener so the wiring test asserts the call without a real
// transport. importOriginal preserves the live function refs (shared closures).
vi.mock('@papercusp/flags/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/client')>();
  return { ...actual, subscribeToFlagStream: vi.fn(() => ({ close: vi.fn() })) };
});

type Payload = Parameters<typeof setFlagPayload>[0];

afterEach(() => {
  cleanup();
  setFlagPayload({ flags: {}, evaluatedAt: 0, source: 'defaults' } as Payload);
  vi.clearAllMocks();
});

function Probe() {
  return <span>{useFlag(FLAGS.TESTING) ? 'ON' : 'OFF'}</span>;
}

describe('useFlag reactivity', () => {
  it('re-renders the consumer when a flag flips in the shared store (no reload)', () => {
    act(() =>
      setFlagPayload({ flags: { [FLAGS.TESTING]: true }, evaluatedAt: 1, source: 'override' } as Payload),
    );
    render(<Probe />);
    expect(screen.getByText('ON')).toBeTruthy();

    // The exact path the dev-rail toggle drives: server → SSE → setFlagPayload.
    act(() =>
      setFlagPayload({ flags: { [FLAGS.TESTING]: false }, evaluatedAt: 2, source: 'override' } as Payload),
    );
    expect(screen.getByText('OFF')).toBeTruthy();
  });
});

describe('useFlagStreamSync wiring', () => {
  it('opens the flag stream on mount and closes it on unmount', () => {
    const close = vi.fn();
    vi.mocked(subscribeToFlagStream).mockReturnValue({ close });

    function Host() {
      useFlagStreamSync();
      return null;
    }
    const { unmount } = render(<Host />);
    expect(subscribeToFlagStream).toHaveBeenCalledTimes(1);

    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
