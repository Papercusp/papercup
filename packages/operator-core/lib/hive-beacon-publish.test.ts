/**
 * hive-beacon-publish.test.ts — the consent-gated beacon publisher (P-005, brief
 * B-06). Drives buildHiveBeacon / maybeBuildHiveBeacon over injected signal
 * sources (no PG). Pins:
 *   - consent gate: maybeBuildHiveBeacon returns undefined when NOT consented;
 *   - a beacon (clamped) when consented;
 *   - the work-signal partition (focus = newest non-terminal, lastCompleted =
 *     newest terminal, queueDepth = non-terminal count);
 *   - the memo collapses repeat builds within the TTL and a fresh source is read
 *     after it expires;
 *   - a failing signal degrades the field, never the build.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  __resetBeaconPublishMemoForTest,
  buildHiveBeacon,
  maybeBuildHiveBeacon,
  type BeaconSignalSources,
} from './hive-beacon-publish';
import { BEACON_TEXT_MAX } from './hive-beacon';

const WS = 'ws-1';
const HIVE = 'hive-home';
const NOW = 1_800_000_000_000;

function sources(over: Partial<BeaconSignalSources> = {}): BeaconSignalSources {
  return {
    now: () => NOW,
    liveAgents: async () => 3,
    workSignals: async () => ({ queueDepth: 4, focus: 'building beacon', lastCompleted: 'shipped grants' }),
    consented: async () => true,
    ...over,
  };
}

beforeEach(() => __resetBeaconPublishMemoForTest());

describe('buildHiveBeacon — signal assembly (no consent check)', () => {
  it('assembles + clamps a beacon from the sources', async () => {
    const b = await buildHiveBeacon(WS, HIVE, sources());
    expect(b).toEqual({
      v: 1,
      liveAgents: 3,
      queueDepth: 4,
      focus: 'building beacon',
      lastCompleted: 'shipped grants',
      ts: new Date(NOW).toISOString(),
    });
  });

  it('clamps an oversize focus from the source to ≤120', async () => {
    const b = await buildHiveBeacon(
      WS,
      HIVE,
      sources({ workSignals: async () => ({ queueDepth: 1, focus: 'z'.repeat(400), lastCompleted: '' }) }),
    );
    expect(b.focus.length).toBe(BEACON_TEXT_MAX);
  });

  it('degrades a single failing signal to its default, not the whole build', async () => {
    const b = await buildHiveBeacon(
      WS,
      HIVE,
      sources({ liveAgents: async () => { throw new Error('fleet down'); } }),
    );
    expect(b.liveAgents).toBe(0);
    expect(b.queueDepth).toBe(4); // the other signal still landed
  });
});

describe('maybeBuildHiveBeacon — consent gate (publish iff consented)', () => {
  it('returns undefined when NOT consented (default-OFF)', async () => {
    const b = await maybeBuildHiveBeacon(WS, HIVE, { sources: sources({ consented: async () => false }), ttlMs: 0 });
    expect(b).toBeUndefined();
  });

  it('returns a beacon when consented', async () => {
    const b = await maybeBuildHiveBeacon(WS, HIVE, { sources: sources(), ttlMs: 0 });
    expect(b).toMatchObject({ v: 1, liveAgents: 3, queueDepth: 4 });
  });

  it('a failing consent read reads as NOT consented (undefined, never throws)', async () => {
    const b = await maybeBuildHiveBeacon(WS, HIVE, {
      sources: sources({ consented: async () => { throw new Error('pg down'); } }),
      ttlMs: 0,
    });
    expect(b).toBeUndefined();
  });
});

describe('maybeBuildHiveBeacon — memo on the re-announce cadence', () => {
  it('collapses repeat builds within the TTL (one consent + signal read)', async () => {
    const consented = vi.fn(async () => true);
    const liveAgents = vi.fn(async () => 2);
    const src = sources({ consented, liveAgents, now: () => NOW });
    await maybeBuildHiveBeacon(WS, HIVE, { sources: src, ttlMs: 60_000 });
    await maybeBuildHiveBeacon(WS, HIVE, { sources: src, ttlMs: 60_000 });
    expect(consented).toHaveBeenCalledTimes(1);
    expect(liveAgents).toHaveBeenCalledTimes(1);
  });

  it('recomputes after the TTL expires', async () => {
    const consented = vi.fn(async () => true);
    let clock = NOW;
    const src = sources({ consented, now: () => clock });
    await maybeBuildHiveBeacon(WS, HIVE, { sources: src, ttlMs: 60_000 });
    clock = NOW + 61_000;
    await maybeBuildHiveBeacon(WS, HIVE, { sources: src, ttlMs: 60_000 });
    expect(consented).toHaveBeenCalledTimes(2);
  });

  it('memo keys by hive — distinct hives build independently', async () => {
    const consented = vi.fn(async () => true);
    const src = sources({ consented });
    await maybeBuildHiveBeacon(WS, 'hive-a', { sources: src, ttlMs: 60_000 });
    await maybeBuildHiveBeacon(WS, 'hive-b', { sources: src, ttlMs: 60_000 });
    expect(consented).toHaveBeenCalledTimes(2);
  });
});
