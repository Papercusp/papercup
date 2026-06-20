import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  renderOverwatchBrief,
  emptyOverwatchBrief,
  type OverwatchBrief,
  type Anomaly,
} from './brief-types';

// A fully-populated, unhealthy brief covering every panel + a mix of anomalies.
function unhealthyBrief(): OverwatchBrief {
  return {
    hiveSlug: 'papercup-hive',
    wokeBy: 'timer',
    queen: { lastWakeAt: '2026-06-15T01:00:00Z', stalled: true, cadenceOk: false, workingTracked: 3, nextFireAt: null, coordOwner: 's-queen-1781000000-abc' },
    bees: { running: 4, completed: 11, churning: 2, deadClaims: 1 },
    workFeed: { frontier: 7, autoEligibleStuck: 5, deadRoutines: 1, blockedStranded: 2 },
    tokens: { pausedBuckets: ['opus', 'sonnet'], gatewayFailovers: 3, gw429s: 12, accountsAvailable: 1, gatewayWedged: false, gatewaySustainedThrottle: false },
    plans: { active: 6, stalledItems: 4, agingEscalations: 2 },
    observations: { laneCount: 9, recentByRole: { worker: 5, queen: 3, scout: 1 } },
    crossMonitor: { queenAlive: false, overwatchAlive: true },
    inbox: [
      { kind: 'message', from: 'queen', summary: 're: F-FIX-021 — re-opened, thanks' },
      { kind: 'escalation', summary: 'owner: keep an eye on the opus bucket' },
    ],
    anomalies: [
      {
        kind: 'observation-dark',
        severity: 'info',
        subject: 'observation lane',
        detail: 'lane flat 40m while 4 bees run',
        suggestedAction: { type: 'observe', message: 'observation lane flat while the fleet is active' },
      },
      {
        kind: 'queen-stalled',
        severity: 'critical',
        subject: 'queen',
        detail: 'last woke 47m ago (cadence 10m)',
        suggestedAction: { type: 'nudge', target: 'queen', message: 'you have stalled past your cadence — wake and clear recoveries' },
      },
      {
        kind: 'token-paused',
        severity: 'warning',
        subject: 'opus bucket',
        detail: 'paused on RPM saturation',
        suggestedAction: { type: 'escalate', target: 'owner', message: 'opus bucket paused; structural rate-limit fix needed' },
      },
    ],
  };
}

test('renderOverwatchBrief — every panel + the anomalies section render', () => {
  const out = renderOverwatchBrief(unhealthyBrief());

  // Header carries the hive + the nudge-not-replace mandate (D-001).
  assert.match(out, /## Overwatch wake brief — system-health snapshot for papercup-hive/);
  assert.match(out, /you never re-place work — that is the Queen/);
  assert.match(out, /\*\*Woke by:\*\* timer/);

  // Anomalies section + all three lines, with the action verb + target + message.
  assert.match(out, /### Anomalies — detected this wake \(act on these\)/);
  assert.match(out, /\[critical\] queen-stalled — queen: last woke 47m ago \(cadence 10m\) → NUDGE queen: you have stalled/);
  assert.match(out, /\[warning\] token-paused — opus bucket: paused on RPM saturation → ESCALATE owner: opus bucket paused/);
  assert.match(out, /\[info\] observation-dark — observation lane: lane flat 40m while 4 bees run → OBSERVE: observation lane flat/);

  // Health panels — one line each, every field surfaced.
  assert.match(out, /### Queen\n- last woke 2026-06-15T01:00:00Z \[STALLED\] · cadence OFF · driving 3 placement\(s\) · next unscheduled/);
  // The Queen-nudge address: coord:send to her resolved coordOwner (lands in her wake brief).
  assert.match(out, /nudge the Queen via `coord:send \{ to: \['s-queen-1781000000-abc'\]/);

  // The pre-folded Inbox section (coord messages addressed to the overwatch).
  assert.match(out, /### Inbox — coord messages for you/);
  assert.match(out, /- \[message\] queen: re: F-FIX-021 — re-opened, thanks/);
  assert.match(out, /- \[escalation\] owner: keep an eye on the opus bucket/);
  assert.match(out, /### Bees\n- running 4 · completed 11 · churning 2 · dead claims 1/);
  assert.match(out, /### Work feed\n- frontier 7 ready · 5 auto-eligible stuck · 1 dead routine\(s\) · 2 stranded/);
  assert.match(out, /### Tokens \/ gateway\n- paused buckets: opus, sonnet · 3 failover\(s\) · 12 429\(s\) · 1 account\(s\) available/);
  assert.match(out, /### Plans \+ escalations\n- 6 active plan\(s\) · 4 stalled item\(s\) · 2 aging escalation\(s\)/);
  // recentByRole rendered role-sorted (queen, scout, worker), deterministic.
  assert.match(out, /### Observation lane\n- 9 observation\(s\) this window · by role: queen 3, scout 1, worker 5/);
  assert.match(out, /### Cross-monitor \(who-watches-the-watcher\)\n- queen DARK · overwatch alive/);
});

test('renderOverwatchBrief — anomalies render most-severe-first (stable sort), ties keep input order', () => {
  const out = renderOverwatchBrief(unhealthyBrief());
  const critical = out.indexOf('queen-stalled');
  const warning = out.indexOf('token-paused');
  const info = out.indexOf('observation-dark');
  assert.ok(critical < warning && warning < info, 'critical < warning < info ordering');
  // Numbered after re-ordering: the critical one is #1.
  assert.match(out, /1\. \[critical\] queen-stalled/);
  assert.match(out, /3\. \[info\] observation-dark/);
});

test('renderOverwatchBrief — empty anomalies render an explicit healthy signal, not an omission', () => {
  const out = renderOverwatchBrief(emptyOverwatchBrief('papercup-hive'));
  assert.match(out, /### Anomalies — detected this wake \(act on these\)/);
  assert.match(out, /_no anomalies — system healthy\._/);
  // The panels still render with the neutral defaults.
  assert.match(out, /- last woke unknown · cadence ok · driving 0 placement\(s\) · next unscheduled/);
  // No resolvable Queen coord owner (null default) ⇒ the render tells the overwatch to ESCALATE, not nudge.
  assert.match(out, /no resolvable Queen coord owner right now — ESCALATE/);
  assert.match(out, /- queen alive · overwatch alive/);
  assert.match(out, /by role: none/);
  assert.match(out, /paused buckets: none/);
});

test('renderOverwatchBrief — over-cap anomalies are digested with a "+N more" overflow line', () => {
  const brief = emptyOverwatchBrief('papercup-hive');
  brief.anomalies = Array.from(
    { length: 25 },
    (_, i): Anomaly => ({
      kind: 'bees-churning',
      severity: 'warning',
      subject: `bee-${i}`,
      detail: 'stale claim',
      suggestedAction: { type: 'nudge', target: `bee-${i}`, message: 'progress?' },
    }),
  );
  const out = renderOverwatchBrief(brief, { anomalies: 5 });
  assert.match(out, /1\. \[warning\] bees-churning — bee-0:/);
  assert.match(out, /5\. \[warning\] bees-churning — bee-4:/);
  assert.doesNotMatch(out, /6\. \[warning\] bees-churning — bee-5:/);
  assert.match(out, /…\+20 more \(drill into the full brief\)/);
});

test('renderOverwatchBrief — deterministic: same brief renders byte-identical output', () => {
  const brief = unhealthyBrief();
  const a = renderOverwatchBrief(brief);
  const b = renderOverwatchBrief(brief);
  assert.equal(a, b, 'identical input must render identical bytes');
});

test('renderOverwatchBrief — wokeBy omitted / whitespace-only suppresses the Woke-by line', () => {
  const brief = emptyOverwatchBrief('papercup-hive');
  assert.doesNotMatch(renderOverwatchBrief(brief), /Woke by:/);
  brief.wokeBy = '   ';
  assert.doesNotMatch(renderOverwatchBrief(brief), /Woke by:/);
});

test('emptyOverwatchBrief — neutral fail-soft default: healthy, zeroed, no anomalies, independent instances', () => {
  const a = emptyOverwatchBrief('hive-a');
  assert.equal(a.hiveSlug, 'hive-a');
  assert.equal(a.anomalies.length, 0);
  assert.equal(a.crossMonitor.queenAlive, true);
  assert.equal(a.queen.stalled, false);
  assert.equal(a.queen.cadenceOk, true);
  assert.equal(a.queen.coordOwner, null); // resolved by the async wrapper; null until then
  // Distinct instances don't share nested objects/arrays (B-03 mutates the brief as reads land).
  const b = emptyOverwatchBrief('hive-b');
  a.tokens.pausedBuckets.push('opus');
  a.observations.recentByRole.worker = 2;
  assert.deepEqual(b.tokens.pausedBuckets, []);
  assert.deepEqual(b.observations.recentByRole, {});
});
