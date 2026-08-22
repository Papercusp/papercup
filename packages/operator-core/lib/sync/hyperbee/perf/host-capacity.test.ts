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
  PER_PEER_BASE_BYTES,
  PER_PEER_GROWTH_BYTES_PER_PEER,
  capacityOverridesFromEnv,
  decideMeshCapacity,
  parseMemAvailableBytes,
  perPeerBytesFor,
} from './host-capacity';

/** The host as measured on 2026-08-16 when the >64 ladder produced garbage. */
const MEASURED_AVAILABLE = 69e9;

/**
 * The 2026-08-22 (WI-40592) post-no-PG-loader ladder: `childRssPeak` p50 per peer
 * count, `replication.sustained` at a fixed rate:10/count:200 workload, every leg
 * passing both `sloPassed` and `convergencePassed`.
 *
 * This is the CALIBRATION DATA, kept here rather than in a comment so the model
 * cannot drift away from it silently.
 */
const MEASURED_RSS_P50: ReadonlyArray<readonly [peers: number, p50Bytes: number]> = [
  [4, 167.8e6],
  [12, 184.3e6],
  [24, 190.2e6],
  [48, 267.4e6],
  [64, 285.0e6],
];

describe('perPeerBytesFor', () => {
  it('NEVER under-estimates a measured point — the safety property the whole guard rests on', () => {
    // Direction matters and is asymmetric: over-estimating costs a refused run,
    // under-estimating admits a mesh that swaps the shared box for every other
    // agent on it. A least-squares fit would FAIL this test at 48 peers, which is
    // precisely why the coefficients are not least-squares.
    for (const [peers, measured] of MEASURED_RSS_P50) {
      expect(perPeerBytesFor(peers)).toBeGreaterThanOrEqual(measured);
    }
  });

  it('stays within 15% of every measured point — conservative, not arbitrarily inflated', () => {
    // The paired half of the test above. Without this, the guard could satisfy
    // "never under-estimates" by returning a huge number and refusing everything.
    for (const [peers, measured] of MEASURED_RSS_P50) {
      expect(perPeerBytesFor(peers) / measured).toBeLessThan(1.15);
    }
  });

  it('GROWS with peer count — the property a scalar constant cannot express', () => {
    // The defect this replaced: `peers x CONSTANT` assumed independence. If someone
    // re-scalarises the model, growth goes to zero and this fails.
    expect(perPeerBytesFor(64)).toBeGreaterThan(perPeerBytesFor(4));
    expect(PER_PEER_GROWTH_BYTES_PER_PEER).toBeGreaterThan(0);
    expect(perPeerBytesFor(0)).toBe(PER_PEER_BASE_BYTES);
  });
});

describe('decideMeshCapacity', () => {
  it('ADMITS 64 peers on the measured host — the largest count with a clean measured result', () => {
    const d = decideMeshCapacity({ peers: 64, availableBytes: MEASURED_AVAILABLE });
    expect(d.ok).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it('now ADMITS 80 peers on that host — the pre-loader refusal was the stale constant, not the substrate', () => {
    // This assertion INVERTED on 2026-08-22 (WI-40592) and the inversion is the
    // point: 80 peers was refused when a peer cost ~450MB. Post-no-PG-loader a
    // peer at that count costs ~346MB, so 80 needs ~27.7GB against a 34.5GB
    // budget. The old refusal was being quoted as a product ceiling.
    const d = decideMeshCapacity({ peers: 80, availableBytes: MEASURED_AVAILABLE });
    expect(d.ok).toBe(true);
  });

  it('STILL REFUSES the 96- and 128-peer configs whose verdicts were swap artifacts', () => {
    // The measurement moved the boundary; it did not remove it. These two were the
    // configs that actually produced unquotable swap-driven verdicts, and they are
    // still refused under the growth-aware model.
    for (const peers of [96, 128]) {
      expect(decideMeshCapacity({ peers, availableBytes: MEASURED_AVAILABLE }).ok).toBe(false);
    }
  });

  it('marks a >64 projection as EXTRAPOLATED in the refusal, so it is not quoted as measured', () => {
    const d = decideMeshCapacity({ peers: 128, availableBytes: MEASURED_AVAILABLE });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/EXTRAPOLATED past the 64-peer measurement envelope/);
  });

  it('does NOT claim extrapolation when the caller supplied their own per-peer figure', () => {
    // The caveat is about OUR model. An operator-supplied number is theirs to own.
    const d = decideMeshCapacity({ peers: 128, availableBytes: 1e9, perPeerBytes: 400e6 });
    expect(d.ok).toBe(false);
    expect(d.reason).not.toMatch(/EXTRAPOLATED/);
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
    // 96 * ~383MB = ~36.8GB, which needs > 73.5GB available at the default fraction.
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
    const d = decideMeshCapacity({ peers: 96, availableBytes: MEASURED_AVAILABLE });
    expect(d.projectedBytes).toBe(96 * perPeerBytesFor(96));
    expect(d.budgetBytes).toBe(MEASURED_AVAILABLE * DEFAULT_AVAILABLE_FRACTION);
  });

  it('sits exactly at the boundary: <= budget admits, one peer over refuses', () => {
    // Derived from the model rather than hardcoded, so re-measuring the
    // coefficients moves the boundary here instead of silently breaking this test.
    const budget = 10 * perPeerBytesFor(10);
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
