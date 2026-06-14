import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';

// Mock the PG-backed deps; renderQueenBrief + floorFromSurvey stay REAL (the
// renderer is unit-tested in queen-brief.test.ts). Arrow-deref so the hoisted
// vi.mock factory sees the consts.
const surveyHive = vi.fn();
const getHiveCarryNote = vi.fn();
const summarizeOpenPlacements = vi.fn(
  async (..._a: unknown[]) => ({ recovering: 0, cursed: 0, stranded: 0, workingTracked: 0, items: [] as unknown[] }),
);
const gatherFleetSignals = vi.fn(async (..._a: unknown[]) => [] as Array<Record<string, unknown>>);
vi.mock('./survey', () => ({ surveyHive: (...a: unknown[]) => surveyHive(...a) }));
vi.mock('./wake', () => ({ getHiveCarryNote: (...a: unknown[]) => getHiveCarryNote(...a) }));
vi.mock('./placement-watchdog', () => ({ summarizeOpenPlacements: (...a: unknown[]) => summarizeOpenPlacements(...a) }));
vi.mock('../curation/fleet-signals', () => ({ gatherFleetSignals: (...a: unknown[]) => gatherFleetSignals(...a) }));
vi.mock('../curation/deps', () => ({ buildFleetReaders: () => ({}) }));

const { computeQueenWakeBrief } = await import('./queen-brief-launch');

beforeEach(() => {
  vi.clearAllMocks();
});

test('computeQueenWakeBrief — renders the survey floor + carry-note (B-03/B-04 read-side)', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryNote.mockResolvedValue('revisit the staging deploy at next wake');
  const out = await computeQueenWakeBrief('ws-1', 'papercup', { wokeBy: 'timer' });
  assert.ok(out, 'a brief should be produced');
  assert.match(out!, /Your wake brief/);
  assert.match(out!, /do NOT re-run `hive:survey`/); // P-007 reinforcement
  assert.match(out!, /Woke by:.*timer/);
  assert.match(out!, /### Your carry-note/);
  assert.match(out!, /revisit the staging deploy/);
  // Surveys the Queen's home (workspace + install slug).
  assert.deepEqual(surveyHive.mock.calls[0], ['ws-1', 'papercup']);
});

test('computeQueenWakeBrief — fleet escalations flow into the floor (P-007); a flaky escalations read is fail-soft', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryNote.mockResolvedValue(null);
  gatherFleetSignals.mockResolvedValue([
    { id: 'escalation:m1', kind: 'blocker', title: 'staging deploy red', severity: 'blocker', ref: 'escalation:m1' },
  ]);
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out);
  assert.match(out!, /### Open escalations/);
  assert.match(out!, /escalation:m1 \(blocker\): staging deploy red/);

  // Fail-soft: a throwing escalations read degrades that section, not the whole brief.
  gatherFleetSignals.mockRejectedValueOnce(new Error('curation pg down'));
  const out2 = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out2, 'the brief survives a failed escalations read');
  assert.doesNotMatch(out2!, /### Open escalations/);
});

test('computeQueenWakeBrief — empty floor + no carry-note still renders (skip-the-survey signal)', async () => {
  surveyHive.mockResolvedValue({ frontier: [], plans: [], frontierBlocked: 0 });
  getHiveCarryNote.mockResolvedValue(null);
  const out = await computeQueenWakeBrief('ws-1', 'papercup');
  assert.ok(out);
  assert.match(out!, /_empty — no ready work to place\._/);
  assert.doesNotMatch(out!, /### Your carry-note/);
});

test('computeQueenWakeBrief — fail-soft: a survey error returns null (Queen falls back to tools)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    surveyHive.mockRejectedValue(new Error('pg unavailable'));
    getHiveCarryNote.mockResolvedValue(null);
    const out = await computeQueenWakeBrief('ws-1', 'papercup');
    assert.equal(out, null, 'errors must degrade to null, never throw');
  } finally {
    warn.mockRestore();
  }
});
