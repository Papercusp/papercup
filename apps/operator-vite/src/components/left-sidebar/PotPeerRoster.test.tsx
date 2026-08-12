// @vitest-environment jsdom
/**
 * PotPeerRoster render coverage — the p2p swarm roster, re-homed from the removed
 * Pots tab into the System tab by P-077 (this file is the surviving half of
 * PotsTab.test.tsx, whose LocalPotsControl/POT_CONTROL branches went with the
 * retired tier). The pure `groupHives` reducer keeps its own unit test
 * (group-pots.test); this pins the COMPONENT branches: the collapsed-header
 * summary, the error + honest-empty states, and the per-device row (live vs stale
 * dot, stale pill, gh-users + harness suffixes).
 *
 * The collapsed-header summary is asserted DIRECTLY (rosterSummary) as well as
 * through the DOM, because it is the one signal a user sees while the section is
 * closed — which is its default state — so a regression there is invisible to any
 * assertion that only inspects the open body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  result: { data: [] as unknown[], loading: false, error: null as unknown },
}));

vi.mock('@papercusp/sync', () => ({ onSyncBusEvent: () => () => {}, useSyncQuery: () => H.result }));
// Lexicon resolver mocked to ECHO its key (t('pot') → 'pot') — isolates this
// test from the flag hook; classic pack renders 'Pots'/'Pot' at runtime
// (restore-pot-lexicon P-005).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
// RailSection holds its open state in the URL (nuqs), per the repo's state rule.
// Pinned OPEN here so the body is assertable — the collapsed path is covered by
// the rosterSummary assertions below, which is what a closed section shows.
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: () => [true, vi.fn()],
  parseAsBoolean: { withDefault: () => ({}) },
}));

import PotPeerRoster, { rosterSummary, type HiveGroup } from './PotPeerRoster';

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

function group(over: Partial<HiveGroup> = {}): HiveGroup {
  return {
    machine: 'box-a',
    devicePubkey: 'pk-aaa',
    users: [],
    harnesses: [],
    doing: '',
    lastSeen: '',
    stale: false,
    ...over,
  };
}

beforeEach(() => {
  H.result = { data: [], loading: false, error: null };
});
afterEach(() => cleanup());

describe('rosterSummary (the collapsed-header signal)', () => {
  it('reads "flying solo" when nobody has announced — not a false 0-peer alarm', () => {
    expect(rosterSummary([], false)).toEqual({ label: 'flying solo', tone: 'mute' });
  });

  it('holds its tongue while the first push is in flight', () => {
    expect(rosterSummary([], true)).toEqual({ label: '…', tone: 'mute' });
  });

  it('warns when every joined peer has gone quiet — "joined" alone would read as connected', () => {
    expect(rosterSummary([group({ stale: true })], false)).toEqual({
      label: '⚠ 1 quiet',
      tone: 'warn',
    });
  });

  it('reports live/total when at least one peer is live', () => {
    expect(rosterSummary([group(), group({ devicePubkey: 'pk-bbb', stale: true })], false)).toEqual({
      label: '1/2 live',
      tone: 'good',
    });
  });
});

describe('<PotPeerRoster>', () => {
  it('renders the honest empty state when no peers have announced', () => {
    render(<PotPeerRoster />);
    expect(screen.getByText(/this pot flies solo/)).toBeTruthy();
  });

  it('does not show the empty state while loading', () => {
    H.result = { data: [], loading: true, error: null };
    render(<PotPeerRoster />);
    expect(screen.queryByText(/this pot flies solo/)).toBeNull();
  });

  it('surfaces a query error', () => {
    H.result = { data: [], loading: false, error: 'substrate unreachable' };
    render(<PotPeerRoster />);
    expect(screen.getByText(/substrate unreachable/)).toBeTruthy();
  });

  it('groups rows per device and renders a live row with gh-users + harness suffix', () => {
    H.result = { data: [row()], loading: false, error: null };
    render(<PotPeerRoster />);
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
    render(<PotPeerRoster />);
    const tile = screen.getByTestId('hive-box-a');
    expect(tile.querySelector('.pclsb-dot.is-down')).toBeTruthy();
    expect(tile.querySelector('.pclsb-pill')?.textContent).toBe('stale');
    expect(tile.textContent).toContain('quiet');
  });

  it('merges two presence rows from the same device pubkey into one tile', () => {
    H.result = {
      data: [
        row({ userId: 'alice', harnessSlug: 'pot-x' }),
        row({
          ownerId: 'o2',
          userId: 'bob',
          harnessSlug: 'pot-y',
          heartbeatAt: '2026-06-15T11:00:00Z',
        }),
      ],
      loading: false,
      error: null,
    };
    render(<PotPeerRoster />);
    const tile = screen.getByTestId('hive-box-a');
    expect(tile.textContent).toContain('gh:alice,bob');
    expect(tile.textContent).toContain('[pot-x, pot-y]');
  });
});
