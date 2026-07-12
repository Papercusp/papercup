import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateLivenessAlarm,
  runLivenessAlarmTick,
  deriveSignatureFromSummary,
  livenessSignatureOf,
  _resetLivenessAlarmDebounce,
} from './liveness-alarm';
import type { SystemHealth, HealthPanel, PanelKey, PanelStatus } from './types';
import type { EscalationRecord } from '../agent-tools/coordination/escalations';

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

  // P-008: PG-restart drift detector.
  it('PG postmaster-start FIRST observation (no prior baseline) → NO pg-restarted signal (just seeds)', () => {
    const h = mkHealth({ panels: { infra: { data: { pg: { postmasterStartMs: 1_700_000_000_000 } } } } });
    const sigs = evaluateLivenessAlarm(h, null, { prevPostmasterStartMs: null });
    expect(sigs.map((s) => s.key)).not.toContain('pg-restarted');
  });

  it('PG postmaster-start DRIFT (prev != cur, both present) → pg-restarted blocker', () => {
    const h = mkHealth({ panels: { infra: { data: { pg: { postmasterStartMs: 1_700_000_050_000 } } } } });
    const sigs = evaluateLivenessAlarm(h, null, { prevPostmasterStartMs: 1_700_000_000_000 });
    const pg = sigs.find((s) => s.key === 'pg-restarted');
    expect(pg?.severity).toBe('blocker');
    expect(pg?.summary).toContain('Postgres RESTARTED');
    expect(pg?.summary).toContain(new Date(1_700_000_050_000).toISOString());
  });

  it('PG postmaster-start STABLE (prev == cur) → NO pg-restarted signal', () => {
    const h = mkHealth({ panels: { infra: { data: { pg: { postmasterStartMs: 1_700_000_000_000 } } } } });
    const sigs = evaluateLivenessAlarm(h, null, { prevPostmasterStartMs: 1_700_000_000_000 });
    expect(sigs.map((s) => s.key)).not.toContain('pg-restarted');
  });

  it('PG unreadable this tick (cur null) → NO pg-restarted signal even with a prior baseline', () => {
    const h = mkHealth({ panels: { infra: { data: { pg: null } } } });
    const sigs = evaluateLivenessAlarm(h, null, { prevPostmasterStartMs: 1_700_000_000_000 });
    expect(sigs.map((s) => s.key)).not.toContain('pg-restarted');
  });

  it('queen dark (started + not alive) → queen-dark blocker', () => {
    const h = mkHealth({ crossMonitor: { queenAlive: false }, panels: { queen: { data: { started: true } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).toContain('queen-dark');
  });

  it('queen dark but NOT started → no queen-dark signal (a chosen pause is not an alarm)', () => {
    const h = mkHealth({ crossMonitor: { queenAlive: false }, panels: { queen: { data: { started: false } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('queen-dark');
  });

  it('overwatch alive but skipping its scorecard → overwatch-scorecard-skipped (monitor-the-monitor)', () => {
    const h = mkHealth({ panels: { overwatch: { data: { started: true, scorecardSkipped: true, scorecardEmission: { status: 'stale', lastCompleteAt: null, missingCount: 0 } } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).toContain('overwatch-scorecard-skipped');
  });

  it('partial-only emission names the unrated-criteria count', () => {
    const h = mkHealth({ panels: { overwatch: { data: { started: true, scorecardSkipped: true, scorecardEmission: { status: 'partial-only', lastCompleteAt: null, missingCount: 4 } } } } });
    const sig = evaluateLivenessAlarm(h, null).find((s) => s.key === 'overwatch-scorecard-skipped');
    expect(sig?.summary).toContain('4 criteria unrated');
  });

  it('NOT skipped (fresh, or wake not yet settled) → no scorecard-skipped signal', () => {
    const h = mkHealth({ panels: { overwatch: { data: { started: true, scorecardSkipped: false, scorecardEmission: { status: 'fresh', lastCompleteAt: '2026-06-21T11:00:00Z', missingCount: 0 } } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('overwatch-scorecard-skipped');
  });

  it('skipping but NOT started → no signal (a paused supervisor is not skipping)', () => {
    const h = mkHealth({ panels: { overwatch: { data: { started: false, scorecardSkipped: true, scorecardEmission: { status: 'stale', lastCompleteAt: null, missingCount: 0 } } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('overwatch-scorecard-skipped');
  });

  // 4c — rubric-emission-dark (WI-2374): enabled + STOPPED long past a wake must
  // NOT be silent forever ('not-started' reads benign to the freshness interpreter,
  // so nothing else ever surfaces a stopped monitor's dead rubric emission).
  const DARK_NOW = 100 * 3_600_000;

  it('overwatch enabled + STOPPED, last wake 7h ago → rubric-emission-dark advisory', () => {
    const h = mkHealth({ evaluatedAt: DARK_NOW, panels: { overwatch: { data: { flagEnabled: true, started: false, lastWakeAt: DARK_NOW - 7 * 3_600_000 } } } });
    const sig = evaluateLivenessAlarm(h, null).find((s) => s.key === 'rubric-emission-dark');
    expect(sig?.severity).toBe('advisory');
    expect(sig?.summary).toContain('7h');
    expect(sig?.summary).toContain('STOPPED');
  });

  it('enabled + STOPPED but only 2h dark → within the 6h grace, no signal', () => {
    const h = mkHealth({ evaluatedAt: DARK_NOW, panels: { overwatch: { data: { flagEnabled: true, started: false, lastWakeAt: DARK_NOW - 2 * 3_600_000 } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('rubric-emission-dark');
  });

  it('flag OFF + stopped → no rubric-emission-dark (explicitly disabled is not an alarm)', () => {
    const h = mkHealth({ evaluatedAt: DARK_NOW, panels: { overwatch: { data: { flagEnabled: false, started: false, lastWakeAt: DARK_NOW - 30 * 3_600_000 } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('rubric-emission-dark');
  });

  it('never woke (lastWakeAt null) → no signal (a fresh pre-armed install stays quiet)', () => {
    const h = mkHealth({ evaluatedAt: DARK_NOW, panels: { overwatch: { data: { flagEnabled: true, started: false, lastWakeAt: null } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('rubric-emission-dark');
  });

  it('started (running) → no rubric-emission-dark; the started cases belong to 4/4b', () => {
    const h = mkHealth({ evaluatedAt: DARK_NOW, panels: { overwatch: { data: { flagEnabled: true, started: true, lastWakeAt: DARK_NOW - 30 * 3_600_000 } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('rubric-emission-dark');
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

  it('queen crit + dark → exactly ONE signal (queen-dark), not also duplicated by the catch-all', () => {
    // Regression: coveredKeys must list the panel's stable KEY ('queen'), not its
    // display label ('Mug') — the key is deliberately unrenamed (types.ts
    // PANEL_LABELS: queen → 'Mug'), so a coveredKeys entry of 'mug' never matches
    // panel.key and the catch-all silently double-fires 'panel:queen' alongside
    // 'queen-dark'. See cup-lexicon-full-rename-2026-07-09.
    const h = mkHealth({
      crossMonitor: { queenAlive: false },
      panels: { queen: { status: 'crit', summary: 'queen loop dark', data: { started: true } } },
    });
    const keys = evaluateLivenessAlarm(h, null).map((s) => s.key);
    expect(keys).toContain('queen-dark');
    expect(keys).not.toContain('panel:queen');
    expect(keys.filter((k) => k === 'queen-dark' || k === 'panel:queen')).toHaveLength(1);
  });

  it('EI-2146 #3: "no bees" does NOT fire when the frontier is empty (idle fleet, not a fault)', () => {
    const h = mkHealth({
      panels: {
        bees: { status: 'crit', summary: 'no bees running', data: { running: 0 } },
        workFeed: { data: { frontier: 0, deadRoutines: 0 } },
      },
    });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('panel:bees');
  });

  it('EI-2146 #3: no-bees crit STILL fires when there is placeable work (frontier > 0)', () => {
    const h = mkHealth({
      panels: {
        bees: { status: 'crit', summary: 'no bees running', data: { running: 0 } },
        workFeed: { data: { frontier: 3, deadRoutines: 0 } },
      },
    });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).toContain('panel:bees');
  });

  it('EI-2146 #3: a bees crit for another reason (bees still running) is NOT suppressed', () => {
    // e.g. a cursed placement while bees run: running > 0, so the no-bees gate
    // never applies regardless of the frontier.
    const h = mkHealth({
      panels: {
        bees: { status: 'crit', summary: '2 bee(s), 2 alive, 1 cursed', data: { running: 2 } },
        workFeed: { data: { frontier: 0, deadRoutines: 0 } },
      },
    });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).toContain('panel:bees');
  });
});

// EI-9794: signal 5c — autoloop FIRE-RECENCY staleness. Independent of
// `last_status`/`consecutive_errors` (frozen the instant a loop stops firing)
// and of the `armed` wake-routine bit (a self-deactivating one-shot's normal
// resting state is indistinguishable from a failed re-arm).
describe('evaluateLivenessAlarm — EI-9794 autoloop fire-staleness (5c)', () => {
  const NOW = 1_000_000_000; // arbitrary fixed "now" for evaluatedAt

  it('(a) expected + stale beyond N x cadence → autoloop-fire-stale blocker', () => {
    const cadenceSec = 600;
    const staleForMs = cadenceSec * 1000 * 3 + 60_000; // just past the default 3x threshold
    const h = mkHealth({ evaluatedAt: NOW });
    const sigs = evaluateLivenessAlarm(h, null, {
      autoloopFireRows: [
        { role: 'kettle', harnessSlug: 'papercusp', lastFiredAtMs: NOW - staleForMs, cadenceSec, expected: true },
      ],
    });
    const sig = sigs.find((s) => s.key === 'autoloop-fire-stale:kettle');
    expect(sig).toBeDefined();
    expect(sig?.severity).toBe('blocker');
    expect(sig?.summary).toContain('kettle@papercusp');
    expect(sig?.summary).toContain('has not fired in');
  });

  it('(b) NOT expected → never fires even when lastFiredAtMs is ancient', () => {
    const h = mkHealth({ evaluatedAt: NOW });
    const sigs = evaluateLivenessAlarm(h, null, {
      autoloopFireRows: [
        { role: 'kettle', harnessSlug: 'papercusp', lastFiredAtMs: NOW - 100 * 3_600_000, cadenceSec: 600, expected: false },
      ],
    });
    expect(sigs.map((s) => s.key)).not.toContain('autoloop-fire-stale:kettle');
  });

  it('(c) lastFiredAtMs null (never fired yet) → no signal (starting, not dead)', () => {
    const h = mkHealth({ evaluatedAt: NOW });
    const sigs = evaluateLivenessAlarm(h, null, {
      autoloopFireRows: [
        { role: 'kettle', harnessSlug: 'papercusp', lastFiredAtMs: null, cadenceSec: 600, expected: true },
      ],
    });
    expect(sigs.map((s) => s.key)).not.toContain('autoloop-fire-stale:kettle');
  });

  it('(d) within the threshold (recent fire) → no signal', () => {
    const cadenceSec = 600;
    const h = mkHealth({ evaluatedAt: NOW });
    const sigs = evaluateLivenessAlarm(h, null, {
      autoloopFireRows: [
        { role: 'kettle', harnessSlug: 'papercusp', lastFiredAtMs: NOW - 60_000, cadenceSec, expected: true },
      ],
    });
    expect(sigs.map((s) => s.key)).not.toContain('autoloop-fire-stale:kettle');
  });

  it('multiple rows are evaluated independently (only the stale one fires)', () => {
    const cadenceSec = 600;
    const h = mkHealth({ evaluatedAt: NOW });
    const sigs = evaluateLivenessAlarm(h, null, {
      autoloopFireRows: [
        { role: 'kettle', harnessSlug: 'papercusp', lastFiredAtMs: NOW - cadenceSec * 1000 * 5, cadenceSec, expected: true },
        { role: 'other-role', harnessSlug: 'papercusp', lastFiredAtMs: NOW - 60_000, cadenceSec, expected: true },
      ],
    });
    const keys = sigs.map((s) => s.key);
    expect(keys).toContain('autoloop-fire-stale:kettle');
    expect(keys).not.toContain('autoloop-fire-stale:other-role');
  });

  it('no autoloopFireRows passed (omitted opt) → no signal (fail-open, not a false negative from an unwired caller)', () => {
    const h = mkHealth({ evaluatedAt: NOW });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('autoloop-fire-stale:kettle');
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
      // No durable open escalations in this fixture → durable dedup never blocks;
      // this test exercises the in-memory cooldown debounce path specifically.
      listOpen: async () => [],
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
      listOpen: async () => [],
      now: () => 100 * 60_000 + 60_000, // 1m old → under the 6m stale window
      snapshotStaleMs: 6 * 60_000,
    };
    const r = await runLivenessAlarmTick('ws', deps);
    expect(computed).toBe(0); // warm cache used, no recompute
    expect(r.fired).toEqual([]);
  });

  it('(f) EI-9794: an unwired/failing readAutoloopFireRows never crashes the tick nor synthesizes a false alarm (fail-soft)', async () => {
    // No `readAutoloopFireRows` dep injected → the module's real
    // `defaultReadAutoloopFireRows` runs. Whether it fails-soft via its own
    // try/catch (a broken DB/import) or via the "no installSlug resolvable"
    // early-return, either path must degrade to [] — never throw, never fire
    // a false autoloop-fire-stale signal.
    const fresh = mkHealth({ evaluatedAt: 100 * 60_000 });
    const deps = {
      readLast: () => fresh,
      computeHealth: async () => fresh,
      escalate: async () => {},
      listOpen: async () => [],
      now: () => 100 * 60_000 + 60_000,
      snapshotStaleMs: 6 * 60_000,
    };
    const r = await runLivenessAlarmTick('ws', deps); // must not throw
    expect(r.fired.map((s) => s.key)).not.toContain('autoloop-fire-stale:kettle');
  });

  it('(f2) an explicitly-injected readAutoloopFireRows that throws still degrades to no fire-stale signal (never crashes the tick)', async () => {
    const fresh = mkHealth({ evaluatedAt: 100 * 60_000 });
    const deps = {
      readLast: () => fresh,
      computeHealth: async () => fresh,
      escalate: async () => {},
      listOpen: async () => [],
      now: () => 100 * 60_000 + 60_000,
      snapshotStaleMs: 6 * 60_000,
      readAutoloopFireRows: async () => {
        throw new Error('simulated DB read failure');
      },
    };
    const r = await runLivenessAlarmTick('ws', deps); // must not throw
    expect(r.fired.map((s) => s.key)).not.toContain('autoloop-fire-stale:kettle');
  });
});

describe('deriveSignatureFromSummary (legacy classifier)', () => {
  it('maps each known signal summary back to its signature', () => {
    expect(deriveSignatureFromSummary('[infra-liveness] system-health tick stale for 10m — ...')).toBe('health-tick-stale');
    expect(deriveSignatureFromSummary('[infra-liveness] 2 dead routine(s) overdue >10m: git-sync — the routine engine is starved.')).toBe('dead-routines');
    expect(deriveSignatureFromSummary('[infra-liveness] Queen loop dark (started, no live wake) — ...')).toBe('queen-dark');
    expect(deriveSignatureFromSummary('[infra-liveness] Overwatch supervisor loop dark — ...')).toBe('overwatch-dark');
    expect(deriveSignatureFromSummary('[infra-liveness] all 8 LLM pool account(s) paused — the fleet is rate-starved.')).toBe('accounts-starved');
    expect(deriveSignatureFromSummary('[infra-liveness] Bees / fleet: no bees running')).toBe('panel:bees');
    expect(deriveSignatureFromSummary('[infra-liveness] Work items: 500 items — 0 todo/0 in-flight — REAPER WEDGED')).toBe('panel:workItems');
  });

  it('(e) EI-9794: recovers the autoloop-fire-stale:<role> signature from a rendered summary', () => {
    expect(
      deriveSignatureFromSummary(
        "[infra-liveness] kettle@papercusp has not fired in 660m (expected every 600s, alarm threshold 3x) — last_status may still read 'ok' since that field only updates on a fire. The supervisor is likely dead; kettle:start to resume.",
      ),
    ).toBe('autoloop-fire-stale:kettle');
    // a different role name is captured, not hardcoded
    expect(deriveSignatureFromSummary('some-other-role@papercusp has not fired in 5m ...')).toBe(
      'autoloop-fire-stale:some-other-role',
    );
  });

  it('returns null for an unrecognizable summary (left untouched, never mis-resolved)', () => {
    expect(deriveSignatureFromSummary('some unrelated escalation')).toBeNull();
    expect(deriveSignatureFromSummary('')).toBeNull();
  });

  it('prefers an explicit livenessSignature over summary derivation', () => {
    const rec = { summary: 'totally unrelated text', livenessSignature: 'dead-routines' } as unknown as EscalationRecord;
    expect(livenessSignatureOf(rec)).toBe('dead-routines');
  });
});

describe('runLivenessAlarmTick — durable dedup + auto-resolve (EI-2146)', () => {
  beforeEach(() => _resetLivenessAlarmDebounce());

  /** A minimal in-memory escalation store mirroring the append-only open/resolve log. */
  function makeStore() {
    const opens: EscalationRecord[] = [];
    const resolvedIds = new Set<string>();
    let seq = 0;
    return {
      escalate: async (input: { severity: string; summary: string; meta?: Record<string, unknown> }) => {
        seq += 1;
        opens.push({
          ts: new Date(seq * 1000).toISOString(),
          msg_id: `esc-${seq}`,
          from: 'system:infra-liveness-alarm',
          to: ['human'],
          kind: 'escalation',
          severity: input.severity,
          summary: input.summary,
          resolved: null,
          ...(input.meta ?? {}),
        } as unknown as EscalationRecord);
      },
      listOpen: async (): Promise<EscalationRecord[]> => opens.filter((e) => !resolvedIds.has(e.msg_id)),
      resolve: async (msg_id: string) => { resolvedIds.add(msg_id); },
      openCount: () => opens.filter((e) => !resolvedIds.has(e.msg_id)).length,
    };
  }

  it('(a) a repeat firing of the same signature opens NO second escalation — even across a worker restart (durable, not just in-memory)', async () => {
    const store = makeStore();
    const sick = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } },
    });
    const deps = {
      readLast: () => sick,
      computeHealth: async () => sick,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      now: () => 100 * 60_000 + 60_000, // fresh snapshot (no stale signal)
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    };

    const first = await runLivenessAlarmTick('ws', deps);
    expect(first.fired.map((s) => s.key)).toEqual(['dead-routines']);
    expect(store.openCount()).toBe(1);

    // Simulate a request-worker RESTART: the in-memory debounce is wiped. The OLD
    // code re-fired here (the storm); durable dedup off the open log must still
    // collapse it — no second row.
    _resetLivenessAlarmDebounce();
    const second = await runLivenessAlarmTick('ws', deps);
    expect(second.fired).toEqual([]);
    expect(store.openCount()).toBe(1);
  });

  it('(b) a cleared condition auto-resolves its open escalation, then re-fires only after recovery', async () => {
    const store = makeStore();
    let healthy = false;
    const sick = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } },
    });
    const well = mkHealth({ evaluatedAt: 100 * 60_000 });
    let now = 100 * 60_000 + 60_000;
    const deps = {
      readLast: () => (healthy ? well : sick),
      computeHealth: async () => (healthy ? well : sick),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    };

    // Condition present → fires + opens one escalation.
    const t1 = await runLivenessAlarmTick('ws', deps);
    expect(t1.fired.map((s) => s.key)).toEqual(['dead-routines']);
    expect(store.openCount()).toBe(1);

    // Condition clears → auto-resolve drains the open escalation.
    healthy = true;
    now += 60_000;
    const t2 = await runLivenessAlarmTick('ws', deps);
    expect(t2.resolved.length).toBe(1);
    expect(store.openCount()).toBe(0);

    // Re-occurrence AFTER recovery fires fresh — within what WOULD have been the
    // in-memory debounce window, proving recovery cleared the cooldown.
    healthy = false;
    now += 60_000;
    const t3 = await runLivenessAlarmTick('ws', deps);
    expect(t3.fired.map((s) => s.key)).toEqual(['dead-routines']);
    expect(store.openCount()).toBe(1);
  });

  it('(pg) P-008: postmaster-start drift fires pg-restarted ONCE then auto-resolves; the first tick only seeds', async () => {
    const store = makeStore();
    let pmStart = 1_700_000_000_000;
    const mk = () =>
      mkHealth({
        evaluatedAt: 100 * 60_000,
        panels: { infra: { data: { pg: { postmasterStartMs: pmStart } } } },
      });
    let now = 100 * 60_000 + 60_000; // fresh snapshot (no stale signal)
    const deps = {
      readLast: () => mk(),
      computeHealth: async () => mk(),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    };

    // t1: first observation just seeds the baseline — a restart cannot be inferred
    // from one reading, so no signal (this is why a :3070 restart never false-fires).
    const t1 = await runLivenessAlarmTick('ws', deps);
    expect(t1.fired.map((s) => s.key)).not.toContain('pg-restarted');
    expect(store.openCount()).toBe(0);

    // t2: PG restarted (postmaster start-time jumps) → exactly one pg-restarted blocker.
    pmStart = 1_700_000_050_000;
    now += 60_000;
    const t2 = await runLivenessAlarmTick('ws', deps);
    expect(t2.fired.map((s) => s.key)).toContain('pg-restarted');
    expect(store.openCount()).toBe(1);

    // t3: start-time stable at the new value → the drift clears → auto-resolves (a
    // restart is an EVENT, not a stuck condition — one page, then the all-clear).
    now += 60_000;
    const t3 = await runLivenessAlarmTick('ws', deps);
    expect(t3.fired.map((s) => s.key)).not.toContain('pg-restarted');
    expect(t3.resolved.length).toBe(1);
    expect(store.openCount()).toBe(0);
  });

  it('one-time backlog sweep: a LEGACY open escalation (no signature meta) whose condition recovered is classified by summary and auto-resolved', async () => {
    const store = makeStore();
    // Seed a legacy "no bees running" blocker as the prior incident left it —
    // written WITHOUT a livenessSignature, classifiable only from its summary.
    await store.escalate({ severity: 'blocker', summary: '[infra-liveness] Bees / fleet: no bees running' });
    expect(store.openCount()).toBe(1);

    // The fleet is now idle-but-healthy (no bees, empty frontier) → no signal.
    const idle = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: {
        bees: { status: 'crit', summary: 'no bees running', data: { running: 0 } },
        workFeed: { data: { frontier: 0, deadRoutines: 0 } },
      },
    });
    const deps = {
      readLast: () => idle,
      computeHealth: async () => idle,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      now: () => 100 * 60_000 + 60_000,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    };

    const r = await runLivenessAlarmTick('ws', deps);
    expect(r.fired).toEqual([]);       // suppressed false positive — nothing new
    expect(r.resolved.length).toBe(1); // the legacy pile drains
    expect(store.openCount()).toBe(0);
  });

  it("WI-4181: a zombie 'open' whose resolve is a no-op (already_resolved) never re-broadcasts recovery", async () => {
    // The live storm: a fold-window zombie re-listed as open every tick;
    // resolveEscalation returned 'already_resolved' (no write, no throw), yet the
    // tick still pushed the sig into the recovery broadcast — 17 workers × every
    // ~2min for ~12h. The transition gate must swallow the no-op entirely.
    const zombie = {
      ts: new Date(1000).toISOString(),
      msg_id: 'esc-zombie',
      from: 'system:infra-liveness-alarm',
      to: ['human'],
      kind: 'escalation',
      severity: 'blocker',
      summary: '[infra-liveness] system-health tick stale for 7m — …',
      livenessSignature: 'health-tick-stale',
      resolved: null,
    } as unknown as EscalationRecord;
    const pageResolvedCalls: string[][] = [];
    const well = mkHealth({ evaluatedAt: 100 * 60_000 });
    const deps = {
      readLast: () => well,
      computeHealth: async () => well,
      escalate: async () => {},
      listOpen: async () => [zombie],
      resolve: async () => 'already_resolved' as const,
      pageResolved: async (sigs: string[]) => { pageResolvedCalls.push(sigs); },
      now: () => 100 * 60_000 + 60_000,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    };

    const t1 = await runLivenessAlarmTick('ws', deps);
    expect(t1.resolved).toEqual([]); // nothing actually transitioned
    // …and across repeated ticks (the storm shape) still not one broadcast.
    await runLivenessAlarmTick('ws', deps);
    await runLivenessAlarmTick('ws', deps);
    expect(pageResolvedCalls.flat()).toEqual([]);
  });

  it('WI-4181: a GENUINE blocker recovery broadcasts the all-clear exactly once — on the tick whose resolve actually transitioned the row', async () => {
    const store = makeStore();
    let healthy = false;
    const sick = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } },
    });
    const well = mkHealth({ evaluatedAt: 100 * 60_000 });
    const pageResolvedCalls: string[][] = [];
    let now = 100 * 60_000 + 60_000;
    const deps = {
      readLast: () => (healthy ? well : sick),
      computeHealth: async () => (healthy ? well : sick),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve, // returns undefined = a real write (transition)
      pageResolved: async (sigs: string[]) => { if (sigs.length) pageResolvedCalls.push(sigs); },
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    };

    await runLivenessAlarmTick('ws', deps); // fires the blocker
    healthy = true;
    now += 60_000;
    await runLivenessAlarmTick('ws', deps); // recovery tick — resolves + announces
    now += 60_000;
    await runLivenessAlarmTick('ws', deps); // steady-state healthy tick — silent
    expect(pageResolvedCalls).toEqual([['dead-routines']]);
  });
});
