/**
 * power-save.test.ts — P5-3 (operator-scalability-event-loop-2026-06-16).
 *
 * Battery-aware derivation: on battery a laptop should run quieter — fewer
 * concurrent agents, no serialization thread pool, and a >1 cadence multiplier so
 * background ticks fire less often. AC / unknown = full power (a server we can't
 * read battery state for is NEVER throttled). The detector itself is best-effort
 * I/O, so we only assert it resolves to a valid value without throwing.
 */
import { describe, expect, it } from 'vitest';
import { deriveResourceProfile, detectPowerSource, type ResourceSignals } from './index';

const GIB = 1024 ** 3;
const BASE: ResourceSignals = {
  cores: 16,
  totalMemBytes: 32 * GIB,
  freeMemBytes: 16 * GIB,
  embeddedPg: false,
  hostRole: 'full',
};

describe('resource-profile power-saver (P5-3)', () => {
  it('AC (default) runs full power; battery throttles cadence + workers + agents', () => {
    const ac = deriveResourceProfile(BASE);
    expect(ac.backgroundCadenceMultiplier).toBe(1);
    expect(ac.serializationWorkers).toBeGreaterThan(0);

    const bat = deriveResourceProfile({ ...BASE, onBattery: true });
    expect(bat.backgroundCadenceMultiplier).toBe(3);
    expect(bat.serializationWorkers).toBe(0); // inline on battery — no busy pool
    expect(bat.maxSimultaneousAgents).toBeLessThanOrEqual(ac.maxSimultaneousAgents);
  });

  it('onBattery halves agent concurrency (floor 1)', () => {
    const ac = deriveResourceProfile(BASE).maxSimultaneousAgents;
    const bat = deriveResourceProfile({ ...BASE, onBattery: true }).maxSimultaneousAgents;
    expect(bat).toBe(Math.max(1, Math.round(ac / 2)));
  });

  it('a tiny host on battery still makes forward progress (never 0 agents/queue)', () => {
    const tiny = deriveResourceProfile({
      cores: 2,
      totalMemBytes: 4 * GIB,
      freeMemBytes: 1 * GIB,
      embeddedPg: true,
      hostRole: 'full',
      onBattery: true,
    });
    expect(tiny.maxSimultaneousAgents).toBeGreaterThanOrEqual(1);
    expect(tiny.dbosQueueConcurrency).toBeGreaterThanOrEqual(1);
    expect(tiny.backgroundCadenceMultiplier).toBe(3);
  });

  it('onBattery omitted ⇒ AC (full power) — absence of signal never throttles', () => {
    const p = deriveResourceProfile(BASE); // no onBattery key at all
    expect(p.backgroundCadenceMultiplier).toBe(1);
  });

  it('battery does NOT change DB tuning (deriveDatabaseTuning ignores power)', () => {
    const ac = deriveResourceProfile(BASE).database;
    const bat = deriveResourceProfile({ ...BASE, onBattery: true }).database;
    expect(bat).toEqual(ac);
  });
});

describe('detectPowerSource (P5-3, best-effort I/O)', () => {
  it('resolves to ac|battery|unknown without throwing on any host', async () => {
    const src = await detectPowerSource();
    expect(['ac', 'battery', 'unknown']).toContain(src);
  });
});
