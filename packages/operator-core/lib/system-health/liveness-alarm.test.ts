import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  evaluateLivenessAlarm,
  diagnoseHealthTickStall,
  runLivenessAlarmTick,
  deriveSignatureFromSummary,
  formatDeadRoutinesSummary,
  livenessSignatureOf,
  beesIdleByDesign,
  beesIdleDecision,
  describeBeesLiveness,
  beesLivenessFromHealth,
  unobservableLivenessSignatures,
  policySuppressedLivenessSignatures,
  resolveEvidenceFor,
  _resetLivenessAlarmDebounce,
  INFRA_LIVENESS_IDENTITY,
  type BeesIdleLeg,
  type BeesLivenessContext,
  type FlapState,
  type FlapMutationResult,
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

  it('EI-11841 attaches typed pool evidence and timing to a stale-tick signal', () => {
    const lastSnapshotAtMs = 1_000_000;
    const observedAtMs = lastSnapshotAtMs + 8 * 60_000;
    const diagnosis = diagnoseHealthTickStall(
      mkHealth({
        panels: {
          infra: { data: { pg: { total: 20, active: 20 }, pool: { probeMs: 4_500, band: 'critical' } } },
          workFeed: { data: { deadRoutines: 2, deadRoutineNames: ['git-sync', 'hive-wake'] } },
        },
      }),
      observedAtMs - lastSnapshotAtMs,
      observedAtMs,
      lastSnapshotAtMs,
    );
    expect(diagnosis.cause).toBe('pg-pool-starvation');
    expect(diagnosis.evidence[0]).toContain('pg acquire probe 4500ms');

    const signal = evaluateLivenessAlarm(mkHealth(), diagnosis.snapshotAgeMs, {
      snapshotStaleMs: 6 * 60_000,
      stallDiagnosis: diagnosis,
    }).find((s) => s.key === 'health-tick-stale');
    expect(signal?.diagnosis).toEqual(diagnosis);
    expect(signal?.summary).toContain('Root cause: pg-pool-starvation');
    expect(signal?.summary).toContain(new Date(lastSnapshotAtMs).toISOString());
    expect(signal?.summary).toContain(new Date(observedAtMs).toISOString());
  });

  it('EI-11841 labels a stale tick with no readable corroboration instead of guessing', () => {
    const diagnosis = diagnoseHealthTickStall(mkHealth(), 8 * 60_000, 2_000_000, 1_520_000);
    expect(diagnosis.cause).toBe('unattributed-stale-tick');
    expect(diagnosis.evidence).toEqual(['no corroborating pool, loop, routine, or PG evidence was readable']);
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

  it('complete D-026 cut + restore evidence reframes overdue routines as a distinct advisory', () => {
    const h = mkHealth({
      panels: {
        workFeed: {
          data: {
            deadRoutines: 2,
            deadRoutinesInScope: 151,
            deadRoutinesDistinct: 1,
            deadRoutineNames: ['git-sync'],
          },
        },
      },
    });
    const signal = evaluateLivenessAlarm(h, null, {
      d026Quiescence: { cutActive: true, restoreActive: true },
    }).find((s) => s.key === 'dead-routines-quiesced');

    expect(signal?.severity).toBe('advisory');
    expect(signal?.summary).toContain('expected D-026 quiescence');
    expect(signal?.summary).toContain('2 of 151 overdue routine(s)');
    expect(signal?.summary).toContain('Do NOT start or restart bg-host');
    expect(signal?.summary).not.toContain('dead routine(s)');
    expect(signal?.summary).toBeDefined();
    expect(deriveSignatureFromSummary(signal?.summary ?? '')).toBe('dead-routines-quiesced');
  });

  it.each([
    ['missing', undefined],
    ['cut only', { cutActive: true, restoreActive: false }],
    ['restore only', { cutActive: false, restoreActive: true }],
  ])('incomplete D-026 evidence (%s) preserves the dead-routines blocker', (_label, d026Quiescence) => {
    const h = mkHealth({ panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } } });
    const signals = evaluateLivenessAlarm(h, null, { d026Quiescence });

    expect(signals.find((s) => s.key === 'dead-routines')?.severity).toBe('blocker');
    expect(signals.map((s) => s.key)).not.toContain('dead-routines-quiesced');
  });

  // WI-5839 / EI-18654017982759582 items 2+3: stale-paused routines.
  it('a stale-paused release-critical routine → stale-paused-routines BLOCKER', () => {
    const h = mkHealth({
      panels: {
        workFeed: {
          data: {
            deadRoutines: 0,
            stalePausedRoutines: 1,
            stalePausedRoutineNames: ['release-trigger'],
            stalePausedCriticalRoutines: 1,
          },
        },
      },
    });
    const sigs = evaluateLivenessAlarm(h, null);
    const sp = sigs.find((s) => s.key === 'stale-paused-routines');
    expect(sp?.severity).toBe('blocker');
    expect(sp?.summary).toContain('release-trigger');
    expect(sp?.summary).toContain('deploy pipeline');
  });

  it('a stale-paused NON-critical routine → stale-paused-routines ADVISORY (not fleet-blocking)', () => {
    const h = mkHealth({
      panels: {
        workFeed: {
          data: {
            deadRoutines: 0,
            stalePausedRoutines: 1,
            stalePausedRoutineNames: ['scout-cycle'],
            stalePausedCriticalRoutines: 0,
          },
        },
      },
    });
    const sigs = evaluateLivenessAlarm(h, null);
    const sp = sigs.find((s) => s.key === 'stale-paused-routines');
    expect(sp?.severity).toBe('advisory');
    expect(sp?.summary).toContain('scout-cycle');
  });

  // EI-18718973731535914: `stalePausedRoutineNames` is sorted critical-first, so the
  // top-4 slice used to bleed non-critical names (e.g. a decommissioned routine's
  // repeated rows) into a message framed around release/deploy-critical routines —
  // reading as if 4 critical routines were paused when only 1 actually was.
  it('a critical stale-paused routine sitting alongside non-critical ones → message names ONLY the critical routine(s)', () => {
    const h = mkHealth({
      panels: {
        workFeed: {
          data: {
            deadRoutines: 0,
            stalePausedRoutines: 4,
            // Sorted critical-first (as computeStalePausedRoutines returns): 1 real
            // critical pause, followed by 3 non-critical (e.g. decommissioned) rows.
            stalePausedRoutineNames: ['green-checkpoint', 'hive-wake', 'hive-wake', 'hive-wake'],
            stalePausedCriticalRoutines: 1,
          },
        },
      },
    });
    const sigs = evaluateLivenessAlarm(h, null);
    const sp = sigs.find((s) => s.key === 'stale-paused-routines');
    expect(sp?.severity).toBe('blocker');
    expect(sp?.summary).toContain('green-checkpoint');
    expect(sp?.summary).not.toContain('hive-wake');
    expect(sp?.summary).toMatch(/^1 release\/deploy-critical/);
  });

  it('no stale-paused routines → no stale-paused-routines signal', () => {
    const h = mkHealth({ panels: { workFeed: { data: { deadRoutines: 0, stalePausedRoutines: 0 } } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('stale-paused-routines');
  });

  it('deriveSignatureFromSummary classifies a legacy stale-paused-routines summary', () => {
    expect(
      deriveSignatureFromSummary('1 release/deploy-critical routine(s) on a stale/unexplained pause: release-trigger — the deploy pipeline may be silently stopped.'),
    ).toBe('stale-paused-routines');
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

  it('EI-21169582379092366: a fresh health tick suppresses accounts-starved when its pool projection is stale', () => {
    const h = mkHealth({
      panels: {
        tokens: {
          data: {
            accountsTotal: 12,
            accountsAvailable: 0,
            spendUsd: 1,
            poolProjectionFreshestAgeMs: 31 * 60_000,
          },
        },
      },
    });
    const keys = evaluateLivenessAlarm(h, 60_000, { snapshotStaleMs: 6 * 60_000 }).map((s) => s.key);
    expect(keys).not.toContain('accounts-starved');
    expect(keys).not.toContain('health-tick-stale');
  });

  it('EI-21169582379092366: a fresh pool projection still supports accounts-starved', () => {
    const h = mkHealth({
      panels: {
        tokens: {
          data: {
            accountsTotal: 12,
            accountsAvailable: 0,
            spendUsd: 1,
            poolProjectionFreshestAgeMs: 29 * 60_000,
          },
        },
      },
    });
    expect(evaluateLivenessAlarm(h, 60_000, { snapshotStaleMs: 6 * 60_000 }).map((s) => s.key))
      .toContain('accounts-starved');
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

// EI-15006: the panel:bees "no bees running" gate must distinguish idle-by-design
// (no cup-placeable frontier + healthy capacity + other agents alive ⇒ NO
// blocker→human page) from genuine starvation (cup work waiting, or the spawner
// provably down). The raw `frontier === 0` gate got BOTH directions wrong: it
// false-paged during idle (frontier carried su-domain/stuck residue) AND
// false-SILENCED a real spawner-down when the frontier happened to read empty.
describe('EI-15006: panel:bees idle-by-design gate', () => {
  const healthy: BeesLivenessContext = {
    cupPlaceableFrontier: 0,
    frontierUnreadable: false,
    dispatchBudget: 20,
    restartRecovering: false,
    otherAgentsAlive: true,
  };
  const noBeesCrit = (over: Record<string, unknown> = {}) =>
    mkHealth({
      panels: {
        bees: { status: 'crit', summary: 'no bees running', data: { running: 0, alive: 0 } },
        workFeed: { data: { frontier: 0, frontierStuck: 0, deadRoutines: 0 } },
        ...over,
      },
    });

  describe('beesIdleByDesign (pure)', () => {
    it('(1) no cup work + capacity healthy + other agents alive → idle by design (no page)', () => {
      expect(beesIdleByDesign(healthy)).toBe(true);
    });
    it('(2) cup-placeable frontier > 0 → NOT idle (genuine starvation, page)', () => {
      expect(beesIdleByDesign({ ...healthy, cupPlaceableFrontier: 3 })).toBe(false);
    });
    it('(3a) gateway restart-recovering → NOT idle (capacity unproven, page)', () => {
      expect(beesIdleByDesign({ ...healthy, restartRecovering: true })).toBe(false);
    });
    it('(3b) no other agents alive → NOT idle (spawner not provably live, page)', () => {
      expect(beesIdleByDesign({ ...healthy, otherAgentsAlive: false })).toBe(false);
    });
    it('(3c) cup tier KNOWN-full (dispatchBudget 0) while 0 bees run → NOT idle (page)', () => {
      expect(beesIdleByDesign({ ...healthy, dispatchBudget: 0 })).toBe(false);
    });
    it('fail-safe: unknown capacity (dispatchBudget null) does NOT force a page — other-agents-alive carries it', () => {
      expect(beesIdleByDesign({ ...healthy, dispatchBudget: null })).toBe(true);
    });
  });

  // EI-19474857043229377 — the boolean alone made a flapping gate undiagnosable after the
  // fact: every leg is a transient nothing persists, so diagnosing ONE burst cost four
  // wakes of live elimination and still ran out of window. The leg must travel with the
  // verdict.
  describe('beesIdleDecision — leg attribution', () => {
    const cases: ReadonlyArray<[string, Partial<typeof healthy>, boolean, BeesIdleLeg]> = [
      ['healthy idle', {}, true, 'idle-by-design'],
      ['cup work waiting', { cupPlaceableFrontier: 3 }, false, 'cup-work-waiting'],
      ['gateway restarting', { restartRecovering: true }, false, 'gateway-restart-recovering'],
      ['no other agent alive', { otherAgentsAlive: false }, false, 'no-other-agent-alive'],
      ['cup tier known-full', { dispatchBudget: 0 }, false, 'dispatch-budget-exhausted'],
      ['unknown capacity is not exhaustion', { dispatchBudget: null }, true, 'idle-by-design'],
      ['survey unreadable', { frontierUnreadable: true }, false, 'frontier-unreadable'],
    ];

    for (const [name, over, idle, leg] of cases) {
      it(`${name} → idle=${idle}, leg=${leg}`, () => {
        expect(beesIdleDecision({ ...healthy, ...over })).toEqual({ idle, leg });
      });
    }

    it('COMPLETENESS: every declared leg is reachable — a new leg cannot ship untested', () => {
      const reached = new Set(cases.map(([, over]) => beesIdleDecision({ ...healthy, ...over }).leg));
      // Mirrors the BeesIdleLeg union. Adding a leg without a case above fails here.
      const declared: BeesIdleLeg[] = [
        'frontier-unreadable',
        'cup-work-waiting',
        'gateway-restart-recovering',
        'no-other-agent-alive',
        'dispatch-budget-exhausted',
        'idle-by-design',
      ];
      expect([...reached].sort()).toEqual([...declared].sort());
    });

    it('DRIFT GUARD: beesIdleByDesign is exactly `leg === idle-by-design` across the matrix', () => {
      for (const cupPlaceableFrontier of [0, 3]) {
        for (const frontierUnreadable of [false, true]) {
          for (const restartRecovering of [false, true]) {
            for (const otherAgentsAlive of [true, false]) {
              for (const dispatchBudget of [15, 0, null]) {
                const ctx = {
                  cupPlaceableFrontier, frontierUnreadable, restartRecovering, otherAgentsAlive, dispatchBudget,
                };
                const d = beesIdleDecision(ctx);
                expect(beesIdleByDesign(ctx)).toBe(d.idle);
                expect(d.idle).toBe(d.leg === 'idle-by-design');
                // FAIL-SAFE INVARIANT: an unreadable survey can never yield idle, under ANY
                // combination of the other legs. This is the whole point of the flag —
                // "unreadable" must never buy silence about zero running bees.
                if (frontierUnreadable) expect(d.idle).toBe(false);
              }
            }
          }
        }
      }
    });

    it('reports the FIRST failing leg when several fail (precedence is stable)', () => {
      expect(
        beesIdleDecision({ ...healthy, cupPlaceableFrontier: 3, restartRecovering: true, otherAgentsAlive: false }).leg,
      ).toBe('cup-work-waiting');
    });

    // The attribution point, not a behaviour point: a fabricated 0 falls through the
    // cup-work-waiting branch anyway, so only the LEG NAME distinguishes "no cup work
    // waiting" from "we could not read whether cup work is waiting".
    it('an unreadable survey outranks every other leg — the note must not blame a downstream one', () => {
      expect(
        beesIdleDecision({
          ...healthy, frontierUnreadable: true, cupPlaceableFrontier: 3,
          restartRecovering: true, otherAgentsAlive: false, dispatchBudget: 0,
        }).leg,
      ).toBe('frontier-unreadable');
    });

    it('renders an unreadable frontier as `unreadable`, never as the fabricated 0', () => {
      const s = describeBeesLiveness({ ...healthy, frontierUnreadable: true });
      expect(s).toContain('cupPlaceableFrontier=unreadable');
      expect(s).not.toContain('cupPlaceableFrontier=0');
      expect(s).toContain('frontier-unreadable');
    });

    it('describeBeesLiveness carries every raw leg value plus the verdict', () => {
      const s = describeBeesLiveness({ ...healthy, dispatchBudget: 0 });
      expect(s).toContain('cupPlaceableFrontier=0');
      expect(s).toContain('dispatchBudget=0');
      expect(s).toContain('restartRecovering=false');
      expect(s).toContain('otherAgentsAlive=true');
      expect(s).toContain('dispatch-budget-exhausted');
    });

    it('renders an UNKNOWN dispatchBudget as unknown, never as 0 (opposite sides of the gate)', () => {
      expect(describeBeesLiveness({ ...healthy, dispatchBudget: null })).toContain('dispatchBudget=unknown');
    });
  });

  describe('beesLivenessFromHealth — unreadable survey (unreadable ≠ clear, on the DECIDING leg)', () => {
    const cap = { dispatchBudget: 15, restartRecovering: false };

    it('propagates WorkFeedHealth.frontierUnreadable', () => {
      const h = mkHealth({
        panels: {
          workFeed: { data: { frontier: 0, frontierStuck: 0, deadRoutines: 0, frontierUnreadable: true } },
          suFleet: { data: { live: 9 } },
        },
      });
      expect(beesLivenessFromHealth(h, cap).frontierUnreadable).toBe(true);
      expect(beesIdleDecision(beesLivenessFromHealth(h, cap))).toEqual({ idle: false, leg: 'frontier-unreadable' });
    });

    it('an OBSERVED empty frontier still suppresses — the flag must not blanket-disarm the gate', () => {
      const h = mkHealth({
        panels: {
          workFeed: { data: { frontier: 0, frontierStuck: 0, deadRoutines: 0 } },
          suFleet: { data: { live: 9 } },
        },
      });
      expect(beesLivenessFromHealth(h, cap).frontierUnreadable).toBe(false);
      expect(beesIdleDecision(beesLivenessFromHealth(h, cap))).toEqual({ idle: true, leg: 'idle-by-design' });
    });

    // THE DELIBERATE BOUNDARY, pinned so a later reader does not "complete" the fix by
    // widening it. A missing workFeed panel fabricates the same 0, but is NOT treated as
    // unreadable: no such snapshot has been observed in production (collectWorkFeed is
    // panelSafe-wrapped), and treating it so un-suppresses panel:bees for every caller
    // whose snapshot lacks the panel — measurably, the policy-suppressed benign row at
    // "THE DEFECT: a policy-suppressed close does NOT claim the condition recovered"
    // stops draining. The flag covers the case that actually happens.
    it('a MISSING workFeed panel is NOT inferred as unreadable (scoped to the flag, on purpose)', () => {
      const h = mkHealth({ panels: { suFleet: { data: { live: 9 } } } });
      expect(beesLivenessFromHealth(h, cap).frontierUnreadable).toBe(false);
      expect(beesIdleByDesign(beesLivenessFromHealth(h, cap))).toBe(true);
    });
  });

  describe('beesLivenessFromHealth (pure derivation)', () => {
    it('cup-placeable frontier = frontier − frontierStuck; other-agents-alive from su fleet', () => {
      const h = mkHealth({
        crossMonitor: { queenAlive: false },
        panels: {
          workFeed: { data: { frontier: 5, frontierStuck: 2, deadRoutines: 0 } },
          suFleet: { data: { live: 9 } },
          bees: { data: { running: 0, alive: 0 } },
        },
      });
      const ctx = beesLivenessFromHealth(h, { dispatchBudget: 20, restartRecovering: false });
      expect(ctx.cupPlaceableFrontier).toBe(3);
      expect(ctx.otherAgentsAlive).toBe(true);
      expect(ctx.dispatchBudget).toBe(20);
    });
    it('other-agents-alive false when su fleet + other bees empty AND the Mug loop is dark', () => {
      const h = mkHealth({
        crossMonitor: { queenAlive: false },
        panels: {
          workFeed: { data: { frontier: 0, deadRoutines: 0 } },
          suFleet: { data: { live: 0 } },
          bees: { data: { running: 0, alive: 0 } },
        },
      });
      expect(beesLivenessFromHealth(h, { dispatchBudget: 20, restartRecovering: false }).otherAgentsAlive).toBe(false);
    });
  });

  describe('evaluateLivenessAlarm with the threaded context', () => {
    it('(1) 0 bees + no cup work + healthy capacity → does NOT open panel:bees', () => {
      const sigs = evaluateLivenessAlarm(noBeesCrit(), null, { beesLiveness: healthy });
      expect(sigs.map((s) => s.key)).not.toContain('panel:bees');
    });
    it('(2) 0 bees + ready cup-placeable work → DOES open panel:bees (blocker)', () => {
      const sigs = evaluateLivenessAlarm(noBeesCrit(), null, {
        beesLiveness: { ...healthy, cupPlaceableFrontier: 4 },
      });
      const bees = sigs.find((s) => s.key === 'panel:bees');
      expect(bees).toBeDefined();
      expect(bees?.severity).toBe('blocker');
    });
    it('(3) 0 bees + gateway restart-recovering (spawner not proven live) → DOES open panel:bees', () => {
      const sigs = evaluateLivenessAlarm(noBeesCrit(), null, {
        beesLiveness: { ...healthy, restartRecovering: true },
      });
      expect(sigs.map((s) => s.key)).toContain('panel:bees');
    });
    it('(3) 0 bees + no other agents alive (spawner provably down) → DOES open panel:bees', () => {
      const sigs = evaluateLivenessAlarm(noBeesCrit(), null, {
        beesLiveness: { ...healthy, otherAgentsAlive: false },
      });
      expect(sigs.map((s) => s.key)).toContain('panel:bees');
    });
    it('a bees crit with bees STILL running (e.g. a cursed placement) is never gated', () => {
      const h = mkHealth({
        panels: {
          bees: { status: 'crit', summary: '2 bee(s), 1 cursed', data: { running: 2, alive: 2 } },
          workFeed: { data: { frontier: 0, deadRoutines: 0 } },
        },
      });
      // Even with an "idle" context, a running-bees crit still surfaces.
      expect(evaluateLivenessAlarm(h, null, { beesLiveness: healthy }).map((s) => s.key)).toContain('panel:bees');
    });
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

  it('request-worker shared-snapshot hit drives recovery without any computeSystemHealth fallback', async () => {
    const now = 100 * 60_000;
    const fresh = mkHealth({ evaluatedAt: now });
    const readSharedHealth = vi.fn(async () => fresh);
    const computeHealth = vi.fn(async () => fresh);
    const resolve = vi.fn(async () => undefined);
    const openRec = {
      msg_id: 'shared-open',
      severity: 'blocker',
      summary: '[infra-liveness] dead routines',
      from: INFRA_LIVENESS_IDENTITY.ownerId,
      livenessSignature: 'dead-routines',
    } as unknown as EscalationRecord;

    const result = await runLivenessAlarmTick('ws', {
      readLast: () => mkHealth({ evaluatedAt: 0 }),
      readSharedHealth,
      computeHealth,
      listOpen: async () => [openRec],
      resolve,
      escalate: async () => {},
      readAutoloopFireRows: async () => [],
      readBeeCapacity: async () => ({ dispatchBudget: null, restartRecovering: false }),
      now: () => now,
    });

    expect(readSharedHealth).toHaveBeenCalledTimes(2); // initial read + recovery re-check
    expect(computeHealth).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledOnce();
    expect(result.resolved).toEqual(['shared-open']);
  });

  it('request-worker shared-snapshot miss is unknown/no-op and never computes or reconciles', async () => {
    const readSharedHealth = vi.fn(async () => null);
    const computeHealth = vi.fn(async () => mkHealth());
    const listOpen = vi.fn(async () => [] as EscalationRecord[]);

    const result = await runLivenessAlarmTick('ws', {
      readLast: () => mkHealth({ evaluatedAt: 0 }),
      readSharedHealth,
      computeHealth,
      listOpen,
      now: () => 100 * 60_000,
    });

    expect(result).toEqual({ fired: [], signals: [], resolved: [] });
    expect(readSharedHealth).toHaveBeenCalledOnce();
    expect(computeHealth).not.toHaveBeenCalled();
    expect(listOpen).not.toHaveBeenCalled();
  });

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
    // stale cache triggers recompute, fresh snapshot shows dead-routines. The fresh
    // snapshot is NOT reported as stale (WI-4878 fix: snapshotAgeMs = null when fresh),
    // so health-tick-stale does NOT fire — the fresh data is actually fresh, not stale.
    expect(first.fired.map((s) => s.key).sort()).toEqual(['dead-routines']);
    expect(escalate.calls.length).toBe(1);
    expect(escalate.calls[0].summary).toContain('[infra-liveness]');

    // Same signals within the debounce window → no new escalations.
    now += 5 * 60_000;
    const second = await runLivenessAlarmTick('ws', deps);
    expect(second.fired).toEqual([]);
    expect(escalate.calls.length).toBe(1);

    // Past the debounce window → fires again.
    now += 30 * 60_000;
    const third = await runLivenessAlarmTick('ws', deps);
    expect(third.fired.length).toBe(1);
    expect(escalate.calls.length).toBe(2);
  });

  it('WI-4773: a stale request-worker cache does not page while the shared bg-host heartbeat is fresh', async () => {
    const stale = mkHealth({ evaluatedAt: 0 });
    const fresh = mkHealth({ evaluatedAt: 100 * 60_000 });
    const now = 100 * 60_000;
    const r = await runLivenessAlarmTick('ws', {
      readLast: () => stale,
      computeHealth: async () => fresh,
      readRoutineEngineLiveness: async () => ({
        stale: false,
        unknown: false,
        lastTickMs: now - 19_000,
        staleMs: 19_000,
      }),
      escalate: async () => {},
      listOpen: async () => [],
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
    });

    expect(r.signals.map((s) => s.key)).not.toContain('health-tick-stale');
    expect(r.fired).toEqual([]);
  });

  it('WI-4773: a stale shared bg-host heartbeat pages even when the request-worker cache is fresh', async () => {
    const now = 100 * 60_000;
    const fresh = mkHealth({ evaluatedAt: now - 30_000 });
    const r = await runLivenessAlarmTick('ws', {
      readLast: () => fresh,
      computeHealth: async () => fresh,
      readRoutineEngineLiveness: async () => ({
        stale: true,
        unknown: false,
        lastTickMs: now - 10 * 60_000,
        staleMs: 10 * 60_000,
      }),
      escalate: async () => {},
      listOpen: async () => [],
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
    });

    const signal = r.signals.find((s) => s.key === 'health-tick-stale');
    expect(signal?.severity).toBe('blocker');
    expect(signal?.diagnosis?.lastSnapshotAtMs).toBe(now - 10 * 60_000);
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

describe('runLivenessAlarmTick — EI-19375157952766991: fresh re-verify before dead-routines fires', () => {
  beforeEach(() => _resetLivenessAlarmDebounce());

  const fresh = mkHealth({
    evaluatedAt: 100 * 60_000,
    panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } },
  });
  const baseDeps = {
    readLast: () => fresh,
    computeHealth: async () => fresh,
    listOpen: async () => [],
    now: () => 100 * 60_000 + 60_000, // 1m old → under the 6m stale window (uses cache as-is)
    snapshotStaleMs: 6 * 60_000,
  };

  it('a confirmed-empty fresh re-read suppresses the fire — no escalate, no page (the measured incident)', async () => {
    const escalateCalls: unknown[] = [];
    const pageCalls: string[] = [];
    const r = await runLivenessAlarmTick('ws', {
      ...baseDeps,
      escalate: async (input) => { escalateCalls.push(input); },
      page: async (s) => { pageCalls.push(s.key); },
      reverifyDeadRoutines: async () => [], // fresh direct read: already cleared
    });
    expect(r.fired).toEqual([]);
    expect(escalateCalls).toEqual([]);
    expect(pageCalls).toEqual([]);
  });

  it('a fresh re-read that still shows dead routines fires normally (a genuine incident is unaffected)', async () => {
    const escalateCalls: unknown[] = [];
    const pageCalls: string[] = [];
    const r = await runLivenessAlarmTick('ws', {
      ...baseDeps,
      escalate: async (input) => { escalateCalls.push(input); },
      page: async (s) => { pageCalls.push(s.key); },
      reverifyDeadRoutines: async () => ['git-sync'], // still overdue on the fresh read
    });
    expect(r.fired.map((s) => s.key)).toEqual(['dead-routines']);
    expect(escalateCalls.length).toBe(1);
    expect(pageCalls).toEqual(['dead-routines']);
  });

  it('a re-verify FAILURE (null / unknown) is fail-open — it fires as if no re-verify were wired', async () => {
    const r1 = await runLivenessAlarmTick('ws', {
      ...baseDeps,
      escalate: async () => {},
      reverifyDeadRoutines: async () => null,
    });
    expect(r1.fired.map((s) => s.key)).toEqual(['dead-routines']);

    _resetLivenessAlarmDebounce();
    const r2 = await runLivenessAlarmTick('ws', {
      ...baseDeps,
      escalate: async () => {},
      reverifyDeadRoutines: async () => { throw new Error('simulated PG failure'); },
    });
    expect(r2.fired.map((s) => s.key)).toEqual(['dead-routines']);
  });

  it('no reverifyDeadRoutines dep injected (deps.readLast set, as every other hermetic test does) → behaves byte-identically to before this fix', async () => {
    // Production gating: reverifyDeadRoutines defaults to null whenever `readLast`
    // is injected (the test/hermetic seam), so every PRE-EXISTING test in this file
    // (which all inject readLast) is provably unaffected by this change.
    const r = await runLivenessAlarmTick('ws', { ...baseDeps, escalate: async () => {} });
    expect(r.fired.map((s) => s.key)).toEqual(['dead-routines']);
  });

  it('does not re-verify a signal that already has an open escalation (dedup short-circuits first)', async () => {
    let reverifyCalls = 0;
    const openRec = { msg_id: 'm1', severity: 'blocker', summary: '[infra-liveness] dead', from: INFRA_LIVENESS_IDENTITY.ownerId, livenessSignature: 'dead-routines' } as unknown as EscalationRecord;
    const r = await runLivenessAlarmTick('ws', {
      ...baseDeps,
      listOpen: async () => [openRec],
      escalate: async () => {},
      reverifyDeadRoutines: async () => { reverifyCalls++; return []; },
    });
    expect(reverifyCalls).toBe(0); // openBySig short-circuits before reverify is ever consulted
    expect(r.fired).toEqual([]);
  });
});

describe('runLivenessAlarmTick — EI-9939 flap-episode suppression', () => {
  beforeEach(() => _resetLivenessAlarmDebounce());

  /** Same minimal in-memory escalation store as the EI-2146 suite below. */
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

  it('fires 1 and 2 within the flap window page normally (byte-identical to pre-EI-9939 behavior)', async () => {
    const store = makeStore();
    let healthy = false;
    const sick = mkHealth({ evaluatedAt: 100 * 60_000, panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } } });
    const well = mkHealth({ evaluatedAt: 100 * 60_000 });
    const pageCalls: string[] = [];
    let now = 100 * 60_000;
    const deps = {
      readLast: () => (healthy ? well : sick),
      computeHealth: async () => (healthy ? well : sick),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      page: async (s: { key: string }) => { pageCalls.push(s.key); },
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 1_000, // short so re-fires aren't blocked by the escalation debounce itself
      flapWindowMs: 30 * 60_000,
      flapThreshold: 2,
    };

    await runLivenessAlarmTick('ws', deps); // fire #1 — pages
    healthy = true; now += 2_000; await runLivenessAlarmTick('ws', deps); // resolves
    healthy = false; now += 2_000; await runLivenessAlarmTick('ws', deps); // fire #2 — still within threshold, pages
    expect(pageCalls).toEqual(['dead-routines', 'dead-routines']);
  });

  it('the 3rd+ fire within the flap window is SUPPRESSED (no page()) but still opens a durable escalation', async () => {
    const store = makeStore();
    let healthy = false;
    const sick = mkHealth({ evaluatedAt: 100 * 60_000, panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } } });
    const well = mkHealth({ evaluatedAt: 100 * 60_000 });
    const pageCalls: string[] = [];
    let now = 100 * 60_000;
    const deps = {
      readLast: () => (healthy ? well : sick),
      computeHealth: async () => (healthy ? well : sick),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      page: async (s: { key: string }) => { pageCalls.push(s.key); },
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 1_000,
      flapWindowMs: 30 * 60_000,
      flapThreshold: 2,
    };

    for (let i = 0; i < 3; i++) {
      healthy = false; now += 2_000; await runLivenessAlarmTick('ws', deps); // fire
      healthy = true; now += 2_000; await runLivenessAlarmTick('ws', deps); // resolve
    }
    // 3 fire/resolve cycles → fires 1,2 page; fire 3 is the flap, suppressed.
    expect(pageCalls).toEqual(['dead-routines', 'dead-routines']);
    // The durable escalation path is COMPLETELY unaffected — every fire still
    // opened + auto-resolved its escalation row (audit trail intact).
    expect(store.openCount()).toBe(0);
  });

  it('a suppressed flapping signature is NOT resolved-broadcast on every micro-recovery (no pageResolved storm)', async () => {
    const store = makeStore();
    let healthy = false;
    const sick = mkHealth({ evaluatedAt: 100 * 60_000, panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } } });
    const well = mkHealth({ evaluatedAt: 100 * 60_000 });
    const pageResolvedCalls: string[][] = [];
    let now = 100 * 60_000;
    const deps = {
      readLast: () => (healthy ? well : sick),
      computeHealth: async () => (healthy ? well : sick),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      page: async () => {},
      pageResolved: async (sigs: string[]) => { if (sigs.length) pageResolvedCalls.push(sigs); },
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 1_000,
      flapWindowMs: 30 * 60_000,
      flapThreshold: 2,
    };

    // Cycle through 5 fire/resolve pairs — only the first 2 recoveries are
    // non-flapping (fireCount ≤ threshold at the time they resolve, so they
    // broadcast immediately exactly like today); the 3rd-5th are
    // flap-suppressed (deferred, never broadcast individually).
    for (let i = 0; i < 5; i++) {
      healthy = false; now += 2_000; await runLivenessAlarmTick('ws', deps);
      healthy = true; now += 2_000; await runLivenessAlarmTick('ws', deps);
    }
    // Exactly 2 immediate resolved-broadcasts (fires/resolves #1 and #2, both
    // ≤ threshold) — the 3 later flap-cycle recoveries are all deferred, so
    // this is 3 fewer broadcasts than the pre-EI-9939 storm (5) would send.
    expect(pageResolvedCalls.length).toBe(2);
  });

  it('a settled flapping signature (quiet for a FULL flap window, no re-fire) gets exactly one final all-clear', async () => {
    const store = makeStore();
    let healthy = false;
    const sick = mkHealth({ evaluatedAt: 100 * 60_000, panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } } });
    const well = mkHealth({ evaluatedAt: 100 * 60_000 });
    const pageResolvedCalls: string[][] = [];
    let now = 100 * 60_000;
    const flapWindowMs = 30 * 60_000;
    const deps = {
      readLast: () => (healthy ? well : sick),
      computeHealth: async () => (healthy ? well : sick),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      page: async () => {},
      pageResolved: async (sigs: string[]) => { if (sigs.length) pageResolvedCalls.push(sigs); },
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 1_000,
      flapWindowMs,
      flapThreshold: 2,
    };

    // Drive it into flapping (3 fire/resolve cycles, well inside the window).
    for (let i = 0; i < 3; i++) {
      healthy = false; now += 2_000; await runLivenessAlarmTick('ws', deps);
      healthy = true; now += 2_000; await runLivenessAlarmTick('ws', deps);
    }
    pageResolvedCalls.length = 0; // only care about what happens from here

    // Stay healthy and let enough time pass for the settle sweep to fire —
    // ticks continue (as the real 2min-interval loop would) but the condition
    // never re-fires.
    now += flapWindowMs + 60_000;
    const settled = await runLivenessAlarmTick('ws', deps);
    expect(settled.resolved).toEqual([]); // nothing NEW to durably resolve this tick
    expect(pageResolvedCalls).toEqual([['dead-routines']]); // exactly one final all-clear

    // And a FRESH re-occurrence after settling is treated as a first fire again.
    const pageCalls: string[] = [];
    (deps as unknown as { page: (s: { key: string }) => Promise<void> }).page = async (s) => { pageCalls.push(s.key); };
    healthy = false; now += 60_000;
    await runLivenessAlarmTick('ws', deps);
    expect(pageCalls).toEqual(['dead-routines']);
  });

  it('re-firing before the settle window elapses defers the all-clear further (no premature all-clear)', async () => {
    const store = makeStore();
    let healthy = false;
    const sick = mkHealth({ evaluatedAt: 100 * 60_000, panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } } });
    const well = mkHealth({ evaluatedAt: 100 * 60_000 });
    const pageResolvedCalls: string[][] = [];
    let now = 100 * 60_000;
    const flapWindowMs = 30 * 60_000;
    const deps = {
      readLast: () => (healthy ? well : sick),
      computeHealth: async () => (healthy ? well : sick),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      page: async () => {},
      pageResolved: async (sigs: string[]) => { if (sigs.length) pageResolvedCalls.push(sigs); },
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 1_000,
      flapWindowMs,
      flapThreshold: 2,
    };

    for (let i = 0; i < 3; i++) {
      healthy = false; now += 2_000; await runLivenessAlarmTick('ws', deps);
      healthy = true; now += 2_000; await runLivenessAlarmTick('ws', deps);
    }
    pageResolvedCalls.length = 0;

    // Almost settled — but re-fires just short of the settle window.
    now += flapWindowMs - 5_000;
    healthy = false;
    await runLivenessAlarmTick('ws', deps); // re-fire cancels the pending settle
    healthy = true; now += 2_000;
    await runLivenessAlarmTick('ws', deps); // resolves again (still flapping → deferred)
    expect(pageResolvedCalls).toEqual([]); // no premature all-clear fired
  });

  it('EI-15126: flap suppression engages across independent "workers" sharing one durable store (the production shape)', async () => {
    // Reproduces the actual production topology: multiple :3070 cluster
    // REQUEST WORKERS each run their own runLivenessAlarmTick loop, so the
    // worker that happens to observe fire #1 is rarely the same one that
    // observes fire #2 or #3. Simulated here as two alternating "workers" —
    // each with its OWN store/page arrays — that read+write the SAME
    // injected readFlapState/writeFlapState backing (a plain object standing
    // in for the migration-635 PG row). Before the EI-15126 fix this shared
    // backing didn't exist — each worker's flap counter was a private
    // module-level Map — so alternating workers would NEVER accumulate past
    // flapThreshold and every fire would page.
    const store = makeStore();
    let healthy = false;
    const sick = mkHealth({ evaluatedAt: 100 * 60_000, panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } } });
    const well = mkHealth({ evaluatedAt: 100 * 60_000 });
    const pageCalls: string[] = [];
    let now = 100 * 60_000;
    let sharedFlapBacking: Record<string, unknown> = {};
    const baseDeps = {
      readLast: () => (healthy ? well : sick),
      computeHealth: async () => (healthy ? well : sick),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      page: async (s: { key: string }) => { pageCalls.push(s.key); },
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 1_000,
      flapWindowMs: 30 * 60_000,
      flapThreshold: 2,
      // The shared backing store every "worker" reads and writes — standing
      // in for the durable PG row (migration 635) production actually uses.
      readFlapState: async () => sharedFlapBacking as never,
      writeFlapState: async (_ws: string, state: unknown) => {
        sharedFlapBacking = state as Record<string, unknown>;
      },
    };

    // Worker A observes fire #1; worker B observes the resolve; worker A
    // observes fire #2; worker B observes the resolve; worker A observes
    // fire #3 (the flap) — each call is a FRESH runLivenessAlarmTick
    // invocation with baseDeps re-passed (no shared JS closure state besides
    // the injected read/write), simulating genuinely independent workers.
    healthy = false; now += 2_000; await runLivenessAlarmTick('ws', baseDeps); // fire #1 — pages
    healthy = true; now += 2_000; await runLivenessAlarmTick('ws', baseDeps); // resolves
    healthy = false; now += 2_000; await runLivenessAlarmTick('ws', baseDeps); // fire #2 — pages
    healthy = true; now += 2_000; await runLivenessAlarmTick('ws', baseDeps); // resolves
    healthy = false; now += 2_000; await runLivenessAlarmTick('ws', baseDeps); // fire #3 — SUPPRESSED

    expect(pageCalls).toEqual(['dead-routines', 'dead-routines']);
    // The durable state accumulated the fireCount across the independent calls.
    expect((sharedFlapBacking['dead-routines'] as { fireCount: number }).fireCount).toBe(3);
  });

  it('EI-18673998482704275: the atomic updateFlapState step never loses an update under genuinely CONCURRENT (Promise.all) callers', async () => {
    // Reproduces the actual lost-update race this fix closes: EI-15126's fix
    // (the test above) only proved cross-worker durability across SEQUENTIAL
    // calls — real :3070 cluster workers can have their ticks genuinely
    // OVERLAP in wall time (the read-at-start/write-at-end shape this fix
    // replaces would let a second concurrent caller read the pre-first-writer
    // state and clobber it on write). `updateFlapState` must serialize
    // concurrent mutations like a real `SELECT ... FOR UPDATE` transaction —
    // simulated here with an explicit async mutex around a shared backing
    // object, standing in for Postgres's row lock. Three "workers" fire the
    // SAME signature fully concurrently (`Promise.all`, not sequential
    // awaits); if the read-modify-write were not atomic, at least one
    // increment would be lost and fireCount would end below 3.
    let backing: FlapState = {};
    let chain: Promise<unknown> = Promise.resolve();
    const updateFlapState = (
      _w: string,
      mutate: (current: FlapState) => FlapMutationResult,
    ): Promise<FlapMutationResult> => {
      const run = chain.then(async () => {
        // A deliberate microtask hop INSIDE the critical section — if the
        // mutex didn't serialize callers, this would maximize the window for
        // a concurrent caller's read to observe stale `backing`.
        await Promise.resolve();
        const result = mutate(backing);
        backing = result.next;
        return result;
      });
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    const mutateFire = (current: FlapState): FlapMutationResult => {
      const episodes = new Map<string, { fireCount: number; quietSinceMs: number | null }>(Object.entries(current));
      const ep = episodes.get('dead-routines') ?? { fireCount: 0, quietSinceMs: null };
      ep.fireCount += 1;
      ep.quietSinceMs = null;
      episodes.set('dead-routines', ep);
      const flapThreshold = 2;
      return {
        next: Object.fromEntries(episodes),
        toPage:
          ep.fireCount <= flapThreshold
            ? [{ key: 'dead-routines', severity: 'blocker' as const, summary: 'x' }]
            : [],
        toResolveSigs: [],
      };
    };

    const results = await Promise.all([
      updateFlapState('ws', mutateFire),
      updateFlapState('ws', mutateFire),
      updateFlapState('ws', mutateFire),
    ]);

    // All 3 increments landed — no lost update despite genuinely concurrent
    // invocation.
    expect((backing['dead-routines'] as { fireCount: number }).fireCount).toBe(3);
    // Exactly 2 of the 3 calls decided to page (fires 1-2), the 3rd suppressed
    // — the flap threshold is honored correctly under concurrency, not just
    // sequential calls.
    expect(results.filter((r) => r.toPage.length > 0).length).toBe(2);
  });
});

describe('runLivenessAlarmTick — EI-10060 needsHumanRoute meta stamp', () => {
  beforeEach(() => _resetLivenessAlarmDebounce());

  function makeStore() {
    const opens: Array<EscalationRecord & { meta?: Record<string, unknown> }> = [];
    return {
      escalate: async (input: { severity: string; summary: string; meta?: Record<string, unknown> }) => {
        const rec = {
          ts: new Date().toISOString(),
          msg_id: `esc-${opens.length + 1}`,
          from: 'system:infra-liveness-alarm',
          to: ['human'],
          kind: 'escalation',
          severity: input.severity,
          summary: input.summary,
          resolved: null,
          meta: input.meta,
          ...(input.meta ?? {}),
        } as unknown as EscalationRecord & { meta?: Record<string, unknown> };
        opens.push(rec);
        return rec;
      },
      listOpen: async (): Promise<EscalationRecord[]> => [],
      resolve: async () => {},
      opens,
    };
  }

  it('a REGISTERED signal (dead-routines) stamps needsHumanRoute:false — @role:mug is on the hook', async () => {
    const store = makeStore();
    const sick = mkHealth({ panels: { workFeed: { data: { deadRoutines: 1, deadRoutineNames: ['git-sync'] } } } });
    await runLivenessAlarmTick('ws', {
      readLast: () => sick,
      computeHealth: async () => sick,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      page: async () => {},
      now: () => 100 * 60_000,
      snapshotStaleMs: 6 * 60_000,
    });
    expect(store.opens).toHaveLength(1);
    expect(store.opens[0]!.meta).toMatchObject({ needsHumanRoute: false, livenessSignature: 'dead-routines' });
  });

  it('an UNREGISTERED signal (accounts-starved) stamps needsHumanRoute:true — nobody is on the hook', async () => {
    const store = makeStore();
    const sick = mkHealth({ panels: { tokens: { data: { accountsTotal: 8, accountsAvailable: 0 } } } });
    await runLivenessAlarmTick('ws', {
      readLast: () => sick,
      computeHealth: async () => sick,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      page: async () => {},
      now: () => 100 * 60_000,
      snapshotStaleMs: 6 * 60_000,
    });
    expect(store.opens).toHaveLength(1);
    expect(store.opens[0]!.meta).toMatchObject({ needsHumanRoute: true, livenessSignature: 'accounts-starved' });
  });
});

describe('deriveSignatureFromSummary (legacy classifier)', () => {
  it('maps each known signal summary back to its signature', () => {
    expect(deriveSignatureFromSummary('[infra-liveness] system-health tick stale for 10m — ...')).toBe('health-tick-stale');
    expect(deriveSignatureFromSummary('[infra-liveness] 2 dead routine(s) overdue >10m: git-sync — the routine engine is starved.')).toBe('dead-routines');
    expect(deriveSignatureFromSummary('[infra-liveness] Queen loop dark (started, no live wake) — ...')).toBe('queen-dark');
    expect(deriveSignatureFromSummary('[infra-liveness] Overwatch supervisor loop dark — ...')).toBe('overwatch-dark');
    expect(deriveSignatureFromSummary('[infra-liveness] all 8 LLM pool account(s) paused — the fleet is rate-starved.')).toBe('accounts-starved');
    expect(deriveSignatureFromSummary('[infra-liveness] all 8 LLM pool account(s) unavailable by a fresh capacity projection — the fleet is rate-starved.')).toBe('accounts-starved');
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

describe('EI-20517935014246192 — D-026 dead-routine alarm reclassification', () => {
  beforeEach(() => _resetLivenessAlarmDebounce());

  it('threads complete cut + restore evidence through the tick and reclassifies a legacy blocker', async () => {
    const health = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: {
        workFeed: {
          data: {
            deadRoutines: 2,
            deadRoutinesInScope: 151,
            deadRoutinesDistinct: 1,
            deadRoutineNames: ['git-sync'],
          },
        },
      },
    });
    const legacy = {
      msg_id: 'legacy-dead-routines',
      severity: 'blocker',
      summary: '[infra-liveness] 2 dead routine(s) overdue >10m: git-sync',
      from: INFRA_LIVENESS_IDENTITY.ownerId,
      livenessSignature: 'dead-routines',
      resolved: null,
    } as unknown as EscalationRecord;
    const resolvedNotes: string[] = [];
    const escalated: Array<{ severity: string; summary: string }> = [];
    let readerCalls = 0;

    const result = await runLivenessAlarmTick('ws', {
      readLast: () => health,
      computeHealth: async () => health,
      d026Quiescence: async () => {
        readerCalls += 1;
        return { cutActive: true, restoreActive: true };
      },
      listOpen: async () => [legacy],
      resolve: async (_msgId: string, _choice: string, note: string) => {
        resolvedNotes.push(note);
      },
      escalate: async (input: { severity: string; summary: string }) => {
        escalated.push(input);
      },
      page: async () => {},
      pageResolved: async () => {},
      now: () => 100 * 60_000 + 60_000,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    });

    expect(readerCalls).toBe(1);
    expect(result.signals.map((s) => s.key)).toContain('dead-routines-quiesced');
    expect(result.fired.map((s) => s.key)).toEqual(['dead-routines-quiesced']);
    expect(result.resolved).toEqual(['legacy-dead-routines']);
    expect(resolvedNotes[0]).toContain('reclassified as expected D-026 quiescence');
    expect(resolvedNotes[0]).toContain('condition is STILL TRUE (NOT recovered)');
    expect(escalated[0]?.severity).toBe('advisory');
    expect(escalated[0]?.summary).toContain('expected D-026 quiescence');
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

  it('EI-20068390701347529: refreshes a growing dead-routines summary without a second fire or page', async () => {
    let deadCount = 1;
    let open: EscalationRecord | null = null;
    let sequence = 0;
    const escalations: Array<{ severity: string; summary: string }> = [];
    const pages: string[] = [];
    const health = () => mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: {
        workFeed: {
          data: {
            deadRoutines: deadCount,
            deadRoutinesInScope: 151,
            deadRoutinesDistinct: deadCount,
            deadRoutineNames: deadCount === 1 ? ['pr-poll'] : ['git-sync'],
            deadRoutineCriticalNames: deadCount === 1 ? [] : ['git-sync'],
          },
        },
      },
    });
    const deps = {
      readLast: health,
      computeHealth: async () => health(),
      listOpen: async () => (open ? [open] : []),
      escalate: async (input: { severity: string; summary: string; meta?: Record<string, unknown> }) => {
        escalations.push(input);
        sequence += 1;
        open = {
          msg_id: open?.msg_id ?? `esc-${sequence}`,
          ts: new Date(sequence * 1000).toISOString(),
          from: INFRA_LIVENESS_IDENTITY.ownerId,
          to: ['human'],
          kind: 'escalation',
          severity: input.severity as EscalationRecord['severity'],
          summary: input.summary,
          resolved: null,
          ...(input.meta ?? {}),
        } as unknown as EscalationRecord;
      },
      page: async (signal: { key: string }) => { pages.push(signal.key); },
      now: () => 100 * 60_000 + 60_000,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
      readAutoloopFireRows: async () => [],
    };

    const first = await runLivenessAlarmTick('ws', deps);
    expect(first.fired.map((s) => s.key)).toEqual(['dead-routines']);
    expect(escalations).toHaveLength(1);
    expect(pages).toEqual(['dead-routines']);

    deadCount = 101;
    const second = await runLivenessAlarmTick('ws', deps);
    expect(second.fired).toEqual([]);
    expect(escalations).toHaveLength(2);
    expect(escalations[1]?.summary).toContain('101 of 151');
    expect((open as EscalationRecord | null)?.summary).toContain('101 of 151');
    expect(pages).toEqual(['dead-routines']);
  });

  // WI-36010: the durable dedup above is keyed on the SIGNATURE alone. Both stale-paused
  // branches emit key 'stale-paused-routines' and differ ONLY in severity, so an open
  // `advisory` row used to swallow every later `blocker` for that key. Measured live: an
  // advisory opened 2026-08-06T19:20Z never resolved, and the alarm then fired zero times
  // for 2 days while the detector still matched 57 routines — a release-critical stale
  // pause (the literal WI-5839 incident) could not have paged anyone.
  //
  // ⚠ Read (a2) and (a3) TOGETHER. The guard alone would also pass with the dedup deleted
  // outright; (a3) is what pins the break-through as NARROW rather than "blockers always
  // re-fire". Reverting either half of the `escalatesToBlocker` condition reds one of them.
  function stalePausedHealth(critical: number) {
    return mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: {
        workFeed: {
          data: {
            deadRoutines: 0,
            stalePausedRoutines: critical > 0 ? 6 : 5,
            stalePausedRoutineNames: critical > 0 ? ['release-trigger'] : ['scout-cycle'],
            stalePausedCriticalRoutines: critical,
          },
        },
      },
    });
  }

  function stalePausedDeps(store: ReturnType<typeof makeStore>, readCritical: () => number) {
    return {
      readLast: () => stalePausedHealth(readCritical()),
      computeHealth: async () => stalePausedHealth(readCritical()),
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      now: () => 100 * 60_000 + 60_000,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    };
  }

  it('(a2) WI-36010 GUARD: an open ADVISORY does not swallow a later BLOCKER for the same signature', async () => {
    const store = makeStore();
    let critical = 0;
    const deps = stalePausedDeps(store, () => critical);

    const first = await runLivenessAlarmTick('ws', deps);
    expect(first.fired.map((s) => s.key)).toEqual(['stale-paused-routines']);
    expect(first.fired[0]?.severity).toBe('advisory');

    // The pause is now on a release-critical routine. Wipe the in-memory debounce so the
    // durable signature dedup is the ONLY thing under test.
    critical = 1;
    _resetLivenessAlarmDebounce();
    const second = await runLivenessAlarmTick('ws', deps);
    expect(second.fired.map((s) => s.key)).toEqual(['stale-paused-routines']);
    expect(second.fired[0]?.severity).toBe('blocker');
    // NOTE: deliberately no openCount() assertion. This fixture's `escalate` appends
    // unconditionally, so it shows 2 rows — production does NOT: openEscalation coalesces
    // on (dedupKind, subjectSignature), both severity-independent for the explicit
    // dedupKind this alarm stamps, folding the upgrade onto the ONE open row and
    // refreshing its severity in place (EI-12546). Don't read 2 here as a duplicate-row bug.
  });

  it('(a3) WI-36010 stays NARROW: a same-severity repeat is still suppressed (advisory→advisory AND blocker→blocker)', async () => {
    // advisory → advisory: unchanged pre-WI-36010 behavior.
    const advisoryStore = makeStore();
    const advisoryDeps = stalePausedDeps(advisoryStore, () => 0);
    const advisoryFirst = await runLivenessAlarmTick('ws', advisoryDeps);
    expect(advisoryFirst.fired.map((s) => s.key)).toEqual(['stale-paused-routines']);
    _resetLivenessAlarmDebounce();
    expect((await runLivenessAlarmTick('ws', advisoryDeps)).fired).toEqual([]);
    expect(advisoryStore.openCount()).toBe(1);

    // blocker → blocker: the break-through must NOT degrade into "a blocker always fires",
    // which would re-arm exactly the fire storm the durable dedup exists to prevent.
    const blockerStore = makeStore();
    const blockerDeps = stalePausedDeps(blockerStore, () => 1);
    const blockerFirst = await runLivenessAlarmTick('ws', blockerDeps);
    expect(blockerFirst.fired[0]?.severity).toBe('blocker');
    _resetLivenessAlarmDebounce();
    expect((await runLivenessAlarmTick('ws', blockerDeps)).fired).toEqual([]);
    expect(blockerStore.openCount()).toBe(1);
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

  it('WI-4878: recovery detection works even when local cache is stale (> 6 min old)', async () => {
    // Scenario: an infra panel signal fires, opening an escalation. Later, the
    // underlying failures roll out of the 1h window, so the signal should stop
    // firing. But if the local snapshot cache is older than 6 minutes (stale),
    // the prior code would skip recovery detection and never emit RECOVERED.
    // This test ensures that recovery is detected even with a stale cache.
    const store = makeStore();
    const staleMs = 6 * 60_000; // default stale threshold

    // Time 0: infra panel CRIT (failures in window), cache computed
    const now0 = 100 * 60_000;
    const infraCrit = mkHealth({
      evaluatedAt: now0,
      panels: { infra: { status: 'crit', summary: 'MCP PROXY FAILING: 12 hard failures/1h' } },
    });

    // Tick 1: cache is fresh, escalation fires
    let now = now0;
    let currentHealth = infraCrit;
    const deps = {
      readLast: () => currentHealth,
      computeHealth: async () => currentHealth,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      pageResolved: async (sigs: string[]) => { /* tracked via resolved below */ },
      now: () => now,
      snapshotStaleMs: staleMs,
      debounceMs: 30 * 60_000,
    };

    const t1 = await runLivenessAlarmTick('ws', deps);
    expect(t1.signals.map((s) => s.key)).toContain('panel:infra');
    expect(t1.fired.length).toBeGreaterThan(0);
    const openEsc = await store.listOpen();
    expect(openEsc.length).toBeGreaterThan(0);

    // Tick 2: cache is 7+ minutes old (STALE), but failures have rolled out
    // of the 1h window, so infra panel is now OK
    now = now0 + 8 * 60_000; // 8 minutes later
    const infraOk = mkHealth({ evaluatedAt: now0 }); // still using old evaluatedAt
    currentHealth = infraOk; // health is now OK (failures rolled out)

    const t2 = await runLivenessAlarmTick('ws', deps);
    // The key assertion: even though the cache is stale, recovery should be detected
    // and RECOVERED should be emitted (returned in resolved).
    expect(t2.signals.map((s) => s.key)).not.toContain('panel:infra');
    expect(t2.resolved.length).toBeGreaterThan(0); // RECOVERED was emitted
  });

  it('WI-4878 comprehensive: MCP proxy failures roll out of window → recovery detected → no re-fire', async () => {
    // Comprehensive scenario: MCP proxy records failures within a 1h window, the
    // condition fires and opens an escalation. Later, those failures age out of
    // the window (now - windowMs), the infra panel recovers, and the recovery
    // must be auto-detected even if the evaluator cache is stale. The condition
    // should stay resolved and NOT re-fire with phantom failures.
    const store = makeStore();
    const windowMs = 60 * 60_000; // 1h MCP proxy window
    const staleMs = 6 * 60_000; // 6 min health-tick stale threshold
    const mcpFailureTs = 100 * 60_000;
    const mcpFailureAgeMs = windowMs - 5 * 60_000; // 55 min old (still in window at t1)

    // Time t1: MCP failures recorded 55 min ago, still in window → infra crit
    let now = mcpFailureTs + mcpFailureAgeMs;
    const infraWithMcpCrit = mkHealth({
      evaluatedAt: now,
      panels: { infra: { status: 'crit', summary: 'MCP PROXY FAILING: 10 hard tool-call failures/1h' } },
    });

    // Tick 1: escalation fires because infra is crit
    const deps = {
      readLast: () => infraWithMcpCrit,
      computeHealth: async () => infraWithMcpCrit,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      pageResolved: async () => {},
      now: () => now,
      snapshotStaleMs: staleMs,
      debounceMs: 30 * 60_000,
    };

    const t1 = await runLivenessAlarmTick('ws', deps);
    expect(t1.signals.map((s) => s.key)).toContain('panel:infra');
    expect(t1.fired.length).toBeGreaterThan(0);
    const openEsc = await store.listOpen();
    expect(openEsc.length).toBeGreaterThan(0); // escalation opened

    // Time t2: 30+ minutes later, MCP failures have aged out of window
    // (now 85 min old, window is 60 min), so infra should recover → panel ok
    now = mcpFailureTs + mcpFailureAgeMs + 35 * 60_000; // 35 min later
    const infraRecovered = mkHealth({ evaluatedAt: now }); // panel now ok
    let currentHealth = infraRecovered;

    // Tick 2: snapshot cache is now 35 min old (STALE by 6-min threshold),
    // but infra panel is ok because MCP failures rolled out. Recovery detection
    // must recompute fresh, see the ok panel, and auto-resolve the escalation.
    const deps2 = {
      readLast: () => currentHealth,
      computeHealth: async () => currentHealth,
      escalate: store.escalate,
      listOpen: store.listOpen,
      resolve: store.resolve,
      pageResolved: async () => {},
      now: () => now,
      snapshotStaleMs: staleMs,
      debounceMs: 30 * 60_000,
    };

    const t2 = await runLivenessAlarmTick('ws', deps2);
    // Recovery should be detected: panel:infra is no longer firing
    expect(t2.signals.map((s) => s.key)).not.toContain('panel:infra');
    // Escalation should be auto-resolved
    expect(t2.resolved.length).toBeGreaterThan(0);

    // Time t3: One more tick. Even though another ~30 min has passed,
    // the condition should stay resolved (not re-fire).
    now = mcpFailureTs + mcpFailureAgeMs + 65 * 60_000; // 1 hour+ later
    const t3 = await runLivenessAlarmTick('ws', deps2);
    expect(t3.signals.map((s) => s.key)).not.toContain('panel:infra'); // still recovered
    expect(t3.fired.length).toBe(0); // no re-fire
  });
});

describe('EI-21025158485847408 — ambient host memory-pressure infra crit downgrades to advisory (no page/thrash)', () => {
  const ambientPerf = {
    status: 'crit',
    critAttribution: {
      operatorDefect: [],
      ambientHost: [
        'PSI memory full avg60 10.13 ≥ 5 — all tasks stalled on memory reclaim/swap (WI-5471 class: real thrashing, not a CPU issue)',
      ],
    },
  };
  const mixedPerf = {
    status: 'crit',
    critAttribution: {
      operatorDefect: ['event-loop lag p95 1200ms ≥ 1000ms'],
      ambientHost: ['PSI memory full avg60 10.13 ≥ 5 — all tasks stalled on memory reclaim/swap'],
    },
  };

  it('a PURELY ambient-host infra crit fires as advisory, not blocker — never pages', () => {
    const h = mkHealth({
      panels: {
        infra: {
          status: 'crit',
          summary: 'HOST MEMORY PRESSURE: PSI memory full avg60 10.13 ≥ 5',
          data: { perf: ambientPerf },
        },
      },
    });
    const sigs = evaluateLivenessAlarm(h, null);
    const infraSig = sigs.find((s) => s.key === 'panel:infra');
    expect(infraSig).toBeDefined();
    expect(infraSig?.severity).toBe('advisory');
    expect(infraSig?.summary).toMatch(/ambient host pressure, non-blocking/);
  });

  it('an infra crit that ALSO carries an operator-defect leg still pages as blocker', () => {
    const h = mkHealth({
      panels: {
        infra: {
          status: 'crit',
          summary: 'PER-THREAD WEDGE: event-loop lag p95 1200ms ≥ 1000ms',
          data: { perf: mixedPerf },
        },
      },
    });
    const sigs = evaluateLivenessAlarm(h, null);
    expect(sigs.find((s) => s.key === 'panel:infra')?.severity).toBe('blocker');
  });

  it('an infra crit with NO critAttribution at all (older projection) fails SAFE toward blocker', () => {
    const h = mkHealth({
      panels: {
        infra: { status: 'crit', summary: 'some infra crit', data: { perf: { status: 'crit' } } },
      },
    });
    const sigs = evaluateLivenessAlarm(h, null);
    expect(sigs.find((s) => s.key === 'panel:infra')?.severity).toBe('blocker');
  });

  it('a non-perf infra crit (a broken tool handler) still pages, even alongside an ambient-only perf reason', () => {
    const h = mkHealth({
      panels: {
        infra: {
          status: 'crit',
          summary: 'TOOL FAILING FLEET-WIDE: facts:assert 100% (500)',
          data: {
            perf: ambientPerf,
            toolFailures: {
              rating: 'broken', evidence: 'facts:assert 100% (500)', brokenTools: ['facts:assert'],
              windowMin: 15, worstPct: 100, totalCalls: 20,
            },
          },
        },
      },
    });
    const sigs = evaluateLivenessAlarm(h, null);
    expect(sigs.find((s) => s.key === 'panel:infra')?.severity).toBe('blocker');
  });

  it('runLivenessAlarmTick still records a panel:infra advisory durably, with severity carried through to the escalation writer (never `blocker`)', async () => {
    const health = mkHealth({
      panels: {
        infra: {
          status: 'crit',
          summary: 'HOST MEMORY PRESSURE: PSI memory full avg60 10.13 ≥ 5',
          data: { perf: ambientPerf },
        },
      },
    });
    // A minimal store that just captures what severity was actually escalated —
    // `runLivenessAlarmTick` only reaches its fleet-wide page path
    // (`newBlockerSignals`, gated on `s.severity === 'blocker'`) for signals it
    // ALSO passed to `escalate()` at that same severity, so asserting the
    // escalated severity here is the load-bearing check that this never pages.
    const escalated: Array<{ severity: string; summary: string }> = [];
    const t = await runLivenessAlarmTick('ws', {
      readLast: () => health,
      computeHealth: async () => health,
      escalate: async (input: { severity: string; summary: string }) => {
        escalated.push({ severity: input.severity, summary: input.summary });
      },
      listOpen: async () => [],
      resolve: async () => {},
      now: () => 1_000_000,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    });
    expect(t.signals.map((s) => s.key)).toContain('panel:infra');
    expect(t.fired.map((s) => s.key)).toContain('panel:infra');
    expect(escalated).toHaveLength(1);
    expect(escalated[0]?.severity).toBe('advisory');
  });

  it('sustained ambient pressure across repeated ticks stays advisory and durably deduped', async () => {
    const health = mkHealth({
      panels: {
        infra: {
          status: 'crit',
          summary: 'HOST MEMORY PRESSURE: PSI memory full avg60 10.13 ≥ 5',
          data: { perf: ambientPerf },
        },
      },
    });
    let now = 1_000_000;
    let open: EscalationRecord | null = null;
    const escalated: Array<{ severity: string; summary: string }> = [];
    const pages: string[] = [];
    const deps = {
      readLast: () => health,
      computeHealth: async () => health,
      escalate: async (input: { severity: string; summary: string; meta?: Record<string, unknown> }) => {
        escalated.push({ severity: input.severity, summary: input.summary });
        open = {
          msg_id: 'ambient-1',
          ts: new Date(0).toISOString(),
          from: INFRA_LIVENESS_IDENTITY.ownerId,
          to: ['human'],
          kind: 'escalation',
          severity: input.severity as EscalationRecord['severity'],
          summary: input.summary,
          resolved: null,
          ...(input.meta ?? {}),
        } as unknown as EscalationRecord;
      },
      listOpen: async () => (open ? [open] : []),
      resolve: async () => {},
      page: async (signal: { key: string }) => { pages.push(signal.key); },
      now: () => now,
      snapshotStaleMs: 6 * 60_000,
      debounceMs: 30 * 60_000,
    };

    for (let tickNumber = 0; tickNumber < 3; tickNumber += 1) {
      // Simulate separate request workers: durable open-row dedup must hold even
      // after the process-local cooldown is discarded between ticks.
      _resetLivenessAlarmDebounce();
      const tick = await runLivenessAlarmTick('ws', deps);
      expect(tick.signals).toHaveLength(1);
      expect(tick.signals[0]?.key).toBe('panel:infra');
      expect(tick.signals[0]?.severity).toBe('advisory');
      expect(tick.fired.map((signal) => signal.key)).toEqual(
        tickNumber === 0 ? ['panel:infra'] : [],
      );
      now += 60_000;
    }

    expect(escalated).toHaveLength(1);
    expect(escalated[0]?.severity).toBe('advisory');
    // The assignment happens inside the injected async escalation writer, which
    // TypeScript's local control-flow analysis cannot prove ran. The preceding
    // length assertion and three awaited ticks are the runtime proof; retain the
    // nullable cast so this checks the persisted row without widening production
    // types or pretending the callback assignment is synchronous.
    expect((open as EscalationRecord | null)?.severity).toBe('advisory');
    expect(pages).toEqual([]);
  });
});

describe('EI-19462267124852221 — an UNREADABLE input must not auto-resolve as "recovered"', () => {
  beforeEach(() => _resetLivenessAlarmDebounce());

  /** An open infra-liveness escalation carrying an explicit signature. */
  function openRec(sig: string, msg_id: string): EscalationRecord {
    return {
      msg_id,
      severity: 'advisory',
      summary: `[infra-liveness] ${sig}`,
      from: INFRA_LIVENESS_IDENTITY.ownerId,
      livenessSignature: sig,
      resolved: null,
    } as unknown as EscalationRecord;
  }

  function tickWith(health: SystemHealth, opens: EscalationRecord[]) {
    const resolvedIds: string[] = [];
    return {
      resolvedIds,
      run: () =>
        runLivenessAlarmTick('ws', {
          readLast: () => health,
          computeHealth: async () => health,
          listOpen: async () => opens,
          resolve: async (msg_id: string) => { resolvedIds.push(msg_id); },
          escalate: async () => {},
          page: async () => {},
          now: () => 100 * 60_000 + 60_000,
          snapshotStaleMs: 6 * 60_000,
        }),
    };
  }

  // ── the pure helper ────────────────────────────────────────────────────────
  it('a panel that panelSafe caught (status unknown + error) marks EVERY signature it feeds unobservable', () => {
    const h = mkHealth({
      panels: { workFeed: { status: 'unknown', data: null, error: 'connect-phase deadline' } },
    });
    const out = unobservableLivenessSignatures(h);
    expect([...out].sort()).toEqual(['dead-routines', 'dead-routines-quiesced', 'stale-paused-routines']);
  });

  it('a SUCCEEDING panel whose stale-paused sub-read failed marks only that signature', () => {
    const h = mkHealth({
      panels: { workFeed: { data: { deadRoutines: 0, deadRoutineNames: [], stalePausedRoutines: 0, stalePausedRoutinesUnreadable: true } } },
    });
    expect([...unobservableLivenessSignatures(h)]).toEqual(['stale-paused-routines']);
  });

  it('EI-22806259337076005: a stale token projection keeps accounts-starved unobservable', () => {
    const h = mkHealth({
      panels: {
        tokens: {
          data: {
            accountsTotal: 12,
            accountsAvailable: 0,
            spendUsd: 1,
            poolProjectionFreshestAgeMs: 31 * 60_000,
          },
        },
      },
    });
    expect([...unobservableLivenessSignatures(h)]).toEqual(['accounts-starved']);
  });

  it('EI-22806259337076005: a fresh token projection remains observable', () => {
    const h = mkHealth({
      panels: {
        tokens: {
          data: {
            accountsTotal: 12,
            accountsAvailable: 0,
            spendUsd: 1,
            poolProjectionFreshestAgeMs: 29 * 60_000,
          },
        },
      },
    });
    expect([...unobservableLivenessSignatures(h)]).toEqual([]);
  });

  it('EI-22806259337076005: an unreadable tokens panel keeps accounts-starved unobservable', () => {
    const h = mkHealth({
      panels: { tokens: { status: 'unknown', data: null, error: 'account pool read failed' } },
    });
    expect([...unobservableLivenessSignatures(h)]).toEqual(['accounts-starved']);
  });

  it('CALIBRATION: a healthy, fully-READ panel marks nothing unobservable', () => {
    // Without this the two assertions above would also pass if the helper simply
    // returned every signature always.
    const h = mkHealth({
      panels: { workFeed: { data: { deadRoutines: 0, deadRoutineNames: [], stalePausedRoutines: 0 } } },
    });
    expect([...unobservableLivenessSignatures(h)]).toEqual([]);
  });

  it('the idiomatic `data: null` healthy fixture is NOT treated as unreadable (status stays ok)', () => {
    // `data: null` is ambiguous — production only makes it via panelSafe's catch, but
    // it is also this suite's "nothing to report" value. Keying on it would make a
    // genuine recovery unresolvable, so the helper keys on `status`/`error` instead.
    expect([...unobservableLivenessSignatures(mkHealth())]).toEqual([]);
  });

  // ── the defect: auto-resolve ───────────────────────────────────────────────
  it('THE DEFECT: an open stale-paused escalation is NOT resolved when the sub-read was unreadable', async () => {
    const health = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: { workFeed: { data: { deadRoutines: 0, deadRoutineNames: [], stalePausedRoutines: 0, stalePausedRoutinesUnreadable: true } } },
    });
    const t = tickWith(health, [openRec('stale-paused-routines', 'esc-sp')]);
    const r = await t.run();
    // Pre-fix this resolved 'esc-sp' as "condition recovered", dropping the open row
    // the next fire would have coalesced onto → fire/false-resolve/fire forever.
    // ⚠ That IS the shape of the measured flap (5,303 strictly-alternating fire/resolve
    // pairs in 30d, byte-identical summary) but this guard is NOT established as its
    // cause — see the SCOPE note on `unobservableLivenessSignatures`. This test pins the
    // conflation, not the incident.
    expect(t.resolvedIds).toEqual([]);
    expect(r.resolved).toEqual([]);
  });

  it('THE DEFECT (panel-level): neither workFeed signature resolves when the whole panel was caught', async () => {
    const health = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: { workFeed: { status: 'unknown', data: null, error: 'could not obtain a database connection' } },
    });
    const t = tickWith(health, [openRec('stale-paused-routines', 'esc-sp'), openRec('dead-routines', 'esc-dr')]);
    await t.run();
    expect(t.resolvedIds).toEqual([]);
  });

  it('EI-22806259337076005: an open accounts-starved escalation is NOT resolved while projection writes are stale', async () => {
    const health = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: {
        tokens: {
          data: {
            accountsTotal: 12,
            accountsAvailable: 0,
            spendUsd: 1,
            poolProjectionFreshestAgeMs: 31 * 60_000,
          },
        },
      },
    });
    const t = tickWith(health, [openRec('accounts-starved', 'esc-accounts')]);
    const r = await t.run();
    // The fire path deliberately suppresses this signal while the projection is
    // stale. The recovery path must preserve the open row for the same reason.
    expect(t.resolvedIds).toEqual([]);
    expect(r.resolved).toEqual([]);
  });

  it('EI-22806259337076005 calibration: fresh serviceability evidence still resolves accounts-starved', async () => {
    const health = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: {
        tokens: {
          data: {
            accountsTotal: 12,
            accountsAvailable: 12,
            spendUsd: 1,
            poolProjectionFreshestAgeMs: 29 * 60_000,
          },
        },
      },
    });
    const t = tickWith(health, [openRec('accounts-starved', 'esc-accounts')]);
    const r = await t.run();
    expect(t.resolvedIds).toEqual(['esc-accounts']);
    expect(r.resolved).toEqual(['esc-accounts']);
  });

  it('CALIBRATION: a genuine, OBSERVED recovery still auto-resolves (the fix is not a blanket freeze)', async () => {
    // The load-bearing control. Without it, the two tests above would pass if the fix
    // simply stopped auto-resolving anything — which would break recovery entirely.
    const health = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: { workFeed: { data: { deadRoutines: 0, deadRoutineNames: [], stalePausedRoutines: 0 } } },
    });
    const t = tickWith(health, [openRec('stale-paused-routines', 'esc-sp')]);
    await t.run();
    expect(t.resolvedIds).toEqual(['esc-sp']);
  });
});

// EI-19462267124852221 — THE THIRD ABSENCE REASON, and the one that was still firing.
//
// A signature is missing from `currentSigs` for three different reasons: the condition
// cleared, its input was unreadable (the describe above), or it is STILL TRUE and a
// policy gate deliberately withheld it. Only the first may auto-resolve. The second was
// closed first and the third left open — which is why the fix read as complete while the
// phenomenon continued: the two signatures the second covers had gone quiet, and every
// occurrence still happening was the third.
//
// MEASURED 2026-08-04 (papercusp-workspace): every `panel:bees` auto-resolve in the
// sampled window announced "condition recovered" while the bees panel read crit in the
// health tick immediately before AND after it — 00:14:41.818, 00:12:45.328, 00:12:45.284,
// 00:10:44.497, all crit/crit. No recovery window existed for the resolve to describe.
describe('EI-19462267124852221 — a POLICY-SUPPRESSED signal must not auto-resolve as "recovered"', () => {
  beforeEach(() => _resetLivenessAlarmDebounce());

  const idle: BeesLivenessContext = {
    cupPlaceableFrontier: 0,
    frontierUnreadable: false,
    dispatchBudget: 20,
    restartRecovering: false,
    otherAgentsAlive: true,
  };
  /** bees crit with zero running — the ONLY shape the idle-by-design gate withholds. */
  const noBeesCrit = (over: Record<string, unknown> = {}) =>
    mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: {
        bees: { status: 'crit', summary: 'no bees running', data: { running: 0, alive: 0 } },
        ...over,
      },
    });

  function openRec(sig: string, msg_id: string): EscalationRecord {
    return {
      msg_id,
      severity: 'advisory',
      summary: `[infra-liveness] ${sig}`,
      from: INFRA_LIVENESS_IDENTITY.ownerId,
      livenessSignature: sig,
      resolved: null,
    } as unknown as EscalationRecord;
  }

  function tickWith(health: SystemHealth, opens: EscalationRecord[]) {
    const resolvedIds: string[] = [];
    const notes: string[] = [];
    return {
      resolvedIds,
      notes,
      run: () =>
        runLivenessAlarmTick('ws', {
          readLast: () => health,
          computeHealth: async () => health,
          listOpen: async () => opens,
          resolve: async (msg_id: string, _choice?: unknown, note?: string) => {
            resolvedIds.push(msg_id);
            if (note) notes.push(note);
          },
          escalate: async () => {},
          page: async () => {},
          now: () => 100 * 60_000 + 60_000,
          snapshotStaleMs: 6 * 60_000,
        }),
    };
  }

  // ── the pure helper ────────────────────────────────────────────────────────
  it('reports panel:bees suppressed when the idle-by-design gate withholds it', () => {
    expect(policySuppressedLivenessSignatures(noBeesCrit(), idle).has('panel:bees')).toBe(true);
  });

  it('a GENUINE no-bees crit (cup work waiting) is fired, so it is NOT suppressed', () => {
    const live = { ...idle, cupPlaceableFrontier: 3 };
    expect(policySuppressedLivenessSignatures(noBeesCrit(), live).has('panel:bees')).toBe(false);
  });

  it('a bees crit for another reason (bees still running) is NOT suppressed', () => {
    const h = noBeesCrit({ bees: { status: 'crit', summary: '2 bee(s), 1 cursed', data: { running: 2, alive: 2 } } });
    expect(policySuppressedLivenessSignatures(h, idle).has('panel:bees')).toBe(false);
  });

  it('CALIBRATION: a healthy bees panel marks nothing suppressed', () => {
    // Without this the assertions above would also pass if the helper returned
    // 'panel:bees' unconditionally.
    expect([...policySuppressedLivenessSignatures(mkHealth(), idle)]).toEqual([]);
  });

  // ── the anti-drift guard ───────────────────────────────────────────────────
  it('THE DRIFT GUARD: withheld-by-the-gate and reported-suppressed are exact complements', () => {
    // The fire path and the resolve guard read the SAME predicate. If a future edit
    // changes one gate leg without the other, "we did not fire this" and "we must not
    // resolve this" desynchronise — and the false resolve comes straight back. Every
    // case below is bees-crit + running 0, so `fired` and `suppressed` must be opposites.
    const cases: Array<[string, BeesLivenessContext]> = [
      ['idle by design', idle],
      ['cup work waiting', { ...idle, cupPlaceableFrontier: 3 }],
      ['gateway restart-recovering', { ...idle, restartRecovering: true }],
      ['no other agents alive', { ...idle, otherAgentsAlive: false }],
      ['cup tier known-full', { ...idle, dispatchBudget: 0 }],
      ['capacity unknown (fail-safe)', { ...idle, dispatchBudget: null }],
    ];
    for (const [label, ctx] of cases) {
      const h = noBeesCrit();
      const fired = evaluateLivenessAlarm(h, null, { beesLiveness: ctx }).some((s) => s.key === 'panel:bees');
      const suppressed = policySuppressedLivenessSignatures(h, ctx).has('panel:bees');
      expect(suppressed, `${label}: fired=${fired} suppressed=${suppressed}`).toBe(!fired);
    }
  });

  it('the LEGACY caller (no beesLiveness threaded) is guarded by the same frontier gate it fires on', () => {
    const h = noBeesCrit({ workFeed: { data: { frontier: 0, frontierStuck: 0, deadRoutines: 0 } } });
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain('panel:bees');
    expect(policySuppressedLivenessSignatures(h).has('panel:bees')).toBe(true);
  });

  // ── the defect: the note, not the close ────────────────────────────────────
  //
  // The close itself is CORRECT and must stay: an idle-by-design fleet needs no human
  // attention, so an open "no bees running" blocker is a false positive that has to
  // drain (the one-time backlog sweep depends on it). Holding the row open instead was
  // tried and rejected — it strands a benign escalation forever. The defect is that the
  // close was ANNOUNCED as a recovery, making the durable log unable to distinguish a
  // condition that cleared from one that was reclassified.
  it('THE DEFECT: a policy-suppressed close does NOT claim the condition recovered', async () => {
    const t = tickWith(noBeesCrit(), [openRec('panel:bees', 'esc-bees')]);
    await t.run();
    expect(t.resolvedIds).toEqual(['esc-bees']); // still drains — a benign row must not linger
    const note = t.notes.join('\n');
    expect(note).not.toContain('condition recovered');
    expect(note).toContain('STILL TRUE');
  });

  it('CALIBRATION: a genuine recovery still says "condition recovered"', async () => {
    // The load-bearing control. Without it the test above would pass if the fix simply
    // stamped "STILL TRUE" on every close, which would destroy the distinction it exists
    // to create — the same conflation, sign-flipped.
    const t = tickWith(mkHealth({ evaluatedAt: 100 * 60_000 }), [openRec('panel:bees', 'esc-bees')]);
    await t.run();
    expect(t.resolvedIds).toEqual(['esc-bees']);
    expect(t.notes.join('\n')).toContain('condition recovered');
  });
});

describe('EI-19462267124852221 — an auto-resolve must carry its OBSERVATION, not just its conclusion', () => {
  beforeEach(() => _resetLivenessAlarmDebounce());

  function openRec(sig: string, msg_id: string): EscalationRecord {
    return {
      msg_id, severity: 'advisory', summary: `[infra-liveness] ${sig}`,
      from: INFRA_LIVENESS_IDENTITY.ownerId, livenessSignature: sig, resolved: null,
    } as unknown as EscalationRecord;
  }

  it('stamps the observed panel status + count for a mapped signature', () => {
    const h = mkHealth({
      panels: { workFeed: { status: 'warn', data: { deadRoutines: 0, deadRoutineNames: [], stalePausedRoutines: 0 } } },
    });
    expect(resolveEvidenceFor('stale-paused-routines', h))
      .toBe('observed workFeed status=warn stalePausedRoutines=0');
  });

  it('an UNMAPPED signature says so explicitly rather than implying it was observed clear', () => {
    // The load-bearing distinction: silence must not read as evidence. A future query
    // over the durable log can then separate "observed clear" from "we did not record".
    expect(resolveEvidenceFor('some-other-signal', mkHealth()))
      .toBe('no per-signature evidence recorded');
  });

  it('a caught panel reports unreadable, not a fabricated zero', () => {
    const h = mkHealth({ panels: { workFeed: { status: 'unknown', data: null, error: 'boom' } } });
    expect(resolveEvidenceFor('stale-paused-routines', h))
      .toBe('observed workFeed status=unknown stalePausedRoutines=unreadable');
  });

  // The `panel:<key>` catch-all family. Measured 2026-08-04 (24h, papercusp-workspace):
  // panel:infra 148 fire/resolve cycles, panel:bees 83, rubric-emission-dark 41, while the
  // two workFeed signatures above sat quiet — so these ARE the live occurrences, and the
  // helper used to record 'no per-signature evidence recorded' for every one of them.
  it('records the observed panel status for a panel:<key> signature (the family that actually flaps)', () => {
    const h = mkHealth({ panels: { infra: { status: 'warn', summary: 'pg slow' } } });
    expect(resolveEvidenceFor('panel:infra', h)).toBe('observed panel infra status=warn');
  });

  it('an ERRORED panel is marked as such, so a resolve cannot read as observed-clear', () => {
    const h = mkHealth({ panels: { infra: { status: 'unknown', data: null, error: 'boom' } } });
    expect(resolveEvidenceFor('panel:infra', h)).toBe('observed panel infra status=unknown (panel ERRORED)');
  });

  it('a panel MISSING from the snapshot says panel-absent — absence is not evidence of recovery', () => {
    // The same load-bearing distinction as the unmapped-signature case: we did not look,
    // which must never render as "we looked and it was clear".
    expect(resolveEvidenceFor('panel:no-such-panel', mkHealth())).toBe('observed panel no-such-panel status=panel-absent');
  });

  // EI-19474857043229377 — `panel:bees` is withheld by the beesIdleByDesign gate, so a
  // resolve can be announcing the GATE flipping while the panel reads crit on both sides
  // (measured: 83 such cycles in 24h). The panel status alone therefore cannot name the
  // cause; the gate's inputs must ride along or the occurrence is undiagnosable once the
  // window closes — which is exactly what cost four wakes of live elimination.
  it('panel:bees carries the GATE INPUTS alongside the panel status', () => {
    const h = mkHealth({ panels: { bees: { status: 'crit', summary: 'no bees running', data: { running: 0 } } } });
    const ctx: BeesLivenessContext = {
      cupPlaceableFrontier: 0,
      frontierUnreadable: false,
      dispatchBudget: 0,
      restartRecovering: false,
      otherAgentsAlive: true,
    };
    const s = resolveEvidenceFor('panel:bees', h, ctx);
    expect(s).toContain('observed panel bees status=crit');
    expect(s).toContain('gate: cupPlaceableFrontier=0');
    expect(s).toContain('dispatch-budget-exhausted');
  });

  it('panel:bees WITHOUT a threaded context degrades to the status alone — never a fabricated gate reading', () => {
    const h = mkHealth({ panels: { bees: { status: 'crit', summary: 'no bees running', data: { running: 0 } } } });
    expect(resolveEvidenceFor('panel:bees', h)).toBe('observed panel bees status=crit');
  });

  it('the gate suffix is scoped to panel:bees — another panel is unchanged even when a context is passed', () => {
    const h = mkHealth({ panels: { infra: { status: 'warn', summary: 'pg slow' } } });
    const ctx: BeesLivenessContext = {
      cupPlaceableFrontier: 0,
      frontierUnreadable: false,
      dispatchBudget: 15,
      restartRecovering: false,
      otherAgentsAlive: true,
    };
    expect(resolveEvidenceFor('panel:infra', h, ctx)).toBe('observed panel infra status=warn');
  });

  it('THE CALL SITE: the note actually written on a genuine recovery carries the evidence', async () => {
    // Testing the helper alone would prove nothing about whether anything CALLS it —
    // so assert on the string the resolve() dep really receives.
    const notes: string[] = [];
    const health = mkHealth({
      evaluatedAt: 100 * 60_000,
      panels: { workFeed: { status: 'warn', data: { deadRoutines: 0, deadRoutineNames: [], stalePausedRoutines: 0 } } },
    });
    await runLivenessAlarmTick('ws', {
      readLast: () => health,
      computeHealth: async () => health,
      listOpen: async () => [openRec('stale-paused-routines', 'esc-sp')],
      resolve: async (_id: string, _choice: string, note: string) => { notes.push(note); },
      escalate: async () => {},
      page: async () => {},
      now: () => 100 * 60_000 + 60_000,
      snapshotStaleMs: 6 * 60_000,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("infra-liveness signal 'stale-paused-routines' cleared (condition recovered)");
    expect(notes[0]).toContain('observed workFeed status=warn stalePausedRoutines=0');
  });
});

describe('formatDeadRoutinesSummary — magnitude + consequence (EI-20045691451471399)', () => {
  it('reads as a fleet-wide freeze, not a one-routine blip, when the engine is frozen', () => {
    const s = formatDeadRoutinesSummary({
      deadRoutines: 101,
      deadRoutinesInScope: 151,
      deadRoutinesDistinct: 9,
      deadRoutineNames: ['git-sync', 'green-checkpoint', 'pr-poll'],
      deadRoutineCriticalNames: ['git-sync', 'green-checkpoint'],
      deadRoutineCoverage: { 'git-sync': { overdue: 70, active: 70 } },
    });
    expect(s).toContain('101 of 151');            // the ratio, not a bare count
    expect(s).toContain('FROZEN');                 // >=50% of the engine is a freeze, say so
    // ⚠ 6, not 98: the remainder is counted in DISTINCT names (9 distinct − 3 named), never
    // rows − names. The row count is 101 only because one row exists per install.
    expect(s).toContain('(+6 more)');
    expect(s).toContain('git-sync');
    expect(s).toContain('NOTHING in the shared tree is being committed');
  });

  it('discloses the unit when one routine is dead across many installs', () => {
    // The live shape that makes this necessary: git-sync is 59 rows (one per install), so a
    // row count of 59 reads as "59 different routines died" when exactly ONE routine did.
    const s = formatDeadRoutinesSummary({
      deadRoutines: 59, deadRoutinesInScope: 144, deadRoutinesDistinct: 1,
      deadRoutineNames: ['git-sync'], deadRoutineCriticalNames: ['git-sync'],
    });
    expect(s).toContain('59 of 144 dead routine(s) overdue >10m (1 distinct)');
    expect(s).not.toContain('more)');   // 1 distinct, 1 named ⇒ nothing withheld
  });

  it('omits the distinct note when rows and distinct routines agree (nothing to disambiguate)', () => {
    const s = formatDeadRoutinesSummary({
      deadRoutines: 3, deadRoutinesInScope: 144, deadRoutinesDistinct: 3,
      deadRoutineNames: ['pr-poll', 'a', 'b'],
    });
    expect(s).not.toContain('distinct');
  });

  it('never mixes units: says nothing about a remainder when the distinct count was not observed', () => {
    const s = formatDeadRoutinesSummary({
      deadRoutines: 101, deadRoutinesInScope: 151, deadRoutineNames: ['git-sync'],
    });
    expect(s).toContain('101 of 151');
    expect(s).not.toContain('more)');   // no distinct count ⇒ no guess
  });

  it('still classifies as the dead-routines signature — the substring dedup depends on', () => {
    // ⚠ THE COUPLING GUARD. `deriveSignatureFromSummary` classifies this signal by regex over
    // the summary text, and that is the dedup identity for legacy escalation rows written
    // before EI-2146 stamped an explicit signature. Reword `dead routine(s)` out of the
    // summary and those rows silently stop classifying — they would never auto-resolve. This
    // asserts the round-trip rather than trusting the wording to stay put.
    const frozen = formatDeadRoutinesSummary({
      deadRoutines: 101, deadRoutinesInScope: 151,
      deadRoutineNames: ['git-sync'], deadRoutineCriticalNames: ['git-sync'],
    });
    const single = formatDeadRoutinesSummary({ deadRoutines: 1, deadRoutineNames: ['pr-poll'] });
    expect(deriveSignatureFromSummary(frozen)).toBe('dead-routines');
    expect(deriveSignatureFromSummary(single)).toBe('dead-routines');
  });

  it('degrades to a bare count rather than inventing a denominator it never observed', () => {
    const s = formatDeadRoutinesSummary({ deadRoutines: 4, deadRoutineNames: ['pr-poll'] });
    expect(s).toContain('4 dead routine(s)');
    expect(s).not.toContain(' of ');
    // No observed scope ⇒ no ratio ⇒ no basis to call it frozen.
    expect(s).toContain('starved');
    expect(s).not.toContain('FROZEN');
  });

  it('does not call a handful of stuck routines a freeze', () => {
    const s = formatDeadRoutinesSummary({
      deadRoutines: 3, deadRoutinesInScope: 151, deadRoutineNames: ['pr-poll', 'a', 'b'],
    });
    expect(s).toContain('3 of 151');
    expect(s).toContain('starved');
    expect(s).not.toContain('FROZEN');
    expect(s).not.toContain('more)');   // nothing withheld, so claim nothing withheld
  });

  it('names a non-git-sync fleet-blocking routine without the commit-outage claim', () => {
    const s = formatDeadRoutinesSummary({
      deadRoutines: 2, deadRoutinesInScope: 151,
      deadRoutineNames: ['release-trigger', 'pr-poll'], deadRoutineCriticalNames: ['release-trigger'],
    });
    expect(s).toContain('Fleet-blocking: release-trigger.');
    expect(s).not.toContain('shared tree');
  });

  it('does not turn a minority of per-install git-sync rows into a fleet-wide outage', () => {
    const s = formatDeadRoutinesSummary({
      deadRoutines: 2,
      deadRoutinesInScope: 153,
      deadRoutinesDistinct: 1,
      deadRoutineNames: ['git-sync'],
      deadRoutineCriticalNames: ['git-sync'],
      deadRoutineCoverage: { 'git-sync': { overdue: 2, active: 70 } },
    });
    expect(s).toContain('2 of 70 active rows overdue');
    expect(s).toContain('not evidence of a fleet-wide commit outage');
    expect(s).not.toContain('NOTHING in the shared tree is being committed');
  });

  it('requires a strict majority, not half, before asserting a fleet-wide commit outage', () => {
    const s = formatDeadRoutinesSummary({
      deadRoutines: 2,
      deadRoutinesInScope: 4,
      deadRoutinesDistinct: 1,
      deadRoutineNames: ['git-sync'],
      deadRoutineCriticalNames: ['git-sync'],
      deadRoutineCoverage: { 'git-sync': { overdue: 2, active: 4 } },
    });
    expect(s).not.toContain('NOTHING in the shared tree is being committed');
    expect(s).toContain('not evidence of a fleet-wide commit outage');
  });
});
