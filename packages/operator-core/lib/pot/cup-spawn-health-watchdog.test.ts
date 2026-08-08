/**
 * WI-36299 — cup-spawn-health-watchdog verdict logic. The pure decider
 * (evaluateCupSpawnHealth) is unit-pinned directly; checkCupSpawnHealth's DB
 * wiring is exercised with a mocked sql/notify/broadcast surface (mirrors
 * green-stall-watchdog.test.ts's mock-the-dependency unit style) rather than a
 * live PG — the regression under test is which VALUES reach the alarm plumbing,
 * not schema/constraint enforcement.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const notifyAttentionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../attention-notify', () => ({
  notifyAttention: (...args: unknown[]) => notifyAttentionMock(...args),
}));
const broadcastSevereEventMock = vi.fn().mockResolvedValue(true);
const broadcastSevereEventResolvedMock = vi.fn().mockResolvedValue(true);
vi.mock('../severe-event-broadcast', () => ({
  broadcastSevereEvent: (...args: unknown[]) => broadcastSevereEventMock(...args),
  broadcastSevereEventResolved: (...args: unknown[]) => broadcastSevereEventResolvedMock(...args),
}));

import { evaluateCupSpawnHealth, checkCupSpawnHealth } from './cup-spawn-health-watchdog';

describe('evaluateCupSpawnHealth (pure decider)', () => {
  it('does not alarm on an empty sample (no cup activity)', () => {
    const v = evaluateCupSpawnHealth({ recent: [] });
    expect(v.alarmed).toBe(false);
    expect(v.consecutiveFailures).toBe(0);
  });

  it('does not alarm below the consecutive-failure threshold', () => {
    const v = evaluateCupSpawnHealth({
      recent: [
        { status: 'failed', exitCode: 1 },
        { status: 'failed', exitCode: 1 },
      ],
    });
    expect(v.alarmed).toBe(false);
    expect(v.consecutiveFailures).toBe(2);
  });

  it('alarms at the default threshold (3 consecutive failures, no success)', () => {
    const v = evaluateCupSpawnHealth({
      recent: [
        { status: 'failed', exitCode: 1 },
        { status: 'failed', exitCode: 127 },
        { status: 'failed', exitCode: 1 },
      ],
    });
    expect(v.alarmed).toBe(true);
    expect(v.consecutiveFailures).toBe(3);
    expect(v.reason).toMatch(/3 consecutive cup:spawn failure/);
  });

  it('mixed non-success statuses (cancelled/reaped) all count as failures', () => {
    const v = evaluateCupSpawnHealth({
      recent: [
        { status: 'reaped', exitCode: null },
        { status: 'cancelled', exitCode: null },
        { status: 'failed', exitCode: 1 },
      ],
    });
    expect(v.alarmed).toBe(true);
    expect(v.consecutiveFailures).toBe(3);
  });

  it('a success ANYWHERE in the recent streak breaks the count — the WI-36357 burst-then-recover shape never alarms', () => {
    const v = evaluateCupSpawnHealth({
      recent: [
        { status: 'failed', exitCode: 1 },
        { status: 'failed', exitCode: 1 },
        { status: 'done', exitCode: 0 }, // the recovery
        { status: 'failed', exitCode: 1 },
        { status: 'failed', exitCode: 1 },
      ],
    });
    expect(v.alarmed).toBe(false);
    expect(v.consecutiveFailures).toBe(2); // only the two newest, before the success
  });

  it('a `done` row with a null exit_code (legacy rows) counts as success', () => {
    const v = evaluateCupSpawnHealth({
      recent: [
        { status: 'failed', exitCode: 1 },
        { status: 'failed', exitCode: 1 },
        { status: 'done', exitCode: null },
      ],
    });
    expect(v.alarmed).toBe(false);
    expect(v.consecutiveFailures).toBe(2);
  });

  it('respects a custom threshold', () => {
    const v = evaluateCupSpawnHealth(
      { recent: [{ status: 'failed', exitCode: 1 }, { status: 'failed', exitCode: 1 }] },
      { consecutiveThreshold: 2 },
    );
    expect(v.alarmed).toBe(true);
    expect(v.consecutiveFailures).toBe(2);
  });
});

// Minimal fake tagged-template `sql` — enough for checkCupSpawnHealth's two query
// shapes (the ranked-cup-spawns read, and the harness_escalations existence/insert/
// update reads). Keyed off the literal fragment text at each call site, mirroring the
// lightweight fake-sql style already used elsewhere in this package's watchdog tests.
function makeFakeSql(opts: {
  rankedRows: Array<{ workspace_id: string; harness_slug: string; status: string; exit_code: number | null }>;
  existingEscalation: unknown;
}) {
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const fn = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM harness_shared.spawned_agents')) {
      return Promise.resolve(opts.rankedRows);
    }
    if (text.includes('SELECT escalation FROM')) {
      return Promise.resolve(opts.existingEscalation == null ? [] : [{ escalation: opts.existingEscalation }]);
    }
    if (text.includes('INSERT INTO harness_shared.harness_escalations')) {
      inserted.push(_values);
      return Promise.resolve({ count: 1 });
    }
    if (text.includes('UPDATE harness_shared.harness_escalations')) {
      updated.push(_values);
      return Promise.resolve({ count: 1 });
    }
    return Promise.resolve([]);
  };
  return { sql: fn as unknown as import('postgres').Sql, inserted, updated };
}

describe('checkCupSpawnHealth (DB wiring, mocked sql)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('alarms once (notify + broadcast + escalation insert) on a fresh 3-in-a-row failure streak', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sql, inserted } = makeFakeSql({
      rankedRows: [
        { workspace_id: 'ws1', harness_slug: 'papercusp', status: 'failed', exit_code: 1 },
        { workspace_id: 'ws1', harness_slug: 'papercusp', status: 'failed', exit_code: 1 },
        { workspace_id: 'ws1', harness_slug: 'papercusp', status: 'failed', exit_code: 1 },
      ],
      existingEscalation: null,
    });
    const result = await checkCupSpawnHealth(sql);
    expect(result.alarmed).toEqual([{ workspaceId: 'ws1', harnessSlug: 'papercusp' }]);
    expect(notifyAttentionMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventMock).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventMock.mock.calls[0][0].conditionKey).toBe('cup-spawn-health:ws1:papercusp');
    expect(inserted.length).toBe(1);
  });

  it('does not re-alarm when an escalation is already open (one-shot until recovery)', async () => {
    const { sql } = makeFakeSql({
      rankedRows: [
        { workspace_id: 'ws1', harness_slug: 'papercusp', status: 'failed', exit_code: 1 },
        { workspace_id: 'ws1', harness_slug: 'papercusp', status: 'failed', exit_code: 1 },
        { workspace_id: 'ws1', harness_slug: 'papercusp', status: 'failed', exit_code: 1 },
      ],
      existingEscalation: { kind: 'cup-spawn-health-watchdog' },
    });
    const result = await checkCupSpawnHealth(sql);
    expect(result.alarmed).toEqual([]);
    expect(notifyAttentionMock).not.toHaveBeenCalled();
    expect(broadcastSevereEventMock).not.toHaveBeenCalled();
  });

  it('clears a stale alarm once a success lands (recovery)', async () => {
    const { sql, updated } = makeFakeSql({
      rankedRows: [
        { workspace_id: 'ws1', harness_slug: 'papercusp', status: 'done', exit_code: 0 },
        { workspace_id: 'ws1', harness_slug: 'papercusp', status: 'failed', exit_code: 1 },
        { workspace_id: 'ws1', harness_slug: 'papercusp', status: 'failed', exit_code: 1 },
      ],
      existingEscalation: { kind: 'cup-spawn-health-watchdog' },
    });
    const result = await checkCupSpawnHealth(sql);
    expect(result.recovered).toEqual([{ workspaceId: 'ws1', harnessSlug: 'papercusp' }]);
    expect(broadcastSevereEventResolvedMock).toHaveBeenCalledTimes(1);
    expect(updated.length).toBe(1);
  });

  it('never throws when the underlying sql call rejects (fail-soft)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = (() => Promise.reject(new Error('boom'))) as unknown as import('postgres').Sql;
    const result = await checkCupSpawnHealth(sql);
    expect(result).toEqual({ alarmed: [], recovered: [] });
  });
});
