// @vitest-environment jsdom
/**
 * HivesTab render coverage (left-sidebar-tauri-2026-06-07) — the p2p swarm
 * roster. The pure `groupHives` reducer has its own unit test (group-hives.test);
 * this pins the COMPONENT branches: the HIVE_CONTROL-gated LocalHivesControl, the
 * joined/live count line, the error + honest-empty states, and the per-device row
 * (live vs stale dot, stale pill, gh-users + harness suffixes). The `sidebar.hives`
 * sync query and the flag client are mocked; the child control is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  flagOn: false,
  result: { data: [] as unknown[], loading: false, error: null as unknown },
}));

vi.mock('@papercusp/flags/client', () => ({ useFlag: () => H.flagOn }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => H.result }));
// Lexicon resolver mocked to ECHO its key (t('pot') → 'pot') — isolates this
// test from the flag hook; classic pack renders 'Pots'/'Pot' at runtime
// (restore-pot-lexicon P-005).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('./LocalHivesControl', () => ({
  default: () => <div data-testid="local-hives-control" />,
}));
// HiveFederationStatus is mounted inside HivesTab but is its OWN surface with its
// own test + its own `network.federationStatus` sync query. Stub it so this test's
// queryName-agnostic useSyncQuery mock doesn't feed it HivesTab's hive rows (which
// it would mis-read as a FedStatus and crash on). Mirrors the LocalHivesControl stub.
vi.mock('./HiveFederationStatus', () => ({
  default: () => <div data-testid="hive-federation-status" />,
}));

import HivesTab from './HivesTab';

function row(over: Record<string, unknown> = {}) {
  return {
    ownerId: 'o1',
    ownerLabel: 'Owner 1',
    host: 'box-a',
    userId: 'alice',
    intent: 'building things',
    currentView: null,
    harnessSlug: 'pot-x',
    devicePubkey: 'pk-aaa',
    heartbeatAt: '2026-06-15T10:00:00Z',
    stale: false,
    ...over,
  };
}

beforeEach(() => {
  H.flagOn = false;
  H.result = { data: [], loading: false, error: null };
});
afterEach(() => cleanup());

describe('<HivesTab>', () => {
  it('renders the honest empty state when no peers have announced', () => {
    render(<HivesTab active={true} />);
    expect(screen.getByText(/p2p pot · 0 joined · 0 live/)).toBeTruthy();
    expect(screen.getByText(/this pot flies solo/)).toBeTruthy();
    expect(screen.queryByTestId('local-hives-control')).toBeNull();
  });

  it('mounts LocalHivesControl only when the HIVE_CONTROL flag is on', () => {
    H.flagOn = true;
    render(<HivesTab active={true} />);
    expect(screen.getByTestId('local-hives-control')).toBeTruthy();
  });

  it('does not show the empty state while loading', () => {
    H.result = { data: [], loading: true, error: null };
    render(<HivesTab active={true} />);
    expect(screen.queryByText(/this pot flies solo/)).toBeNull();
  });

  it('surfaces a query error', () => {
    H.result = { data: [], loading: false, error: 'substrate unreachable' };
    render(<HivesTab active={true} />);
    expect(screen.getByText(/substrate unreachable/)).toBeTruthy();
  });

  it('groups rows per device and renders a live row with gh-users + harness suffix', () => {
    H.result = { data: [row()], loading: false, error: null };
    render(<HivesTab active={true} />);
    expect(screen.getByText(/1 joined · 1 live/)).toBeTruthy();
    const tile = screen.getByTestId('hive-box-a');
    expect(tile.textContent).toContain('box-a');
    expect(tile.textContent).toContain('gh:alice');
    expect(tile.textContent).toContain('building things');
    expect(tile.textContent).toContain('[pot-x]');
    // live dot, no stale pill
    expect(tile.querySelector('.pclsb-dot.is-up')).toBeTruthy();
    expect(tile.querySelector('.pclsb-pill')).toBeNull();
  });

  it('flags an all-stale device with the stale dot + pill and "quiet" doing', () => {
    H.result = {
      data: [row({ stale: true, intent: null, currentView: null })],
      loading: false,
      error: null,
    };
    render(<HivesTab active={true} />);
    expect(screen.getByText(/1 joined · 0 live/)).toBeTruthy();
    const tile = screen.getByTestId('hive-box-a');
    expect(tile.querySelector('.pclsb-dot.is-down')).toBeTruthy();
    expect(tile.querySelector('.pclsb-pill')?.textContent).toBe('stale');
    expect(tile.textContent).toContain('quiet');
  });

  it('merges two presence rows from the same device pubkey into one tile', () => {
    H.result = {
      data: [
        row({ userId: 'alice', harnessSlug: 'pot-x' }),
        row({ ownerId: 'o2', userId: 'bob', harnessSlug: 'pot-y', heartbeatAt: '2026-06-15T11:00:00Z' }),
      ],
      loading: false,
      error: null,
    };
    render(<HivesTab active={true} />);
    expect(screen.getByText(/1 joined · 1 live/)).toBeTruthy();
    const tile = screen.getByTestId('hive-box-a');
    expect(tile.textContent).toContain('gh:alice,bob');
    expect(tile.textContent).toContain('[pot-x, pot-y]');
  });
});
