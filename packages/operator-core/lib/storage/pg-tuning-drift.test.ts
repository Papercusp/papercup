import { describe, it, expect, vi } from 'vitest';
import {
  evaluateHugePageBacking,
  formatHugePageBackingToast,
  formatTuningDriftToast,
  parseMeminfoKb,
  readHugePagePool,
  runPgHugePageBackingCheckOnce,
  runPgTuningDriftCheckOnce,
  targetSettings,
  type HugePagePgState,
  type HugePagePool,
} from './pg-tuning-drift';
import { diffPgSettings, type PgLiveSetting } from '@papercusp/resource-profile';

function live(name: string, setting: string, over: Partial<PgLiveSetting> = {}): PgLiveSetting {
  return { name, setting, unit: null, context: 'sighup', ...over };
}

/** A live snapshot that matches the derived target on every GUC. */
function inSyncSnapshot(): PgLiveSetting[] {
  return Object.entries(targetSettings()).map(([name, value]) => live(name, value));
}

describe('targetSettings', () => {
  it('carries the safety GUCs the alarm exists to protect', () => {
    const t = targetSettings();
    expect(t.max_slot_wal_keep_size).toBe('32GB');
    expect(t.jit_inline_above_cost).toBe('-1');
  });

  it('omits shared_preload_libraries — its target depends on live state, not derivation', () => {
    // pg-autotune UNIONs it with whatever is already loaded, so a fixed
    // expectation here would alarm on any host preloading an extra library.
    expect(targetSettings().shared_preload_libraries).toBeUndefined();
  });
});

describe('runPgTuningDriftCheckOnce', () => {
  it('skips an embedded PG — its settings come from -c flags at every boot', async () => {
    const emitToast = vi.fn();
    const r = await runPgTuningDriftCheckOnce({
      isEmbeddedPg: () => true,
      fetchLiveSettings: async () => {
        throw new Error('must not be queried');
      },
      emitToast,
    });
    expect(r.skipped).toBe(true);
    expect(r.drift).toBeNull();
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('stays silent when the live cluster matches the derivation', async () => {
    const emitToast = vi.fn();
    const r = await runPgTuningDriftCheckOnce({
      isEmbeddedPg: () => false,
      fetchLiveSettings: async () => inSyncSnapshot(),
      emitToast,
    });
    expect(r.skipped).toBe(false);
    expect(r.drift?.inSync).toBe(true);
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('catches the real regression: max_slot_wal_keep_size left at PG default -1', async () => {
    // The exact live state found on the dev box — the disk-fill defense that the
    // code, its tests and replication-slot-alarm's comments all said was armed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitToast = vi.fn();
    const snapshot = inSyncSnapshot().map((r) =>
      r.name === 'max_slot_wal_keep_size' ? live(r.name, '-1', { unit: 'MB' }) : r,
    );
    const r = await runPgTuningDriftCheckOnce({
      isEmbeddedPg: () => false,
      fetchLiveSettings: async () => snapshot,
      emitToast,
    });
    expect(r.drift?.diverged.map((d) => d.name)).toEqual(['max_slot_wal_keep_size']);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].description).toContain('max_slot_wal_keep_size');
    // The operator-log line matters as much as the toast: it is what a human
    // greps when the cluster misbehaves, and it must carry the remedy.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('max_slot_wal_keep_size live=-1MB want=32GB');
    expect(warn.mock.calls[0][0]).toContain('pg-autotune.ts --check');
    warn.mockRestore();
  });

  it('a GUC this server does not expose is "unknown", not drift — no false alarm', async () => {
    // pg_settings hides some GUCs from a non-superuser role. Reporting those as
    // drift would make the alarm cry wolf forever and train readers to ignore it.
    const emitToast = vi.fn();
    const r = await runPgTuningDriftCheckOnce({
      isEmbeddedPg: () => false,
      fetchLiveSettings: async () =>
        inSyncSnapshot().filter((r) => r.name !== 'max_slot_wal_keep_size'),
      emitToast,
    });
    expect(r.drift?.unknown).toEqual(['max_slot_wal_keep_size']);
    expect(r.drift?.inSync).toBe(true);
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('never throws when the settings scan fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runPgTuningDriftCheckOnce({
      isEmbeddedPg: () => false,
      fetchLiveSettings: async () => {
        throw new Error('connection refused');
      },
      emitToast: vi.fn(),
    });
    expect(r).toEqual({ skipped: false, checked: 0, drift: null });
    expect(warn.mock.calls[0][0]).toContain('connection refused');
    warn.mockRestore();
  });

  it('never throws when the toast emit fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const snapshot = inSyncSnapshot().map((r) =>
      r.name === 'work_mem' ? live(r.name, '4096', { unit: 'kB', context: 'user' }) : r,
    );
    const r = await runPgTuningDriftCheckOnce({
      isEmbeddedPg: () => false,
      fetchLiveSettings: async () => snapshot,
      emitToast: async () => {
        throw new Error('toast_log unavailable');
      },
    });
    expect(r.drift?.diverged.map((d) => d.name)).toEqual(['work_mem']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('toast emit failed'))).toBe(true);
    warn.mockRestore();
  });
});

describe('formatTuningDriftToast', () => {
  it('says whether closing the drift needs a restart or only a reload', () => {
    const drift = diffPgSettings(
      { max_slot_wal_keep_size: '32GB', shared_buffers: '64392MB' },
      [
        live('max_slot_wal_keep_size', '-1', { unit: 'MB' }),
        live('shared_buffers', '1024', { unit: '8kB', context: 'postmaster' }),
      ],
    );
    const t = formatTuningDriftToast(drift);
    expect(t.level).toBe('warning');
    expect(t.description).toContain('SIGHUP-reloadable — no downtime');
    expect(t.description).toContain('needs a PG restart');
    expect(t.description).toContain('pg-autotune.ts --check');
  });
});

// ── Huge-page backing alarm (endgame D-052 / WI-10002573) ────────────────────

/** The tower's live state, measured 2026-09-23 (pg_settings + /sys + /proc/meminfo). */
function towerPg(over: Partial<HugePagePgState> = {}): HugePagePgState {
  return {
    hugePages: 'try',
    status: 'off',
    requiredPages: 32983,
    sharedMemoryMb: 65966,
    hugePageSizeKb: 0,
    ...over,
  };
}
function towerPool(over: Partial<HugePagePool> = {}): HugePagePool {
  return { pageSizeKb: 2048, total: 618, free: 425, reserved: 423, pageTablesKb: 12605576, ...over };
}
const linux = { platform: 'linux' as const };

describe('evaluateHugePageBacking', () => {
  it('flags the D-052 state: huge_pages=try fell back and the pool cannot hold the segment', () => {
    const v = evaluateHugePageBacking(towerPg(), towerPool(), linux);
    expect(v).toMatchObject({ kind: 'unbacked', cause: 'pool-too-small', requiredPages: 32983 });
  });

  it('is silent once PostgreSQL reports huge_pages_status=on', () => {
    expect(evaluateHugePageBacking(towerPg({ status: 'on' }), towerPool({ total: 34000 }), linux)).toEqual({
      kind: 'backed',
    });
  });

  it('pool boundary: a pool exactly the required size is big enough, so the cause is "not adopted"', () => {
    // Pins the ruled predicate (required > HugePages_Total) at its edge, both sides.
    expect(evaluateHugePageBacking(towerPg(), towerPool({ total: 32983 }), linux)).toMatchObject({
      cause: 'pool-not-adopted',
    });
    expect(evaluateHugePageBacking(towerPg(), towerPool({ total: 32982 }), linux)).toMatchObject({
      cause: 'pool-too-small',
    });
  });

  it('huge_pages=off is an explicit choice and huge_pages=on cannot run unbacked: neither alarms', () => {
    expect(evaluateHugePageBacking(towerPg({ hugePages: 'off' }), towerPool(), linux).kind).toBe('not-applicable');
    expect(evaluateHugePageBacking(towerPg({ hugePages: 'on' }), towerPool(), linux).kind).toBe('not-applicable');
  });

  it('is "unknown", not healthy, when huge_pages_status is absent (PostgreSQL < 17)', () => {
    expect(evaluateHugePageBacking(towerPg({ status: null }), towerPool(), linux).kind).toBe('unknown');
    expect(evaluateHugePageBacking(towerPg({ status: 'unknown' }), towerPool(), linux).kind).toBe('unknown');
  });

  it('does not alarm off Linux, where "try" always resolves to off by design', () => {
    expect(evaluateHugePageBacking(towerPg(), null, { platform: 'darwin' }).kind).toBe('not-applicable');
  });

  it('does not alarm an unbacked segment below the 1 GiB floor', () => {
    const v = evaluateHugePageBacking(towerPg({ requiredPages: 80, sharedMemoryMb: 150 }), towerPool(), linux);
    expect(v).toEqual({ kind: 'below-floor', sharedMemoryBytes: 150 * 1024 ** 2 });
  });

  it('still alarms when the pool is unreadable: PostgreSQL itself confirmed the fallback', () => {
    expect(evaluateHugePageBacking(towerPg(), null, linux)).toMatchObject({
      kind: 'unbacked',
      cause: 'pool-unreadable',
    });
  });
});

describe('formatHugePageBackingToast', () => {
  it('names the numbers, the measured cost, and the reboot remedy for a pool that is too small', () => {
    const v = evaluateHugePageBacking(towerPg(), towerPool(), linux);
    if (v.kind !== 'unbacked') throw new Error('expected unbacked');
    const t = formatHugePageBackingToast(v);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('64.4 GiB');
    expect(t.description).toContain('huge_pages_status=off');
    expect(t.description).toContain('618 allocated');
    expect(t.description).toContain('needs 32983');
    expect(t.description).toContain('PageTables is currently 12.0 GiB');
    expect(t.description).toContain('vm.nr_hugepages to at least 32983');
    expect(t.description).toContain('reboot');
    expect(t.description).toContain('D-052');
  });

  it('for a large-enough pool, says a restart adopts it and warns when other processes hold it', () => {
    const v = evaluateHugePageBacking(towerPg(), towerPool({ total: 34000, free: 34000, reserved: 30000 }), linux);
    if (v.kind !== 'unbacked') throw new Error('expected unbacked');
    const t = formatHugePageBackingToast(v);
    expect(t.description).toContain('restart PostgreSQL');
    expect(t.description).toContain('only 4000 pages are unreserved');
  });
});

describe('readHugePagePool', () => {
  const meminfo = 'PageTables:     12605576 kB\nHugePages_Total:     618\nHugepagesize:       2048 kB\n';
  const sys = (dir: string): Record<string, string> => ({
    [`${dir}/nr_hugepages`]: '618\n',
    [`${dir}/free_hugepages`]: '425\n',
    [`${dir}/resv_hugepages`]: '423\n',
  });

  it('reads the default-size pool from /sys when huge_page_size=0', () => {
    const files: Record<string, string> = {
      '/proc/meminfo': meminfo,
      ...sys('/sys/kernel/mm/hugepages/hugepages-2048kB'),
    };
    expect(readHugePagePool(0, (p) => files[p] ?? (() => { throw new Error(`ENOENT ${p}`); })())).toEqual(
      towerPool(),
    );
  });

  it('reads the pool for an explicit huge_page_size, not the kernel default', () => {
    const files: Record<string, string> = {
      '/proc/meminfo': meminfo,
      ...sys('/sys/kernel/mm/hugepages/hugepages-1048576kB'),
    };
    const pool = readHugePagePool(1048576, (p) => files[p] ?? (() => { throw new Error(`ENOENT ${p}`); })());
    expect(pool?.pageSizeKb).toBe(1048576);
  });

  it('returns null, never throws, when a counter is unreadable', () => {
    expect(
      readHugePagePool(0, (p) => {
        if (p === '/proc/meminfo') return meminfo;
        throw new Error('EACCES');
      }),
    ).toBeNull();
  });

  it('parseMeminfoKb reads one key and answers null for an absent one', () => {
    expect(parseMeminfoKb(meminfo, 'Hugepagesize')).toBe(2048);
    expect(parseMeminfoKb(meminfo, 'ShmemHugePages')).toBeNull();
  });
});

describe('runPgHugePageBackingCheckOnce', () => {
  it('toasts once, and logs the cause, on the D-052 state', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitToast = vi.fn();
    const r = await runPgHugePageBackingCheckOnce({
      isEmbeddedPg: () => false,
      platform: 'linux',
      fetchPgState: async () => towerPg(),
      readPool: () => towerPool(),
      emitToast,
    });
    expect(r.verdict).toMatchObject({ kind: 'unbacked', cause: 'pool-too-small' });
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('cause=pool-too-small');
    warn.mockRestore();
  });

  it('stays silent when backed', async () => {
    const emitToast = vi.fn();
    const r = await runPgHugePageBackingCheckOnce({
      isEmbeddedPg: () => false,
      platform: 'linux',
      fetchPgState: async () => towerPg({ status: 'on' }),
      readPool: () => towerPool({ total: 34000 }),
      emitToast,
    });
    expect(r.verdict).toEqual({ kind: 'backed' });
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('skips an embedded PG without querying it', async () => {
    const r = await runPgHugePageBackingCheckOnce({
      isEmbeddedPg: () => true,
      fetchPgState: async () => {
        throw new Error('must not be queried');
      },
      emitToast: vi.fn(),
    });
    expect(r).toEqual({ skipped: true, verdict: null });
  });

  it('never throws when the settings scan or the toast fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      runPgHugePageBackingCheckOnce({
        isEmbeddedPg: () => false,
        fetchPgState: async () => {
          throw new Error('connection refused');
        },
      }),
    ).resolves.toEqual({ skipped: false, verdict: null });
    const r = await runPgHugePageBackingCheckOnce({
      isEmbeddedPg: () => false,
      platform: 'linux',
      fetchPgState: async () => towerPg(),
      readPool: () => {
        throw new Error('EACCES');
      },
      emitToast: async () => {
        throw new Error('toast_log unavailable');
      },
    });
    expect(r.verdict).toMatchObject({ kind: 'unbacked', cause: 'pool-unreadable' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('toast emit failed'))).toBe(true);
    warn.mockRestore();
  });
});
