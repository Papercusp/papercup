// @vitest-environment jsdom
/**
 * MugHeartbeat.test — the persistent Mug aliveness indicator
 * (queen-heartbeat-2026-06-16, owner-priority).
 *
 * Covers the pure liveness derivation (running / parked / stalled / paused) and a
 * rendered parked-with-placements snapshot (the owner's "is she alive + what's she
 * driving" question), with a fixed system time for a deterministic countdown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({ result: { data: [] as unknown[], loading: false, error: null as unknown, invalidate: vi.fn() } }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => H.result }));
// Lexicon resolver mocked to ECHO its key (t('brain') → 'brain', t('pot') → 'pot')
// — isolates from the THE_HIVE flag hook (restore-pot-lexicon P-005).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import MugHeartbeat, { deriveMugState, type HiveControlState } from './MugHeartbeat';

const NOW = Date.parse('2026-06-16T04:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function row(over: Partial<HiveControlState> = {}): HiveControlState {
  return { slug: 'papercup-hive', started: true, nextFireAt: null, lastWakeAt: null, ...over };
}

describe('deriveMugState', () => {
  it('no row / not started ⇒ stopped', () => {
    expect(deriveMugState(undefined, NOW).state).toBe('stopped');
    expect(deriveMugState(row({ started: false }), NOW)).toEqual({ state: 'stopped', label: 'Paused' });
  });

  it('a fresh wake (< 90s) ⇒ running', () => {
    expect(deriveMugState(row({ lastWakeAt: iso(-30_000), nextFireAt: iso(300_000) }), NOW)).toEqual({ state: 'running', label: 'Running' });
  });

  it('started + an armed next wake (not freshly woken) ⇒ parked/alive', () => {
    expect(deriveMugState(row({ lastWakeAt: iso(-5 * 60_000), nextFireAt: iso(4 * 60_000) }), NOW)).toEqual({ state: 'parked', label: 'Alive · parked' });
  });

  it('started + no armed wake + stale past 45m ⇒ stalled', () => {
    expect(deriveMugState(row({ lastWakeAt: iso(-50 * 60_000), nextFireAt: null }), NOW)).toEqual({ state: 'stalled', label: 'Stalled?' });
  });

  it('started + no armed wake but recent-ish ⇒ alive (not stalled)', () => {
    expect(deriveMugState(row({ lastWakeAt: iso(-10 * 60_000), nextFireAt: null }), NOW)).toEqual({ state: 'parked', label: 'Alive' });
  });
});

describe('MugHeartbeat render', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders a parked Mug with the next-wake countdown and the placements she is driving', () => {
    H.result = {
      data: [
        row({
          lastWakeAt: iso(-3 * 60_000),
          nextFireAt: iso(5 * 60_000),
          placements: {
            recovering: 1,
            cursed: 0,
            stranded: 0,
            workingTracked: 2,
            items: [
              { workItemId: 'WI-168', status: 'recovering' },
              { workItemId: 'WI-170', status: 'working' },
            ],
          },
        }),
      ],
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<MugHeartbeat />);
    expect(screen.getByText('Alive · parked')).toBeTruthy();
    expect(screen.getByText(/woke 3m ago/)).toBeTruthy();
    expect(screen.getByText(/next in 5m/)).toBeTruthy();
    expect(screen.getByText('driving 2')).toBeTruthy();
    expect(screen.getByText('1 recovering')).toBeTruthy();
    expect(screen.getByText('WI-168')).toBeTruthy(); // the recovering work-item id ("what she did")
  });

  it('renders a paused Mug', () => {
    H.result = { data: [row({ started: false })], loading: false, error: null, invalidate: vi.fn() };
    render(<MugHeartbeat />);
    expect(screen.getByText('Paused')).toBeTruthy();
  });
});
