import { afterEach, describe, expect, it } from 'vitest';
import {
  boundedOrgPoolMax,
  configureResourceProfile,
  databaseTuningToSettings,
  deriveDatabaseTuning,
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

  it('scales httpWorkers to cores-1 capped at 32, + 1 background primary (P3-2)', () => {
    expect(p.httpWorkers).toBe(32); // clamp(128 - 1, 1, 32)
    expect(p.processCount).toBe(33); // 32 request workers + 1 background primary
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

describe('non-finite cores never poison the profile (RP1 — was a real defect)', () => {
  // Before the fix: Math.floor(NaN)=NaN flowed straight through Math.max and the
  // un-guarded clamp(), so every cap came back NaN; NaN<=4 and NaN<=16 are both
  // false so the host misclassed as 'server' — and the WHOLE bogus profile got
  // memoized for the process lifetime. A NaN profile is never intended. Reverting
  // either guard (the cores fallback or the clamp Number.isFinite check) makes NaN
  // reappear and these assertions fail.
  it('cores:NaN falls back to a single-core laptop with finite caps', () => {
    const p = deriveResourceProfile(signals({ cores: NaN }));
    // host class is sane, not the bogus 'server' the NaN comparisons produced.
    expect(p.hostClass).toBe('laptop');
    // every cap is a finite number (the defect made all of these NaN).
    for (const cap of [
      p.maxSimultaneousAgents,
      p.dbosQueueConcurrency,
      p.pgPoolMax,
      p.serializationWorkers,
      p.embedBatchSize,
    ]) {
      expect(Number.isFinite(cap)).toBe(true);
    }
    // and each lands on its small-host floor / value.
    expect(p.maxSimultaneousAgents).toBe(1);
    expect(p.dbosQueueConcurrency).toBe(1);
    expect(p.pgPoolMax).toBe(6); // 1 + 1 + 4
    expect(p.serializationWorkers).toBe(0);
    expect(p.embedBatchSize).toBe(32);
    // the persisted signal is a finite core count, not NaN.
    expect(Number.isFinite(p.signals.cores)).toBe(true);
    expect(p.signals.cores).toBe(1);
  });

  it('cores:Infinity also falls back to a single-core laptop (not an oversized server)', () => {
    const p = deriveResourceProfile(signals({ cores: Infinity }));
    expect(p.hostClass).toBe('laptop');
    expect(Number.isFinite(p.signals.cores)).toBe(true);
    expect(p.signals.cores).toBe(1);
    expect(p.maxSimultaneousAgents).toBe(1);
    expect(p.dbosQueueConcurrency).toBe(1);
    for (const cap of [p.pgPoolMax, p.serializationWorkers, p.embedBatchSize]) {
      expect(Number.isFinite(cap)).toBe(true);
    }
  });

  it('a non-finite freeMemBytes is absorbed by the clamp guard, not the cap', () => {
    // freeMemBytes:NaN -> Math.max(0,NaN)=NaN -> floor(NaN/0.5)=NaN ->
    // Math.min(agentsByCore, NaN)=NaN reaches clamp(). Without the clamp
    // Number.isFinite guard the agent cap would come back NaN even though cores
    // is a healthy 16; the guard pins it to the floor of 1.
    const p = deriveResourceProfile(
      signals({ cores: 16, freeMemBytes: NaN }),
    );
    expect(Number.isFinite(p.maxSimultaneousAgents)).toBe(true);
    expect(p.maxSimultaneousAgents).toBe(1);
  });
});

describe('cores + freeMem normalization (RP2)', () => {
  it('floors fractional cores down and lifts non-positive cores to 1', () => {
    // Math.max(1, Math.floor(cores))
    expect(deriveResourceProfile(signals({ cores: 0 })).signals.cores).toBe(1);
    expect(deriveResourceProfile(signals({ cores: -5 })).signals.cores).toBe(1);
    expect(deriveResourceProfile(signals({ cores: 2.7 })).signals.cores).toBe(2);
  });

  it('overwrites the frozen signals.cores with the normalized value, not the raw input', () => {
    // signals: Object.freeze({ ...signals, cores }) — the derived (floored) value wins.
    const p = deriveResourceProfile(signals({ cores: 2.7 }));
    expect(p.signals.cores).toBe(2);
    // and the frozen object can't be mutated back.
    expect(() => {
      (p.signals as { cores: number }).cores = 99;
    }).toThrow();
  });

  it('a negative freeMemBytes is floored to 0, clamping agents to the floor of 1', () => {
    // Math.max(0, freeMemBytes)/GIB -> 0 free GiB -> floor(0/0.5)=0 agents-by-ram,
    // clamped up to the floor of 1.
    const p = deriveResourceProfile(
      signals({ cores: 128, embeddedPg: false, totalMemBytes: 512 * GIB, freeMemBytes: -1 * GIB }),
    );
    expect(p.maxSimultaneousAgents).toBe(1);
  });
});

describe('utility hostRole halves the DBOS queue like request-only (RP3)', () => {
  it('a 16-core utility host gets half the full-host queue depth', () => {
    // queueRoleFactor = hostRole === 'full' ? 1 : 0.5 — 'utility' is in the else.
    // round(16 * 1) = 16 base; * 0.5 = 8.
    const p = deriveResourceProfile(signals({ cores: 16, hostRole: 'utility' }));
    expect(p.dbosQueueConcurrency).toBe(8);
    const full = deriveResourceProfile(signals({ cores: 16, hostRole: 'full' }));
    expect(p.dbosQueueConcurrency).toBeLessThan(full.dbosQueueConcurrency);
  });
});

describe('deriveDatabaseTuning — server (128 cores, 256 GiB, native PG)', () => {
  const t = deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB, freeMemBytes: 256 * GIB }));

  it('scales max_connections far past the stock 100 (128 * 4 = 512)', () => {
    expect(t.maxConnections).toBe(512);
    expect(t.maxConnections).toBeGreaterThan(100); // the stock default it replaces
  });

  it('keeps superuser slots reserved so an exhausted pool never locks operators out', () => {
    expect(t.superuserReservedConnections).toBe(10); // round(512 * 0.02)
  });

  it('hits the shared_buffers ceiling at 64 GiB (256 GiB * 0.25 = 64 GiB)', () => {
    expect(t.sharedBuffersMb).toBe(65536);
  });

  it('sets effective_cache_size to ~75% RAM (planner hint)', () => {
    expect(t.effectiveCacheSizeMb).toBe(196608); // 256 * 0.75 * 1024
  });

  it('caps maintenance_work_mem at 2 GiB and work_mem at 64 MiB', () => {
    expect(t.maintenanceWorkMemMb).toBe(2048);
    expect(t.workMemMb).toBe(64);
  });

  it('scales the parallel-worker pool to the cores', () => {
    expect(t.maxWorkerProcesses).toBe(128);
    expect(t.maxParallelWorkers).toBe(128);
    expect(t.maxParallelWorkersPerGather).toBe(8); // clamp(round(128/2), 1, 8)
    expect(t.maxParallelMaintenanceWorkers).toBe(8);
  });

  it('never lets the parallel cap exceed the worker-process pool (PG invariant)', () => {
    expect(t.maxParallelWorkers).toBeLessThanOrEqual(t.maxWorkerProcesses);
    expect(t.maxParallelWorkersPerGather).toBeLessThanOrEqual(t.maxParallelWorkers);
  });
});

describe('deriveDatabaseTuning — laptop with embedded PG sits on the floors', () => {
  const t = deriveDatabaseTuning(signals({ cores: 4, embeddedPg: true, totalMemBytes: 8 * GIB, freeMemBytes: 8 * GIB }));

  it('floors max_connections at 100 (a small box never goes below the stock ceiling)', () => {
    expect(t.maxConnections).toBe(100); // clamp(4 * 4, 100, 1000)
    expect(t.superuserReservedConnections).toBe(3); // floor
  });

  it('takes only a gentle slice of a shared box (15% RAM, not 25%)', () => {
    expect(t.sharedBuffersMb).toBe(Math.round(8 * 1024 * 0.15)); // 1229
  });

  it('floors the worker pool at 8 (== the PG default, no regression on tiny hosts)', () => {
    expect(t.maxWorkerProcesses).toBe(8);
    expect(t.maxParallelWorkers).toBe(8);
    expect(t.maxParallelWorkersPerGather).toBe(2); // round(4 / 2)
  });
});

describe('deriveDatabaseTuning — embedded takes a gentler RAM slice than dedicated', () => {
  it('shared_buffers + effective_cache_size shrink when the DB shares the box', () => {
    const dedicated = deriveDatabaseTuning(signals({ cores: 16, embeddedPg: false, totalMemBytes: 64 * GIB }));
    const embedded = deriveDatabaseTuning(signals({ cores: 16, embeddedPg: true, totalMemBytes: 64 * GIB }));
    expect(embedded.sharedBuffersMb).toBeLessThan(dedicated.sharedBuffersMb);
    expect(embedded.effectiveCacheSizeMb).toBeLessThan(dedicated.effectiveCacheSizeMb);
    expect(dedicated.sharedBuffersMb).toBe(16384); // 64 * 0.25 * 1024
    expect(embedded.sharedBuffersMb).toBe(9830); // round(64 * 0.15 * 1024)
  });
});

describe('deriveDatabaseTuning — non-finite signals never poison the knobs', () => {
  it('NaN cores → finite knobs on the floor', () => {
    const t = deriveDatabaseTuning(signals({ cores: NaN, totalMemBytes: NaN }));
    for (const v of Object.values(t)) expect(Number.isFinite(v)).toBe(true);
    expect(t.maxConnections).toBe(100); // 1 core * 4 -> floored to 100
    expect(t.sharedBuffersMb).toBeGreaterThanOrEqual(128); // RAM floored to 0.5 GiB -> floor
  });
});

describe('databaseTuningToSettings — renders GUC strings with units', () => {
  it('counts are plain, sizes carry MB', () => {
    const t = deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB }));
    const s = databaseTuningToSettings(t);
    expect(s.max_connections).toBe('512');
    expect(s.shared_buffers).toBe('65536MB');
    expect(s.effective_cache_size).toBe('196608MB');
    expect(s.work_mem).toBe('64MB');
    expect(s.max_parallel_workers_per_gather).toBe('8');
  });
});

describe('resource profile exposes the database tuning', () => {
  it('the memoized profile carries the derived DB knobs', () => {
    const p = deriveResourceProfile(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB, freeMemBytes: 256 * GIB }));
    expect(p.database.maxConnections).toBe(512);
    expect(p.database.sharedBuffersMb).toBe(65536);
  });
});

describe('boundedOrgPoolMax — keep org pools under the DB ceiling (C1-1)', () => {
  it('does not reduce when the budget is ample (this box: 52 vs 512)', () => {
    expect(
      boundedOrgPoolMax({ desired: 52, maxConnections: 512, superuserReserved: 10, expectedProcesses: 2 }),
    ).toBe(52);
  });

  it('caps when desired × 2 pools × procs would blow the ceiling (the regression case)', () => {
    // The pre-fix scenario: desired 52, but a 100-slot DB. 2 pools × 2 procs × 52
    // = 208 >> 100. Must come down hard.
    const bounded = boundedOrgPoolMax({
      desired: 52,
      maxConnections: 100,
      superuserReserved: 3,
      expectedProcesses: 2,
    });
    expect(bounded).toBeLessThan(52);
    // invariant holds: 2 pools × 2 procs × bounded + overhead ≤ 100
    expect(bounded * 2 * 2 + 13 * 2 + 32 + 3).toBeLessThanOrEqual(100);
  });

  it('behind a pooler, returns the full desired size (app pool ≠ PG backends)', () => {
    expect(
      boundedOrgPoolMax({
        desired: 52,
        maxConnections: 100,
        superuserReserved: 3,
        expectedProcesses: 2,
        behindPooler: true,
      }),
    ).toBe(52);
  });

  it('never returns below 1', () => {
    expect(
      boundedOrgPoolMax({ desired: 1, maxConnections: 10, superuserReserved: 3, expectedProcesses: 8 }),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('CI guard (C5-2) — derived pool sizing never exceeds the host-tuned ceiling', () => {
  // The 2026-06-17 outage was pool sizing that ignored the DB ceiling. This is the
  // permanent tripwire: for every host shape, the bounded org pools + per-process
  // fixed overhead + other-DB pools + reserved must fit under max_connections.
  const FIXED_PER_PROC = 13; // admin-cache(8) + 5 LISTEN buses
  const OTHER_DBS = 32; // su-lock in papercusp_su
  const PROCS = 2; // dev box runs :3070 + :3170
  for (const cores of [2, 4, 8, 16, 24, 32, 64, 128, 256]) {
    for (const ramGib of [2, 4, 8, 16, 64, 256, 512]) {
      for (const embeddedPg of [false, true]) {
        it(`fits: ${cores} cores / ${ramGib} GiB / embedded=${embeddedPg}`, () => {
          const p = deriveResourceProfile(
            signals({ cores, embeddedPg, totalMemBytes: ramGib * GIB, freeMemBytes: ramGib * GIB }),
          );
          const db = p.database;
          const bounded = boundedOrgPoolMax({
            desired: p.pgPoolMax,
            maxConnections: db.maxConnections,
            superuserReserved: db.superuserReservedConnections,
            expectedProcesses: PROCS,
          });
          const total =
            bounded * 2 * PROCS + FIXED_PER_PROC * PROCS + OTHER_DBS + db.superuserReservedConnections;
          expect(total).toBeLessThanOrEqual(db.maxConnections);
        });
      }
    }
  }
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
