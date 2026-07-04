import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { DrainSlotInput } from '../agent-tools/coordination/slot-parked-store';

// Mock the PG-backed deps; renderQueenBrief + floorFromSurvey stay REAL (the
// renderer is unit-tested in queen-brief.test.ts). Arrow-deref so the hoisted
// vi.mock factory sees the consts.
const surveyHive = vi.fn();
const getHiveCarryJournal = vi.fn();
const summarizeOpenPlacements = vi.fn(
  async (..._a: unknown[]) => ({ recovering: 0, cursed: 0, stranded: 0, workingTracked: 0, items: [] as unknown[] }),
);
const listEscalations = vi.fn(async (..._a: unknown[]) => [] as Array<Record<string, unknown>>);
const gatherCompletions = vi.fn(async (..._a: unknown[]) => [] as Array<Record<string, unknown>>);
const gatherLiveBees = vi.fn(async (..._a: unknown[]) => [] as Array<Record<string, unknown>>);
const resolveQueenOwner = vi.fn(async (..._a: unknown[]) => 's-queen-1' as string | null);
const readInbox = vi.fn(async (..._a: unknown[]) => [] as Array<Record<string, unknown>>);
const drainSlotMessages = vi.fn(async (..._a: unknown[]) => [] as Array<Record<string, unknown>>);
vi.mock('./survey', () => ({ surveyHive: (...a: unknown[]) => surveyHive(...a) }));
vi.mock('./wake', () => ({ getHiveCarryJournal: (...a: unknown[]) => getHiveCarryJournal(...a) }));
vi.mock('./placement-watchdog', () => ({
  summarizeOpenPlacements: (...a: unknown[]) => summarizeOpenPlacements(...a),
  resolveQueenOwner: (...a: unknown[]) => resolveQueenOwner(...a),
}));
vi.mock('../agent-tools/coordination/escalations', () => ({ listEscalations: (...a: unknown[]) => listEscalations(...a) }));
vi.mock('../curation/change-feed', () => ({ gatherCompletions: (...a: unknown[]) => gatherCompletions(...a) }));
vi.mock('../curation/change-feed-deps', () => ({ buildChangeFeedReaders: () => ({}) }));
vi.mock('../fleet/placement-gather', () => ({ gatherLiveBees: (...a: unknown[]) => gatherLiveBees(...a) }));
vi.mock('../agent-tools/coordination/messages', () => ({ readInbox: (...a: unknown[]) => readInbox(...a) }));
vi.mock('../agent-tools/coordination/slot-parked-store', () => ({ drainSlotMessages: (...a: unknown[]) => drainSlotMessages(...a) }));
vi.mock('../workspace-als', () => ({ runWithWorkspace: (_ws: string, fn: () => unknown) => fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: {} }) }));
// The capacity gather (P-002) hits the live gateway /stats — mock it so the brief tests are HERMETIC
// (no dependency on a running :8788). Default: unreachable ⇒ the Capacity panel is omitted (fail-soft).
const fetchGatewayHeadroom = vi.fn(async (..._a: unknown[]) => ({ reachable: false }) as Record<string, unknown>);
vi.mock('../inference-gateway/observability', () => ({ fetchGatewayHeadroom: (...a: unknown[]) => fetchGatewayHeadroom(...a) }));
// owner-steering (C-1): default = un-steered (today's behaviour). isPausedNow kept
// faithful (pure) so the gather's expired-pause normalization is exercised for real.
const getOwnerSteering = vi.fn(async (..._a: unknown[]) => ({
  directive: null as string | null,
  eligiblePlans: [] as string[],
  eligibleHives: [] as string[],
  pauseNewWork: false,
  pausedUntil: null as number | null,
}));
vi.mock('../owner-steering', () => ({
  getOwnerSteering: (...a: unknown[]) => getOwnerSteering(...a),
  isPausedNow: (s: { pauseNewWork: boolean; pausedUntil: number | null }, now: number) =>
    s.pauseNewWork ? true : s.pausedUntil != null && now < s.pausedUntil,
}));

const { computeQueenWakeBrief } = await import('./queen-brief-launch');

beforeEach(() => {
  vi.clearAllMocks();
});

test('computeQueenWakeBrief — renders the survey floor + carry-journal (B-03/B-04 read-side, L1a)', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryJournal.mockResolvedValue([
    { at: Date.now(), note: 'revisit the staging deploy at next wake' },
    { at: Date.now() - 60_000, note: 'placed WI-9 on a bee; verify completion' },
  ]);
  const out = await computeQueenWakeBrief('ws-1', 'papercup', { wokeBy: 'timer' });
  assert.ok(out, 'a brief should be produced');
  assert.match(out!, /Your wake brief/);
  assert.match(out!, /do NOT re-run `hive:survey`/); // P-007 reinforcement
  assert.match(out!, /Woke by:.*timer/);
  assert.match(out!, /### Your carry-journal/);
  assert.match(out!, /revisit the staging deploy/);
  assert.match(out!, /placed WI-9 on a bee/);
  // Surveys the Queen's home (workspace + install slug). The third arg is the
  // options object (scopeFilter / extraSurveySlugs — owner model 2026-07-01);
  // empty here: no scope filter and no started placements in this scenario.
  assert.deepEqual(surveyHive.mock.calls[0], ['ws-1', 'papercup', {}]);
});

test('computeQueenWakeBrief — EI-3419: the install slug renders as the ground-truth hive anchor, ahead of Woke-by', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryJournal.mockResolvedValue([{ at: Date.now(), note: 'trailing intention from a prior wake' }]);
  const out = await computeQueenWakeBrief('ws-1', 'papercup', { wokeBy: 'timer' });
  assert.ok(out);
  assert.match(out!, /\*\*Hive \(this wake\):\*\* papercup/);
  assert.ok(out!.indexOf('**Hive (this wake):**') < out!.indexOf('**Woke by:**'));
  assert.match(out!, /if it names a different hive than \*\*papercup\*\* above, IGNORE it/);
});

test('computeQueenWakeBrief — owner steering directive flows into the brief (B-02 / P-002)', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getOwnerSteering.mockResolvedValueOnce({ directive: 'Only the in-flight backlog — start nothing new.', eligiblePlans: ['plan-x'], eligibleHives: [], pauseNewWork: false, pausedUntil: null });
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out);
  assert.match(out!, /### Owner steering directive/);
  assert.match(out!, /Only the in-flight backlog/);
  assert.match(out!, /Eligible plans ONLY:.*plan-x/);
  // Steering is read for the Queen's home (workspace + install slug).
  assert.deepEqual(getOwnerSteering.mock.calls[0], ['ws-1', 'papercup']);
});

test('computeQueenWakeBrief — un-steered Hive renders NO steering section (default behaviour)', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.doesNotMatch(out!, /### Owner steering directive/);
});

test('computeQueenWakeBrief — a flaky getOwnerSteering read is fail-soft (brief still renders, section omitted)', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getOwnerSteering.mockRejectedValueOnce(new Error('pg down'));
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out, 'the brief still renders despite the steering read failing');
  assert.doesNotMatch(out!, /### Owner steering directive/);
});

test('computeQueenWakeBrief — an EXPIRED pausedUntil is normalized away (no stale PAUSED line)', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getOwnerSteering.mockResolvedValueOnce({ directive: null, eligiblePlans: [], eligibleHives: [], pauseNewWork: false, pausedUntil: 1 });
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  // Specific to the owner-steering pause directive (not a bare /PAUSED/, which now also matches the
  // capacity panel's "POOL PAUSED" — the steering pause renders "start NO new work").
  assert.doesNotMatch(out!, /start NO new work/);
  assert.doesNotMatch(out!, /### Owner steering directive/);
});

// queen-capacity-aware-dispatch-2026-06-22 P-002 — the Capacity panel flows from the gateway oracle.
test('computeQueenWakeBrief — capacity panel flows from the gateway oracle, fail-soft when unreachable', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  // default mock = unreachable ⇒ panel omitted, brief still renders (fail-soft)
  let out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out);
  assert.doesNotMatch(out!, /Inference capacity:/);
  // reachable + tiered ⇒ the panel renders the bee-tier dispatchBudget (cap 20 − inFlight 6 − queued 3 = 11)
  fetchGatewayHeadroom.mockResolvedValueOnce({
    reachable: true, utilization: 0.2, utilizationPct: 20, paused: false, rejected: false, inFlight: 2, queueDepth: 0,
    priorityTiers: { healthyAccounts: 8, tier1Reserve: 4, tiers: [{ tier: 3, cap: 20, inFlight: 6, queued: 3 }] },
  });
  out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.match(out!, /Inference capacity:.*~11 bee slot\(s\) free/);
});

test('computeQueenWakeBrief — eligibleHives scopes the survey via allowedHarnesses (B-04 round-2, C-2)', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getOwnerSteering.mockResolvedValueOnce({ directive: null, eligiblePlans: [], eligibleHives: ['hive-a', 'hive-b'], pauseNewWork: false, pausedUntil: null });
  await computeQueenWakeBrief('ws-1', 'papercup');
  // The eligibleHives scope reaches surveyHive as scopeFilter.allowedHarnesses.
  assert.deepEqual(surveyHive.mock.calls[0], [
    'ws-1',
    'papercup',
    { scopeFilter: { allowedHarnesses: ['hive-a', 'hive-b'] } },
  ]);
});

test('computeQueenWakeBrief — fleet escalations flow into the floor (P-007); a flaky escalations read is fail-soft', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryJournal.mockResolvedValue([]);
  listEscalations.mockResolvedValue([
    { msg_id: 'm-new', from: 'bee-2', severity: 'blocker', summary: 'new blocker', ts: '2026-06-14T00:00:03.000Z' },
    { msg_id: 'm-old', from: 'bee-1', severity: 'advisory', summary: 'old advisory', repeatCount: 3, ts: '2026-06-14T00:00:01.000Z' },
    { msg_id: 'm-mid', from: 'bee-3', severity: 'question', summary: 'middle question', ts: '2026-06-14T00:00:02.000Z' },
  ]);
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out);
  assert.match(out!, /### Open escalations/);
  assert.ok(
    out!.indexOf('escalation:m-old (advisory): old advisory (x3)') <
      out!.indexOf('escalation:m-mid (question): middle question'),
    'oldest escalation should render first',
  );
  assert.ok(
    out!.indexOf('escalation:m-mid (question): middle question') <
      out!.indexOf('escalation:m-new (blocker): new blocker'),
    'newest escalation should render last within the quota',
  );

  // Fail-soft: a throwing escalations read degrades that section, not the whole brief.
  listEscalations.mockRejectedValueOnce(new Error('coord pg down'));
  const out2 = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out2, 'the brief survives a failed escalations read');
  assert.doesNotMatch(out2!, /### Open escalations/);
});

test('computeQueenWakeBrief — change-feed (steering digest) flows into the floor (P-007); fail-soft', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryJournal.mockResolvedValue([]);
  gatherCompletions.mockResolvedValue([
    { id: 'c1', kind: 'completion', title: 'wi-080 shipped', ref: 'wi:080', ts: '2026-06-14' },
    { id: 'c2', kind: 'plan-run', title: 'plan-x run finished', ref: 'plan:x', ts: '2026-06-14' },
  ]);
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out);
  assert.match(out!, /### Change feed/);
  assert.match(out!, /completion: wi-080 shipped/);
  assert.match(out!, /plan-run: plan-x run finished/);

  gatherCompletions.mockRejectedValueOnce(new Error('change-feed pg down'));
  const out2 = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out2, 'the brief survives a failed change-feed read');
  assert.doesNotMatch(out2!, /### Change feed/);
});

test('computeQueenWakeBrief — live bees (load + liveness) flow into the floor (P-007); fail-soft', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryJournal.mockResolvedValue([]);
  gatherLiveBees.mockResolvedValue([
    { ownerId: 's-1', label: 'bee-alpha', intent: 'on plan-x', load: 2, alive: true },
    { ownerId: 's-2', label: null, currentPlanSlug: 'plan-y', load: 0, alive: false },
  ]);
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out);
  assert.match(out!, /### Bees — load \+ liveness/);
  assert.match(out!, /bee-alpha: load 2, doing on plan-x \[alive\]/);
  assert.match(out!, /s-2: load 0, doing plan-y \[DEAD/);

  gatherLiveBees.mockRejectedValueOnce(new Error('nursery pg down'));
  const out2 = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out2, 'the brief survives a failed bee read');
  assert.doesNotMatch(out2!, /### Bees — load \+ liveness/);
});

test('computeQueenWakeBrief — coord:inbox recent digest flows into the floor (D-020); ambient dropped; fail-soft', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryJournal.mockResolvedValue([]);
  resolveQueenOwner.mockResolvedValue('s-queen-1');
  // readInbox already excludes own + notify; we additionally drop ambient (category).
  readInbox.mockResolvedValue([
    { kind: 'handoff', from: 'bee-alpha', summary: 'taking wi-101, need the schema', ts: '2026-06-14T00:00:01Z' },
    { kind: 'message', from: 'sys', summary: 'service health blip', category: 'service-health', ts: '2026-06-14T00:00:02Z' },
    { kind: 'message', from: 'bee-beta', body: 'paused on plan-y, blocked', ts: '2026-06-14T00:00:03Z' },
  ]);
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out);
  assert.match(out!, /### Inbox — recent \(addressed to you\)/);
  assert.match(out!, /\[handoff\] bee-alpha: taking wi-101/);
  assert.match(out!, /\[message\] bee-beta: paused on plan-y/); // body used when summary absent
  assert.doesNotMatch(out!, /service health blip/); // ambient dropped
  // The skip-list now includes coord:inbox (it's folded into the floor — D-020).
  assert.match(out!, /do NOT re-run[\s\S]*coord:inbox/);
  // Read against the Queen's resolved durable owner id.
  assert.equal(readInbox.mock.calls[0]?.[0], 's-queen-1');

  // Fail-soft: no resolvable owner → no inbox section, brief survives.
  resolveQueenOwner.mockResolvedValueOnce(null);
  const outNoOwner = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(outNoOwner);
  assert.doesNotMatch(outNoOwner!, /### Inbox — recent/);

  // Fail-soft: a throwing inbox read degrades that section, not the whole brief.
  readInbox.mockRejectedValueOnce(new Error('coord pg down'));
  const outErr = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(outErr, 'the brief survives a failed inbox read');
  assert.doesNotMatch(outErr!, /### Inbox — recent/);
});

test('computeQueenWakeBrief — drains stable @role:queen parked nudges into the inbox floor', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryJournal.mockResolvedValue([]);
  resolveQueenOwner.mockResolvedValue('s-queen-1');
  readInbox.mockResolvedValue([
    { kind: 'message', from: 'bee-alpha', summary: 'older direct inbox', ts: '2026-06-14T00:00:01Z', msg_id: 'm1' },
  ]);
  drainSlotMessages.mockResolvedValue([
    {
      kind: 'message',
      from: 'overwatch',
      summary: 'Queen placement drift: re-open stranded item',
      ts: '2026-06-14T00:00:02Z',
      msg_id: 'm2',
    },
  ]);

  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out);
  assert.match(out!, /Queen placement drift: re-open stranded item/);
  assert.equal((drainSlotMessages.mock.calls[0]?.[1] as DrainSlotInput | undefined)?.slot?.kind, 'role');
  assert.equal((drainSlotMessages.mock.calls[0]?.[1] as DrainSlotInput | undefined)?.slot?.ref, 'queen');
  // WI-682: the workspace Queen drains role:queen across EVERY harness scope —
  // senders park under whatever slug they had (often NULL), so a slug-keyed
  // drain strands rows. anyHarnessSlug replaces the harnessSlug key here.
  assert.equal((drainSlotMessages.mock.calls[0]?.[1] as DrainSlotInput | undefined)?.anyHarnessSlug, true);
  assert.equal((drainSlotMessages.mock.calls[0]?.[1] as DrainSlotInput | undefined)?.toOwner, 's-queen-1');
  assert.equal((drainSlotMessages.mock.calls[0]?.[1] as DrainSlotInput | undefined)?.workspaceId, 'ws-1');
});

test('computeQueenWakeBrief — empty floor + no carry-note still renders (skip-the-survey signal)', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryJournal.mockResolvedValue([]);
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out);
  assert.match(out!, /_empty — no ready work to place\._/);
  assert.doesNotMatch(out!, /### Your carry-note/);
});

test('computeQueenWakeBrief — fail-soft: a survey error returns null (Queen falls back to tools)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    surveyHive.mockRejectedValue(new Error('pg unavailable'));
    getHiveCarryJournal.mockResolvedValue([]);
    const out = await computeQueenWakeBrief('ws-1', 'papercup');
    assert.equal(out, null, 'errors must degrade to null, never throw');
  } finally {
    warn.mockRestore();
  }
});
