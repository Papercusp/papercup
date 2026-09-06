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
    potSlug: 'papercup-hive',
    wokeBy: 'timer',
    queen: { started: true, lastWakeAt: '2026-06-15T01:00:00Z', stalled: true, midTurn: false, cadenceOk: false, workingTracked: 3, nextFireAt: null, coordOwner: 's-queen-1781000000-abc' },
    bees: { running: 4, completed: 11, churning: 2, deadClaims: 1, invalidModelFailures: 3 },
    workFeed: { frontier: 7, autoEligibleStuck: 5, deadRoutines: 1, blockedStranded: 2 },
    tokens: { pausedBuckets: ['opus', 'sonnet'], gatewayFailovers: 3, gw429s: 12, accountsAvailable: 1, gatewayWedged: false, gatewaySustainedThrottle: false, gatewayAdmissionStarved: false },
    plans: { active: 6, stalledItems: 4, agingEscalations: 2 },
    observations: { laneCount: 9, recentByRole: { worker: 5, queen: 3, scout: 1 } },
    crossMonitor: { queenAlive: false, overwatchAlive: true },
    ownerSteering: { pauseNewWork: false, pausedUntil: null, eligiblePlans: [] },
    inbox: [
      { kind: 'message', from: 'mug', summary: 're: F-FIX-021 — re-opened, thanks' },
      { kind: 'escalation', summary: 'owner: keep an eye on the opus bucket' },
    ],
    anomalies: [
      {
        kind: 'observation-dark',
        severity: 'info',
        subject: 'observation lane',
        detail: 'lane flat 40m while 4 bees run',
        suggestedAction: { type: 'observe', conditionKey: 'overwatch:observation-dark', message: 'observation lane flat while the fleet is active' },
      },
      {
        kind: 'queen-stalled',
        severity: 'critical',
        subject: 'mug',
        detail: 'last woke 47m ago (cadence 10m)',
        suggestedAction: { type: 'nudge', target: 'mug', conditionKey: 'overwatch:queen-stalled', message: 'you have stalled past your cadence — wake and clear recoveries' },
      },
      {
        kind: 'token-paused',
        severity: 'warning',
        subject: 'opus bucket',
        detail: 'paused on RPM saturation',
        suggestedAction: { type: 'escalate', target: 'owner', conditionKey: 'overwatch:token-paused', message: 'opus bucket paused; structural rate-limit fix needed' },
      },
    ],
  };
}

test('renderOverwatchBrief — every panel + the anomalies section render', () => {
  const out = renderOverwatchBrief(unhealthyBrief());

  // Header carries the hive + the nudge-not-replace mandate (D-001).
  assert.match(out, /## Kettle wake brief — system-health snapshot for papercup-hive/);
  assert.match(out, /you never re-place work — that is the Mug/);
  // EI-13557: the intro now teaches the conditionKey contract explicitly.
  assert.match(out, /you MUST pass that\s+exact string as `coord:escalate`'s `conditionKey` argument/);
  // EI-15448: the intro also teaches the observation-side coalescing contract.
  assert.match(out, /also belongs on `improvements:capture`'s `conditionKey` argument/);
  assert.match(out, /\*\*Woke by:\*\* timer/);

  // Anomalies section + all three lines, with the action verb + target + message.
  assert.match(out, /### Anomalies — detected this wake \(act on these\)/);
  // EI-15448: a nudge/observe line carrying a conditionKey now surfaces it too (the
  // D-003 companion-observation coalescing key, not just escalate's own arg).
  assert.match(out, /\[critical\] queen-stalled — mug: last woke 47m ago \(cadence 10m\) → NUDGE mug \[conditionKey: overwatch:queen-stalled\]: you have stalled/);
  // EI-13557: the escalate line surfaces the conditionKey explicitly (before the
  // message) so the agent copies it verbatim into coord:escalate's conditionKey arg.
  assert.match(out, /\[warning\] token-paused — opus bucket: paused on RPM saturation → ESCALATE owner \[conditionKey: overwatch:token-paused\]: opus bucket paused/);
  assert.match(out, /\[info\] observation-dark — observation lane: lane flat 40m while 4 bees run → OBSERVE \[conditionKey: overwatch:observation-dark\]: observation lane flat/);

  // Health panels — one line each, every field surfaced.
  assert.match(out, /### Mug\n- last woke 2026-06-15T01:00:00Z \[STALLED\] · cadence OFF · driving 3 placement\(s\) · next unscheduled/);
  // The Mug-nudge address is the stable role slot; the session owner is diagnostic only.
  assert.match(out, /nudge the Mug via `coord:send \{ to: \['@role:mug'\], wake: 'optimistic'/);
  assert.match(out, /latest Mug session owner \(diagnostic only\): s-queen-1781000000-abc/);

  // The pre-folded Inbox section (coord messages addressed to the overwatch).
  assert.match(out, /### Inbox — coord messages for you/);
  assert.match(out, /- \[message\] mug: re: F-FIX-021 — re-opened, thanks/);
  assert.match(out, /- \[escalation\] owner: keep an eye on the opus bucket/);
  assert.match(out, /### Bees \(Mug-placed only — NOT the whole fleet\)\n- running 4 · completed 11 · churning 2 · dead claims 1 · invalid-model failures 3/);
  // EI-6493: the zero-caveat only fires when running is actually 0 — this fixture has 4.
  assert.doesNotMatch(out, /zero here means no Mug-dispatched bee is active/);
  assert.match(out, /### Work feed\n- frontier 7 ready · 5 auto-eligible stuck \(dispatcher lane — NOT a Mug\/placement signal; see auto-implement dispatcher-staleness\) · 1 dead routine\(s\) · 2 stranded/);
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
  // No resolvable Queen coord owner (null default) still has a stable role-slot route.
  assert.match(out, /role-slot nudge still parks for the next Mug wake/);
  assert.match(out, /- queen alive · overwatch alive/);
  assert.match(out, /by role: none/);
  assert.match(out, /paused buckets: none/);
  // EI-6493: bees.running=0 (the empty-brief default) must carry the explicit
  // "not the whole fleet" caveat, so a reader never mistakes it for a stall.
  assert.match(out, /### Bees \(Mug-placed only — NOT the whole fleet\)/);
  assert.match(
    out,
    /zero here means no Mug-dispatched bee is active — it does NOT mean the fleet is idle/,
  );
});

test('renderOverwatchBrief — EI-6493: the bees-running=0 caveat only fires at zero, and always names the scope', () => {
  const zero = renderOverwatchBrief(emptyOverwatchBrief('papercup-hive'));
  assert.match(zero, /cross-check fleet:assignments\/coord:presence before reading this as a stall/);

  const nonZero = renderOverwatchBrief(unhealthyBrief());
  assert.doesNotMatch(nonZero, /zero here means no Mug-dispatched bee is active/);
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

test('renderOverwatchBrief — a mid-turn Mug reads on-cadence, not "cadence OFF · next unscheduled" (EI-12553)', () => {
  // A healthily-working Mug: her one-shot pot-wake routine fired + self-deactivated,
  // so nextFireAt is momentarily null and armed reads false until she re-declares at
  // turn end. The panel must NOT false-report a stall for this — it corrupts the
  // Kettle's mug-stalled detector input (crying wolf / masking a real stall).
  const brief = emptyOverwatchBrief('papercup-hive');
  brief.queen = {
    started: true,
    lastWakeAt: '2026-07-15T10:06:33.533Z',
    stalled: false,
    midTurn: true,
    cadenceOk: true, // as the fixed compute.ts derivation now yields for a mid-turn Mug
    workingTracked: 0,
    nextFireAt: null,
    coordOwner: null,
  };
  const out = renderOverwatchBrief(brief);
  assert.match(out, /cadence ok/);
  assert.doesNotMatch(out, /cadence OFF/);
  assert.match(out, /next pending \(turn live\)/);
  assert.doesNotMatch(out, /next unscheduled/);

  // The render is self-correcting: even if an upstream derivation forgot to fold
  // midTurn into cadenceOk, a mid-turn Mug still renders on-cadence.
  brief.queen.cadenceOk = false;
  const out2 = renderOverwatchBrief(brief);
  assert.match(out2, /cadence ok/);
  assert.doesNotMatch(out2, /cadence OFF/);

  // A genuinely unarmed, NON-mid-turn Mug still reads OFF · unscheduled (no false green).
  brief.queen.midTurn = false;
  brief.queen.cadenceOk = false;
  const out3 = renderOverwatchBrief(brief);
  assert.match(out3, /cadence OFF/);
  assert.match(out3, /next unscheduled/);
});

test('emptyOverwatchBrief — neutral fail-soft default: healthy, zeroed, no anomalies, independent instances', () => {
  const a = emptyOverwatchBrief('hive-a');
  assert.equal(a.potSlug, 'hive-a');
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

test('renderOverwatchBrief — keylessHumanReviewBacklog renders as a separate, explicitly non-Mug-actionable line (EI-14223)', () => {
  const brief = unhealthyBrief();
  brief.workFeed.keylessHumanReviewBacklog = 202;
  const out = renderOverwatchBrief(brief);
  // The by-design keyless backlog must be visible but clearly labelled as NOT
  // Mug-actionable, and must not be folded into the auto-eligible-stuck count.
  assert.match(out, /202 keyless human-review-backlog/);
  assert.match(out, /do NOT nudge or escalate to Mug/);
  assert.match(out, /5 auto-eligible stuck/); // unhealthyBrief's autoEligibleStuck (5) unchanged
});

test('renderOverwatchBrief — a zero/absent keylessHumanReviewBacklog omits the line entirely', () => {
  const out = renderOverwatchBrief(unhealthyBrief()); // no keylessHumanReviewBacklog set
  assert.doesNotMatch(out, /keyless human-review-backlog/);
});
