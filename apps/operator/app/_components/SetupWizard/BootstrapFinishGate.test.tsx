// @vitest-environment jsdom
/**
 * BootstrapFinishGate.test.tsx — EI-3548 auto-retry behavior.
 *
 * A transient bootstrap error (e.g. a GitHub connect-timeout) must SELF-HEAL:
 * the gate auto-retries with backoff and shows a "retrying" message instead of a
 * terminal "failed" + manual Retry. Only once the bounded auto-retries are
 * exhausted does the manual Retry button surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { DogfoodBootstrapProgress } from '../useDogfoodBootstrapProgress';

// Drive the hook from a mutable object + spy the trigger.
let progress: DogfoodBootstrapProgress;
const startSpy = vi.fn(async () => ({ ok: true }));
vi.mock('../useDogfoodBootstrapProgress', () => ({
  useDogfoodBootstrapProgress: () => progress,
  startDogfoodBootstrap: () => startSpy(),
}));

import { BootstrapFinishGate } from './BootstrapFinishGate';

function errorEpisode(networkError: boolean): DogfoodBootstrapProgress {
  return {
    rows: [],
    clone: { step: 'clone', status: 'error', ts: 1, detail: networkError ? 'network_timeout' : 'unknown' },
    hasRows: true,
    hasError: true,
    networkError,
    ready: false,
    inProgress: false,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  startSpy.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BootstrapFinishGate auto-retry (EI-3548)', () => {
  it('auto-retries a network error with backoff and shows no manual Retry until exhausted', async () => {
    progress = errorEpisode(true);
    render(<BootstrapFinishGate onReady={() => {}} onCancel={() => {}} />);

    // While auto-retrying: a "retrying" message, network-aware, and NO manual button.
    expect(screen.getAllByText(/retrying/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/reach GitHub/i)).toBeTruthy();
    expect(screen.queryByTestId('bootstrap-gate-retry')).toBeNull();
    expect(startSpy).not.toHaveBeenCalled();

    // Backoff schedule: 2s, 4s, 8s → one auto-retry fires per window, bounded at 3.
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(startSpy).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(startSpy).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(startSpy).toHaveBeenCalledTimes(3);

    // Exhausted → no further auto-retries, and the manual Retry now appears with a
    // network-specific, non-auth message.
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(startSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('bootstrap-gate-retry')).toBeTruthy();
    expect(screen.getAllByText(/couldn’t reach GitHub/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/not your GitHub sign-in/i)).toBeTruthy();
  });

  it('auto-retries a non-network error too, then falls back to the generic failure', async () => {
    progress = errorEpisode(false);
    render(<BootstrapFinishGate onReady={() => {}} onCancel={() => {}} />);

    expect(screen.getByText(/snag — retrying/i)).toBeTruthy();
    // One auto-retry fires per backoff window (timers rescheduled by the effect
    // are only armed after each act() flush, so advance window-by-window).
    await act(async () => { vi.advanceTimersByTime(2000); });
    await act(async () => { vi.advanceTimersByTime(4000); });
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(startSpy).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/Workspace download failed/i)).toBeTruthy();
    expect(screen.getByTestId('bootstrap-gate-retry')).toBeTruthy();
  });
});
