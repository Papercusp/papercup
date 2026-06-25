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

function errorEpisode(
  kind: 'network' | 'unknown' | 'git_missing',
): DogfoodBootstrapProgress {
  return {
    rows: [],
    clone: { step: 'clone', status: 'error', ts: 1, detail: kind === 'network' ? 'network_timeout' : kind },
    hasRows: true,
    hasError: true,
    networkError: kind === 'network',
    gitMissing: kind === 'git_missing',
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
    progress = errorEpisode('network');
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
    progress = errorEpisode('unknown');
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

  it('does NOT auto-retry a git-missing error — shows the install hint + Retry immediately', async () => {
    progress = errorEpisode('git_missing');
    render(<BootstrapFinishGate onReady={() => {}} onCancel={() => {}} />);

    // Actionable, non-transient: the install instruction and a manual Retry are
    // shown right away, and NO automatic retry fires (it can't fix a missing binary).
    expect(screen.getByText(/Git isn’t available/i)).toBeTruthy();
    expect(screen.getByText(/xcode-select --install/i)).toBeTruthy();
    expect(screen.getByTestId('bootstrap-gate-retry')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe('BootstrapFinishGate never-trap escape (WI-791, public-release)', () => {
  it('always offers "Continue into Papercusp", and it enters the app via onReady', async () => {
    // A persistent (git-missing) terminal error must NOT strand the user — the
    // dogfood clone is best-effort/non-fatal, so the escape is always present and
    // wired to onReady (which the parent SetupWizard uses to enter the app).
    progress = errorEpisode('git_missing');
    const onReady = vi.fn();
    render(<BootstrapFinishGate onReady={onReady} onCancel={() => {}} />);

    const cont = screen.getByTestId('bootstrap-gate-continue');
    expect(cont).toBeTruthy();
    // On a terminal error it's the PRIMARY action.
    expect(cont.className).toMatch(/pc-btn--primary/);

    await act(async () => { cont.click(); });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('exposes the escape even while still downloading (no error) so a long clone never blocks entry', async () => {
    progress = {
      rows: [],
      clone: { step: 'clone', status: 'running', ts: 1, percent: 12 },
      hasRows: true,
      hasError: false,
      networkError: false,
      gitMissing: false,
      ready: false,
      inProgress: true,
    };
    const onReady = vi.fn();
    render(<BootstrapFinishGate onReady={onReady} onCancel={() => {}} />);

    const cont = screen.getByTestId('bootstrap-gate-continue');
    expect(cont).toBeTruthy();
    // While downloading (no error) it's a quiet SECONDARY, not primary.
    expect(cont.className).not.toMatch(/pc-btn--primary/);

    await act(async () => { cont.click(); });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('fires onReady at most once across the auto-advance latch and a manual continue', async () => {
    progress = errorEpisode('git_missing');
    const onReady = vi.fn();
    const { rerender } = render(<BootstrapFinishGate onReady={onReady} onCancel={() => {}} />);
    await act(async () => { screen.getByTestId('bootstrap-gate-continue').click(); });
    expect(onReady).toHaveBeenCalledTimes(1);
    // A subsequent real "ready" must not double-fire onReady.
    progress = { ...progress, hasError: false, gitMissing: false, ready: true };
    await act(async () => { rerender(<BootstrapFinishGate onReady={onReady} onCancel={() => {}} />); });
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
