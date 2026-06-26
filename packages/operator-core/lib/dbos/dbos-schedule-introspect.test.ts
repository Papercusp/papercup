import { describe, expect, it } from 'vitest';
import {
  defaultGetRegisteredSchedules,
  listDbosScheduledWorkflows,
  type FireState,
  type RegisteredSchedule,
} from './dbos-schedule-introspect';

const reg = (name: string, crontab: string, extra: Partial<RegisteredSchedule> = {}): RegisteredSchedule => ({
  name,
  crontab,
  mode: 'ExactlyOncePerIntervalWhenActive',
  queueName: null,
  ...extra,
});

describe('listDbosScheduledWorkflows', () => {
  it('returns [] when no schedules are registered (DBOS not loaded in this process)', async () => {
    const out = await listDbosScheduledWorkflows({ getRegisteredSchedules: () => [] });
    expect(out).toEqual([]);
  });

  it('merges the registry with fire-state and sorts by name', async () => {
    const fireState: FireState = new Map([
      ['telemetryFlush', { lastFireMs: 1_700_000_000_000, lastStatus: 'SUCCESS' }],
      // backupCadence intentionally has no fire-state row (never fired / not tracked)
    ]);
    const out = await listDbosScheduledWorkflows({
      getRegisteredSchedules: () => [
        reg('telemetryFlush', '0 0 * * * *', { queueName: 'maint' }),
        reg('backupCadence', '0 * * * * *'),
      ],
      getFireState: async () => fireState,
    });

    expect(out.map((e) => e.name)).toEqual(['backupCadence', 'telemetryFlush']); // alpha-sorted
    const telem = out.find((e) => e.name === 'telemetryFlush')!;
    expect(telem).toMatchObject({
      crontab: '0 0 * * * *',
      mode: 'ExactlyOncePerIntervalWhenActive',
      queueName: 'maint',
      lastFireMs: 1_700_000_000_000,
      lastStatus: 'SUCCESS',
    });
    const backup = out.find((e) => e.name === 'backupCadence')!;
    expect(backup.lastFireMs).toBeNull();
    expect(backup.lastStatus).toBeNull();
  });

  it('degrades to null fire-state (never throws) when the enrichment leg fails', async () => {
    const out = await listDbosScheduledWorkflows({
      getRegisteredSchedules: () => [reg('scratchGc', '0 0 3 * * *')],
      getFireState: async () => {
        throw new Error('pg down');
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'scratchGc', crontab: '0 0 3 * * *', lastFireMs: null, lastStatus: null });
  });

  it('passes the registered names to the fire-state query', async () => {
    let seen: string[] | null = null;
    await listDbosScheduledWorkflows({
      getRegisteredSchedules: () => [reg('a.x', '* * * * * *'), reg('b.y', '* * * * * *')],
      getFireState: async (names) => {
        seen = names;
        return new Map();
      },
    });
    expect(seen).toEqual(['a.x', 'b.y']);
  });
});

describe('defaultGetRegisteredSchedules', () => {
  it('never throws and returns an array (SDK present, no schedules registered in the test process)', async () => {
    const out = await defaultGetRegisteredSchedules();
    expect(Array.isArray(out)).toBe(true);
    // In a bare vitest process the workflow modules are not imported, so the
    // SDK registry is empty — the contract under test is "no throw, array out".
  });
});
