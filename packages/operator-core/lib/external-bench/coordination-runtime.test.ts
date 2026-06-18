/**
 * coordination-runtime — the spec→spawn-plan mapping (benchmark-coordination-topologies). Pins repo
 * parsing, team grouping per spec.team, and that the directive encodes each topology's behavior.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  repoKey,
  groupTeams,
  coordinationDirective,
  coordinationSpawnPlans,
  isCoordinationToolCall,
  countCoordinationCalls,
} from './coordination-runtime';
import type { CoordinationSpec } from './coordination-topology';
import type { BenchTask } from './types';

const task = (instanceId: string): BenchTask =>
  ({
    benchmark: 'swe-bench-pro',
    instanceId,
    problemStatement: 'x',
    repo: '/tmp/r',
    baseCommit: 'abc1234',
    language: 'python',
    graderMeta: {},
  }) as unknown as BenchTask;

const spec = (over: Partial<CoordinationSpec>): CoordinationSpec => ({
  arm: 'dist-broadcast',
  claimModel: 'self-claim-fifo',
  broadcast: 'topic',
  review: 'none',
  sharedState: 'both',
  team: 'per-backlog',
  aggregate: 'none',
  disciplineForbid: [],
  central: false,
  ...over,
});

test('repoKey — parses org__repo from a SWE-bench instanceId (strips the commit/version suffix)', () => {
  assert.equal(repoKey(task('instance_flipt-io__flipt-aebaecd026f752b187f11328b0d464761b15d2ab')), 'flipt-io__flipt');
  assert.equal(
    repoKey(task('instance_element-hq__element-web-ca8b1b04effb4fec0e1dd3de8e3198eeb364d50e-vnan')),
    'element-hq__element-web',
  );
});

test('groupTeams — per-backlog=1, per-task=1-each, per-repo=by repo', () => {
  const b = [
    task('instance_flipt-io__flipt-aaaaaa111111'),
    task('instance_flipt-io__flipt-bbbbbb222222'),
    task('instance_ansible__ansible-cccccc333333'),
  ];
  assert.equal(groupTeams(spec({ team: 'per-backlog' }), b).length, 1);
  assert.equal(groupTeams(spec({ team: 'per-task' }), b).length, 3);
  const repos = groupTeams(spec({ team: 'per-repo' }), b);
  assert.equal(repos.length, 2, 'flipt(2) + ansible(1) → 2 repo teams');
});

test('coordinationDirective — encodes the topology; central=Queen → empty', () => {
  const bc = coordinationDirective(spec({}), 'all-0');
  assert.ok(/claim_next/i.test(bc), 'self-claim instructs claim_next');
  assert.ok(/broadcast/i.test(bc), 'broadcast topology mentions broadcast');

  const bb = coordinationDirective(
    spec({ sharedState: 'blackboard', broadcast: 'none', disciplineForbid: ['coord:send'] }),
    'all-0',
  );
  assert.ok(/blackboard/i.test(bb), 'blackboard topology mentions the blackboard');
  assert.ok(/coord:send is disabled/i.test(bb), 'blackboard forbids direct messaging');
  assert.ok(!/^.*\bbroadcast to topic\b/i.test(bb), 'blackboard does not broadcast to a topic');

  const pr = coordinationDirective(spec({ review: 'peer' }), 'all-0');
  assert.ok(/peer review/i.test(pr), 'peer-review topology instructs review');

  assert.equal(coordinationDirective(spec({ central: true }), 'all-0'), '', 'central=Queen → no worker directive');
});

test('coordinationSpawnPlans — per-repo yields one plan per repo with tasks + tool-scope', () => {
  const b = [task('instance_flipt-io__flipt-aaaaaa111111'), task('instance_ansible__ansible-cccccc333333')];
  const plans = coordinationSpawnPlans(spec({ team: 'per-repo', disciplineForbid: ['coord:send'] }), b);
  assert.equal(plans.length, 2);
  assert.ok(plans.every((p) => p.tasks.length >= 1 && p.directive.length > 0));
  assert.ok(plans.every((p) => p.forbidTools.length === 1 && p.forbidTools[0] === 'coord:send'));
  assert.deepEqual(plans.map((p) => p.teamKey).sort(), ['ansible__ansible', 'flipt-io__flipt']);
});

test('C4 coordination-call measurement — counts inter-agent comms, NOT work-acquisition', () => {
  // counts: direct messaging (coord:*), broadcast (topics:*), hand-off, blackboard reads/writes
  for (const t of ['coord:send', 'coord:ask', 'coord:emit', 'topics:feed', 'topics:subscribe', 'messages:send', 'work_items:comment', 'work_items:amend', 'work_items:observe']) {
    assert.equal(isCoordinationToolCall(t), true, `${t} is coordination`);
  }
  // does NOT count: self-claim / work acquisition (present even in the no-coordination arm) + plain work
  for (const t of ['work_items:claim_next', 'fleet:assignments', 'work_items:get', 'work_items:complete', 'capability:edit', 'bash', 'Read']) {
    assert.equal(isCoordinationToolCall(t), false, `${t} is NOT coordination`);
  }
  // the standard coordCalls computation: 4 coordination calls in a mixed trace.
  const trace = ['Read', 'coord:send', 'capability:edit', 'work_items:claim_next', 'topics:feed', 'work_items:comment', 'messages:send', 'bash'];
  assert.equal(countCoordinationCalls(trace), 4);
  assert.equal(countCoordinationCalls([]), 0, 'a non-coordinating agent → 0 (the C4 red flag)');
});
