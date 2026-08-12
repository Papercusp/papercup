import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CarryBrief } from './carry-brief';
const refusalMarks = vi.hoisted(() => new Map<string, number>());
vi.mock('./flush-refusal-marker', () => ({
  REFUSAL_MARKER_TTL_MS: 10 * 60_000,
  wasRecentlyRefused: async (boundary: string, ownerId: string, nowMs = Date.now()) =>
    (refusalMarks.get(`${boundary}:${ownerId}`) ?? -1) >= nowMs,
  markRefused: async (boundary: string, ownerId: string, nowMs = Date.now()) => {
    refusalMarks.set(`${boundary}:${ownerId}`, nowMs + 10 * 60_000);
  },
  clearRefused: async (boundary: string, ownerId: string) => {
    refusalMarks.delete(`${boundary}:${ownerId}`);
  },
  __resetRefusalMarkers: async () => { refusalMarks.clear(); },
}));
import {
  REFUSAL_MARKER_TTL_MS,
  flushGateEnabled,
  wasRecentlyRefused,
  markRefused,
  clearRefused,
  runFlushGate,
  __resetRefusalMarkers,
} from './enforcement-gate-io';

const NOW = 1_800_000_000_000;

function brief(over: Partial<CarryBrief> = {}): CarryBrief {
  return {
    ownerId: 'su-test',
    loop: null,
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
    ...over,
  };
}

/** A brief with one held item that has NO checkpoint → a missing-checkpoint tripwire. */
function unflushedBrief(): CarryBrief {
  return brief({
    heldItems: [{ id: 'WI-7', title: 't', body: null, harness: 'papercusp', checkpoint: null, checkpointUpdatedAtMs: null }],
  });
}

beforeEach(async () => {
  await __resetRefusalMarkers();
  // Hermetic against host load (WI-5582): runFlushGate races the inner work against
  // a bounded-timeout budget (default 4s). On an event-loop-starved green-checkpoint
  // host that 4s wall clock once beat the instant mocked inner work, degrading the
  // verdict to `clear` and emitting the bounded-timeout console.warn — a gate flake.
  // Raise the budget far past any plausible starvation so the deadline never fires.
  process.env.PAPERCUSP_FLUSH_GATE_BUDGET_MS = '600000';
});
afterEach(async () => {
  await __resetRefusalMarkers();
  delete process.env.PAPERCUSP_FLUSH_GATE;
  delete process.env.PAPERCUSP_FLUSH_GATE_BUDGET_MS;
});

describe('refusal markers', () => {
  it('records and reads a refusal within the TTL, and clears it', async () => {
    expect(await wasRecentlyRefused('compaction', 'su-a', NOW)).toBe(false);
    await markRefused('compaction', 'su-a', NOW);
    expect(await wasRecentlyRefused('compaction', 'su-a', NOW)).toBe(true);
    // a different boundary / owner is independent
    expect(await wasRecentlyRefused('handoff', 'su-a', NOW)).toBe(false);
    expect(await wasRecentlyRefused('compaction', 'su-b', NOW)).toBe(false);
    await clearRefused('compaction', 'su-a');
    expect(await wasRecentlyRefused('compaction', 'su-a', NOW)).toBe(false);
  });

  it('expires a marker past the TTL', async () => {
    await markRefused('compaction', 'su-a', NOW);
    expect(await wasRecentlyRefused('compaction', 'su-a', NOW + REFUSAL_MARKER_TTL_MS + 1)).toBe(false);
  });
});

describe('flushGateEnabled', () => {
  it('defaults ON', () => {
    delete process.env.PAPERCUSP_FLUSH_GATE;
    expect(flushGateEnabled()).toBe(true);
  });
  it('is disabled by off/0/false/no', () => {
    for (const v of ['off', '0', 'false', 'NO', 'Off']) {
      process.env.PAPERCUSP_FLUSH_GATE = v;
      expect(flushGateEnabled()).toBe(false);
    }
  });
});

describe('runFlushGate ladder', () => {
  it('clears when the brief is clean', async () => {
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-c',
      workspaceId: '*',
      sessionId: 'su-c',
      sinceIso: new Date(NOW).toISOString(),
      brief: brief(),
      nowMs: NOW,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
  });

  it('refuses once, then escalates to mechanical-fallback on the un-flushed retry', async () => {
    const args = {
      boundary: 'compaction' as const,
      ownerId: 'su-d',
      workspaceId: '*',
      sessionId: 'su-d',
      sinceIso: new Date(NOW).toISOString(),
      brief: unflushedBrief(),
      nowMs: NOW,
    };
    const first = await runFlushGate(args);
    expect(first.verdict).toBe('refuse');
    expect(first.refusalText).toContain('WI-7');
    expect(first.tripwires[0].kind).toBe('missing-checkpoint');
    // marker is now set
    expect(await wasRecentlyRefused('compaction', 'su-d', NOW)).toBe(true);

    // retry with the SAME unflushed brief → the system writes the fallback + proceeds
    const second = await runFlushGate(args);
    expect(second.verdict).toBe('mechanical-fallback');
    expect(second.fallback).toBeDefined();
    // the fallback write fails soft with no DB in the unit env — checkpointedItems is
    // an array either way, and the verdict/marker transition is what matters here.
    expect(Array.isArray(second.fallback?.checkpointedItems)).toBe(true);
    // the marker is retired after the fallback fires
    expect(await wasRecentlyRefused('compaction', 'su-d', NOW)).toBe(false);
  });

  it('retires a stale marker when the boundary comes back clean (flush happened)', async () => {
    await markRefused('compaction', 'su-e', NOW);
    const out = await runFlushGate({
      boundary: 'compaction',
      ownerId: 'su-e',
      workspaceId: '*',
      sessionId: 'su-e',
      sinceIso: new Date(NOW).toISOString(),
      brief: brief(), // clean now
      nowMs: NOW,
    });
    expect(out.verdict).toBe('clear');
    expect(await wasRecentlyRefused('compaction', 'su-e', NOW)).toBe(false);
  });

  it('is a no-op (clear) when disabled by env, even with tripwires', async () => {
    process.env.PAPERCUSP_FLUSH_GATE = 'off';
    const out = await runFlushGate({
      boundary: 'handoff',
      ownerId: 'su-f',
      workspaceId: '*',
      sessionId: 'su-f',
      sinceIso: new Date(NOW).toISOString(),
      brief: unflushedBrief(),
      nowMs: NOW,
    });
    expect(out.verdict).toBe('clear');
    expect(out.tripwires).toEqual([]);
  });
});
