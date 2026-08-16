/**
 * host-capacity.test.ts — the mesh capacity preflight (WI-39359).
 *
 * The decision under test is PURE, so these cases pin the fit boundary without
 * touching /proc and without spawning anything. Per this repo's falsifiability
 * discipline, the boundary cases are paired: a config that must PASS sits beside
 * a config that must REFUSE, so a guard that silently degraded to "always ok"
 * (or "always refuse") fails here rather than looking green.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AVAILABLE_FRACTION,
  DEFAULT_PER_PEER_RSS_BYTES,
  capacityOverridesFromEnv,
  decideMeshCapacity,
  parseMemAvailableBytes,
} from './host-capacity';

/** The host as measured on 2026-08-16 when the >64 ladder produced garbage. */
const MEASURED_AVAILABLE = 69e9;

describe('decideMeshCapacity', () => {
  it('ADMITS 64 peers on the measured host — the largest count that ever produced a clean result', () => {
    const d = decideMeshCapacity({ peers: 64, availableBytes: MEASURED_AVAILABLE });
    expect(d.ok).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it('REFUSES 80 peers on that same host — the smallest count that never produced a clean result', () => {
    const d = decideMeshCapacity({ peers: 80, availableBytes: MEASURED_AVAILABLE });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/cannot fit a 80-peer proc mesh/);
  });

  it('REFUSES the 96- and 128-peer configs whose verdicts were swap artifacts', () => {
    for (const peers of [96, 128]) {
      expect(decideMeshCapacity({ peers, availableBytes: MEASURED_AVAILABLE }).ok).toBe(false);
    }
  });

  it('counts the WRITER as a peer — the caller passes readers+1, and 1 peer always fits', () => {
    expect(decideMeshCapacity({ peers: 1, availableBytes: MEASURED_AVAILABLE }).ok).toBe(true);
  });

  it('ABSTAINS when the host does not report MemAvailable, rather than guessing', () => {
    // A guard that is not the thing under test must fail OPEN.
    const d = decideMeshCapacity({ peers: 4096, availableBytes: null });
    expect(d.ok).toBe(true);
    expect(d.budgetBytes).toBe(Number.POSITIVE_INFINITY);
  });

  it('scales with the host: the same 96-peer mesh that is refused on a small box is admitted on a big one', () => {
    const peers = 96;
    expect(decideMeshCapacity({ peers, availableBytes: MEASURED_AVAILABLE }).ok).toBe(false);
    // 96 * 450MB = 43.2GB, which needs > 86.4GB available at the default fraction.
    expect(decideMeshCapacity({ peers, availableBytes: 200e9 }).ok).toBe(true);
  });

  it('honours an explicit override, so a deliberate operator can still force a run', () => {
    const base = { peers: 96, availableBytes: MEASURED_AVAILABLE };
    expect(decideMeshCapacity(base).ok).toBe(false);
    expect(decideMeshCapacity({ ...base, availableFraction: 1.0 }).ok).toBe(true);
    // A peer that genuinely costs less makes the same mesh fit.
    expect(decideMeshCapacity({ ...base, perPeerBytes: 50e6 }).ok).toBe(true);
  });

  it('reports the arithmetic it used, so a refusal can be checked rather than trusted', () => {
    const d = decideMeshCapacity({ peers: 80, availableBytes: MEASURED_AVAILABLE });
    expect(d.projectedBytes).toBe(80 * DEFAULT_PER_PEER_RSS_BYTES);
    expect(d.budgetBytes).toBe(MEASURED_AVAILABLE * DEFAULT_AVAILABLE_FRACTION);
  });

  it('sits exactly at the boundary: <= budget admits, one byte over refuses', () => {
    const budget = 10 * DEFAULT_PER_PEER_RSS_BYTES;
    const availableBytes = budget / DEFAULT_AVAILABLE_FRACTION;
    expect(decideMeshCapacity({ peers: 10, availableBytes }).ok).toBe(true);
    expect(decideMeshCapacity({ peers: 11, availableBytes }).ok).toBe(false);
  });
});

describe('parseMemAvailableBytes', () => {
  it('reads MemAvailable in kB and returns bytes', () => {
    const meminfo = 'MemTotal:       263842576 kB\nMemFree:         28000000 kB\nMemAvailable:    69000000 kB\n';
    expect(parseMemAvailableBytes(meminfo)).toBe(69000000 * 1024);
  });

  it('does NOT confuse MemAvailable with MemFree or MemTotal', () => {
    // Calibration: proves the parser keys on the right line rather than the
    // first number it can find, which is how this would silently read wrong.
    const meminfo = 'MemTotal:       263842576 kB\nMemFree:         28000000 kB\nMemAvailable:    69000000 kB\n';
    expect(parseMemAvailableBytes(meminfo)).not.toBe(263842576 * 1024);
    expect(parseMemAvailableBytes(meminfo)).not.toBe(28000000 * 1024);
  });

  it('returns null when the field is absent, so the guard abstains instead of reading 0', () => {
    // A 0 here would refuse EVERY mesh — the guard must not invent a reading.
    expect(parseMemAvailableBytes('MemTotal: 263842576 kB\n')).toBeNull();
  });
});

describe('capacityOverridesFromEnv', () => {
  it('is empty when unset, so the defaults apply', () => {
    expect(capacityOverridesFromEnv({})).toEqual({
      perPeerBytes: undefined,
      availableFraction: undefined,
    });
  });

  it('ignores junk and non-positive values rather than propagating NaN into the budget', () => {
    const o = capacityOverridesFromEnv({
      PERF_MESH_PER_PEER_BYTES: 'not-a-number',
      PERF_MESH_AVAILABLE_FRACTION: '0',
    });
    expect(o.perPeerBytes).toBeUndefined();
    expect(o.availableFraction).toBeUndefined();
  });

  it('parses real overrides', () => {
    const o = capacityOverridesFromEnv({
      PERF_MESH_PER_PEER_BYTES: '100000000',
      PERF_MESH_AVAILABLE_FRACTION: '0.8',
    });
    expect(o).toEqual({ perPeerBytes: 100000000, availableFraction: 0.8 });
  });
});
