/**
 * thresholds.test — the green/yellow/red status model (system-health-tab-2026-06-15
 * P-006 / Phase 4). Pure boundary tests: no DB, no IO. Pins the load-bearing
 * boundaries (Queen stall, opus paused, dead routine, sync-lag, escalation aging)
 * + the worst-of roll-up's fail-soft (unknown never reds the system).
 */
import { describe, it, expect } from 'vitest';
import {
  queenStatus,
  beesStatus,
  workItemsStatus,
  workFeedStatus,
  tokensStatus,
  watchdogStatus,
  deployStatus,
  plansStatus,
  escalationsStatus,
  autonomyStatus,
  overwatchStatus,
  worstStatus,
  deriveQueenAlive,
  QUEEN_STALL_MS,
  SYNC_LAG_WARN_MS,
  DEPLOY_BEHIND_WARN,
} from './thresholds';
import type {
  QueenHealth,
  BeesHealth,
  WorkItemsHealth,
  WorkFeedHealth,
  TokensHealth,
  WatchdogHealth,
  DeployHealth,
  PlansHealth,
  EscalationsHealth,
  AutonomyHealth,
  OverwatchPanelHealth,
} from './types';

const queen = (o: Partial<QueenHealth> = {}): QueenHealth => ({
  hiveSlug: 'h', started: true, stalled: false, midTurn: false, armed: true,
  lastWakeAt: 0, staleForMs: 60_000, nextFireAt: 0, cadenceOk: true,
  watchdogFires24h: 0, demand: { todoItems: 0, startedPlans: 0 },
  decisionsWindow: { total: 0, auto: 0, gated: 0 }, workingTracked: 0, ...o,
});

describe('queenStatus', () => {
  it('crit when stalled (the origin failure mode)', () => {
    expect(queenStatus(queen({ stalled: true }))).toBe('crit');
  });
  it('warn when paused (not started)', () => {
    expect(queenStatus(queen({ started: false }))).toBe('warn');
  });
  it('warn when started + no wake armed + demand queued', () => {
    expect(queenStatus(queen({ armed: false, demand: { todoItems: 3, startedPlans: 0 } }))).toBe('warn');
  });
  it('ok when started + no wake armed but no demand (nothing to do)', () => {
    expect(queenStatus(queen({ armed: false, demand: { todoItems: 0, startedPlans: 0 } }))).toBe('ok');
  });
  it('warn when the watchdog has fired repeatedly (prompt bug)', () => {
    expect(queenStatus(queen({ watchdogFires24h: 3 }))).toBe('warn');
  });
  it('ok when looping with cadence', () => {
    expect(queenStatus(queen())).toBe('ok');
  });
});

describe('deriveQueenAlive — liveness-only, kept DISTINCT from stalled (EI-623)', () => {
  it('alive when looping with cadence (started + armed + not stalled)', () => {
    expect(deriveQueenAlive(queen())).toBe(true);
  });
  it('alive when started + ARMED even if stalled (re-armable → flows to queen-stalled, NOT queen-dark)', () => {
    expect(deriveQueenAlive(queen({ stalled: true, armed: true }))).toBe(true);
  });
  it('DARK when started + NOT armed + stalled (no next wake AND stale = the loop is gone)', () => {
    expect(deriveQueenAlive(queen({ stalled: true, armed: false }))).toBe(false);
  });
  it('alive when started + not armed but not stalled (between wakes, not dead)', () => {
    expect(deriveQueenAlive(queen({ stalled: false, armed: false }))).toBe(true);
  });
  it('alive when paused (not started) — intentional, never a false dark alarm', () => {
    expect(deriveQueenAlive(queen({ started: false, armed: false, stalled: false }))).toBe(true);
  });
  it('alive when the queen panel is unreadable (null) — conservative, never false-dark', () => {
    expect(deriveQueenAlive(null)).toBe(true);
  });
});

describe('beesStatus', () => {
  const bees = (o: Partial<BeesHealth> = {}): BeesHealth => ({
    running: 2, alive: 2, stale: 0, orphanedClaims: 0, totalLoad: 2,
    placements: { recovering: 0, cursed: 0, stranded: 0, workingTracked: 2 }, ...o,
  });
  it('crit on a cursed placement', () => {
    expect(beesStatus(bees({ placements: { recovering: 0, cursed: 1, stranded: 0, workingTracked: 0 } }))).toBe('crit');
  });
  it('warn on orphaned claims', () => {
    expect(beesStatus(bees({ orphanedClaims: 1 }))).toBe('warn');
  });
  it('warn on stranded/recovering placements', () => {
    expect(beesStatus(bees({ placements: { recovering: 0, cursed: 0, stranded: 2, workingTracked: 0 } }))).toBe('warn');
  });
  it('ok with healthy bees', () => {
    expect(beesStatus(bees())).toBe('ok');
  });
});

describe('workItemsStatus', () => {
  const wi = (o: Partial<WorkItemsHealth> = {}): WorkItemsHealth => ({
    total: 10, byState: {}, todo: 4, inProgress: 3, blocked: 2, needsHuman: 0, done: 1, ...o,
  });
  it('warn when items need a human', () => {
    expect(workItemsStatus(wi({ needsHuman: 1 }))).toBe('warn');
  });
  it('ok otherwise (backlog alone is not unhealthy)', () => {
    expect(workItemsStatus(wi({ blocked: 50 }))).toBe('ok');
  });
  // Stuck-items recovery (work-queue-stuck-item-recovery P-008 / P-009).
  it('crit when the reaper is WEDGED (recorded but aged-out: reaperStale + non-null age)', () => {
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: 600 }))).toBe('crit');
  });
  it('warn (not crit) when the reaper has NEVER recorded a run (null age — fresh boot)', () => {
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null }))).toBe('warn');
  });
  it('warn when any feature is freed-but-non-dispatchable (stuck)', () => {
    expect(workItemsStatus(wi({ stuckFeatures: 1 }))).toBe('warn');
  });
  it('warn on a dead-held claim backlog or a dead-assigned issue', () => {
    expect(workItemsStatus(wi({ deadHeldClaims: 3 }))).toBe('warn');
    expect(workItemsStatus(wi({ deadAssignedIssues: 2 }))).toBe('warn');
  });
  it('ok when recovery fields are healthy (reaper fresh, nothing stuck)', () => {
    expect(workItemsStatus(wi({ reaperStale: false, reaperAgeSec: 30, stuckFeatures: 0, deadHeldClaims: 0 }))).toBe('ok');
  });
});

describe('workFeedStatus', () => {
  const wf = (o: Partial<WorkFeedHealth> = {}): WorkFeedHealth => ({
    frontier: 5, frontierBlocked: 1, startedPlans: 2, autoEligibleStuck: 0, deadRoutines: 0, deadRoutineNames: [], ...o,
  });
  it('crit on a dead routine (EI-584 — starves the feed)', () => {
    expect(workFeedStatus(wf({ deadRoutines: 1, deadRoutineNames: ['hive-wake'] }))).toBe('crit');
  });
  it('warn when auto-eligible work is stuck at attempts:0 (ready work not flowing)', () => {
    expect(workFeedStatus(wf({ autoEligibleStuck: 3 }))).toBe('warn');
  });
  it('crit (dead routine) dominates auto-stuck', () => {
    expect(workFeedStatus(wf({ autoEligibleStuck: 3, deadRoutines: 1, deadRoutineNames: ['x'] }))).toBe('crit');
  });
  it('ok with a healthy feed (frontier depth alone is fine)', () => {
    expect(workFeedStatus(wf({ frontier: 500 }))).toBe('ok');
  });
});

describe('tokensStatus', () => {
  const tk = (o: Partial<TokensHealth> = {}): TokensHealth => ({
    gatewayEnabled: false, gatewayReachable: null, pausedBuckets: 0, totalBuckets: 4,
    fleetInFlight: 1, fleetCap: 8, spendUsd: 1, windowMs: 3_600_000,
    accountsTotal: 3, accountsAvailable: 3, accountsPaused: 0, ...o,
  });
  it('crit when all accounts paused (starved)', () => {
    expect(tokensStatus(tk({ accountsAvailable: 0 }))).toBe('crit');
  });
  it('crit when gateway is in the path but unreachable', () => {
    expect(tokensStatus(tk({ gatewayEnabled: true, gatewayReachable: false }))).toBe('crit');
  });
  it('warn on a paused bucket (RPM pacing)', () => {
    expect(tokensStatus(tk({ pausedBuckets: 1 }))).toBe('warn');
  });
  it('warn on a paused account (but others available)', () => {
    expect(tokensStatus(tk({ accountsPaused: 1, accountsAvailable: 2 }))).toBe('warn');
  });
  it('does not crit on zero accounts configured (single bound credential)', () => {
    expect(tokensStatus(tk({ accountsTotal: 0, accountsAvailable: 0 }))).toBe('ok');
  });
  it('ok when healthy', () => {
    expect(tokensStatus(tk())).toBe('ok');
  });
});

describe('watchdogStatus', () => {
  const wd = (o: Partial<WatchdogHealth> = {}): WatchdogHealth => ({
    fires24h: 0, livenessArmed: true, staleForMs: 1000, recentErrors: 0, ...o,
  });
  it('warn when firing repeatedly', () => {
    expect(watchdogStatus(wd({ fires24h: 3 }))).toBe('warn');
  });
  it('ok when quiet (the watchdog firing is never itself crit)', () => {
    expect(watchdogStatus(wd({ fires24h: 1 }))).toBe('ok');
  });
});

describe('deployStatus', () => {
  const now = 1_000_000_000_000;
  const dp = (o: Partial<DeployHealth> = {}): DeployHealth => ({
    deployedShortSha: 'abcd1234', deployedBehindMain: 2, readyBehindMain: 0,
    deployedBehindReady: 2, readyAtMainHead: true, deployedAtMs: now - 1000,
    lastCommitAtMs: now - 60_000, errors: [], ...o,
  });
  it('unknown when no refs resolved (a box without the release checkout)', () => {
    expect(deployStatus(dp({ deployedShortSha: null, lastCommitAtMs: null }), now)).toBe('unknown');
  });
  it('warn when git-sync has lagged past the threshold', () => {
    expect(deployStatus(dp({ lastCommitAtMs: now - SYNC_LAG_WARN_MS - 1 }), now)).toBe('warn');
  });
  it('warn when the live host is far behind staging', () => {
    expect(deployStatus(dp({ deployedBehindMain: DEPLOY_BEHIND_WARN + 1 }), now)).toBe('warn');
  });
  it('ok when fresh + caught up', () => {
    expect(deployStatus(dp(), now)).toBe('ok');
  });
});

describe('plansStatus', () => {
  const pl = (o: Partial<PlansHealth> = {}): PlansHealth => ({
    active: 2, started: 1, shipped: 5, draft: 1, itemsDone: 3, itemsTotal: 8, stalledPlans: 0, ...o,
  });
  it('warn on a stalled started plan', () => {
    expect(plansStatus(pl({ stalledPlans: 1 }))).toBe('warn');
  });
  it('ok otherwise', () => {
    expect(plansStatus(pl())).toBe('ok');
  });
});

describe('escalationsStatus', () => {
  const es = (o: Partial<EscalationsHealth> = {}): EscalationsHealth => ({
    open: 0, oldestAgeMs: null, bySeverity: {}, aging: 0, ...o,
  });
  it('warn on an open blocker', () => {
    expect(escalationsStatus(es({ open: 1, bySeverity: { blocker: 1 } }))).toBe('warn');
  });
  it('warn on an aging open escalation', () => {
    expect(escalationsStatus(es({ open: 1, aging: 1, bySeverity: { warning: 1 } }))).toBe('warn');
  });
  it('ok when no open escalations', () => {
    expect(escalationsStatus(es())).toBe('ok');
  });
  it('ok on a fresh non-blocker escalation', () => {
    expect(escalationsStatus(es({ open: 1, bySeverity: { info: 1 } }))).toBe('ok');
  });
});

describe('autonomyStatus', () => {
  const au = (o: Partial<AutonomyHealth> = {}): AutonomyHealth => ({
    categories: 13, locked: 13, byCeiling: { 'never-auto': 13 },
    tripwiresArmed: 0, tripwiresTripped: 0, tripwiresReverted: 0, ...o,
  });
  it('warn on a tripped tripwire', () => {
    expect(autonomyStatus(au({ tripwiresTripped: 1 }))).toBe('warn');
  });
  it('ok when only armed (locked categories are intentional config)', () => {
    expect(autonomyStatus(au({ tripwiresArmed: 4 }))).toBe('ok');
  });
});

describe('overwatchStatus — the who-watches-the-watcher panel (#15, D-004)', () => {
  const ow = (o: Partial<OverwatchPanelHealth> = {}): OverwatchPanelHealth => ({
    flagEnabled: true, started: true, alive: true, armed: true, cadenceSec: 600,
    lastWakeAt: 0, nextFireAt: 0, staleForMs: 60_000, watchdogFires24h: 0, ...o,
  });
  it('unknown (greyed) when the flag is off — the intended default-off state, NOT a failure', () => {
    expect(overwatchStatus(ow({ flagEnabled: false, started: false }))).toBe('unknown');
  });
  it('unknown when pre-armed (flag off but started bit set, awaiting B-12)', () => {
    expect(overwatchStatus(ow({ flagEnabled: false, started: true }))).toBe('unknown');
  });
  it('unknown when proven-but-paused by the owner (flag on, not started)', () => {
    expect(overwatchStatus(ow({ started: false }))).toBe('unknown');
  });
  it('crit when live but DARK — the supervisor loop itself died (the D-004 failure)', () => {
    expect(overwatchStatus(ow({ alive: false }))).toBe('crit');
  });
  it('warn when the overwatch watchdog has fired repeatedly (forgot-to-declare bug)', () => {
    expect(overwatchStatus(ow({ watchdogFires24h: 3 }))).toBe('warn');
  });
  it('ok when live + looping (flag on, started, alive, quiet watchdog)', () => {
    expect(overwatchStatus(ow())).toBe('ok');
  });
  it('alive=null (uncomputable) is NOT crit — a started loop with unknown liveness stays ok', () => {
    expect(overwatchStatus(ow({ alive: null }))).toBe('ok');
  });
});

describe('worstStatus — the fail-soft roll-up', () => {
  it('crit dominates', () => {
    expect(worstStatus(['ok', 'warn', 'crit', 'unknown'])).toBe('crit');
  });
  it('warn over ok', () => {
    expect(worstStatus(['ok', 'warn', 'unknown'])).toBe('warn');
  });
  it('unknown NEVER reds the system — ok wins over a greyed panel', () => {
    expect(worstStatus(['ok', 'unknown', 'unknown'])).toBe('ok');
  });
  it('all-unknown rolls up to unknown', () => {
    expect(worstStatus(['unknown', 'unknown'])).toBe('unknown');
  });
  it('empty rolls up to unknown', () => {
    expect(worstStatus([])).toBe('unknown');
  });
});

describe('threshold constants are sane', () => {
  it('Queen stall is 30 minutes (the failure mode the tab exists for)', () => {
    expect(QUEEN_STALL_MS).toBe(30 * 60_000);
  });
});
