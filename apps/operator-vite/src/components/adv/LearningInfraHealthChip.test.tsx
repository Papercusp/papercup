// @vitest-environment jsdom
//
// LearningInfraHealthChip render coverage (self-improvement-consume-edges-
// 2026-06-12 P-003 / D-002) — the composite learning-infra status chip.
// Mounts the chip against `learning.health` snapshots (useSyncQuery mocked,
// the pinned sibling pattern — see LearningTab.test.tsx) and pins the three
// tones plus the must-render-NOTHING states: loading, error, empty (flag
// off), and a foreign payload (LearningTab.test.tsx's mock falls through to
// the improvements digest for unknown queryNames — the chip must not render
// a digest as a health status).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let healthResult: Record<string, unknown> = { data: undefined, loading: true, fetching: true, error: null, invalidate: vi.fn() };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => healthResult,
}));

import LearningInfraHealthChip from './LearningInfraHealthChip';

const snapshot = (status: 'ok' | 'degraded' | 'offline', reason: string) => ({
  status,
  reason,
  legs: [
    { name: 'meridian', status: status === 'offline' ? 'down' : 'ok', detail: '127.0.0.1:3456' },
    { name: 'spawn-path', status: 'ok', detail: 'no open spawn-structural watchdog item' },
    { name: 'gym-circuit', status: status === 'degraded' ? 'down' : 'ok', detail: 'circuit state' },
  ],
  evaluatedAt: Date.now() - 30_000,
});

const setResult = (data: unknown[] | undefined, extra: Record<string, unknown> = {}) => {
  healthResult = { data, loading: false, fetching: false, error: null, invalidate: vi.fn(), ...extra };
};

afterEach(() => cleanup());

describe('LearningInfraHealthChip', () => {
  it('renders the green chip on ok', () => {
    setResult([snapshot('ok', 'all legs up')]);
    render(<LearningInfraHealthChip />);
    const chip = screen.getByLabelText('learning infra up');
    expect(chip.className).toContain('pc-lihealth--good');
    expect(chip.title).toContain('meridian: ok');
  });

  it('renders the amber chip + reason on degraded', () => {
    setResult([snapshot('degraded', 'gym-circuit: circuit OPEN: gymloopharness (8 consecutive errors)')]);
    render(<LearningInfraHealthChip />);
    const chip = screen.getByLabelText('learning infra degraded');
    expect(chip.className).toContain('pc-lihealth--warn');
    expect(chip.textContent).toContain('circuit OPEN');
  });

  it('renders the red chip on offline', () => {
    setResult([snapshot('offline', 'meridian: 127.0.0.1:3456 ECONNREFUSED')]);
    render(<LearningInfraHealthChip />);
    const chip = screen.getByLabelText('learning system OFFLINE');
    expect(chip.className).toContain('pc-lihealth--bad');
    expect(chip.title).toContain('meridian: down');
  });

  it('renders nothing while loading, on error, on an empty result (flag off), or for a foreign payload', () => {
    healthResult = { data: undefined, loading: true, fetching: true, error: null, invalidate: vi.fn() };
    const { container: loading } = render(<LearningInfraHealthChip />);
    expect(loading.innerHTML).toBe('');
    cleanup();

    setResult(undefined, { error: new Error('boom') });
    const { container: errored } = render(<LearningInfraHealthChip />);
    expect(errored.innerHTML).toBe('');
    cleanup();

    setResult([]); // flag off → resolver returns []
    const { container: empty } = render(<LearningInfraHealthChip />);
    expect(empty.innerHTML).toBe('');
    cleanup();

    setResult([{ total: 135, open: 117, headline: 'a digest, not a health snapshot' }]);
    const { container: foreign } = render(<LearningInfraHealthChip />);
    expect(foreign.innerHTML).toBe('');
  });
});
