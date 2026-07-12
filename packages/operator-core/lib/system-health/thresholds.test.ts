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
  infraStatus,
  statusSeverity,
  ackCovers,
  reconcilePausedQueen,
  loopsStatus,
  coordinationStatus,
  memoryStatus,
  QUEEN_STALL_MS,
  SYNC_LAG_WARN_MS,
  DEPLOY_BEHIND_WARN,
  GIT_SYNC_PUSH_FAIL_CRIT,
  MCP_PROXY_HARD_FAIL_CRIT,
  DISK_USED_WARN_PCT,
  DISK_USED_CRIT_PCT,
  BACKUP_STALE_MS,
  UNANSWERED_DIRECTED_WARN_MS,
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
  InfraHealth,
  McpProxyHealth,
  LoopsHealth,
  CoordinationHealth,
  MemoryPanelHealth,
} from './types';

const queen = (o: Partial<QueenHealth> = {}): QueenHealth => ({
  potSlug: 'h', started: true, stalled: false, midTurn: false, armed: true,
  lastWakeAt: 0, staleForMs: 60_000, nextFireAt: 0, cadenceOk: true,
  watchdogFires24h: 0, demand: { todoItems: 0, startedPlans: 0 },
  decisionsWindow: { total: 0, auto: 0, gated: 0 }, workingTracked: 0, consecutiveZeroTokenWakes: 0, ...o,
});

describe('queenStatus', () => {
  it('crit when stalled (the origin failure mode)', () => {
    expect(queenStatus(queen({ stalled: true }))).toBe('crit');
  });
  it('warn when paused (not started) with nothing queued — idle by choice', () => {
    expect(queenStatus(queen({ started: false }))).toBe('warn');
  });
  it('crit when paused with demand queued — silent outage (P-003)', () => {
    expect(queenStatus(queen({ started: false, demand: { todoItems: 2, startedPlans: 0 } }))).toBe('crit');
    expect(queenStatus(queen({ started: false, demand: { todoItems: 0, startedPlans: 1 } }))).toBe('crit');
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
    running: 2, alive: 2, stale: 0, orphanedClaims: 0, totalLoad: 2, invalidModelFailures: 0,
    placements: { recovering: 0, cursed: 0, stranded: 0, workingTracked: 2 }, ...o,
  });
  it('crit on a cursed placement', () => {
    expect(beesStatus(bees({ placements: { recovering: 0, cursed: 1, stranded: 0, workingTracked: 0 } }))).toBe('crit');
  });
  it('warn on orphaned claims', () => {
    expect(beesStatus(bees({ orphanedClaims: 1 }))).toBe('warn');
  });
  it('warn on invalid selected-model spawn failures', () => {
    expect(beesStatus(bees({ invalidModelFailures: 1 }))).toBe('warn');
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
  it('warn (not crit) when the reaper has NEVER recorded a run (null age — fresh boot, no backlog)', () => {
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null }))).toBe('warn');
  });
  // EI-2534 (reclaim-lane-not-firing): a never-recorded reaper (un-armed/dark sweep)
  // WHILE a real dead-held backlog is stranded must escalate to crit — NOT the passive
  // warn that let 7 P1 claims sit ~3h. The boot-blip warn above only applies with no backlog.
  it('crit when the reaper has NEVER recorded a run AND a dead-held backlog is stranded (un-armed sweep)', () => {
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null, deadHeldClaims: 7 }))).toBe('crit');
  });
  it('crit on a never-recorded reaper with any stranded recovery backlog (stuck / dead-assigned / dead-held reservations)', () => {
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null, stuckFeatures: 1 }))).toBe('crit');
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null, deadAssignedIssues: 2 }))).toBe('crit');
    expect(workItemsStatus(wi({ reaperStale: true, reaperAgeSec: null, deadHeldAssignments: 3 }))).toBe('crit');
  });
  it('a dead-held backlog with a LIVE (fresh) reaper stays warn — it is actively being cleared, not stranded', () => {
    expect(workItemsStatus(wi({ reaperStale: false, reaperAgeSec: 30, deadHeldClaims: 7 }))).toBe('warn');
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
    accountsTotal: 3, accountsAvailable: 3, accountsPaused: 0, gateway: null, ...o,
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
  // ── Gateway wedge / throttle (B-GW-5) ──
  const gw = (o: Partial<NonNullable<TokensHealth['gateway']>> = {}): NonNullable<TokensHealth['gateway']> => ({
    inFlight: 3, queueDepth: 0, maxConcurrent: 24, concurrencyCap: 24, shed429: 0, shedAllThrottled: 0,
    failovers: 0, upstream429: 0, utilizationPct: 40, aimdEffective: 24, aimdCap: 24,
    wedge: false, saturated: false, sustainedThrottle: false, slotLeak: false,
    admissionStarvationRisk: false, admissionStarved: false, reasons: [], ...o,
  });
  it('crit when the gateway is WEDGED', () => {
    expect(tokensStatus(tk({ gateway: gw({ wedge: true, saturated: true }) }))).toBe('crit');
  });
  it('warn when the gateway is saturated (wedge-risk, not yet frozen)', () => {
    expect(tokensStatus(tk({ gateway: gw({ saturated: true }) }))).toBe('warn');
  });
  it('warn when the gateway is sustained-throttling', () => {
    expect(tokensStatus(tk({ gateway: gw({ sustainedThrottle: true }) }))).toBe('warn');
  });
  it('warn on a slot-leak (P-005/W3): a leaked slot the valve cannot reclaim, before it wedges', () => {
    expect(tokensStatus(tk({ gateway: gw({ slotLeak: true }) }))).toBe('warn');
  });
  it('ok with a healthy gateway sub-panel', () => {
    expect(tokensStatus(tk({ gateway: gw() }))).toBe('ok');
  });
  // ── WI-3565: admission starvation (deep queue BELOW the ceiling, idle healthy accounts unused) ──
  it('crit when admission is confirmed-starved AND idle accounts exceed the threshold', () => {
    expect(
      tokensStatus(tk({ accountsAvailable: 5, gateway: gw({ admissionStarved: true, queueDepth: 24, maxConcurrent: 2 }) })),
    ).toBe('crit');
  });
  it('NOT crit when confirmed-starved but idle accounts are at/below the threshold (no spare capacity to use)', () => {
    expect(
      tokensStatus(tk({ accountsAvailable: 2, gateway: gw({ admissionStarved: true, queueDepth: 24, maxConcurrent: 2 }) })),
    ).not.toBe('crit');
  });
  it('warn on an unconfirmed starvation RISK (not yet sustained 5min)', () => {
    expect(tokensStatus(tk({ gateway: gw({ admissionStarvationRisk: true }) }))).toBe('warn');
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
    lastCommitAtMs: now - 60_000, errors: [],
    gitSyncStatus: 'synced', gitSyncConsecutiveErrorTicks: 0,
    gitSyncPushBacklog: null, gitSyncLastSyncedAtMs: now - 60_000, gitSyncOversizedCount: 0, ...o,
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
  // EI-18 git-sync UPSTREAM-delivery signal (F3/P-032): a failing push is the deploy
  // panel's ONLY crit path — local commits silently not reaching origin.
  it('crit when git-sync push has failed >= the escalation threshold (commits not reaching origin)', () => {
    expect(deployStatus(dp({ gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: GIT_SYNC_PUSH_FAIL_CRIT }), now)).toBe('crit');
  });
  it('warns, not crit, when a live git check proves the push-failure counter is stale', () => {
    expect(deployStatus(dp({ gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: GIT_SYNC_PUSH_FAIL_CRIT + 20, gitSyncPushBacklog: 0 }), now)).toBe('warn');
  });
  it('keeps crit when the live git check still sees commits waiting to reach origin', () => {
    expect(deployStatus(dp({ gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: GIT_SYNC_PUSH_FAIL_CRIT, gitSyncPushBacklog: 2 }), now)).toBe('crit');
  });
  it('crit on push-failure even with no release refs (push-fail outranks unknown)', () => {
    expect(deployStatus(dp({ deployedShortSha: null, lastCommitAtMs: null, gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: GIT_SYNC_PUSH_FAIL_CRIT + 2 }), now)).toBe('crit');
  });
  it('warn (not crit) on a single git-sync error tick below the threshold', () => {
    expect(deployStatus(dp({ gitSyncStatus: 'error', gitSyncConsecutiveErrorTicks: 1 }), now)).toBe('warn');
  });
  it('warn when git-sync excluded an oversized blob (it will never push)', () => {
    expect(deployStatus(dp({ gitSyncOversizedCount: 1 }), now)).toBe('warn');
  });
});

describe('plansStatus', () => {
  const pl = (o: Partial<PlansHealth> = {}): PlansHealth => ({
    active: 2, started: 1, shipped: 5, draft: 1, itemsDone: 3, itemsTotal: 8, stalledPlans: 0, startedDraft: 0, ...o,
  });
  it('warn on a stalled started plan', () => {
    expect(plansStatus(pl({ stalledPlans: 1 }))).toBe('warn');
  });
  it('ok otherwise', () => {
    expect(plansStatus(pl())).toBe('ok');
  });
});

describe('escalationsStatus — keys on NEW aging, not standing backlog (health-tab-v2 P-003)', () => {
  const es = (o: Partial<EscalationsHealth> = {}): EscalationsHealth => ({
    open: 0, oldestAgeMs: null, bySeverity: {}, aging: 0, agingNew: 0, ...o,
  });
  it('warn on an open blocker', () => {
    expect(escalationsStatus(es({ open: 1, bySeverity: { blocker: 1 } }))).toBe('warn');
  });
  it('warn on a NEWLY-aging escalation (crossed the threshold in the last 24h)', () => {
    expect(escalationsStatus(es({ open: 1, aging: 1, agingNew: 1, bySeverity: { warning: 1 } }))).toBe('warn');
  });
  it('STANDING aging alone does NOT warn — a month-old backlog is a muted metric, not a fresh alarm (P-003)', () => {
    expect(escalationsStatus(es({ open: 3, aging: 3, agingNew: 0, bySeverity: { warning: 3 } }))).toBe('ok');
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
    lastWakeAt: 0, nextFireAt: 0, staleForMs: 60_000, watchdogFires24h: 0,
    scorecardEmission: null, scorecardSkipped: false, ...o,
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

const mcpProxy = (o: Partial<McpProxyHealth> = {}): McpProxyHealth => ({
  windowMs: 60 * 60_000, total: 0, hardFailures: 0, recovered: 0, otherNon2xx: 0, benign: 0, byKind: {}, newestAt: null, ...o,
});
const infra = (o: Partial<InfraHealth> = {}): InfraHealth => ({
  pg: { version: '16', total: 10, active: 2, idle: 8, postmasterStartMs: null }, gatewayReachable: true, perf: null, mcpProxy: null, ...o,
});

describe('infraStatus — PG + gateway + perf + MCP-proxy SLO (W8/P-008)', () => {
  it('ok when PG healthy, gateway up, no perf/mcp signal', () => {
    expect(infraStatus(infra())).toBe('ok');
  });
  it('unknown when PG is unreadable (greyed leg) and nothing else reds it', () => {
    expect(infraStatus(infra({ pg: null }))).toBe('unknown');
  });
  it('crit when the gateway is enabled-but-unreachable (spine down)', () => {
    expect(infraStatus(infra({ gatewayReachable: false }))).toBe('crit');
  });
  it('crit on a per-thread perf WEDGE (operator_degraded)', () => {
    // A minimal PerfVerdict-shaped object — only `status` is read by infraStatus.
    expect(infraStatus(infra({ perf: { status: 'crit' } as InfraHealth['perf'] }))).toBe('crit');
  });

  // ── MCP tool-call transport SLO (W8/P-008) ──────────────────────────────────
  it('ok when the MCP proxy reports zero hard failures (healthy transport)', () => {
    expect(infraStatus(infra({ mcpProxy: mcpProxy({ hardFailures: 0, recovered: 5 }) }))).toBe('ok');
  });
  it('warn on ANY MCP-proxy hard failure — ends the "transient is normal" culture (visible, sub-page)', () => {
    expect(infraStatus(infra({ mcpProxy: mcpProxy({ hardFailures: 1, total: 1 }) }))).toBe('warn');
  });
  it('crit at/above MCP_PROXY_HARD_FAIL_CRIT hard failures — a regression that pages', () => {
    expect(infraStatus(infra({ mcpProxy: mcpProxy({ hardFailures: MCP_PROXY_HARD_FAIL_CRIT }) }))).toBe('crit');
  });
  it('a crit MCP-proxy SLO breach OUTRANKS a greyed (null) PG leg — a real failure beats unknown', () => {
    expect(infraStatus(infra({ pg: null, mcpProxy: mcpProxy({ hardFailures: MCP_PROXY_HARD_FAIL_CRIT }) }))).toBe('crit');
  });
  it('a null mcpProxy leg (ledger unreadable) contributes nothing — fail-soft', () => {
    expect(infraStatus(infra({ mcpProxy: null }))).toBe('ok');
  });
  it('a perf crit still dominates an MCP-proxy warn', () => {
    expect(infraStatus(infra({ perf: { status: 'crit' } as InfraHealth['perf'], mcpProxy: mcpProxy({ hardFailures: 1 }) }))).toBe('crit');
  });
  it('a critical PG-pool band warns — the routinesTick freeze mode (P-006/W4)', () => {
    expect(infraStatus(infra({ pool: { probeMs: 5000, band: 'critical' } }))).toBe('warn');
  });
  it('an elevated / ok / absent PG-pool band does not raise infra on its own (P-006/W4)', () => {
    expect(infraStatus(infra({ pool: { probeMs: 1800, band: 'elevated' } }))).toBe('ok');
    expect(infraStatus(infra({ pool: { probeMs: 40, band: 'ok' } }))).toBe('ok');
    expect(infraStatus(infra({ pool: undefined }))).toBe('ok'); // deploy-skew: field absent
  });
  it('a perf crit still dominates a PG-pool warn', () => {
    expect(infraStatus(infra({ perf: { status: 'crit' } as InfraHealth['perf'], pool: { probeMs: 5000, band: 'critical' } }))).toBe('crit');
  });
});

describe('threshold constants are sane', () => {
  it('Queen stall is 30 minutes (the failure mode the tab exists for)', () => {
    expect(QUEEN_STALL_MS).toBe(30 * 60_000);
  });
  it('MCP-proxy hard-fail crit threshold is a positive integer (the SLO page line)', () => {
    expect(MCP_PROXY_HARD_FAIL_CRIT).toBeGreaterThan(0);
    expect(Number.isInteger(MCP_PROXY_HARD_FAIL_CRIT)).toBe(true);
  });
  it('disk warn is below disk crit (health-tab-v2 P-011)', () => {
    expect(DISK_USED_WARN_PCT).toBeLessThan(DISK_USED_CRIT_PCT);
  });
  it('backup staleness threshold is 48h (cadence is ~hours)', () => {
    expect(BACKUP_STALE_MS).toBe(48 * 60 * 60_000);
  });
});

// ── health-tab-v2 (2026-07-12) additions ─────────────────────────────────────

describe('infraStatus — disk / migration-drift / backup legs (health-tab-v2 P-011)', () => {
  it('crit at >=95% used on any watched volume — writes are about to fail', () => {
    expect(infraStatus(infra({ disk: [{ path: '/', usedPct: 96 }, { path: '/data', usedPct: 40 }] }))).toBe('crit');
  });
  it('disk crit outranks a greyed PG leg (like the MCP-proxy SLO)', () => {
    expect(infraStatus(infra({ pg: null, disk: [{ path: '/', usedPct: DISK_USED_CRIT_PCT }] }))).toBe('crit');
  });
  it('warn at >=90% used', () => {
    expect(infraStatus(infra({ disk: [{ path: '/', usedPct: 91 }] }))).toBe('warn');
  });
  it('ok below the warn line; null/empty disk contributes nothing (fail-soft)', () => {
    expect(infraStatus(infra({ disk: [{ path: '/', usedPct: 72 }] }))).toBe('ok');
    expect(infraStatus(infra({ disk: null }))).toBe('ok');
    expect(infraStatus(infra({ disk: [] }))).toBe('ok');
  });
  it('warn on unapplied migrations (one restart away from surprise DDL)', () => {
    expect(infraStatus(infra({ migrationDrift: { unapplied: 2 } }))).toBe('warn');
    expect(infraStatus(infra({ migrationDrift: { unapplied: 0 } }))).toBe('ok');
  });
  it('warn when the newest OK backup is older than the staleness window', () => {
    expect(infraStatus(infra({ backup: { lastOkAtMs: 1, ageMs: BACKUP_STALE_MS + 1, lastStatus: 'ok' } }))).toBe('warn');
    expect(infraStatus(infra({ backup: { lastOkAtMs: 1, ageMs: 60_000, lastStatus: 'ok' } }))).toBe('ok');
    expect(infraStatus(infra({ backup: null }))).toBe('ok'); // leg unreadable — fail-soft
  });
});

describe('statusSeverity + ackCovers — ack coverage semantics (P-004 / D-A)', () => {
  it('severity ladder: crit 2, warn 1, ok/unknown 0', () => {
    expect(statusSeverity('crit')).toBe(2);
    expect(statusSeverity('warn')).toBe(1);
    expect(statusSeverity('ok')).toBe(0);
    expect(statusSeverity('unknown')).toBe(0);
  });
  const now = 1_000_000;
  it('an ack at crit covers warn AND crit', () => {
    expect(ackCovers({ status: 'crit', snoozeUntil: null }, 'crit', now)).toBe(true);
    expect(ackCovers({ status: 'crit', snoozeUntil: null }, 'warn', now)).toBe(true);
  });
  it('an ack at warn does NOT cover a later crit — escalation re-alarms', () => {
    expect(ackCovers({ status: 'warn', snoozeUntil: null }, 'crit', now)).toBe(false);
    expect(ackCovers({ status: 'warn', snoozeUntil: null }, 'warn', now)).toBe(true);
  });
  it('ok/unknown are never "covered" (the sweep clears the ack instead)', () => {
    expect(ackCovers({ status: 'crit', snoozeUntil: null }, 'ok', now)).toBe(false);
    expect(ackCovers({ status: 'crit', snoozeUntil: null }, 'unknown', now)).toBe(false);
  });
  it('an expired snooze covers nothing; a live snooze still covers', () => {
    expect(ackCovers({ status: 'warn', snoozeUntil: now - 1 }, 'warn', now)).toBe(false);
    expect(ackCovers({ status: 'warn', snoozeUntil: now + 60_000 }, 'warn', now)).toBe(true);
  });
});

describe('reconcilePausedQueen — the paused-Mug cry-wolf fix (P-001)', () => {
  const pausedQueen = (todo: number) =>
    ({ status: 'crit' as const, data: queen({ started: false, armed: false, demand: { todoItems: todo, startedPlans: 0 } }) });
  const wf = (o: Partial<WorkFeedHealth> = {}): WorkFeedHealth => ({
    frontier: 0, frontierBlocked: 0, startedPlans: 0, autoEligibleStuck: 0, deadRoutines: 0, deadRoutineNames: [], ...o,
  });
  it('paused + PLACEABLE frontier stays crit (a genuine silent outage)', () => {
    const r = reconcilePausedQueen(pausedQueen(3), { data: wf({ frontier: 2 }) });
    expect(r?.status).toBe('crit');
    expect(r?.summary).toContain('2 placeable item(s)');
  });
  it('paused + started plans (no frontier) stays crit', () => {
    const r = reconcilePausedQueen(pausedQueen(0), { data: wf({ startedPlans: 1 }) });
    expect(r?.status).toBe('crit');
    expect(r?.summary).toContain('started plan(s)');
  });
  it('paused + only STUCK frontier downgrades to warn — idle by choice, summary agrees', () => {
    const r = reconcilePausedQueen(pausedQueen(2), { data: wf({ frontier: 2, frontierStuck: 2 }) });
    expect(r?.status).toBe('warn');
    expect(r?.summary).toContain('none placeable');
  });
  it('paused + empty queue downgrades to warn (colony idle by choice)', () => {
    const r = reconcilePausedQueen(pausedQueen(0), { data: wf() });
    expect(r?.status).toBe('warn');
    expect(r?.summary).toContain('idle by choice');
  });
  it('unreadable work-feed keeps the conservative crit (returns null — no adjustment)', () => {
    expect(reconcilePausedQueen(pausedQueen(2), { data: null })).toBeNull();
  });
  it('no adjustment when not paused or not crit', () => {
    expect(reconcilePausedQueen({ status: 'crit', data: queen({ started: true, stalled: true }) }, { data: wf() })).toBeNull();
    expect(reconcilePausedQueen({ status: 'warn', data: queen({ started: false }) }, { data: wf() })).toBeNull();
    expect(reconcilePausedQueen({ status: 'crit', data: null }, { data: wf() })).toBeNull();
  });
});

describe('loopsStatus — engine self-wake loops (P-008)', () => {
  const lo = (o: Partial<LoopsHealth> = {}): LoopsHealth => ({
    armed: 2, overdue: 0, overdueNames: [], failureStreaks: 0, lastFireAt: null, ...o,
  });
  it('warn on an overdue armed loop', () => {
    expect(loopsStatus(lo({ overdue: 1, overdueNames: ['loop-su-x'] }))).toBe('warn');
  });
  it('warn on a failure streak', () => {
    expect(loopsStatus(lo({ failureStreaks: 1 }))).toBe('warn');
  });
  it('ok with healthy loops — and ok with zero armed loops (none is not a failure)', () => {
    expect(loopsStatus(lo())).toBe('ok');
    expect(loopsStatus(lo({ armed: 0 }))).toBe('ok');
  });
});

describe('coordinationStatus — WARN-max during burn-in (P-009 / D-D)', () => {
  const co = (o: Partial<CoordinationHealth> = {}): CoordinationHealth => ({
    unansweredAgents: 0, unansweredTotal: 0, unansweredOldestMs: null,
    criticalContext: 0, highContext: 0, activeAwaits: 0, staleAwaits: 0,
    leaderlessFleets: 0, liveFleets: 0, ...o,
  });
  it('warn on a leaderless fleet', () => {
    expect(coordinationStatus(co({ leaderlessFleets: 1, liveFleets: 2 }))).toBe('warn');
  });
  it('warn on stale (likely stranded) awaits', () => {
    expect(coordinationStatus(co({ activeAwaits: 5, staleAwaits: 1 }))).toBe('warn');
  });
  it('warn on critical context pressure', () => {
    expect(coordinationStatus(co({ criticalContext: 1, highContext: 3 }))).toBe('warn');
  });
  it('warn on an unanswered directed message past the threshold — never crit (burn-in)', () => {
    expect(coordinationStatus(co({ unansweredOldestMs: UNANSWERED_DIRECTED_WARN_MS + 1 }))).toBe('warn');
  });
  it('a fresh unanswered directed message does not warn yet', () => {
    expect(coordinationStatus(co({ unansweredTotal: 1, unansweredOldestMs: 60_000 }))).toBe('ok');
  });
  it('high (not critical) context alone is ok; ok when quiet', () => {
    expect(coordinationStatus(co({ highContext: 4 }))).toBe('ok');
    expect(coordinationStatus(co())).toBe('ok');
  });
  it('is warn-max by construction: every alarming input together still warns', () => {
    expect(coordinationStatus(co({
      leaderlessFleets: 2, staleAwaits: 3, criticalContext: 2,
      unansweredOldestMs: 4 * UNANSWERED_DIRECTED_WARN_MS,
    }))).toBe('warn');
  });
});

describe('memoryStatus — degraded recall over a real store (P-010)', () => {
  const me = (o: Partial<MemoryPanelHealth> = {}): MemoryPanelHealth => ({
    totalMemories: 500, entityRows: 0, feedback30d: 10, zeroHitRate: 0.2, ...o,
  });
  it('warn only when a REAL store has a ~dead recall signal', () => {
    expect(memoryStatus(me({ zeroHitRate: 0.95 }))).toBe('warn');
  });
  it('a small/new store never warns, whatever its hit rate', () => {
    expect(memoryStatus(me({ totalMemories: 50, zeroHitRate: 1 }))).toBe('ok');
  });
  it('no telemetry (null rate) is ok — fail-soft, and a healthy rate is ok', () => {
    expect(memoryStatus(me({ zeroHitRate: null }))).toBe('ok');
    expect(memoryStatus(me())).toBe('ok');
  });
});
