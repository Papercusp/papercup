import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionNotifyResult, ReplaySafeAttentionNotifyInput } from '../attention-notify';
import { checkGreenMainSlo, parseLastGreenAtMs, runGreenMainSloPass, type GreenMainSloPassDeps } from './green-main-slo-watchdog';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 2, 0, 0);

const mocks = vi.hoisted(() => ({
  readVerdictRateWindow: vi.fn(),
  readFrozenCandidateRepairQueueState: vi.fn(),
  notifyAttentionOnce: vi.fn(),
  recordWatchdogPassOutcome: vi.fn(),
}));
vi.mock('./gate-verdict-rate-alarm', () => ({ readVerdictRateWindow: mocks.readVerdictRateWindow }));
vi.mock('../harness/routines/release-actions', () => ({
  readFrozenCandidateRepairQueueState: mocks.readFrozenCandidateRepairQueueState,
}));
vi.mock('../attention-notify', () => ({ notifyAttentionOnce: mocks.notifyAttentionOnce }));
vi.mock('./watchdog-health', () => ({ recordWatchdogPassOutcome: mocks.recordWatchdogPassOutcome }));

/** A durable once-per-key store, the contract notifyAttentionOnce gives a stable dedupeKey. */
function onceStore() {
  const seen = new Set<string>();
  const sent: ReplaySafeAttentionNotifyInput[] = [];
  const notifyOnce = vi.fn(async (input: ReplaySafeAttentionNotifyInput): Promise<AttentionNotifyResult> => {
    const deduped = seen.has(input.dedupeKey);
    if (!deduped) {
      seen.add(input.dedupeKey);
      sent.push(input);
    }
    return { recordId: deduped ? null : sent.length, deduped, mobileDelivered: !deduped, desktopDelivered: !deduped };
  });
  return { notifyOnce, sent };
}

function deps(over: Partial<GreenMainSloPassDeps> = {}): GreenMainSloPassDeps {
  return {
    installSlug: 'papercusp',
    workspaceId: 'ws-1',
    nowMs: NOW,
    readLastGreenAtMs: async () => NOW - 2 * HOUR,
    readLastVerdictAtMs: async () => NOW - 1 * HOUR,
    readQueue: async () => null,
    notifyOnce: onceStore().notifyOnce,
    ...over,
  };
}

describe('runGreenMainSloPass', () => {
  it('delivers nothing while main is inside its SLO', async () => {
    const store = onceStore();
    const res = await runGreenMainSloPass(
      deps({ readLastGreenAtMs: async () => NOW - 11 * HOUR, readLastVerdictAtMs: async () => NOW - 5 * HOUR, notifyOnce: store.notifyOnce }),
    );
    expect(res.slo.breaches).toEqual([]);
    expect(store.notifyOnce).not.toHaveBeenCalled();
    expect(res.readErrors).toEqual([]);
  });

  it('pages the owner exactly ONCE per red episode across many ticks, and again for a new episode', async () => {
    const store = onceStore();
    const lastGreen = NOW - 13 * HOUR;
    const ticks = [0, 15, 30, 45, 60, 600].map((min) => NOW + min * 60_000);
    const fresh: string[] = [];
    for (const nowMs of ticks) {
      // Red verdicts keep landing (the gate is alive), so only the red page is in play.
      const res = await runGreenMainSloPass(
        deps({
          nowMs,
          readLastGreenAtMs: async () => lastGreen,
          readLastVerdictAtMs: async () => nowMs - 30 * 60_000,
          notifyOnce: store.notifyOnce,
        }),
      );
      fresh.push(...res.deliveries.filter((d) => !d.deduped).map((d) => d.episodeKey));
    }
    expect(fresh).toEqual([`green-main-slo:papercusp:time-since-green:${lastGreen}`]);
    expect(store.notifyOnce).toHaveBeenCalledTimes(ticks.length);
    expect(store.sent[0]).toMatchObject({
      kind: 'intervention',
      importance: 'urgent',
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      dedupeKey: `green-main-slo:papercusp:time-since-green:${lastGreen}`,
      data: { source: 'green-main-slo', metric: 'time-since-green', severity: 'page' },
    });

    // Main goes green, then red again for 12h+: a NEW episode, so exactly one new page.
    const nextGreen = NOW + 1 * HOUR;
    const later = await runGreenMainSloPass(
      deps({ nowMs: nextGreen + 12 * HOUR, readLastGreenAtMs: async () => nextGreen, readLastVerdictAtMs: async () => nextGreen + 11 * HOUR, notifyOnce: store.notifyOnce }),
    );
    expect(later.deliveries).toEqual([
      { episodeKey: `green-main-slo:papercusp:time-since-green:${nextGreen}`, severity: 'page', deduped: false },
    ]);
    expect(store.sent).toHaveLength(2);
  });

  it('pages a silent gate (no verdict of any kind for 6h+) once', async () => {
    const store = onceStore();
    const lastVerdict = NOW - 7 * HOUR;
    const res = await runGreenMainSloPass(deps({ readLastVerdictAtMs: async () => lastVerdict, notifyOnce: store.notifyOnce }));
    expect(res.deliveries).toEqual([
      { episodeKey: `green-main-slo:papercusp:time-since-verdict:${lastVerdict}`, severity: 'page', deduped: false },
    ]);
    expect(store.sent[0].importance).toBe('urgent');
  });

  it('a failed reader is reported, never read as fine, and does not silence the other page', async () => {
    const store = onceStore();
    const res = await runGreenMainSloPass(
      deps({
        readLastGreenAtMs: async () => {
          throw new Error('pg down');
        },
        readLastVerdictAtMs: async () => NOW - 8 * HOUR,
        notifyOnce: store.notifyOnce,
      }),
    );
    expect(res.readErrors).toEqual([{ input: 'lastGreenAt', message: 'pg down' }]);
    expect(res.slo.metrics.timeSinceGreenMs).toBeNull();
    expect(res.deliveries.map((d) => d.episodeKey)).toEqual([`green-main-slo:papercusp:time-since-verdict:${NOW - 8 * HOUR}`]);
  });

  it('a failed delivery is recorded and retried on the next tick (never lost)', async () => {
    const store = onceStore();
    let failNext = true;
    const flaky = vi.fn(async (input: ReplaySafeAttentionNotifyInput) => {
      if (failNext) {
        failNext = false;
        throw new Error('push gateway 503');
      }
      return store.notifyOnce(input);
    });
    const d = deps({ readLastGreenAtMs: async () => NOW - 20 * HOUR, notifyOnce: flaky });
    const first = await runGreenMainSloPass(d);
    expect(first.deliveries).toEqual([
      expect.objectContaining({ severity: 'page', deduped: false, error: 'push gateway 503' }),
    ]);
    const second = await runGreenMainSloPass(d);
    expect(second.deliveries).toEqual([expect.objectContaining({ severity: 'page', deduped: false })]);
    expect(second.deliveries[0].error).toBeUndefined();
    expect(store.sent).toHaveLength(1);
  });
});

describe('syncTalliesFromDeltaCoverage', () => {
  it('counts only judged (green|red) batches from the delta-check coverage ledger, and null when unreadable', async () => {
    const { syncTalliesFromDeltaCoverage } = await import('./green-main-slo');
    const ticks = ['green', 'red', 'skipped', 'up-to-date', 'red', 'radius-too-wide', 'missed-opportunity', 'green', 'leg-timeout'].map(
      (status, i) => ({ atMs: NOW - i * 300_000, evaluated: true, status }),
    );
    expect(syncTalliesFromDeltaCoverage({ coverage: { ticks } })).toEqual([{ fleet: null, judgedBatches: 4, redBatches: 2 }]);
    expect(syncTalliesFromDeltaCoverage({ coverage: { ticks: [] } })).toEqual([{ fleet: null, judgedBatches: 0, redBatches: 0 }]);
    expect(syncTalliesFromDeltaCoverage(undefined)).toBeNull();
    expect(syncTalliesFromDeltaCoverage({ coverage: { ticks: 'nope' } })).toBeNull();
  });

  it('a red-heavy delta ledger raises the per-sync red-rate alert through the pass', async () => {
    const store = onceStore();
    const ticks = Array.from({ length: 10 }, (_, i) => ({ atMs: NOW - i * 300_000, evaluated: true, status: i < 4 ? 'red' : 'green' }));
    const { syncTalliesFromDeltaCoverage } = await import('./green-main-slo');
    const res = await runGreenMainSloPass(
      deps({ readSyncTallies: async () => syncTalliesFromDeltaCoverage({ coverage: { ticks } }), notifyOnce: store.notifyOnce }),
    );
    expect(res.slo.metrics.perSyncRedRate).toEqual([{ fleet: null, judgedBatches: 10, redBatches: 4, rate: 0.4 }]);
    expect(res.deliveries).toEqual([expect.objectContaining({ severity: 'alert', deduped: false })]);
    expect(store.sent[0]).toMatchObject({ importance: 'normal', title: 'All agents: 40% of syncs red on papercusp' });
  });
});

describe('parseLastGreenAtMs', () => {
  it('reads the stored epoch and refuses garbage instead of reading it as "never green"', () => {
    expect(parseLastGreenAtMs(null)).toBeNull();
    expect(parseLastGreenAtMs('')).toBeNull();
    expect(parseLastGreenAtMs('1791000000000')).toBe(1791000000000);
    expect(parseLastGreenAtMs(1791000000000)).toBe(1791000000000);
    expect(() => parseLastGreenAtMs('not-a-date')).toThrow(/not an epoch ms/);
  });
});

describe('checkGreenMainSlo (production wiring)', () => {
  const fakeSql = (rows: unknown[]) => (async () => rows) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readVerdictRateWindow.mockResolvedValue({ fires: 3, verdicts: 2, lastVerdictBearingAtMs: NOW - 1 * HOUR });
    mocks.readFrozenCandidateRepairQueueState.mockResolvedValue({ status: 'absent' });
    mocks.notifyAttentionOnce.mockResolvedValue({ recordId: 1, deduped: false, mobileDelivered: true, desktopDelivered: true });
    mocks.recordWatchdogPassOutcome.mockResolvedValue(0);
  });

  it('reads lastGreenAt from the gate routine row, pages through notifyAttentionOnce, and records a healthy pass', async () => {
    const lastGreen = NOW - 14 * HOUR;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await checkGreenMainSlo(fakeSql([{ workspace_id: 'ws-1', last_green_at: String(lastGreen) }]), {
      nowMs: () => NOW,
    });
    expect(warn).toHaveBeenCalledWith(`[green-main-slo] papercusp: delivered page green-main-slo:papercusp:time-since-green:${lastGreen}`);
    warn.mockRestore();
    expect(res?.deliveries.map((d) => d.episodeKey)).toEqual([`green-main-slo:papercusp:time-since-green:${lastGreen}`]);
    expect(mocks.readVerdictRateWindow).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', installSlug: 'papercusp' });
    expect(mocks.notifyAttentionOnce).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: `green-main-slo:papercusp:time-since-green:${lastGreen}`, importance: 'urgent' }),
    );
    expect(mocks.recordWatchdogPassOutcome).toHaveBeenCalledWith(
      expect.anything(),
      'green-main-slo',
      { routineName: 'green-checkpoint', installSlug: 'papercusp' },
      undefined,
    );
  });

  it('an unreadable frozen queue records a FAILED pass instead of reading as "no queue"', async () => {
    mocks.readFrozenCandidateRepairQueueState.mockResolvedValue({ status: 'unreadable', reason: 'invalid-shape', schemaVersion: null });
    const res = await checkGreenMainSlo(fakeSql([{ workspace_id: 'ws-1', last_green_at: String(NOW - 1 * HOUR) }]), {
      nowMs: () => NOW,
    });
    expect(res?.readErrors).toEqual([{ input: 'queue', message: 'frozen repair queue unreadable: invalid-shape' }]);
    const passError = mocks.recordWatchdogPassOutcome.mock.calls[0][3];
    expect(passError).toBeInstanceOf(Error);
    expect(String(passError)).toMatch(/read queue: frozen repair queue unreadable/);
  });

  it('does nothing (and records a healthy pass) when the install has no gate routine', async () => {
    const res = await checkGreenMainSlo(fakeSql([]), { nowMs: () => NOW });
    expect(res).toBeNull();
    expect(mocks.notifyAttentionOnce).not.toHaveBeenCalled();
    expect(mocks.recordWatchdogPassOutcome).toHaveBeenCalledWith(expect.anything(), 'green-main-slo', expect.anything(), undefined);
  });
});
