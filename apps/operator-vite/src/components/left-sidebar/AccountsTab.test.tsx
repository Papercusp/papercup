// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const H = vi.hoisted(() => ({
  accounts: [] as unknown[],
  loading: false,
  expanded: null as string | null,
  setExpanded: vi.fn(),
  forced: new Set<string>(),
  excluded: new Set<string>(),
  toggleForce: vi.fn(),
  toggleExclude: vi.fn(),
  clearOverride: vi.fn(),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: H.accounts, loading: H.loading, error: null }),
}));

vi.mock('nuqs', () => ({
  parseAsString: {},
  useQueryState: () => [H.expanded, H.setExpanded],
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock('../adv/use-account-override', () => ({
  useAccountOverride: () => ({
    overrideBusy: false,
    forced: H.forced,
    excluded: H.excluded,
    overrideActive: H.forced.size > 0 || H.excluded.size > 0,
    toggleForce: H.toggleForce,
    toggleExclude: H.toggleExclude,
    clearOverride: H.clearOverride,
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AccountsTab from './AccountsTab';

const NOW = 1_800_000_000_000;
const ACCOUNT = {
  id: 'acct-opus-1',
  label: 'Opus Primary',
  credentialRef: 'file:/home/user/.claude/account.json',
  boundTo: ['papercup-hive'],
  available: true,
  sustainedlyLimited: false,
  rate: {
    pausedUntil: 0,
    lastPenaltyAt: 0,
    penaltyCount: 0,
    windowStartedAt: NOW - 60_000,
    utilization: 0.23,
    windowResetAt: NOW + 60 * 60_000,
    utilizationAt: NOW - 30_000,
    utilization7d: 0.61,
    windowResetAt7d: NOW + 3 * 86_400_000,
  },
  egress: { localAddress: '10.0.0.5' },
  liveBuckets: [{ key: 'anthropic:opus', provider: 'anthropic', modelClass: 'opus', paused: false, pausedUntil: 0 }],
};

beforeEach(() => {
  vi.setSystemTime(NOW);
  H.accounts = [ACCOUNT];
  H.loading = false;
  H.expanded = null;
  H.setExpanded = vi.fn((next: string | null) => {
    H.expanded = next;
  });
  H.forced = new Set();
  H.excluded = new Set();
  H.toggleForce = vi.fn();
  H.toggleExclude = vi.fn();
  H.clearOverride = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('AccountsTab', () => {
  it('renders the compact pool summary, row facts, usage meters, and steering actions', () => {
    render(<AccountsTab active />);

    expect(screen.getByText('spawn account pool')).toBeTruthy();
    expect(screen.getAllByText('avail').length).toBeGreaterThan(0);
    expect(screen.getByText('1/1')).toBeTruthy();
    expect(screen.getByText('Opus Primary')).toBeTruthy();
    expect(screen.getByLabelText('Available')).toBeTruthy();
    expect(screen.getByText('file:…/account.json')).toBeTruthy();
    expect(screen.getByText('1 bound')).toBeTruthy();
    expect(screen.getByText('1 bucket')).toBeTruthy();
    expect(screen.getByText('egress')).toBeTruthy();
    expect(screen.getByLabelText(/5h usage ~23%/)).toBeTruthy();
    expect(screen.getByLabelText(/7d usage ~61%/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Force only acct-opus-1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Exclude acct-opus-1' })).toBeTruthy();
  });

  it('surfaces session steering and expanded account detail', () => {
    H.forced = new Set(['acct-opus-1']);
    H.expanded = 'acct-opus-1';

    render(<AccountsTab active />);

    expect(screen.getByText('Session steering active')).toBeTruthy();
    expect(screen.getByText('forced')).toBeTruthy();
    expect(screen.getByText('Bound to')).toBeTruthy();
    expect(screen.getByText('papercup-hive')).toBeTruthy();
    expect(screen.getByText('anthropic/opus')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop forcing acct-opus-1' }));
    expect(H.toggleForce).toHaveBeenCalledWith('acct-opus-1');
  });
});
