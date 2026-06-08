// @vitest-environment jsdom
/**
 * Tests for <LockBanner> — the amber "this plan is locked" banner.
 *
 * Covers: null lock → renders nothing; owner_label preferred over the raw
 * owner id; intent shown only when present; the formatTtl countdown (s vs m
 * vs expired); and the 1s re-render tick. Time is pinned with fake timers so
 * the relative TTL is deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import LockBanner from './LockBanner';
import type { ActiveLock } from './plans-api';

const BASE_NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function lock(overrides: Partial<ActiveLock> = {}): ActiveLock {
  return {
    path: 'apps/operator/docs/plans/x.md',
    owner: 'su-abc',
    owner_label: 'Avi',
    intent: 'editing the now block',
    acquired_ts: new Date(BASE_NOW).toISOString(),
    expires_ts: new Date(BASE_NOW + 45_000).toISOString(),
    ...overrides,
  };
}

describe('LockBanner', () => {
  it('renders nothing when there is no lock', () => {
    const { container } = render(<LockBanner lock={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('names the holder by owner_label and is an aria-live status', () => {
    render(<LockBanner lock={lock()} />);
    const banner = screen.getByRole('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('Avi')).toBeTruthy();
  });

  it('falls back to the raw owner id when owner_label is null', () => {
    render(<LockBanner lock={lock({ owner_label: null, owner: 'su-xyz' })} />);
    expect(screen.getByText('su-xyz')).toBeTruthy();
  });

  it('shows the intent when present and omits it when empty', () => {
    const { container, rerender } = render(<LockBanner lock={lock()} />);
    expect(screen.getByText('editing the now block')).toBeTruthy();
    rerender(<LockBanner lock={lock({ intent: '' })} />);
    expect(container.querySelector('em')).toBeNull();
  });

  it('formats a sub-minute TTL in seconds', () => {
    render(<LockBanner lock={lock({ expires_ts: new Date(BASE_NOW + 45_000).toISOString() })} />);
    expect(screen.getByText('expires in 45s')).toBeTruthy();
  });

  it('formats a multi-minute TTL in minutes', () => {
    render(<LockBanner lock={lock({ expires_ts: new Date(BASE_NOW + 120_000).toISOString() })} />);
    expect(screen.getByText('expires in 2m')).toBeTruthy();
  });

  it('renders an already-past lock as expired', () => {
    render(<LockBanner lock={lock({ expires_ts: new Date(BASE_NOW - 1_000).toISOString() })} />);
    expect(screen.getByText('expired')).toBeTruthy();
  });

  it('counts down on the 1s tick', () => {
    render(<LockBanner lock={lock({ expires_ts: new Date(BASE_NOW + 45_000).toISOString() })} />);
    expect(screen.getByText('expires in 45s')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByText('expires in 42s')).toBeTruthy();
  });
});
