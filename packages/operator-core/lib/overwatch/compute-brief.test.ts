import { test } from 'vitest';
import assert from 'node:assert/strict';
import { detectAnomalies, withAnomalies } from './compute-brief';
import { emptyOverwatchBrief, renderOverwatchBrief, type Anomaly, type OverwatchBrief } from './brief-types';

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
  b.queen = { lastWakeAt: '2026-06-15T01:00:00Z', stalled: true, cadenceOk: false, workingTracked: 2, nextFireAt: null };
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
  b.tokens = { pausedBuckets: ['opus'], gatewayFailovers: 0, gw429s: 5, accountsAvailable: 2 };
  const a = only(detectAnomalies(b), 'token-paused');
  assert.equal(a.severity, 'warning');
  assert.equal(a.suggestedAction.type, 'observe');
  assert.equal(a.suggestedAction.target, undefined);
});

test('detectAnomalies — a paused bucket with ZERO accounts → token-paused critical ESCALATE (starvation)', () => {
  const b = base();
  b.tokens = { pausedBuckets: ['opus', 'sonnet'], gatewayFailovers: 1, gw429s: 9, accountsAvailable: 0 };
  const a = only(detectAnomalies(b), 'token-paused');
  assert.equal(a.severity, 'critical');
  assert.equal(a.suggestedAction.type, 'escalate');
  assert.match(a.detail, /no accounts available/);
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

test('detectAnomalies — auto-eligible stuck with routines alive → work-feed-stuck warning NUDGE queen', () => {
  const b = base();
  b.workFeed = { frontier: 3, autoEligibleStuck: 5, deadRoutines: 0, blockedStranded: 0 };
  const a = only(detectAnomalies(b), 'work-feed-stuck');
  assert.equal(a.severity, 'warning');
  assert.equal(a.suggestedAction.type, 'nudge');
  assert.equal(a.suggestedAction.target, 'queen');
  assert.match(a.detail, /attempts:0/);
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
