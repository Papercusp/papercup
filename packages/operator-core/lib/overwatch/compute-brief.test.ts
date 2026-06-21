import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { computeSystemHealth } from '../system-health';
import { detectAnomalies, withAnomalies, mapSystemHealthToBrief, computeOverwatchBrief } from './compute-brief';
import { emptyOverwatchBrief, renderOverwatchBrief, type Anomaly, type OverwatchBrief } from './brief-types';
import type {
  SystemHealth,
  HealthPanel,
  PanelKey,
  PanelStatus,
  QueenHealth,
  BeesHealth,
  WorkFeedHealth,
  TokensHealth,
  PlansHealth,
  EscalationsHealth,
  ObservationsHealth,
} from '../system-health/types';

// Mock ONLY the runtime aggregator (the index's computeSystemHealth) — the mapper
// tests are pure (no DB), and the wrapper tests drive this mock. The SystemHealth
// TYPES come from '../system-health/types' (type-only, erased), so the real
// compute.ts + its DB deps never load in this unit file. `deriveQueenAlive` (the
// shared liveness derivation the mapper calls, EI-623) is pure — re-export the REAL
// one from the DB-free './thresholds' module so the mapper derives correctly here.
vi.mock('../system-health', async () => {
  const real = await vi.importActual<typeof import('../system-health/thresholds')>('../system-health/thresholds');
  return { computeSystemHealth: vi.fn(), deriveQueenAlive: real.deriveQueenAlive, queenPlacementStalled: real.queenPlacementStalled };
});

// computeOverwatchBrief resolves the Queen's coord owner (the nudge address) AND
// pre-folds the overwatch's own coord inbox, via dynamic imports — mock the DB +
// the readInbox/workspace-als/resolveQueenOwner deps so the wrapper test drives
// both without a real DB. `ownerRows` backs the inbox-owner SELECT (a tagged-
// template call); `readInbox` backs the inbox read.
const owner = vi.hoisted(() => ({
  resolveQueenOwner: vi.fn(),
  readInbox: vi.fn(async (..._a: unknown[]) => [] as Array<Record<string, unknown>>),
  ownerRows: [] as Array<{ coord_owner_id: string }>,
}));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: () => Promise.resolve(owner.ownerRows) }) }));
vi.mock('../hive/placement-watchdog', () => ({ resolveQueenOwner: owner.resolveQueenOwner }));
vi.mock('../agent-tools/coordination/messages', () => ({ readInbox: (...a: unknown[]) => owner.readInbox(...a) }));
vi.mock('../workspace-als', () => ({ runWithWorkspace: (_ws: string, fn: () => unknown) => fn() }));

/** A healthy brief we mutate one panel at a time to trip exactly one detector. */
function base(): OverwatchBrief {
  return emptyOverwatchBrief('papercup-hive');
}

function only(anomalies: Anomaly[], kind: string): Anomaly {
  const hit = anomalies.filter((a) => a.kind === kind);
  assert.equal(hit.length, 1, `expected exactly one ${kind}, got ${anomalies.map((a) => a.kind).join(',') || '(none)'}`);
  return hit[0];
}

test('detectAnomalies — healthy brief trips nothing', () => {
  assert.deepEqual(detectAnomalies(base()), []);
});

test('detectAnomalies — a stalled Queen → a critical queen-stalled NUDGE (B-11)', () => {
  const b = base();
  b.queen = { lastWakeAt: '2026-06-15T01:00:00Z', stalled: true, cadenceOk: false, workingTracked: 2, nextFireAt: null, coordOwner: null, consecutiveZeroTokenWakes: 0 };
  const a = only(detectAnomalies(b), 'queen-stalled');
  assert.equal(a.severity, 'critical');
  assert.equal(a.suggestedAction.type, 'nudge');
  assert.equal(a.suggestedAction.target, 'queen');
  assert.match(a.detail, /2 placement\(s\) in flight/);
});

test('detectAnomalies — a dark Queen → queen-dark, and it SUPPRESSES queen-stalled (precedence)', () => {
  const b = base();
  b.queen.stalled = true; // both conditions true
  b.crossMonitor.queenAlive = false;
  const anomalies = detectAnomalies(b);
  const a = only(anomalies, 'queen-dark');
  assert.equal(a.severity, 'critical');
  assert.equal(a.suggestedAction.type, 'nudge');
  assert.equal(anomalies.filter((x) => x.kind === 'queen-stalled').length, 0, 'queen-stalled must be suppressed by queen-dark');
});

test('detectAnomalies — a paused bucket WITH accounts → token-paused warning OBSERVE (transient)', () => {
  const b = base();
  b.tokens = { pausedBuckets: ['opus'], gatewayFailovers: 0, gw429s: 5, accountsAvailable: 2, gatewayWedged: false, gatewaySustainedThrottle: false };
  const a = only(detectAnomalies(b), 'token-paused');
  assert.equal(a.severity, 'warning');
  assert.equal(a.suggestedAction.type, 'observe');
  assert.equal(a.suggestedAction.target, undefined);
});

test('detectAnomalies — a paused bucket with ZERO accounts → token-paused critical ESCALATE (starvation)', () => {
  const b = base();
  b.tokens = { pausedBuckets: ['opus', 'sonnet'], gatewayFailovers: 1, gw429s: 9, accountsAvailable: 0, gatewayWedged: false, gatewaySustainedThrottle: false };
  const a = only(detectAnomalies(b), 'token-paused');
  assert.equal(a.severity, 'critical');
  assert.equal(a.suggestedAction.type, 'escalate');
  assert.match(a.detail, /no accounts available/);
});

test('detectAnomalies — gateway WEDGED → gateway-wedge critical ESCALATE owner (B-GW-5)', () => {
  const b = base();
  b.tokens.gatewayWedged = true;
  const a = only(detectAnomalies(b), 'gateway-wedge');
  assert.equal(a.severity, 'critical');
  assert.equal(a.suggestedAction.type, 'escalate');
  assert.equal(a.suggestedAction.target, 'owner');
  assert.match(a.detail, /WEDGED/);
});

test('detectAnomalies — gateway sustained-throttle (not wedged) → gateway-throttle warning OBSERVE', () => {
  const b = base();
  b.tokens.gatewaySustainedThrottle = true;
  const a = only(detectAnomalies(b), 'gateway-throttle');
  assert.equal(a.severity, 'warning');
  assert.equal(a.suggestedAction.type, 'observe');
});

test('detectAnomalies — a wedge SUPPRESSES the throttle anomaly (wedge is the louder superset)', () => {
  const b = base();
  b.tokens.gatewayWedged = true;
  b.tokens.gatewaySustainedThrottle = true;
  const kinds = detectAnomalies(b).map((a) => a.kind);
  assert.ok(kinds.includes('gateway-wedge'));
  assert.ok(!kinds.includes('gateway-throttle'), 'wedge wins; do not double-flag');
});

test('detectAnomalies — a dead routine → work-feed-stuck critical ESCALATE (B-11)', () => {
  const b = base();
  b.workFeed = { frontier: 3, autoEligibleStuck: 4, deadRoutines: 1, blockedStranded: 0 };
  const hits = detectAnomalies(b).filter((a) => a.kind === 'work-feed-stuck');
  // Dead-routine present → the structural escalate fires; the placeable-but-stuck
  // nudge is suppressed (deadRoutines>0 guards it) to avoid double-flagging.
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'critical');
  assert.equal(hits[0].suggestedAction.type, 'escalate');
});

test('detectAnomalies — placeable frontier unplaced with routines alive → work-feed-stuck warning NUDGE queen', () => {
  const b = base();
  // EI-2357: the nudge keys off the genuinely Queen-placeable FRONTIER, not the
  // dispatcher lane. frontier:3 (real placeable work) + routines alive → nudge fires.
  b.workFeed = { frontier: 3, autoEligibleStuck: 5, deadRoutines: 0, blockedStranded: 0 };
  const a = only(detectAnomalies(b), 'work-feed-stuck');
  assert.equal(a.severity, 'warning');
  assert.equal(a.suggestedAction.type, 'nudge');
  assert.equal(a.suggestedAction.target, 'queen');
  assert.match(a.detail, /placeable frontier/);
});

test('detectAnomalies — EI-2357 recurrence guard: dispatcher-lane backlog with frontier=0 does NOT nudge/escalate the Queen', () => {
  const b = base();
  // The auto-implement dispatcher's drain lane is large (126 code-bug items at
  // attempts:0), but the Queen-placeable frontier is 0 — she has nothing to place.
  // Must raise NO work-feed-stuck anomaly (this was the chronic false "Queen drove 0
  // placements" + recurring false HUMAN escalations; a stalled dispatcher is surfaced
  // separately by the dispatcher-staleness watchdog).
  b.workFeed = { frontier: 0, autoEligibleStuck: 126, deadRoutines: 0, blockedStranded: 0 };
  const hits = detectAnomalies(b).filter((a) => a.kind === 'work-feed-stuck');
  assert.equal(hits.length, 0);
});

test('detectAnomalies — Queen alive + on cadence but 0-token wakes with placeable frontier → queen-placement-stalled ESCALATE owner (D-009)', () => {
  const b = base();
  // The Queen looks healthy to the cadence signals (alive, not stalled) — this is the
  // silent-stall gap the existing queen-stalled / queen-dark detectors MISS: she wakes on
  // cadence but her wakes run 0 LLM tokens (the LLM never executes — infra/rate-limit loss).
  b.queen.consecutiveZeroTokenWakes = 3;
  b.workFeed = { frontier: 7, autoEligibleStuck: 0, deadRoutines: 0, blockedStranded: 0 };
  const a = only(detectAnomalies(b), 'queen-placement-stalled');
  assert.equal(a.severity, 'warning');
  assert.equal(a.suggestedAction.type, 'escalate');
  assert.equal(a.suggestedAction.target, 'owner');
  // Mutually exclusive with the cadence-liveness anomalies.
  assert.equal(detectAnomalies(b).filter((x) => x.kind === 'queen-stalled' || x.kind === 'queen-dark').length, 0);
});

test('detectAnomalies — queen-placement-stalled does NOT fire when frontier=0 (nothing to place)', () => {
  const b = base();
  b.queen.consecutiveZeroTokenWakes = 5;
  b.workFeed = { frontier: 0, autoEligibleStuck: 0, deadRoutines: 0, blockedStranded: 0 };
  assert.equal(detectAnomalies(b).filter((x) => x.kind === 'queen-placement-stalled').length, 0);
});

test('detectAnomalies — queen-placement-stalled does NOT fire on <3 zero-token wakes (one-off blip)', () => {
  const b = base();
  b.queen.consecutiveZeroTokenWakes = 2;
  b.workFeed = { frontier: 7, autoEligibleStuck: 0, deadRoutines: 0, blockedStranded: 0 };
  assert.equal(detectAnomalies(b).filter((x) => x.kind === 'queen-placement-stalled').length, 0);
});

test('detectAnomalies — stranded-on-resolved-constraint → NUDGE queen to re-open', () => {
  const b = base();
  b.workFeed = { frontier: 0, autoEligibleStuck: 0, deadRoutines: 0, blockedStranded: 2 };
  const a = only(detectAnomalies(b), 'work-feed-stuck');
  assert.equal(a.subject, 'stranded work');
  assert.equal(a.suggestedAction.type, 'nudge');
  assert.match(a.suggestedAction.message ?? '', /re-open/);
});

test('detectAnomalies — bees churning / dead claims → bees-churning NUDGE queen', () => {
  const b = base();
  b.bees = { running: 4, completed: 2, churning: 1, deadClaims: 1 };
  const a = only(detectAnomalies(b), 'bees-churning');
  assert.equal(a.severity, 'warning'); // dead claims present → warning, not info
  assert.equal(a.suggestedAction.type, 'nudge');
  assert.match(a.detail, /1 churning · 1 dead claim/);
});

test('detectAnomalies — aging escalations → escalation-aging NUDGE queen', () => {
  const b = base();
  b.plans = { active: 5, stalledItems: 0, agingEscalations: 3 };
  const a = only(detectAnomalies(b), 'escalation-aging');
  assert.equal(a.severity, 'warning');
  assert.equal(a.suggestedAction.type, 'nudge');
});

test('detectAnomalies — observation lane flat while bees run → observation-dark OBSERVE; quiet when no bees run', () => {
  const b = base();
  b.bees.running = 3;
  b.observations = { laneCount: 0, recentByRole: {} };
  const a = only(detectAnomalies(b), 'observation-dark');
  assert.equal(a.suggestedAction.type, 'observe');
  // No bees running → not a drift (an idle system has nothing to observe).
  const idle = base();
  idle.observations = { laneCount: 0, recentByRole: {} };
  assert.equal(detectAnomalies(idle).filter((x) => x.kind === 'observation-dark').length, 0);
});

test('detectAnomalies — deterministic: same brief → identical anomalies', () => {
  const b = base();
  b.queen.stalled = true;
  b.tokens.pausedBuckets = ['opus'];
  b.tokens.accountsAvailable = 1;
  assert.deepEqual(detectAnomalies(b), detectAnomalies(b));
});

test('withAnomalies — populates the brief and renders most-severe-first end-to-end', () => {
  const b = base();
  b.queen.stalled = true; // critical
  b.plans.agingEscalations = 2; // warning
  b.bees = { running: 2, completed: 0, churning: 1, deadClaims: 0 }; // info
  b.observations.laneCount = 5; // suppress observation-dark so we isolate the 3 tiers
  const populated = withAnomalies(b);
  assert.equal(populated.anomalies.length, 3);
  // Does not mutate the input.
  assert.equal(b.anomalies.length, 0);
  // The renderer (B-02) orders them critical → warning → info.
  const out = renderOverwatchBrief(populated);
  const q = out.indexOf('queen-stalled');
  const esc = out.indexOf('escalation-aging');
  const bee = out.indexOf('bees-churning');
  assert.ok(q < esc && esc < bee, 'rendered order is critical < warning < info');
});

/* ────────────────────────────────────────────────────────────────────────────
 * The aggregator wrapper: mapSystemHealthToBrief (pure) + computeOverwatchBrief.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A status-card wrapper. `data:null` ⇒ status 'unknown' (the greyed/unreadable case). */
function hp<T>(key: PanelKey, data: T | null, status: PanelStatus = data == null ? 'unknown' : 'ok'): HealthPanel<T> {
  return { key, label: key, status, summary: '', metrics: [], data };
}

/** A greyed/unreadable panel (T inferred from the assignment's contextual type). */
function naPanel<T>(key: PanelKey): HealthPanel<T> {
  return { key, label: key, status: 'unknown', summary: '', metrics: [], data: null };
}

const queenData = (o: Partial<QueenHealth> = {}): QueenHealth => ({
  hiveSlug: 'papercup-hive',
  started: true,
  stalled: false,
  midTurn: false,
  armed: true,
  lastWakeAt: 1,
  staleForMs: 0,
  nextFireAt: 2,
  cadenceOk: true,
  watchdogFires24h: 0,
  demand: { todoItems: 0, startedPlans: 0 },
  decisionsWindow: { total: 0, auto: 0, gated: 0 },
  workingTracked: 0,
  consecutiveZeroTokenWakes: 0,
  ...o,
});

const beesData = (o: Partial<BeesHealth> = {}): BeesHealth => ({
  running: 0,
  alive: 0,
  stale: 0,
  orphanedClaims: 0,
  totalLoad: 0,
  placements: { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0 },
  ...o,
});

const workFeedData = (o: Partial<WorkFeedHealth> = {}): WorkFeedHealth => ({
  frontier: 0,
  frontierBlocked: 0,
  startedPlans: 0,
  autoEligibleStuck: 0,
  deadRoutines: 0,
  deadRoutineNames: [],
  ...o,
});

const tokensData = (o: Partial<TokensHealth> = {}): TokensHealth => ({
  gatewayEnabled: true,
  gatewayReachable: true,
  pausedBuckets: 0,
  totalBuckets: 5,
  fleetInFlight: 0,
  fleetCap: 10,
  spendUsd: 0,
  windowMs: 0,
  accountsTotal: 3,
  accountsAvailable: 3,
  accountsPaused: 0,
  gateway: null,
  ...o,
});

const plansData = (o: Partial<PlansHealth> = {}): PlansHealth => ({
  active: 0,
  started: 0,
  shipped: 0,
  draft: 0,
  itemsDone: 0,
  itemsTotal: 0,
  stalledPlans: 0,
  ...o,
});

const escalationsData = (o: Partial<EscalationsHealth> = {}): EscalationsHealth => ({
  open: 0,
  oldestAgeMs: null,
  bySeverity: {},
  aging: 0,
  ...o,
});

const observationsData = (o: Partial<ObservationsHealth> = {}): ObservationsHealth => ({
  laneCount: 0,
  recentByRole: {},
  newestAt: null,
  ...o,
});

/**
 * A full SystemHealth fixture (all 15 panels — the type requires them). Pass a
 * panel's data to fill it, `null` to simulate an unreadable (greyed) panel, or
 * omit it for the healthy default. Panels the overwatch mapper ignores default to
 * `null`. `'papercup-hive'` is the brief's hive in every case.
 */
function fakeHealth(
  p: {
    queen?: QueenHealth | null;
    bees?: BeesHealth | null;
    workFeed?: WorkFeedHealth | null;
    tokens?: TokensHealth | null;
    plans?: PlansHealth | null;
    escalations?: EscalationsHealth | null;
    observations?: ObservationsHealth | null;
    overwatchAlive?: boolean | null;
  } = {},
): SystemHealth {
  const pick = <T>(v: T | null | undefined, dflt: T): T | null => (v === undefined ? dflt : v);
  return {
    workspaceId: 'ws',
    evaluatedAt: 0,
    overall: 'ok',
    crossMonitor: { queenAlive: true, overwatchAlive: p.overwatchAlive === undefined ? null : p.overwatchAlive },
    panels: {
      queen: hp('queen', pick(p.queen, queenData())),
      bees: hp('bees', pick(p.bees, beesData())),
      workItems: naPanel('workItems'),
      workFeed: hp('workFeed', pick(p.workFeed, workFeedData())),
      tokens: hp('tokens', pick(p.tokens, tokensData())),
      watchdog: naPanel('watchdog'),
      deploy: naPanel('deploy'),
      plans: hp('plans', pick(p.plans, plansData())),
      escalations: hp('escalations', pick(p.escalations, escalationsData())),
      autonomy: naPanel('autonomy'),
      observations: hp('observations', pick(p.observations, observationsData())),
      improvements: naPanel('improvements'),
      infra: naPanel('infra'),
      suFleet: naPanel('suFleet'),
      overwatch: naPanel('overwatch'),
    },
  };
}

test('mapSystemHealthToBrief — a healthy snapshot maps to a clean (no-anomaly) brief', () => {
  const brief = withAnomalies(mapSystemHealthToBrief(fakeHealth(), 'papercup-hive'));
  assert.equal(brief.hiveSlug, 'papercup-hive');
  assert.deepEqual(brief.anomalies, []);
  assert.equal(brief.queen.stalled, false);
  assert.equal(brief.crossMonitor.queenAlive, true);
  assert.equal(brief.crossMonitor.overwatchAlive, true); // null on its own brief ⇒ alive
});

test('mapSystemHealthToBrief — maps each panel onto the C-1 subset (counts + ms→ISO + cross-panel)', () => {
  const h = fakeHealth({
    queen: queenData({
      lastWakeAt: Date.parse('2026-06-15T01:00:00.000Z'),
      nextFireAt: Date.parse('2026-06-15T01:30:00.000Z'),
      workingTracked: 3,
    }),
    bees: beesData({ running: 5, stale: 2, orphanedClaims: 1, placements: { recovering: 0, cursed: 0, stranded: 4, workingTracked: 3 } }),
    workFeed: workFeedData({ frontier: 7, deadRoutines: 1 }),
    tokens: tokensData({ pausedBuckets: 2, totalBuckets: 5, accountsAvailable: 3 }),
    plans: plansData({ active: 9, stalledPlans: 2 }),
    escalations: escalationsData({ aging: 4 }),
    observations: observationsData({ laneCount: 6, recentByRole: { queen: 2, worker: 4 } }),
  });
  const b = mapSystemHealthToBrief(h, 'papercup-hive');
  assert.equal(b.queen.lastWakeAt, '2026-06-15T01:00:00.000Z');
  assert.equal(b.queen.nextFireAt, '2026-06-15T01:30:00.000Z');
  assert.equal(b.queen.workingTracked, 3);
  assert.equal(b.bees.running, 5);
  assert.equal(b.bees.churning, 2); // ← bees.stale
  assert.equal(b.bees.deadClaims, 1); // ← bees.orphanedClaims
  assert.equal(b.workFeed.frontier, 7);
  assert.equal(b.workFeed.deadRoutines, 1);
  assert.equal(b.workFeed.blockedStranded, 4); // ← bees.placements.stranded (cross-panel, the co-shape)
  assert.deepEqual(b.tokens.pausedBuckets, ['2 of 5 bucket(s)']); // count→descriptor until names land
  assert.equal(b.tokens.accountsAvailable, 3);
  assert.equal(b.plans.active, 9);
  assert.equal(b.plans.agingEscalations, 4); // ← escalations panel
  assert.equal(b.observations.laneCount, 6);
  assert.deepEqual(b.observations.recentByRole, { queen: 2, worker: 4 });
});

test('mapSystemHealthToBrief — unreadable panels (data:null) degrade to neutral defaults, never an alarm', () => {
  const h = fakeHealth({ queen: null, bees: null, workFeed: null, tokens: null, plans: null, escalations: null, observations: null });
  const b = withAnomalies(mapSystemHealthToBrief(h, 'papercup-hive'));
  assert.deepEqual(b, withAnomalies(emptyOverwatchBrief('papercup-hive'))); // identical to the neutral brief
  assert.deepEqual(b.anomalies, []); // a greyed source never fabricates an anomaly
});

test('mapSystemHealthToBrief — token count→descriptor trips the detector + honors the starvation split', () => {
  // Paused with accounts left → transient observe.
  const transient = withAnomalies(mapSystemHealthToBrief(fakeHealth({ tokens: tokensData({ pausedBuckets: 1, accountsAvailable: 2 }) }), 'h'));
  const t1 = only(transient.anomalies, 'token-paused');
  assert.equal(t1.severity, 'warning');
  assert.equal(t1.suggestedAction.type, 'observe');
  // Paused with ZERO accounts → starvation escalate.
  const starved = withAnomalies(mapSystemHealthToBrief(fakeHealth({ tokens: tokensData({ pausedBuckets: 2, accountsAvailable: 0 }) }), 'h'));
  const t2 = only(starved.anomalies, 'token-paused');
  assert.equal(t2.severity, 'critical');
  assert.equal(t2.suggestedAction.type, 'escalate');
});

test('mapSystemHealthToBrief — queenAlive derivation keeps queen-dark and queen-stalled DISTINCT', () => {
  // started, ARMED, stalled → ALIVE (the loop exists) → queen-stalled, NOT queen-dark.
  const armedLate = withAnomalies(mapSystemHealthToBrief(fakeHealth({ queen: queenData({ stalled: true, cadenceOk: false, armed: true }) }), 'h'));
  assert.equal(armedLate.crossMonitor.queenAlive, true);
  assert.equal(armedLate.anomalies.filter((a) => a.kind === 'queen-stalled').length, 1);
  assert.equal(armedLate.anomalies.filter((a) => a.kind === 'queen-dark').length, 0);

  // started, NOT armed, stalled → DARK (no next wake AND stale = the loop is gone).
  const dark = withAnomalies(mapSystemHealthToBrief(fakeHealth({ queen: queenData({ stalled: true, cadenceOk: false, armed: false }) }), 'h'));
  assert.equal(dark.crossMonitor.queenAlive, false);
  assert.equal(dark.anomalies.filter((a) => a.kind === 'queen-dark').length, 1);
  assert.equal(dark.anomalies.filter((a) => a.kind === 'queen-stalled').length, 0); // suppressed by precedence

  // paused (not started) → intentional, ALIVE, no queen anomaly (never a false dark alarm).
  const paused = withAnomalies(mapSystemHealthToBrief(fakeHealth({ queen: queenData({ started: false, armed: false, cadenceOk: false }) }), 'h'));
  assert.equal(paused.crossMonitor.queenAlive, true);
  assert.equal(paused.anomalies.filter((a) => a.kind.startsWith('queen')).length, 0);
});

test('computeOverwatchBrief — wraps computeSystemHealth: maps the snapshot + attaches anomalies + wokeBy', async () => {
  vi.mocked(computeSystemHealth).mockResolvedValue(fakeHealth({ queen: queenData({ stalled: true, cadenceOk: false, armed: true }) }));
  const b = await computeOverwatchBrief('ws', 'papercup-hive', { wokeBy: 'timer' });
  assert.equal(b.hiveSlug, 'papercup-hive');
  assert.equal(b.wokeBy, 'timer');
  assert.equal(b.anomalies.filter((a) => a.kind === 'queen-stalled').length, 1);
});

test('computeOverwatchBrief — resolves the Queen coord owner into the brief (the nudge address)', async () => {
  vi.mocked(computeSystemHealth).mockResolvedValue(fakeHealth({ queen: queenData() }));
  owner.resolveQueenOwner.mockResolvedValue('s-queen-1781-abc');
  const b = await computeOverwatchBrief('ws', 'papercup-hive');
  assert.equal(b.queen.coordOwner, 's-queen-1781-abc'); // the overwatch can now coord:send the Queen here
});

test('computeOverwatchBrief — Queen-owner resolution is fail-soft → coordOwner null (persona escalates instead)', async () => {
  vi.mocked(computeSystemHealth).mockResolvedValue(fakeHealth({ queen: queenData() }));
  owner.resolveQueenOwner.mockRejectedValue(new Error('no db'));
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const b = await computeOverwatchBrief('ws', 'papercup-hive');
    assert.equal(b.queen.coordOwner, null); // a throw never kills the brief — nudges escalate
  } finally {
    warnSpy.mockRestore();
  }
});

test('computeOverwatchBrief — pre-folds the overwatch coord inbox, dropping ambient rows (Queen-parity)', async () => {
  vi.mocked(computeSystemHealth).mockResolvedValue(fakeHealth({ queen: queenData() }));
  owner.resolveQueenOwner.mockResolvedValue('s-queen-x');
  owner.ownerRows = [{ coord_owner_id: 's-overwatch-1' }]; // the inbox-owner SELECT resolves
  owner.readInbox.mockResolvedValue([
    { kind: 'message', from: 'queen', summary: 're: nudge — re-opened' },
    { kind: 'notify', from: 'sys', summary: 'governor pause', category: 'service-health' }, // ambient → dropped
  ]);
  try {
    const b = await computeOverwatchBrief('ws', 'papercup-hive');
    assert.equal(b.inbox?.length, 1); // ambient (category) row filtered, like coord:inbox default
    assert.equal(b.inbox?.[0].kind, 'message');
    assert.equal(b.inbox?.[0].from, 'queen');
    assert.match(b.inbox?.[0].summary ?? '', /re-opened/);
  } finally {
    owner.ownerRows = []; // reset shared mock state for later tests
    owner.readInbox.mockResolvedValue([]);
  }
});

test('computeOverwatchBrief — no resolvable overwatch session ⇒ no inbox folded (fail-soft)', async () => {
  vi.mocked(computeSystemHealth).mockResolvedValue(fakeHealth({ queen: queenData() }));
  owner.resolveQueenOwner.mockResolvedValue('s-queen-x');
  owner.ownerRows = []; // no overwatch session row
  const b = await computeOverwatchBrief('ws', 'papercup-hive');
  assert.equal(b.inbox, undefined); // brief still coherent; inbox simply absent
});

test('computeOverwatchBrief — a thrown aggregator degrades to the neutral fail-soft brief (wake still fires)', async () => {
  vi.mocked(computeSystemHealth).mockRejectedValue(new Error('aggregator boom'));
  // The degraded path logs a single warn (the catastrophic-failure breadcrumb) — assert it.
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const b = await computeOverwatchBrief('ws', 'papercup-hive', { wokeBy: 'backstop' });
    assert.deepEqual(b.anomalies, []); // no fabricated anomalies on catastrophic failure
    assert.equal(b.wokeBy, 'backstop'); // wokeBy preserved on the fallback
    const { wokeBy: _w, ...rest } = b;
    assert.deepEqual(rest, emptyOverwatchBrief('papercup-hive')); // otherwise the neutral brief
    assert.equal(warnSpy.mock.calls.length, 1);
    assert.match(String(warnSpy.mock.calls[0][0]), /computeSystemHealth failed/);
  } finally {
    warnSpy.mockRestore();
  }
});
