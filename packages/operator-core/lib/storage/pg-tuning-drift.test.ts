import { describe, it, expect, vi } from 'vitest';
import {
  formatTuningDriftToast,
  runPgTuningDriftCheckOnce,
  targetSettings,
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
