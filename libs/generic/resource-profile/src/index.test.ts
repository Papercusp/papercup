import { afterEach, describe, expect, it } from 'vitest';
import {
  configureResourceProfile,
  deriveResourceProfile,
  getResourceProfile,
  resetResourceProfile,
  type ResourceSignals,
} from './index';

const GIB = 1024 * 1024 * 1024;

function signals(overrides: Partial<ResourceSignals>): ResourceSignals {
  return {
    cores: 8,
    totalMemBytes: 16 * GIB,
    freeMemBytes: 16 * GIB,
    embeddedPg: false,
    hostRole: 'full',
    ...overrides,
  };
}

afterEach(() => resetResourceProfile());

describe('deriveResourceProfile — laptop (small, embedded PG)', () => {
  // 4 cores sharing the box with an embedded Postgres, plenty of RAM so RAM isn't
  // the binding constraint — caps should sit near their FLOORS.
  const p = deriveResourceProfile(signals({ cores: 4, embeddedPg: true, totalMemBytes: 8 * GIB, freeMemBytes: 8 * GIB }));

  it('classes as laptop', () => {
    expect(p.hostClass).toBe('laptop');
  });

  it('runs only a couple agents (round(4 * 0.25) = 1)', () => {
    expect(p.maxSimultaneousAgents).toBe(1);
    expect(p.maxSimultaneousAgents).toBeGreaterThanOrEqual(1); // floor honored
  });

  it('keeps the DBOS queue small but never below the floor of 1', () => {
    // round(4 * 0.5) = 2
    expect(p.dbosQueueConcurrency).toBe(2);
    expect(p.dbosQueueConcurrency).toBeGreaterThanOrEqual(1);
  });

  it('barely earns serialization workers at 4 cores (clamp(4 - 2, 0, 8) = 2)', () => {
    expect(p.serializationWorkers).toBe(2);
  });

  it('keeps the smallest embed batch', () => {
    expect(p.embedBatchSize).toBe(32);
  });

  it('pins httpWorkers / processCount to 1', () => {
    expect(p.httpWorkers).toBe(1);
    expect(p.processCount).toBe(1);
  });

  it('keeps background work in-process on the desktop', () => {
    expect(p.backgroundInProcess).toBe(true);
  });
});

describe('deriveResourceProfile — true 2-core minimum hits every floor', () => {
  const p = deriveResourceProfile(signals({ cores: 2, embeddedPg: true, totalMemBytes: 4 * GIB, freeMemBytes: 4 * GIB }));

  it('floors agents at 1', () => {
    // round(2 * 0.25) = 1 (round half up: 0.5 -> 1)
    expect(p.maxSimultaneousAgents).toBe(1);
  });

  it('floors the queue at 1', () => {
    // round(2 * 0.5) = 1
    expect(p.dbosQueueConcurrency).toBe(1);
  });

  it('floors serialization workers at 0 (inline)', () => {
    expect(p.serializationWorkers).toBe(0); // clamp(2 - 2, 0, 8)
  });

  it('pgPoolMax respects its floor (>= 4)', () => {
    expect(p.pgPoolMax).toBeGreaterThanOrEqual(4);
  });
});

describe('deriveResourceProfile — server (128 cores, native PG)', () => {
  const p = deriveResourceProfile(
    signals({ cores: 128, embeddedPg: false, totalMemBytes: 512 * GIB, freeMemBytes: 512 * GIB }),
  );

  it('classes as server', () => {
    expect(p.hostClass).toBe('server');
  });

  it('agents hit the ceiling of 16 (round(128 * 0.5) = 64, clamped)', () => {
    expect(p.maxSimultaneousAgents).toBe(16);
  });

  it('DBOS queue hits the ceiling of 32 (round(128 * 1) = 128, clamped)', () => {
    expect(p.dbosQueueConcurrency).toBe(32);
  });

  it('pgPoolMax hits the ceiling of 64 (16 + 32 + 4 = 52 -> still under, but big hosts cap at 64)', () => {
    // 16 + 32 + 4 = 52, under the ceiling; assert it scaled up and stays <= 64.
    expect(p.pgPoolMax).toBe(52);
    expect(p.pgPoolMax).toBeLessThanOrEqual(64);
  });

  it('serialization workers hit the ceiling of 8', () => {
    expect(p.serializationWorkers).toBe(8); // clamp(128 - 2, 0, 8)
  });

  it('embed batch hits the server tier (128)', () => {
    expect(p.embedBatchSize).toBe(128);
  });

  it('still pins httpWorkers to 1 (no cluster yet)', () => {
    expect(p.httpWorkers).toBe(1);
    expect(p.processCount).toBe(1);
  });

  it('recommends splitting background work to its own process', () => {
    expect(p.backgroundInProcess).toBe(false);
  });
});

describe('backgroundInProcess — split only on a server with dedicated PG', () => {
  it('keeps background in-process on a laptop (native or embedded PG)', () => {
    expect(deriveResourceProfile(signals({ cores: 4, embeddedPg: false })).backgroundInProcess).toBe(true);
    expect(deriveResourceProfile(signals({ cores: 4, embeddedPg: true })).backgroundInProcess).toBe(true);
  });

  it('keeps background in-process on a workstation', () => {
    expect(deriveResourceProfile(signals({ cores: 16, embeddedPg: false })).backgroundInProcess).toBe(true);
  });

  it('splits background out ONLY on a server-class host with a dedicated (native) PG', () => {
    expect(deriveResourceProfile(signals({ cores: 128, embeddedPg: false })).backgroundInProcess).toBe(false);
  });

  it('keeps background in-process on a big box whose PG is embedded on the same machine', () => {
    // server-class cores but an embedded PG sharing the box → no split (the DB is
    // already competing for the same resources; a second process worsens that).
    expect(deriveResourceProfile(signals({ cores: 128, embeddedPg: true })).backgroundInProcess).toBe(true);
  });
});

describe('free-RAM clamp', () => {
  it('caps agents by free RAM even when cores are plentiful', () => {
    // 128 cores would give 16 agents by core, but only 2 GiB free -> floor(2 / 0.5) = 4.
    const p = deriveResourceProfile(
      signals({ cores: 128, embeddedPg: false, totalMemBytes: 512 * GIB, freeMemBytes: 2 * GIB }),
    );
    expect(p.maxSimultaneousAgents).toBe(4);
  });

  it('never drops below the agent floor of 1 even with almost no free RAM', () => {
    const p = deriveResourceProfile(
      signals({ cores: 64, embeddedPg: false, totalMemBytes: 256 * GIB, freeMemBytes: 0.1 * GIB }),
    );
    expect(p.maxSimultaneousAgents).toBe(1);
  });
});

describe('hostRole shrinks the queue on non-draining hosts', () => {
  it('request-only halves the DBOS queue', () => {
    const full = deriveResourceProfile(signals({ cores: 16, hostRole: 'full' }));
    const reqOnly = deriveResourceProfile(signals({ cores: 16, hostRole: 'request-only' }));
    expect(reqOnly.dbosQueueConcurrency).toBeLessThan(full.dbosQueueConcurrency);
    // round(16 * 1) = 16 (full) ; round(16 * 0.5) = 8 (request-only)
    expect(full.dbosQueueConcurrency).toBe(16);
    expect(reqOnly.dbosQueueConcurrency).toBe(8);
  });
});

describe('configure + memoized singleton', () => {
  it('injects signals and memoizes the derived profile', () => {
    configureResourceProfile({ cores: 4, embeddedPg: true, freeMemBytes: 8 * GIB });
    const a = getResourceProfile();
    const b = getResourceProfile();
    expect(a).toBe(b); // same frozen object — detection ran once
    expect(a.signals.cores).toBe(4);
    expect(a.signals.embeddedPg).toBe(true);
    expect(a.maxSimultaneousAgents).toBe(1);
  });

  it('throws if configured after the profile is already realized', () => {
    getResourceProfile();
    expect(() => configureResourceProfile({ cores: 99 })).toThrow(/already detected/);
  });

  it('auto-detects with no config (cores >= 1)', () => {
    const p = getResourceProfile();
    expect(p.signals.cores).toBeGreaterThanOrEqual(1);
    expect(p.maxSimultaneousAgents).toBeGreaterThanOrEqual(1);
    expect(p.hostClass).toMatch(/laptop|workstation|server/);
  });
});
