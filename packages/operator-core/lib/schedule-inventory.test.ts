import { describe, expect, it } from 'vitest';
import {
  collectScheduleInventory,
  humanInterval,
  summarizeInventory,
  type RoutineRow,
} from './schedule-inventory';
import type { DbosScheduledEntry } from './dbos/dbos-schedule-introspect';

const dbos = (over: Partial<DbosScheduledEntry> = {}): DbosScheduledEntry => ({
  name: 'telemetryFlush',
  crontab: '0 0 * * * *',
  mode: 'ExactlyOncePerIntervalWhenActive',
  queueName: null,
  lastFireMs: null,
  lastStatus: null,
  ...over,
});

const routine = (over: Partial<RoutineRow> = {}): RoutineRow => ({
  install_slug: 'system',
  name: 'git-sync',
  trigger_kind: 'cron',
  trigger_config: { cron: '*/2 * * * *' },
  target_role: 'system',
  active: true,
  next_fire_at: null,
  last_fired_at: null,
  metadata: null,
  ...over,
});

describe('humanInterval', () => {
  it('formats seconds, minutes, hours', () => {
    expect(humanInterval(30_000)).toBe('every 30s');
    expect(humanInterval(120_000)).toBe('every 2m');
    expect(humanInterval(3_600_000)).toBe('every 1h');
  });
});

describe('collectScheduleInventory', () => {
  it('unions DBOS + routines + in-process into one tier-tagged row shape', async () => {
    const rows = await collectScheduleInventory({
      getDbosSchedules: async () => [dbos({ name: 'backupCadence', crontab: '0 * * * * *', lastFireMs: 1_700_000_000_000 })],
      getRoutines: async () => [routine({ name: 'green-checkpoint', active: false, metadata: { last_error: 'boom' } })],
      getInProcessChecks: () => ({
        checks: [{ name: 'system-health', intervalMs: 30_000, shed: true }],
        armed: true,
      }),
    });

    expect(rows).toHaveLength(3);

    const d = rows.find((r) => r.source === 'dbos')!;
    expect(d).toMatchObject({ tier: 'durable', category: 'dbos-scheduled', cadence: '0 * * * * *', armed: true });
    expect(d.lastFire).toBe(new Date(1_700_000_000_000).toISOString());

    const r = rows.find((r) => r.source === 'routines')!;
    expect(r).toMatchObject({
      tier: 'durable',
      category: 'routine',
      installSlug: 'system',
      cadence: '*/2 * * * *',
      armed: false,
      lastError: 'boom',
    });

    const ip = rows.find((r) => r.source === 'in-process')!;
    expect(ip).toMatchObject({ tier: 'ephemeral', category: 'global-sweep', cadence: 'every 30s', armed: true });
    expect(ip.detail).toMatchObject({ intervalMs: 30_000, shed: true });
  });

  it('is fail-soft per source — one source throwing yields its empty slice, not a thrown inventory', async () => {
    const rows = await collectScheduleInventory({
      getDbosSchedules: async () => {
        throw new Error('dbos down');
      },
      getRoutines: async () => {
        throw new Error('pg down');
      },
      getInProcessChecks: () => ({ checks: [{ name: 'service-health', intervalMs: 60_000 }], armed: false }),
    });
    expect(rows.map((r) => r.source)).toEqual(['in-process']);
    expect(rows[0].armed).toBe(false);
  });

  it('summarizeInventory rolls up by source and tier', () => {
    const summary = summarizeInventory([
      { source: 'dbos', tier: 'durable' } as never,
      { source: 'routines', tier: 'durable' } as never,
      { source: 'in-process', tier: 'ephemeral' } as never,
    ]);
    expect(summary.total).toBe(3);
    expect(summary.bySource).toEqual({ dbos: 1, routines: 1, 'in-process': 1 });
    expect(summary.byTier).toEqual({ durable: 2, ephemeral: 1 });
  });
});
