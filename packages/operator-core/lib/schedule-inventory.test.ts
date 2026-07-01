import { describe, expect, it } from 'vitest';
import {
  collectScheduleInventory,
  humanInterval,
  summarizeInventory,
  EXTERNAL_PROCESS_TIMERS,
  SCHEDULE_SOURCES,
  type RoutineRow,
} from './schedule-inventory';
import type { DbosScheduledEntry } from './dbos/dbos-schedule-introspect';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its allow/baseline sets only.
import { BASELINE, ALLOWLIST, ALLOWLIST_DIRS } from '../../../scripts/check-no-raw-setinterval.mjs';

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
      getManaged: () => [],
      getInProcessChecks: () => ({
        checks: [{ name: 'system-health', intervalMs: 30_000, shed: true }],
        armed: true,
      }),
      getExternalProcess: () => [], // this test asserts the dbos/routines/in-process union only
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
      getManaged: () => [],
      getInProcessChecks: () => ({ checks: [{ name: 'service-health', intervalMs: 60_000 }], armed: false }),
      getExternalProcess: () => [],
    });
    expect(rows.map((r) => r.source)).toEqual(['in-process']);
    expect(rows[0].armed).toBe(false);
  });

  it('lists external-process timers (P-014) as source=external-process, per-process, with fire-state null', async () => {
    const rows = await collectScheduleInventory({
      getDbosSchedules: async () => [],
      getRoutines: async () => [],
      getManaged: () => [],
      getInProcessChecks: () => ({ checks: [], armed: false }),
      getExternalProcess: () => [
        { process: 'inference-gateway', name: 'gw-self-heal', cadence: 'every ~10s', source: 'inference-gateway/gateway.ts' },
        { process: 'psu-launcher', name: 'psu-supervisor-heartbeat', cadence: 'every ~60s', source: 'apps/operator/scripts/psu-launcher.mjs' },
      ],
    });
    expect(rows.map((r) => r.source)).toEqual(['external-process', 'external-process']);
    const gw = rows.find((r) => r.name === 'gw-self-heal')!;
    expect(gw).toMatchObject({
      source: 'external-process',
      category: 'external-process',
      tier: 'ephemeral',
      cadence: 'every ~10s',
      armed: null, // live fire-state requires federation (the follow-on)
      lastFire: null,
    });
    expect(gw.detail).toMatchObject({ process: 'inference-gateway', source: 'inference-gateway/gateway.ts' });
  });

  it('the DEFAULT external-process manifest covers the gateway + watchdog + psu-launcher (D-007)', async () => {
    const rows = await collectScheduleInventory({
      getDbosSchedules: async () => [],
      getRoutines: async () => [],
      getManaged: () => [],
      getInProcessChecks: () => ({ checks: [], armed: false }),
      // no getExternalProcess → the default EXTERNAL_PROCESS_TIMERS manifest is used
    });
    const ext = rows.filter((r) => r.source === 'external-process');
    expect(ext.length).toBeGreaterThanOrEqual(6);
    const processes = new Set(ext.map((r) => (r.detail as { process: string }).process));
    expect(processes).toEqual(new Set(['inference-gateway', 'gateway-watchdog', 'psu-launcher']));
  });

  it('surfaces live managed timers as source=managed with real fire times, deduping the static in-process fallback', async () => {
    const rows = await collectScheduleInventory({
      getDbosSchedules: async () => [],
      getRoutines: async () => [],
      getManaged: () => [
        {
          name: 'system-health',
          category: 'global-sweep',
          intervalMs: 30_000,
          armedAt: 10,
          lastFireAt: 1_700_000_000_000,
          lastError: null,
          running: false,
          instanced: false,
          instances: 1,
          fires: 5,
          shed: true,
        },
        {
          name: 'engine-death-sentinel',
          category: 'watchdog',
          intervalMs: 300_000,
          armedAt: 10,
          lastFireAt: null,
          lastError: 'last tick failed',
          running: false,
          instanced: false,
          instances: 1,
          fires: 2,
          shed: false,
        },
      ],
      getInProcessChecks: () => ({
        checks: [
          { name: 'system-health', intervalMs: 30_000, shed: true }, // also armed as managed → deduped
          { name: 'service-health', intervalMs: 60_000 }, // NOT managed → static fallback
        ],
        armed: true,
      }),
    });

    // system-health appears ONCE (live managed), not duplicated as in-process
    const sh = rows.filter((r) => r.name === 'system-health');
    expect(sh).toHaveLength(1);
    expect(sh[0]).toMatchObject({ source: 'managed', tier: 'ephemeral', category: 'global-sweep', armed: true });
    expect(sh[0].lastFire).toBe(new Date(1_700_000_000_000).toISOString());

    // a watchdog managed timer is VISIBLE (source managed) but stays its own category — visibility != control
    const wd = rows.find((r) => r.name === 'engine-death-sentinel')!;
    expect(wd).toMatchObject({ source: 'managed', category: 'watchdog', lastError: 'last tick failed' });

    // service-health is not a managed timer here → static in-process fallback (armed flag from the process)
    const svc = rows.find((r) => r.name === 'service-health')!;
    expect(svc).toMatchObject({ source: 'in-process', armed: true, lastFire: null });
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

/**
 * P-009 reconcile (WI-919): diff the operator-host timer AUDIT against the live registry +
 * the external-process manifest, asserting NO silent gaps. Two invariants, both durable:
 *
 *  1. The no-raw-setInterval guard BASELINE is EMPTY — every operator-host timer goes through
 *     managedSetInterval, so it appears in listManaged() → the inventory's 'managed' source.
 *     A non-empty BASELINE means a host timer is runtime-INVISIBLE (the silent gap P-007/P-008
 *     closed); keeping it empty is the universal-visibility ratchet.
 *  2. Every EXTERNAL_PROCESS_TIMERS source is allow-listed in that guard. This reconciles the two
 *     audits: a timer we LOG as 'external-process' must be one the host guard intentionally
 *     EXCLUDES (a separate process, not a host timer) — so no file is both expected-in-the-managed-
 *     registry AND logged-as-external (no double-count), and no external-process timer silently
 *     violates the host-setInterval guard. If the manifest and the allowlist drift apart, this fails.
 */
describe('schedule-inventory ⇄ host-timer guard reconcile (P-009 / WI-919)', () => {
  it('the no-raw-setInterval BASELINE is empty — no operator-host timer is runtime-invisible', () => {
    // The shrink-to-empty grandfather set (P-008 complete). A NEW bare setInterval is a hard guard
    // failure, never a BASELINE addition — that is the whole "every host timer is in schedule:inventory"
    // ratchet. If this fails, a host timer exists outside managedSetInterval ⇒ a silent inventory gap.
    expect(BASELINE.size).toBe(0);
  });

  it('every external-process timer source is allow-listed in the host guard (audits agree, no gap)', () => {
    const allowlisted = (source: string): boolean =>
      ALLOWLIST.has(source) || ALLOWLIST_DIRS.some((dir: string) => source.startsWith(dir));
    const orphans = EXTERNAL_PROCESS_TIMERS.filter((e) => !allowlisted(e.source));
    // Each external-process timer file must be a separate-process site the host guard excludes.
    // An orphan = a manifest entry the guard would FLAG (so it isn't truly separate-process) OR a
    // typo'd path — either way the manifest and the guard have drifted.
    expect(orphans.map((o) => o.source)).toEqual([]);
  });

  it('the manifest covers exactly the three separate-process owners (gateway, watchdog, psu-launcher)', () => {
    const processes = new Set(EXTERNAL_PROCESS_TIMERS.map((e) => e.process));
    expect(processes).toEqual(new Set(['inference-gateway', 'gateway-watchdog', 'psu-launcher']));
    // Every entry carries a real repo source path + a cadence (no blank audit rows).
    for (const e of EXTERNAL_PROCESS_TIMERS) {
      expect(e.source).toMatch(/\.(ts|mjs)$/);
      expect(e.cadence.length).toBeGreaterThan(0);
    }
  });

  it('every source collectScheduleInventory emits is a filterable SCHEDULE_SOURCES value (tool ⇄ inventory parity)', async () => {
    // Stub one row per source so the union exercises all of them; assert the emitted `source`
    // set is a SUBSET of the tool's filter enum. This is what stops the exact drift WI-919 fixed —
    // the inventory surfacing a source (e.g. external-process) the schedule:inventory tool can't filter.
    const rows = await collectScheduleInventory({
      getDbosSchedules: async () => [dbos()],
      getRoutines: async () => [routine()],
      getManaged: () => [
        {
          name: 'system-health',
          category: 'global-sweep',
          intervalMs: 30_000,
          armedAt: 1,
          lastFireAt: null,
          lastError: null,
          running: false,
          instanced: false,
          instances: 1,
          fires: 0,
          shed: false,
        },
      ],
      getInProcessChecks: () => ({ checks: [{ name: 'service-health', intervalMs: 60_000 }], armed: true }),
      // default getExternalProcess → the real EXTERNAL_PROCESS_TIMERS manifest
    });
    const emitted = new Set(rows.map((r) => r.source));
    expect(emitted).toEqual(new Set(['dbos', 'routines', 'managed', 'in-process', 'external-process']));
    for (const s of emitted) expect(SCHEDULE_SOURCES).toContain(s);
  });
});
