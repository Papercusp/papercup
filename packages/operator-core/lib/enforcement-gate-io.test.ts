import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CarryBrief } from './carry-brief';
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

beforeEach(() => __resetRefusalMarkers());
afterEach(() => {
  __resetRefusalMarkers();
  delete process.env.PAPERCUSP_FLUSH_GATE;
});

describe('refusal markers', () => {
  it('records and reads a refusal within the TTL, and clears it', () => {
    expect(wasRecentlyRefused('compaction', 'su-a', NOW)).toBe(false);
    markRefused('compaction', 'su-a', NOW);
    expect(wasRecentlyRefused('compaction', 'su-a', NOW)).toBe(true);
    // a different boundary / owner is independent
    expect(wasRecentlyRefused('handoff', 'su-a', NOW)).toBe(false);
    expect(wasRecentlyRefused('compaction', 'su-b', NOW)).toBe(false);
    clearRefused('compaction', 'su-a');
    expect(wasRecentlyRefused('compaction', 'su-a', NOW)).toBe(false);
  });

  it('expires a marker past the TTL', () => {
    markRefused('compaction', 'su-a', NOW);
    expect(wasRecentlyRefused('compaction', 'su-a', NOW + REFUSAL_MARKER_TTL_MS + 1)).toBe(false);
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
    expect(wasRecentlyRefused('compaction', 'su-d', NOW)).toBe(true);

    // retry with the SAME unflushed brief → the system writes the fallback + proceeds
    const second = await runFlushGate(args);
    expect(second.verdict).toBe('mechanical-fallback');
    expect(second.fallback).toBeDefined();
    // the fallback write fails soft with no DB in the unit env — checkpointedItems is
    // an array either way, and the verdict/marker transition is what matters here.
    expect(Array.isArray(second.fallback?.checkpointedItems)).toBe(true);
    // the marker is retired after the fallback fires
    expect(wasRecentlyRefused('compaction', 'su-d', NOW)).toBe(false);
  });

  it('retires a stale marker when the boundary comes back clean (flush happened)', async () => {
    markRefused('compaction', 'su-e', NOW);
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
    expect(wasRecentlyRefused('compaction', 'su-e', NOW)).toBe(false);
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
