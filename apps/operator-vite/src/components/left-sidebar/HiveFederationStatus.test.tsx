// @vitest-environment jsdom
/**
 * HiveFederationStatus render + honesty coverage (Brief M / G-004).
 *
 * "The UI never lies" is this surface's whole reason to exist, so the assertions
 * are honesty-shaped: a 0-peer published hive must read "broadcasting into the
 * void" (NOT "synced" / "connected"); a private hive must read "private — not
 * announced" (NOT "0 peers", which would imply a failed reach); the substrate line
 * is install-wide health, never a per-peer sync claim; and the scope note that
 * reach ≠ content-sync is always present. The pure label fns carry the core; the
 * rendered DOM pins the wiring. `fetch` is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import HiveFederationStatus, { reachLabel, substrateLabel, drainLabel, type FedStatus } from './HiveFederationStatus';

function mockFetch(body: FedStatus | null, ok = true) {
  global.fetch = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const status = (over: Partial<FedStatus> = {}): FedStatus => ({
  ok: true,
  substrate: { active: true, bootedHarnesses: 2, healthy: 2, booting: 0, degraded: 0 },
  hives: [],
  ...over,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('reachLabel (honesty core)', () => {
  it('announced hive with peers → honest discovery reach', () => {
    expect(reachLabel({ visibility: 'public', reachablePeers: 3 })).toBe('discoverable to 3 peers');
    expect(reachLabel({ visibility: 'invite', reachablePeers: 1 })).toBe('discoverable to 1 peer');
  });
  it('announced hive with 0 peers → the honest stranded copy, NOT a sync/connected claim', () => {
    const label = reachLabel({ visibility: 'public', reachablePeers: 0 });
    expect(label).toBe('no peers connected yet — broadcasting into the void');
    expect(label).not.toMatch(/synced|connected to|in sync/i);
  });
  it('private hive → "not announced", NOT "0 peers" (it never announces)', () => {
    const label = reachLabel({ visibility: 'private', reachablePeers: 0 });
    expect(label).toBe('private — not announced');
    expect(label).not.toMatch(/0 peer|void/i);
  });
});

describe('substrateLabel (install-wide, not a sync claim)', () => {
  it('summarises booted/healthy and flags degraded', () => {
    expect(substrateLabel({ active: true, bootedHarnesses: 2, healthy: 2, booting: 0, degraded: 0 })).toBe(
      'substrate active · 2 harnesses booted · 2 healthy',
    );
    expect(substrateLabel({ active: true, bootedHarnesses: 3, healthy: 2, booting: 0, degraded: 1 })).toContain(
      '⚠ 1 degraded',
    );
    expect(substrateLabel({ active: false, bootedHarnesses: 0, healthy: 0, booting: 0, degraded: 0 })).toBe(
      'substrate inactive',
    );
  });
});

describe('drainLabel (install-wide SYNC honesty — EI-1618/EI-1599)', () => {
  it('returns null when nothing is stalled (silence, NOT a false "all synced" claim)', () => {
    expect(drainLabel(undefined)).toBeNull();
    expect(drainLabel({ stalledHarnesses: 0, worstUndrainedCount: 0, worstOldestUndrainedAgeMs: null })).toBeNull();
  });
  it('reports a stall honestly — captured-but-not-federating, never "synced"', () => {
    const label = drainLabel({ stalledHarnesses: 2, worstUndrainedCount: 12, worstOldestUndrainedAgeMs: 600_000 });
    expect(label).toContain('not syncing');
    expect(label).toContain('2 harnesses');
    expect(label).toContain('12 changes');
    expect(label).toContain('600s');
    expect(label).toMatch(/captured but not federating/);
    expect(label).not.toMatch(/synced|in sync/i);
  });
  it('singularises one harness / one change', () => {
    expect(drainLabel({ stalledHarnesses: 1, worstUndrainedCount: 1, worstOldestUndrainedAgeMs: 65_000 })).toBe(
      '⚠ not syncing — 1 harness with content captured but not federating (1 change undrained, oldest 65s)',
    );
  });
});

describe('<HiveFederationStatus>', () => {
  it('renders an announced hive\'s reach + the install substrate line', async () => {
    mockFetch(status({ hives: [{ hiveId: 'h1', title: 'My Hive', visibility: 'public', memberCount: 1, reachablePeers: 4 }] }));
    render(<HiveFederationStatus />);
    expect((await screen.findByTestId('fed-reach-h1')).textContent).toBe('discoverable to 4 peers');
    expect(screen.getByTestId('fed-substrate').textContent).toContain('2 harnesses booted');
    // honest scope note always present
    expect(screen.getByTestId('fed-scope-note').textContent).toMatch(/not yet surfaced/);
  });

  it('shows a 0-peer published hive as STRANDED (void copy + down dot), never "synced"', async () => {
    mockFetch(status({ hives: [{ hiveId: 'h0', title: 'Lonely', visibility: 'public', memberCount: 1, reachablePeers: 0 }] }));
    render(<HiveFederationStatus />);
    const reach = await screen.findByTestId('fed-reach-h0');
    expect(reach.textContent).toBe('no peers connected yet — broadcasting into the void');
    const tile = screen.getByTestId('fed-hive-h0');
    expect(tile.querySelector('.pclsb-dot.is-down')).toBeTruthy();
    expect(tile.textContent).not.toMatch(/synced/i);
  });

  it('shows a private hive honestly (not announced), not a 0-peer failure', async () => {
    mockFetch(status({ hives: [{ hiveId: 'hp', title: 'Secret', visibility: 'private', memberCount: 0, reachablePeers: 0 }] }));
    render(<HiveFederationStatus />);
    expect((await screen.findByTestId('fed-reach-hp')).textContent).toBe('private — not announced');
  });

  it('flags a degraded substrate with a down dot', async () => {
    mockFetch(status({ substrate: { active: true, bootedHarnesses: 2, healthy: 1, booting: 0, degraded: 1 } }));
    render(<HiveFederationStatus />);
    const sub = await screen.findByTestId('fed-substrate');
    expect(sub.textContent).toContain('⚠ 1 degraded');
    expect(sub.querySelector('.pclsb-dot.is-down')).toBeTruthy();
  });

  it('renders the SYNC-stall row when a harness outbox is stalled (down dot, never "synced")', async () => {
    mockFetch(
      status({
        substrate: {
          active: true,
          bootedHarnesses: 2,
          healthy: 1,
          booting: 0,
          degraded: 1,
          drain: { stalledHarnesses: 1, worstUndrainedCount: 5, worstOldestUndrainedAgeMs: 300_000 },
        },
      }),
    );
    render(<HiveFederationStatus />);
    const drain = await screen.findByTestId('fed-drain');
    expect(drain.textContent).toContain('not syncing');
    expect(drain.textContent).toContain('5 changes');
    expect(drain.textContent).not.toMatch(/synced/i);
    expect(drain.querySelector('.pclsb-dot.is-down')).toBeTruthy();
  });

  it('renders NO sync-stall row when nothing is stalled (silence = healthy, no false claim)', async () => {
    mockFetch(
      status({
        substrate: {
          active: true,
          bootedHarnesses: 2,
          healthy: 2,
          booting: 0,
          degraded: 0,
          drain: { stalledHarnesses: 0, worstUndrainedCount: 0, worstOldestUndrainedAgeMs: null },
        },
      }),
    );
    render(<HiveFederationStatus />);
    await screen.findByTestId('fed-substrate');
    expect(screen.queryByTestId('fed-drain')).toBeNull();
  });

  it('honest empty state when no hives are published', async () => {
    mockFetch(status({ hives: [] }));
    render(<HiveFederationStatus />);
    expect((await screen.findByTestId('fed-no-hives')).textContent).toMatch(/No hives published/);
  });

  it('surfaces a fetch error instead of claiming health', async () => {
    mockFetch(null, false);
    render(<HiveFederationStatus />);
    expect((await screen.findByText(/status unavailable/)).textContent).toMatch(/HTTP 500/);
  });
});
