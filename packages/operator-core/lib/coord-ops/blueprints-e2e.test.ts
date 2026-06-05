/**
 * P-002 / P-003 — the built-in vote + deliberate blueprints run end-to-end
 * against the LIVE op registry (loaded from their real YAML), via the inline
 * runOp + fake caps. Also pins that every op a blueprint names is registered
 * (validateBlueprint with knownOps — the operator's load-time check).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint, validateBlueprint } from '@papercusp/orchestrator/blueprint';
import './index.js'; // register ops
import { coordOpNames } from './registry.js';
import { runProgramCore, inlineRunOp } from './program-runner.js';
import { makeFakeCaps, makeCtx, votePostBody } from './test-support.js';
import type { CollectedPost } from './types.js';

test('vote + deliberate: every op named in the blueprint is registered', () => {
  const known = coordOpNames();
  for (const id of ['vote', 'deliberate']) {
    const { blueprint } = loadBuiltinBlueprint(id);
    const v = validateBlueprint(blueprint, { knownOps: known });
    assert.equal(v.ok, true, `${id}: ${JSON.stringify(v.errors)}`);
  }
});

/** Fake caps where spawned voters/advocate post into the collect store. */
function voteCaps(lensVote: (lens: string) => string, advocateBody: string) {
  const posts: CollectedPost[] = [];
  return makeFakeCaps({
    posts: () => posts,
    onSpawn: (specs) => {
      for (const s of specs) {
        if (s.role === 'voter') posts.push({ id: posts.length + 1, author_id: 'v', body: lensVote(String(s.inject.lens)), created_ts: 't' });
        else if (s.role === 'advocate') posts.push({ id: posts.length + 1, author_id: 'a', body: advocateBody, created_ts: 't' });
      }
    },
  });
}

test('real vote blueprint: decisive → resolve', async () => {
  const { blueprint } = loadBuiltinBlueprint('vote');
  const { caps, calls } = voteCaps(() => votePostBody('ship', 0.9), '```advocate\nveto: false\nobjection: minor\n```');
  const out = await runProgramCore({
    blueprint,
    payload: { question: 'Ship now?', options: ['ship', 'wait'], quorum: 3, timeout_s: 1 },
    ctx: makeCtx(caps, { callerId: 'caller-x' }),
    runOp: inlineRunOp,
  });
  assert.equal(out.resolved, true);
  assert.equal(out.decision, 'ship');
  // default lenses (3) from knobs → 3 voters + advocate
  assert.equal(calls.spawnRoles[0]?.filter((s) => s.role === 'voter').length, 3);
  // every spawned role carries the owning blueprint id so the live spawn runner
  // resolves blueprints/vote/prompts/<role>.md (runProgramCore stamps ctx.blueprintId).
  assert.ok(calls.spawnRoles[0]?.every((s) => s.blueprintId === 'vote'), 'specs carry blueprintId=vote');
});

test('real vote blueprint: split → escalate', async () => {
  const { blueprint } = loadBuiltinBlueprint('vote');
  const { caps, calls } = voteCaps((lens) => votePostBody(lens === 'correctness' ? 'ship' : 'wait', 0.5), '```advocate\nveto: false\nobjection: unclear\n```');
  const out = await runProgramCore({
    blueprint,
    payload: { question: 'Ship now?', options: ['ship', 'wait'], quorum: 3, timeout_s: 1 },
    ctx: makeCtx(caps),
    runOp: inlineRunOp,
  });
  assert.equal(out.resolved, false);
  assert.equal(out.outcome, 'coord:escalate');
  assert.ok(calls.escalate[0]?.summary?.includes('Ship now?'));
});

test('real deliberate blueprint: owner answers → resolve (vote skipped)', async () => {
  const { blueprint } = loadBuiltinBlueprint('deliberate');
  const { caps, calls } = makeFakeCaps({ answer: () => ({ answered: true, answer: 'wait' }) });
  const out = await runProgramCore({
    blueprint,
    payload: { question: 'Ship now?', options: ['ship', 'wait'], ask_timeout_s: 1 },
    ctx: makeCtx(caps),
    runOp: inlineRunOp,
  });
  assert.equal(out.resolved, true);
  assert.equal(out.decision, 'wait');
  // the vote step was skipped (when: NOT asked.answered) → no spawn happened
  assert.equal(calls.spawnRoles.length, 0);
});

/**
 * Wire a fake caps' `runProgram` to RECURSE for real: load the named built-in
 * blueprint + run it via runProgramCore with the SAME caps (mirroring prod-caps
 * without PG). This exercises the genuine deliberate → vote → spawn → collect →
 * aggregate → gate composition (D-008), not a stub.
 */
function recursingDeliberateCaps(voterVote: (lens: string) => string) {
  const posts: CollectedPost[] = [];
  const fc = makeFakeCaps({
    answer: () => ({ answered: false, answer: null }),
    posts: () => posts,
    onSpawn: (specs) => {
      for (const s of specs) {
        if (s.role === 'voter') posts.push({ id: posts.length + 1, author_id: 'v', body: voterVote(String(s.inject.lens)), created_ts: 't' });
        else if (s.role === 'advocate') posts.push({ id: posts.length + 1, author_id: 'a', body: '```advocate\nveto: false\n```', created_ts: 't' });
      }
    },
  });
  fc.caps.runProgram = async (input) => {
    fc.calls.runProgram.push(input);
    const { blueprint } = loadBuiltinBlueprint(input.blueprintId);
    const subCtx = makeCtx(fc.caps, { depth: input.depth, callerId: input.callerId });
    return runProgramCore({ blueprint, payload: input.payload, ctx: subCtx, runOp: inlineRunOp });
  };
  return fc;
}

test('real deliberate blueprint: owner silent + decisive vote → resolve via vote', async () => {
  const { blueprint } = loadBuiltinBlueprint('deliberate');
  const { caps, calls } = recursingDeliberateCaps(() => votePostBody('ship', 0.9));
  const out = await runProgramCore({
    blueprint,
    payload: { question: 'Ship now?', options: ['ship', 'wait'], ask_timeout_s: 1, quorum: 3, timeout_s: 1 },
    ctx: makeCtx(caps),
    runOp: inlineRunOp,
  });
  assert.equal(out.resolved, true);
  assert.equal(out.decision, 'ship');
  // the vote recursion DID spawn voters
  assert.ok(calls.spawnRoles.length >= 1, 'vote recursion spawned voters');
  // runProgram recursion was used for the vote step (deliberate ctx.depth(0)+1)
  assert.equal(calls.runProgram[0]?.blueprintId, 'vote');
  assert.equal(calls.runProgram[0]?.depth, 1);
});

test('real deliberate blueprint: owner silent + split vote → escalate', async () => {
  const { blueprint } = loadBuiltinBlueprint('deliberate');
  const { caps } = recursingDeliberateCaps((lens) => votePostBody(lens === 'correctness' ? 'ship' : 'wait', 0.5));
  const out = await runProgramCore({
    blueprint,
    payload: { question: 'Ship now?', options: ['ship', 'wait'], ask_timeout_s: 1, quorum: 3, timeout_s: 1 },
    ctx: makeCtx(caps),
    runOp: inlineRunOp,
  });
  assert.equal(out.resolved, false);
  assert.equal(out.outcome, 'coord:escalate');
});
