/**
 * @vitest-environment jsdom
 *
 * Tests for selectToolStates (pure helper) and the useStateSnapshots hook's
 * connectivity wiring. PendingCardsBar.test.tsx (PR 1b) covers the hook's
 * consumer-facing `cards`/`connected` behavior via a full mock of this
 * module — it never exercises this hook's OWN body, so the
 * onOpen/onError → shared-connectivity-store wiring added alongside the
 * console-flood investigation (continuing session
 * fc14943c-6984-4791-905b-194e0d8665d4) is covered directly here instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

let captured: { onOpen?: () => void; onError?: () => void } | null = null;
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: (opts: { onOpen?: () => void; onError?: () => void }) => {
    captured = { onOpen: opts.onOpen, onError: opts.onError };
    return { close: vi.fn() };
  },
}));

const reportReachable = vi.fn();
const reportUnreachable = vi.fn();
vi.mock('@papercusp/sync', () => ({
  reportSyncReachable: () => reportReachable(),
  reportSyncUnreachable: () => reportUnreachable(),
}));

import { selectToolStates, useStateSnapshots, type SnapshotEnvelope } from './use-state-snapshots';

function env(runId: string, toolState?: unknown): SnapshotEnvelope {
  return {
    runId,
    version: 1,
    snapshot: { openCards: [], ...(toolState !== undefined ? { toolState } : {}) },
  };
}

describe('selectToolStates', () => {
  it('returns empty for an empty map', () => {
    expect(selectToolStates(new Map())).toEqual(new Map());
  });

  it('skips runs with no toolState (card-only flows)', () => {
    const m = new Map<string, SnapshotEnvelope>();
    m.set('rA', env('rA')); // no toolState
    m.set('rB', env('rB', { count: 3 }));
    const out = selectToolStates(m);
    expect(out.size).toBe(1);
    expect(out.get('rB')).toEqual({ count: 3 });
  });

  it('preserves runId → toolState mapping', () => {
    const m = new Map<string, SnapshotEnvelope>();
    m.set('a', env('a', { phase: 'querying' }));
    m.set('b', env('b', { phase: 'done', results: ['x'] }));
    const out = selectToolStates(m);
    expect(out.get('a')).toEqual({ phase: 'querying' });
    expect(out.get('b')).toEqual({ phase: 'done', results: ['x'] });
  });
});

describe('useStateSnapshots — shared connectivity wiring', () => {
  beforeEach(() => {
    captured = null;
    reportReachable.mockReset();
    reportUnreachable.mockReset();
  });
  afterEach(() => cleanup());

  it('feeds the shared sync connectivity store: onOpen → reachable, onError → unreachable', () => {
    renderHook(() => useStateSnapshots());
    expect(captured).toBeTruthy();

    captured!.onOpen?.();
    expect(reportReachable).toHaveBeenCalledTimes(1);

    captured!.onError?.();
    expect(reportUnreachable).toHaveBeenCalledTimes(1);
  });
});
