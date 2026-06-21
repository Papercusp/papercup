// @vitest-environment jsdom
//
// VersionBadge — the bottom-right "what's running" pill + out-of-date detector.
// Polls GET /api/desktop/version every 30s; captures the FIRST sidecarSha and,
// when a later poll returns a different sha, flips to an amber "↻ reload" that
// hard-reloads the SPA. These tests pin the render-null-until-info, the
// happy-pill render, the stale→reload transition (and its click), the
// same-sha-stays-current path, and the !ok / reject swallow paths — driving the
// poll/compare logic through fake timers with each .then chain flushed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import VersionBadge from './VersionBadge';

interface VersionInfo {
  appVersion: string;
  sidecarSha: string;
  sidecarStartedAtMs: number;
  nowMs: number;
  isDesktop: boolean;
}

const info = (over: Partial<VersionInfo> = {}): VersionInfo => ({
  appVersion: '1.2.3',
  sidecarSha: 'abc1234',
  sidecarStartedAtMs: 1_700_000_000_000,
  nowMs: Date.now(),
  isDesktop: true,
  ...over,
});

/** A fetch mock whose successive calls return successive bodies. The last entry
 *  repeats once the queue drains so extra interval ticks stay deterministic. */
function queueFetch(responses: Array<{ ok: boolean; body?: VersionInfo } | 'reject'>) {
  let i = 0;
  const mock = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r === 'reject') throw new Error('network');
    return { ok: r.ok, json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Flush the poll's await fetch → await json → setState chain. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let reloadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  reloadSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    value: { ...window.location, reload: reloadSpy },
    writable: true,
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('<VersionBadge>', () => {
  it('renders nothing until the first poll lands, then shows the version pill', async () => {
    queueFetch([{ ok: true, body: info() }]);
    const { container } = render(<VersionBadge />);
    // before the fetch resolves → null
    expect(container.innerHTML).toBe('');
    await flush();
    expect(screen.getByText('v1.2.3')).toBeTruthy();
    expect(screen.getByText('abc1234')).toBeTruthy();
    // current build → no reload affordance
    expect(screen.queryByText(/↻ reload/)).toBeNull();
    const btn = screen.getByRole('button');
    expect(btn.style.cursor).toBe('default');
  });

  it('the current-build title carries the sha + desktop/browser, not the stale message', async () => {
    queueFetch([{ ok: true, body: info({ isDesktop: false }) }]);
    render(<VersionBadge />);
    await flush();
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toContain('app v1.2.3 · abc1234');
    expect(btn.getAttribute('aria-label')).toContain('browser');
    expect(btn.getAttribute('aria-label')).not.toContain('newer build is running');
  });

  it('a later poll with a NEW sha flips to "↻ reload"; clicking hard-reloads', async () => {
    queueFetch([
      { ok: true, body: info({ sidecarSha: 'sha-old' }) },
      { ok: true, body: info({ sidecarSha: 'sha-new' }) },
    ]);
    render(<VersionBadge />);
    await flush();
    expect(screen.queryByText('↻ reload')).toBeNull();

    // next 30s tick → second poll → different sha → stale
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();

    expect(screen.getByText('↻ reload')).toBeTruthy();
    const btn = screen.getByRole('button');
    expect(btn.style.cursor).toBe('pointer');
    expect(btn.getAttribute('aria-label')).toContain('A newer build is running on the server');

    fireEvent.click(btn);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('a later poll with the SAME sha stays current (no reload affordance, click is a no-op)', async () => {
    queueFetch([
      { ok: true, body: info({ sidecarSha: 'same' }) },
      { ok: true, body: info({ sidecarSha: 'same', appVersion: '1.2.4' }) },
    ]);
    render(<VersionBadge />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();

    expect(screen.queryByText('↻ reload')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('a non-ok response keeps the prior pill and never sets the initial sha', async () => {
    queueFetch([
      { ok: true, body: info({ sidecarSha: 'sha-1', appVersion: '1.0.0' }) },
      { ok: false }, // a 5xx — bails before json(), no setInfo, no sha capture
      { ok: true, body: info({ sidecarSha: 'sha-2', appVersion: '2.0.0' }) },
    ]);
    render(<VersionBadge />);
    await flush();
    expect(screen.getByText('v1.0.0')).toBeTruthy();

    // tick 1: !ok → prior pill retained
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    expect(screen.getByText('v1.0.0')).toBeTruthy();

    // tick 2: ok with a new sha vs the FIRST seen sha → stale
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    expect(screen.getByText('v2.0.0')).toBeTruthy();
    expect(screen.getByText('↻ reload')).toBeTruthy();
  });

  it('swallows a fetch reject (network blip): no throw, keeps the prior pill', async () => {
    queueFetch([{ ok: true, body: info({ appVersion: '3.0.0' }) }, 'reject']);
    render(<VersionBadge />);
    await flush();
    expect(screen.getByText('v3.0.0')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    // reject is caught; the pill is unchanged
    expect(screen.getByText('v3.0.0')).toBeTruthy();
  });

  it('stays null when the very first poll fails (no info to render)', async () => {
    queueFetch(['reject']);
    const { container } = render(<VersionBadge />);
    await flush();
    expect(container.innerHTML).toBe('');
  });

  it('stops polling after unmount (interval is cleared)', async () => {
    const mock = queueFetch([{ ok: true, body: info() }]);
    const { unmount } = render(<VersionBadge />);
    await flush();
    const callsAtUnmount = mock.mock.calls.length;
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(mock.mock.calls.length).toBe(callsAtUnmount);
  });
});
