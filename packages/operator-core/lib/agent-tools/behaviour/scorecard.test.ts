/**
 * behaviour/scorecard tests (WI-3340) — the PURE dual-emit halves: check→criterion
 * mapping (all 12 su-agent-behavior keys, evidence on every entry, unknown+why for
 * unexercised/n-a criteria) and the scorecard field builder (grader-independent title
 * naming the SUBJECT run). The emitted record must satisfy the same contracts
 * capture-core enforces at write time (validateObservationRatings +
 * validateScorecardCompleteness), so those gates are asserted directly here.
 * The side-effectful emitter is only proven OFF under vitest (the suite guard).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/behaviour/scorecard.test.ts
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { BehaviourCheck } from '../../behaviour-suite/assertions';
import { buildReport } from '../../behaviour-suite/report';
import {
  validateObservationRatings,
  validateScorecardCompleteness,
} from '../../harness/improvements/observation-types';
import {
  SU_AGENT_BEHAVIOR_CRITERIA,
  SU_AGENT_BEHAVIOR_RUBRIC_ID,
  mapChecksToRubricRatings,
  buildBehaviourScorecard,
  emitBehaviourScorecard,
  resolveSuAgentBehaviorCriteriaKeys,
} from './scorecard';

const mk = (id: BehaviourCheck['id'], passed: boolean, extra: Partial<BehaviourCheck> = {}): BehaviourCheck => ({
  id,
  passed,
  critical: true,
  detail: `${id} ${passed ? 'ok' : 'violated'}`,
  metrics: {},
  ...extra,
});

/** A full 8-check clean run. */
const CLEAN: BehaviourCheck[] = [
  mk('model-routing', true),
  mk('context-fit', true),
  mk('routing-gate', true),
  mk('plan-execution', true),
  mk('scope-adherence', true),
  mk('lock-discipline', true, { critical: false }),
  mk('fleet-launch', true),
  mk('completion-evidence', true, { critical: false }),
];

test('mapping emits ALL 12 rubric keys with evidence — passes both capture-core gates', () => {
  const ratings = mapChecksToRubricRatings(CLEAN);
  assert.deepEqual(Object.keys(ratings).sort(), [...SU_AGENT_BEHAVIOR_CRITERIA].sort());
  for (const [key, entry] of Object.entries(ratings)) {
    assert.ok(entry.rating.trim(), `${key} rating non-empty`);
    assert.ok(entry.evidence.trim(), `${key} evidence non-empty (mandatory per rating)`);
  }
  // The exact runtime gates the write path enforces — must not throw.
  const obs = { rubricRef: SU_AGENT_BEHAVIOR_RUBRIC_ID, ratings };
  validateObservationRatings(obs);
  validateScorecardCompleteness(obs, [...SU_AGENT_BEHAVIOR_CRITERIA]);
});

test('a passing mapped check rates pass; its detail is the evidence', () => {
  const ratings = mapChecksToRubricRatings(CLEAN);
  assert.equal(ratings['papercusp-way-routing']!.rating, 'pass'); // routing-gate
  assert.ok(ratings['papercusp-way-routing']!.evidence.includes('routing-gate ok'));
  assert.equal(ratings['completion-integrity-and-bounds']!.rating, 'pass'); // plan-execution
  assert.equal(ratings['tool-discipline']!.rating, 'pass'); // fleet-launch
  assert.equal(ratings['reporting-integrity']!.rating, 'pass'); // completion-evidence
});

test('a failing mapped check rates fail', () => {
  const checks = CLEAN.map((c) => (c.id === 'plan-execution' ? mk('plan-execution', false) : c));
  const ratings = mapChecksToRubricRatings(checks);
  assert.equal(ratings['completion-integrity-and-bounds']!.rating, 'fail');
  assert.ok(ratings['completion-integrity-and-bounds']!.evidence.includes('violated'));
});

test('scope-adherence feeds BOTH resource-discipline and constraint-compliance', () => {
  const failing = CLEAN.map((c) => (c.id === 'scope-adherence' ? mk('scope-adherence', false) : c));
  const bad = mapChecksToRubricRatings(failing);
  assert.equal(bad['resource-discipline']!.rating, 'fail');
  assert.equal(bad['constraint-compliance']!.rating, 'fail');
  const good = mapChecksToRubricRatings(CLEAN);
  assert.equal(good['resource-discipline']!.rating, 'pass');
  assert.equal(good['constraint-compliance']!.rating, 'pass');
});

test("an n/a check rates 'unknown' with the n/a reason as evidence", () => {
  const checks = CLEAN.map((c) =>
    c.id === 'fleet-launch' ? mk('fleet-launch', true, { na: true, detail: 'no fleet expected for this run' }) : c,
  );
  const ratings = mapChecksToRubricRatings(checks);
  assert.equal(ratings['tool-discipline']!.rating, 'unknown');
  assert.ok(ratings['tool-discipline']!.evidence.includes('n/a'));
});

test("unexercised criteria rate 'unknown' with a why (never omitted, never guessed)", () => {
  const ratings = mapChecksToRubricRatings(CLEAN);
  for (const key of ['orientation-and-task-reach', 'coordination-discipline', 'engineering-discipline', 'routing-appropriateness', 'work-correctness', 'comprehension-right-target'] as const) {
    assert.equal(ratings[key]!.rating, 'unknown', key);
    assert.ok(ratings[key]!.evidence.includes('not exercised'), key);
  }
});

test("a mapped check missing from the report rates 'unknown', not a crash", () => {
  const ratings = mapChecksToRubricRatings(CLEAN.filter((c) => c.id !== 'routing-gate'));
  assert.equal(ratings['papercusp-way-routing']!.rating, 'unknown');
  assert.ok(ratings['papercusp-way-routing']!.evidence.includes('absent'));
});

test('builder: title names the SUBJECT session + verdict; refs carry the attribution', () => {
  const report = buildReport(CLEAN, { sessionId: '9870' });
  const f = buildBehaviourScorecard(report, { sessionId: '9870', transcriptPath: '/tmp/t.jsonl' });
  assert.ok(f.title.includes('session 9870'));
  assert.ok(f.title.includes('PASS'));
  assert.ok(f.refs.includes('tool:behaviour:run'));
  assert.ok(f.refs.includes('session:9870'));
  assert.ok(f.refs.includes('file:/tmp/t.jsonl'));
  assert.equal(f.body, report.summary);
});

test('builder: a failed run titles FAIL and falls back to the transcript path as subject', () => {
  const report = buildReport(CLEAN.map((c) => (c.id === 'routing-gate' ? mk('routing-gate', false) : c)));
  const f = buildBehaviourScorecard(report, { transcriptPath: '/tmp/x.jsonl' });
  assert.ok(f.title.includes('FAIL'));
  assert.ok(f.title.includes('/tmp/x.jsonl'));
});

test('emitter is gated OFF under vitest (suites never file observations)', async () => {
  const report = buildReport(CLEAN, { sessionId: '9870' });
  const r = await emitBehaviourScorecard(report, { sessionId: '9870' }, {});
  assert.deepEqual(r, { emitted: false, reason: 'vitest' });
});

// EI-8814 recurrence guard: the emitted key set must always equal the CALLER-SUPPLIED
// criteria keys (what emitBehaviourScorecard resolves live from the rubric store), never a
// hardcoded snapshot baked into this module — so a future rubric version bump can never
// silently desync the emitted ratings map from what capture-core's completeness gate
// actually requires.
test('mapChecksToRubricRatings honors an ARBITRARY criteriaKeys set, not just the static snapshot', () => {
  const liveKeys = ['tool-discipline', 'a-brand-new-future-criterion', 'another-new-one'];
  const ratings = mapChecksToRubricRatings(CLEAN, liveKeys);
  assert.deepEqual(Object.keys(ratings).sort(), [...liveKeys].sort());
  // A mapped key still resolves its check normally even off the static list.
  assert.equal(ratings['tool-discipline']!.rating, 'pass');
  // An unmapped (unrecognized-to-CRITERION_TO_CHECK) key rates 'unknown', never omitted/crash.
  assert.equal(ratings['a-brand-new-future-criterion']!.rating, 'unknown');
  assert.equal(ratings['another-new-one']!.rating, 'unknown');
});

test('buildBehaviourScorecard threads criteriaKeys through to the emitted ratings', () => {
  const report = buildReport(CLEAN, { sessionId: '9870' });
  const f = buildBehaviourScorecard(report, { sessionId: '9870' }, ['tool-discipline', 'only-this-one']);
  assert.deepEqual(Object.keys(f.ratings).sort(), ['only-this-one', 'tool-discipline']);
});

test('resolveSuAgentBehaviorCriteriaKeys falls back to the static snapshot when the live rubric read fails (no DB in this unit test)', async () => {
  const keys = await resolveSuAgentBehaviorCriteriaKeys();
  assert.deepEqual([...keys].sort(), [...SU_AGENT_BEHAVIOR_CRITERIA].sort());
});
