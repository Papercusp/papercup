/**
 * P-005 (gate-throughput-shift-left-2026-10-06, R-5): a gate run whose pid is gone with its
 * in-flight marker still set pages the gate holder and fleet leader ONCE, within minutes, and is
 * silent while the pid is alive or the marker is cleared.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import type { StoredInFlightCandidate } from './in-flight-candidate';
import { beginQualificationTransaction, type CheckpointQualificationTransaction } from './checkpoint-qualification-transaction';
import {
  LOST_RUN_SWEEP_INTERVAL_MS,
  claimLostRunAlarm,
  decideLostRunAlarm,
  lostRunAlarmKey,
  resolveLostRunRoutes,
  sweepLostGateRuns,
  type LostRunSweepDeps,
} from './lost-gate-run-alarm';

const NOW = 1_750_000_000_000;
const SELF_PID = 7;
const DEAD_PID = 424242;

const marker = (over: Partial<StoredInFlightCandidate> = {}): StoredInFlightCandidate => ({
  candidate: 'deadbeef00112233445566778899aabbccddeeff',
  candidateSource: 'tip',
  base: 'cafe0000112233445566778899aabbccddeeff00',
  selectedAtMs: NOW - 120_000,
  quietCutApplied: false,
  tipAtSelection: null,
  refireDepth: 0,
  pid: DEAD_PID,
  observedAtMs: NOW - 120_000,
  verdictWrittenAtMs: null,
  ...over,
});

/**
 * A stateful stand-in for ONE green-checkpoint routines row. It answers the sweep's SELECT from
 * current state and applies the claim/release UPDATEs with the same predicate the SQL states
 * (claim only when the stored key IS DISTINCT FROM the new key; release only on an equal key), so
 * dedup is exercised across passes and simulated restarts rather than asserted on a mock count.
 */
function fakeRoutineRow(initialMarker: StoredInFlightCandidate | null, qualification: unknown = null) {
  const row = {
    installSlug: 'papercusp',
    workspaceId: 'papercusp-workspace',
    marker: initialMarker as StoredInFlightCandidate | null,
    alarmKey: null as string | null,
    qualification,
    retries: 0,
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (/^\s*SELECT install_slug/.test(text)) {
      return Promise.resolve(
        row.marker || row.qualification
          ? [{ install_slug: row.installSlug, workspace_id: row.workspaceId, marker: row.marker, alarmed_key: row.alarmKey, qualification: row.qualification }]
          : [],
      );
    }
    if (text.includes('next_fire_at')) {
      row.retries += 1;
      return Promise.resolve({ count: 1 });
    }
    if (text.includes('IS DISTINCT FROM')) {
      const key = values[0] as string;
      if (row.alarmKey === key) return Promise.resolve({ count: 0 });
      row.alarmKey = key;
      return Promise.resolve({ count: 1 });
    }
    if (text.includes("- 'lostRunAlarm'")) {
      const key = values[2] as string;
      if (row.alarmKey === key) row.alarmKey = null;
      return Promise.resolve({ count: 1 });
    }
    if (/coord_presence/.test(text)) return Promise.resolve([]);
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as Sql;
  return { row, sql };
}

function deps(over: Partial<LostRunSweepDeps> = {}): LostRunSweepDeps & {
  broadcast: ReturnType<typeof vi.fn>;
  notifyOwner: ReturnType<typeof vi.fn>;
} {
  return {
    nowMs: NOW,
    selfPid: SELF_PID,
    pidAlive: (pid: number) => pid !== DEAD_PID,
    hostFleetSlug: null,
    claim: claimLostRunAlarm,
    readHolder: async () => 'su-holder',
    readOwnerFleetSlug: async () => 'gate-fleet',
    ...over,
    broadcast: (over.broadcast as ReturnType<typeof vi.fn>) ?? vi.fn(async () => true),
    notifyOwner: (over.notifyOwner as ReturnType<typeof vi.fn>) ?? vi.fn(async () => {}),
  } as never;
}

describe('decideLostRunAlarm (P-005 / R-5)', () => {
  const base = { alreadyAlarmedKey: null, selfPid: SELF_PID, nowMs: NOW };

  it('alarms for a marker whose pid is gone, with no grace period', () => {
    const fresh = marker({ observedAtMs: NOW - 30_000 });
    const d = decideLostRunAlarm({ ...base, rawMarker: fresh, pidAlive: () => false });
    expect(d).toMatchObject({ action: 'alarm', pid: DEAD_PID, key: lostRunAlarmKey(fresh) });
  });

  it('is silent while the pid is alive, when liveness is unknown, for its own run, and with no marker', () => {
    expect(decideLostRunAlarm({ ...base, rawMarker: marker(), pidAlive: () => true })).toEqual({
      action: 'silent',
      reason: 'pid-alive',
    });
    expect(decideLostRunAlarm({ ...base, rawMarker: marker(), pidAlive: () => null })).toEqual({
      action: 'silent',
      reason: 'pid-unknown',
    });
    expect(
      decideLostRunAlarm({ ...base, rawMarker: marker({ pid: SELF_PID }), pidAlive: () => false }),
    ).toEqual({ action: 'silent', reason: 'own-run' });
    expect(decideLostRunAlarm({ ...base, rawMarker: null, pidAlive: () => false })).toEqual({
      action: 'silent',
      reason: 'no-marker',
    });
  });

  it('is silent for a run it already alarmed, but alarms again for a DIFFERENT dead run', () => {
    const first = marker();
    expect(
      decideLostRunAlarm({ ...base, rawMarker: first, alreadyAlarmedKey: lostRunAlarmKey(first), pidAlive: () => false }),
    ).toEqual({ action: 'silent', reason: 'already-alarmed' });
    const second = marker({ pid: DEAD_PID + 1, observedAtMs: NOW - 10_000 });
    expect(
      decideLostRunAlarm({ ...base, rawMarker: second, alreadyAlarmedKey: lostRunAlarmKey(first), pidAlive: () => false }),
    ).toMatchObject({ action: 'alarm', key: lostRunAlarmKey(second) });
  });
});

describe('resolveLostRunRoutes', () => {
  it("pages the holder and the holder's fleet leader", () => {
    expect(
      resolveLostRunRoutes({ installSlug: 'papercusp', holderOwnerId: 'su-h', holderFleetSlug: 'f1', hostFleetSlug: 'host' })
        .map((r) => r.ownerSelector),
    ).toEqual(['su-h', '@fleet-leader:f1']);
  });

  it("falls back to this host's fleet when the holder has none, and to nobody when neither exists", () => {
    expect(
      resolveLostRunRoutes({ installSlug: 'papercusp', holderOwnerId: 'su-h', holderFleetSlug: null, hostFleetSlug: 'host' })
        .map((r) => r.ownerSelector),
    ).toEqual(['su-h', '@fleet-leader:host']);
    expect(
      resolveLostRunRoutes({ installSlug: 'papercusp', holderOwnerId: null, holderFleetSlug: null, hostFleetSlug: null }),
    ).toEqual([]);
  });
});

describe('sweepLostGateRuns (P-005 / R-5)', () => {
  it('pages the holder and fleet leader exactly once for a dead run, across passes and a restart', async () => {
    const { sql, row } = fakeRoutineRow(marker());
    const d = deps();

    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: ['papercusp'], deduped: [], failed: [] });
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    const ev = d.broadcast.mock.calls[0][0];
    expect(ev.route.ownerSelector).toBe('su-holder');
    expect(ev.extraRoutes.map((r: { ownerSelector: string }) => r.ownerSelector)).toEqual(['@fleet-leader:gate-fleet']);
    expect(ev.conditionKey).toBe('green-checkpoint-lost-run:papercusp');
    expect(ev.summary).toContain(`pid ${DEAD_PID}`);
    expect(row.alarmKey).toBe(lostRunAlarmKey(marker()));

    // The marker lingers (e.g. the 15-minute wake failed): the next pass must not re-page.
    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: [], deduped: ['papercusp'], failed: [] });
    // A restarted process has fresh deps but the same durable stamp: still no re-page.
    const restarted = deps();
    await sweepLostGateRuns(sql, restarted);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    expect(restarted.broadcast).not.toHaveBeenCalled();
  });

  it('a concurrent pass that loses the compare-and-set stays silent', async () => {
    const { sql, row } = fakeRoutineRow(marker());
    row.alarmKey = null;
    const a = deps();
    const b = deps();
    const [ra, rb] = await Promise.all([sweepLostGateRuns(sql, a), sweepLostGateRuns(sql, b)]);
    expect([...ra.alarmed, ...rb.alarmed]).toEqual(['papercusp']);
    expect(a.broadcast.mock.calls.length + b.broadcast.mock.calls.length).toBe(1);
  });

  it('is silent while the pid is alive and once the marker is cleared', async () => {
    const { sql, row } = fakeRoutineRow(marker());
    const d = deps({ pidAlive: () => true });
    await expect(sweepLostGateRuns(sql, d)).resolves.toEqual({ alarmed: [], deduped: [], failed: [] });
    row.marker = null;
    await expect(sweepLostGateRuns(sql, deps())).resolves.toEqual({ alarmed: [], deduped: [], failed: [] });
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it('raises to the owner when no holder or fleet leader is resolvable', async () => {
    const { sql } = fakeRoutineRow(marker());
    const d = deps({ readHolder: async () => null, hostFleetSlug: null });
    await sweepLostGateRuns(sql, d);
    const ev = d.broadcast.mock.calls[0][0];
    expect(ev.route).toBeUndefined();
    expect(d.notifyOwner).toHaveBeenCalledTimes(1);
  });

  it('an unreadable holder never suppresses the alarm', async () => {
    const { sql } = fakeRoutineRow(marker());
    const d = deps({
      readHolder: async () => {
        throw new Error('ownership store down');
      },
      hostFleetSlug: 'host-fleet',
    });
    await expect(sweepLostGateRuns(sql, d)).resolves.toMatchObject({ alarmed: ['papercusp'] });
    expect(d.broadcast.mock.calls[0][0].route.ownerSelector).toBe('@fleet-leader:host-fleet');
  });

  it('an undelivered page releases its claim so the next pass retries it', async () => {
    const { sql, row } = fakeRoutineRow(marker());
    const failing = deps({ broadcast: vi.fn(async () => false) });
    await expect(sweepLostGateRuns(sql, failing)).resolves.toEqual({ alarmed: [], deduped: [], failed: ['papercusp'] });
    expect(row.alarmKey).toBeNull();
    const retry = deps();
    await expect(sweepLostGateRuns(sql, retry)).resolves.toMatchObject({ alarmed: ['papercusp'] });
    expect(retry.broadcast).toHaveBeenCalledTimes(1);
  });
});

describe('qualification progress in the existing lost-run sweep', () => {
  function qualification(heartbeatAtMs = NOW - 4 * 60_000): CheckpointQualificationTransaction {
    const ready = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: NOW - 5 * 60_000,
    }).transaction;
    return {
      ...ready, phase: 'running', lastProgressAtMs: heartbeatAtMs,
      currentPhysicalRunner: {
        id: 'runner-1', candidate: 'candidate-1', reservedAtMs: NOW - 5 * 60_000,
        heartbeatAtMs, leaseExpiresAtMs: NOW + 60 * 60_000,
        pid: DEAD_PID, pidIdentity: 'test-boot:test-start', phase: 'suite', evidenceRefs: [],
      },
    };
  }

  function progressDeps(liveness: 'live' | 'dead' | 'unknown') {
    return Object.assign(deps(), { probeQualificationRunner: vi.fn(() => liveness) });
  }

  it.each(['live', 'unknown'] as const)('pages once for stale progress with %s liveness and never starts another runner', async (liveness) => {
    const { sql, row } = fakeRoutineRow(null, qualification());
    const d = progressDeps(liveness);
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    expect(d.broadcast.mock.calls[0][0]).toMatchObject({
      conditionKey: 'green-checkpoint-run-progress:papercusp',
      route: { ownerSelector: 'su-holder' },
    });
    expect(d.broadcast.mock.calls[0][0].body).toContain('attempt-1');
    expect(d.broadcast.mock.calls[0][0].body).toContain('preserve single flight');
    await sweepLostGateRuns(sql, progressDeps(liveness));
    expect(row.retries).toBe(0);
    expect(row.alarmKey).not.toBeNull();
    expect(d.broadcast).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a recently progressing runner and for a terminal attempt', async () => {
    const { sql, row } = fakeRoutineRow(null, qualification(NOW - 60_000));
    const d = progressDeps('live');
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).not.toHaveBeenCalled();
    row.qualification = { ...qualification(), phase: 'terminal', outcome: { kind: 'green', reason: 'advanced' } };
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).not.toHaveBeenCalled();
    expect(row.retries).toBe(0);
  });

  it('promptly retries a confirmed-dead runner before its unexpired lease, without manufacturing a verdict', async () => {
    const tx = qualification(NOW - 60_000);
    const { sql, row } = fakeRoutineRow(null, tx);
    const d = progressDeps('dead');
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    expect(row.retries).toBe(1);
    expect(row.qualification).toEqual(tx);
    expect(d.broadcast.mock.calls[0][0].body).toContain('proved dead');
  });

  it('releases an undelivered stale-progress alarm for the next pass to retry', async () => {
    const { sql, row } = fakeRoutineRow(null, qualification());
    const d = Object.assign(progressDeps('unknown'), { broadcast: vi.fn(async () => false) });
    await expect(sweepLostGateRuns(sql, d)).resolves.toMatchObject({ failed: ['papercusp'] });
    expect(row.alarmKey).toBeNull();
    const retry = progressDeps('unknown');
    await sweepLostGateRuns(sql, retry);
    expect(retry.broadcast).toHaveBeenCalledTimes(1);
  });

  it('fails closed for malformed qualification metadata', async () => {
    const { sql } = fakeRoutineRow(null, { currentPhysicalRunner: { id: 'unproven' } });
    const d = progressDeps('dead');
    await sweepLostGateRuns(sql, d);
    expect(d.broadcast).not.toHaveBeenCalled();
    expect(d.probeQualificationRunner).not.toHaveBeenCalled();
  });
});

describe('lost-run sweep wiring (R-5: within 10 minutes of the death)', () => {
  it('the sweep cadence leaves the 10-minute bound with margin', () => {
    expect(LOST_RUN_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('startGreenStallWatchdog runs the sweep at boot and on its own timer', () => {
    const src = readFileSync(join(__dirname, 'green-stall-watchdog.ts'), 'utf8');
    const starter = src.slice(src.indexOf('export function startGreenStallWatchdog('));
    expect(starter).toMatch(/sweepLostGateRuns\(sql\)/);
    expect(starter).toMatch(/sweepLostRuns\(\);/);
    expect(starter).toMatch(
      /managedSetInterval\(\s*'green-checkpoint-lost-run-alarm',\s*opts\.lostRunIntervalMs \?\? LOST_RUN_SWEEP_INTERVAL_MS,\s*sweepLostRuns/,
    );
  });
});
