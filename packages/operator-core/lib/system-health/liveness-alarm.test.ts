import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateLivenessAlarm,
  runLivenessAlarmTick,
  _resetLivenessAlarmDebounce,
} from './liveness-alarm';
import type { SystemHealth, HealthPanel, PanelKey, PanelStatus } from './types';

const PANEL_KEYS: PanelKey[] = [
  'queen', 'bees', 'workItems', 'workFeed', 'tokens', 'watchdog', 'deploy',
  'plans', 'escalations', 'autonomy', 'observations', 'improvements', 'infra', 'suFleet', 'overwatch',
];

function panel(key: PanelKey, over: Partial<HealthPanel<unknown>> = {}): HealthPanel<unknown> {
  return { key, label: key, status: 'ok', summary: 'ok', metrics: [], data: null, ...over };
}

function mkHealth(over: {
  evaluatedAt?: number;
  crossMonitor?: Partial<SystemHealth['crossMonitor']>;
  panels?: Partial<Record<PanelKey, Partial<HealthPanel<unknown>>>>;
} = {}): SystemHealth {
  const panels = {} as Record<string, HealthPanel<unknown>>;
  for (const k of PANEL_KEYS) panels[k] = panel(k, over.panels?.[k] ?? {});
  return {
    workspaceId: 'ws',
    evaluatedAt: over.evaluatedAt ?? 1_000_000,
    overall: 'ok' as PanelStatus,
    crossMonitor: { queenAlive: true, overwatchAlive: null, ...over.crossMonitor },
    panels: panels as unknown as SystemHealth['panels'],
  };
}

describe('evaluateLivenessAlarm (pure)', () => {
  it('a healthy snapshot computed fresh (age null) → no signals', () => {
    expect(evaluateLivenessAlarm(mkHealth(), null)).toEqual([]);
  });

  it('a STALE snapshot → the routine-engine-frozen signal (the request-path catch)', () => {
    const sigs = evaluateLivenessAlarm(mkHealth(), 10 * 60_000, { snapshotStaleMs: 6 * 60_000 });
    expect(sigs.map((s) => s.key)).toContain('health-tick-stale');
    expect(sigs.find((s) => s.key === 'health-tick-stale')?.severity).toBe('blocker');
  });

  it('a fresh snapshot under the stale window → NO stale signal', () => {
    const sigs = evaluateLivenessAlarm(mkHealth(), 60_000, { snapshotStaleMs: 6 * 60_000 });
    expect(sigs.map((s) => s.key)).not.toContain('health-tick-stale');
  });

  it('dead routines → dead-routines blocker', () => {
    const h = mkHealth({ panels: { workFeed: { data: { deadRoutines: 2, deadRoutineNames: ['git-sync', 'scout-cycle'] } } } });
    const sigs = evaluateLivenessAlarm(h, null);
    const dr = sigs.find((s) => s.key === 'dead-routines');
    expect(dr?.severity).toBe('blocker');
    expect(dr?.summary).toContain('git-sync');
  });

  it('queen dark (started + not alive) → queen-dark blocker', () => {
    const h = mkHealth({ crossMonitor: { queenAlive: false }, panels: { queen: { data: { started: true } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).toContain('queen-dark');
  });

  it('queen dark but NOT started → no queen-dark signal (a chosen pause is not an alarm)', () => {
    const h = mkHealth({ crossMonitor: { queenAlive: false }, panels: { queen: { data: { started: false } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('queen-dark');
  });

  it('all LLM accounts paused → accounts-starved blocker', () => {
    const h = mkHealth({ panels: { tokens: { data: { accountsTotal: 9, accountsAvailable: 0 } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).toContain('accounts-starved');
  });

  it('EI-1695: a STALE snapshot SUPPRESSES accounts-starved (blinded read folds into health-tick-stale)', () => {
    // bg routine engine frozen (stale) blinds the in-engine account read into a
    // false all-paused; the one root cause is health-tick-stale, not N rate blockers.
    const h = mkHealth({ panels: { tokens: { data: { accountsTotal: 8, accountsAvailable: 0 } } } });
    const keys = evaluateLivenessAlarm(h, 10 * 60_000, { snapshotStaleMs: 6 * 60_000 }).map((s) => s.key);
    expect(keys).toContain('health-tick-stale');
    expect(keys).not.toContain('accounts-starved');
  });

  it('EI-1695: a FRESH snapshot still fires accounts-starved (a real all-paused is not suppressed)', () => {
    const h = mkHealth({ panels: { tokens: { data: { accountsTotal: 8, accountsAvailable: 0 } } } });
    const keys = evaluateLivenessAlarm(h, 60_000, { snapshotStaleMs: 6 * 60_000 }).map((s) => s.key);
    expect(keys).toContain('accounts-starved');
    expect(keys).not.toContain('health-tick-stale');
  });

  it('catch-all: an unforeseen crit panel still surfaces (no silent miss)', () => {
    const h = mkHealth({ panels: { deploy: { status: 'crit', summary: 'release refs unreadable' } } });
    const sigs = evaluateLivenessAlarm(h, null);
    expect(sigs.map((s) => s.key)).toContain('panel:deploy');
  });
});

describe('runLivenessAlarmTick (debounced, transition-only)', () => {
  beforeEach(() => _resetLivenessAlarmDebounce());

  it('computes fresh on a stale cache, escalates each new signal, then debounces repeats', async () => {
    const escalate = (() => {
      const calls: Array<{ severity: string; summary: string }> = [];
      const fn = async (input: { severity: string; summary: string }) => { calls.push(input); };
      (fn as unknown as { calls: typeof calls }).calls = calls;
      return fn as typeof fn & { calls: typeof calls };
    })();
    const stale = mkHealth({ evaluatedAt: 0 }); // very old → stale
    const fresh = mkHealth({ panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } } });
    let now = 100 * 60_000;
    const deps = {
      readLast: () => stale,
      computeHealth: async () => fresh,
      escalate,
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    };

    const first = await runLivenessAlarmTick('ws', deps);
    // stale cache → health-tick-stale fires; computed fresh has dead-routines too.
    expect(first.fired.map((s) => s.key).sort()).toEqual(['dead-routines', 'health-tick-stale']);
    expect(escalate.calls.length).toBe(2);
    expect(escalate.calls[0].summary).toContain('[infra-liveness]');

    // Same signals within the debounce window → no new escalations.
    now += 5 * 60_000;
    const second = await runLivenessAlarmTick('ws', deps);
    expect(second.fired).toEqual([]);
    expect(escalate.calls.length).toBe(2);

    // Past the debounce window → fires again.
    now += 30 * 60_000;
    const third = await runLivenessAlarmTick('ws', deps);
    expect(third.fired.length).toBe(2);
    expect(escalate.calls.length).toBe(4);
  });

  it('a fresh cache is used as-is (no recompute) and a healthy system fires nothing', async () => {
    let computed = 0;
    const fresh = mkHealth({ evaluatedAt: 100 * 60_000 });
    const deps = {
      readLast: () => fresh,
      computeHealth: async () => { computed++; return fresh; },
      escalate: async () => {},
      now: () => 100 * 60_000 + 60_000, // 1m old → under the 6m stale window
      snapshotStaleMs: 6 * 60_000,
    };
    const r = await runLivenessAlarmTick('ws', deps);
    expect(computed).toBe(0); // warm cache used, no recompute
    expect(r.fired).toEqual([]);
  });
});
