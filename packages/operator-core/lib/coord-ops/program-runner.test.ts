/**
 * P-005 — the program executor end-to-end (lib interpreter + ops + registry),
 * via the inline runOp (no DBOS). A full vote program: open-thread → spawn voters
 * → collect → aggregate → gate. Proves the decisive→resolve and split→escalate
 * paths and the recursion guard, all deterministically with fake caps.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BlueprintSchema } from '@papercusp/orchestrator/blueprint';
import './index.js'; // register ops
import { runProgramCore, inlineRunOp } from './program-runner.js';
import { makeFakeCaps, makeCtx, votePostBody } from './test-support.js';
import type { CollectedPost } from './types.js';

/** The vote program (mirrors blueprints/vote/blueprint.yaml — pinned here so the
 *  executor test doesn't depend on the file). */
const VOTE_BP = BlueprintSchema.parse({
  id: 'vote',
  workItem: { kind: 'decision', idPrefix: 'VOTE' },
  roles: [{ id: 'voter' }, { id: 'advocate' }],
  recursion: { maxDepth: 2 },
  knobs: { quorum: 2, max_voters: 5, timeout_s: 1 },
  spine: {
    steps: [
      { id: 'open-thread', op: 'coord:thread-open', args: { title: '{{ payload.question }}', kind: 'discussion' }, bind: 'thread' },
      {
        id: 'fan-out',
        op: 'orchestrator:spawn-roles',
        args: {
          conversation_id: '{{ thread.conversation_id }}',
          inject: { question: '{{ payload.question }}', options: '{{ payload.options }}' },
          roles: [
            { role: 'voter', per: '{{ payload.lenses }}', as: 'lens' },
            { role: 'advocate', count: 1 },
          ],
          max_voters: '{{ payload.max_voters }}',
        },
      },
      {
        id: 'collect',
        op: 'coord:collect',
        args: { conversation_id: '{{ thread.conversation_id }}', quorum: '{{ payload.quorum }}', timeout_s: '{{ payload.timeout_s }}', poll_ms: 50 },
        bind: 'collected',
      },
      {
        id: 'aggregate',
        op: 'vote:aggregate',
        args: { posts: '{{ collected.posts }}', options: '{{ payload.options }}', method: 'confidence-weighted' },
        bind: 'tally',
      },
    ],
    gate: [
      // MatchMap (@papercusp/rules) — implicit-AND of the leaf tests, mirroring
      // blueprints/vote/blueprint.yaml after the string-expr→DataCondition cutover
      // (adopt-event-rules-engines D-002): decisive margin + confident + no veto.
      { when: { 'tally.margin': { gte: 0.5 }, 'tally.mean_conf': { gte: 0.6 }, 'tally.advocate_veto': { truthy: false } }, op: 'resolve', args: { decision: '{{ tally.winner }}' } },
      { else: true, op: 'coord:escalate', args: { severity: 'question', summary: 'Vote split on: {{ payload.question }}', body: '{{ tally.objection }}' } },
    ],
  },
});

/** Fake caps where spawning voters/advocate appends posts the collect step reads. */
function voteCaps(votes: { lensVote: (lens: string) => string; advocate: string }) {
  const posts: CollectedPost[] = [];
  const { caps, calls } = makeFakeCaps({
    posts: () => posts,
    onSpawn: (specs) => {
      for (const s of specs) {
        if (s.role === 'voter') {
          posts.push({ id: posts.length + 1, author_id: `voter:${String(s.inject.lens)}`, body: votes.lensVote(String(s.inject.lens)), created_ts: 't' });
        } else if (s.role === 'advocate') {
          posts.push({ id: posts.length + 1, author_id: 'advocate', body: votes.advocate, created_ts: 't' });
        }
      }
    },
  });
  return { caps, calls, posts };
}

test('decisive vote → resolve with the winner', async () => {
  const { caps, calls } = voteCaps({
    lensVote: () => votePostBody('yes', 0.9),
    advocate: '```advocate\nveto: false\nobjection: minor concern\n```',
  });
  const out = await runProgramCore({
    blueprint: VOTE_BP,
    payload: { question: 'Ship the migration?', options: ['yes', 'no'], lenses: ['risk', 'cost', 'ux'] },
    ctx: makeCtx(caps, { callerId: 'caller-1' }),
    runOp: inlineRunOp,
  });
  assert.equal(out.outcome, 'resolve');
  assert.equal(out.resolved, true);
  assert.equal(out.decision, 'yes');
  // spawned one voter per lens (3) + advocate
  assert.equal(calls.spawnRoles[0]?.length, 4);
  // resolve notified the caller
  assert.equal(calls.notify[0]?.to[0], 'caller-1');
});

test('split vote → escalate (curated, with the objection)', async () => {
  const { caps, calls } = voteCaps({
    // each lens votes differently with low confidence → no margin
    lensVote: (lens) => votePostBody(lens === 'risk' ? 'yes' : 'no', 0.5),
    advocate: '```advocate\nveto: false\nobjection: needs more data\n```',
  });
  const out = await runProgramCore({
    blueprint: VOTE_BP,
    payload: { question: 'Risky refactor now?', options: ['yes', 'no'], lenses: ['risk', 'cost'] },
    ctx: makeCtx(caps),
    runOp: inlineRunOp,
  });
  assert.equal(out.outcome, 'coord:escalate');
  assert.equal(out.resolved, false);
  // escalation carried the interpolated summary + the advocate's objection
  assert.equal(calls.escalate[0]?.summary, 'Vote split on: Risky refactor now?');
  assert.equal(calls.escalate[0]?.body, 'needs more data');
});

test('advocate veto forces escalate even on a strong majority', async () => {
  const { caps } = voteCaps({
    lensVote: () => votePostBody('yes', 0.95),
    advocate: '```advocate\nveto: true\nobjection: this loses data irreversibly\n```',
  });
  const out = await runProgramCore({
    blueprint: VOTE_BP,
    payload: { question: 'Drop the column?', options: ['yes', 'no'], lenses: ['risk', 'cost', 'ux'] },
    ctx: makeCtx(caps),
    runOp: inlineRunOp,
  });
  assert.equal(out.outcome, 'coord:escalate');
  assert.equal(out.resolved, false);
});

test('collect proceeds on quorum without every voter (partial failure)', async () => {
  // 5 lenses but only 2 post (others "failed"); quorum=2 → still resolves
  const posts: CollectedPost[] = [];
  const { caps } = makeFakeCaps({
    posts: () => posts,
    onSpawn: (specs) => {
      let posted = 0;
      for (const s of specs) {
        if (s.role === 'voter' && posted < 2) {
          posts.push({ id: posts.length + 1, author_id: 'v', body: votePostBody('yes', 0.9), created_ts: 't' });
          posted++;
        } else if (s.role === 'advocate') {
          posts.push({ id: posts.length + 1, author_id: 'a', body: '```advocate\nveto: false\n```', created_ts: 't' });
        }
      }
    },
  });
  const out = await runProgramCore({
    blueprint: VOTE_BP,
    payload: { question: 'Q?', options: ['yes', 'no'], lenses: ['a', 'b', 'c', 'd', 'e'], quorum: 2 },
    ctx: makeCtx(caps),
    runOp: inlineRunOp,
  });
  assert.equal(out.resolved, true);
  assert.equal(out.decision, 'yes');
});

test('recursion guard: depth past maxDepth aborts to a non-resolved outcome', async () => {
  const { caps } = voteCaps({ lensVote: () => votePostBody('yes', 0.9), advocate: '```advocate\nveto: false\n```' });
  const out = await runProgramCore({
    blueprint: VOTE_BP,
    payload: { question: 'Q?', options: ['yes', 'no'], lenses: ['a', 'b'] },
    ctx: makeCtx(caps, { depth: 3 }), // maxDepth is 2
    runOp: inlineRunOp,
  });
  assert.equal(out.outcome, 'recursion-exceeded');
  assert.equal(out.resolved, false);
});

test('knob defaults fill an omitted payload (quorum/timeout/max_voters from knobs)', async () => {
  // payload omits quorum → defaults to knobs.quorum (2). 2 voters post → resolves.
  const { caps } = voteCaps({ lensVote: () => votePostBody('yes', 0.9), advocate: '```advocate\nveto: false\n```' });
  const out = await runProgramCore({
    blueprint: VOTE_BP,
    payload: { question: 'Q?', options: ['yes', 'no'], lenses: ['a', 'b'] }, // no quorum/timeout_s/max_voters
    ctx: makeCtx(caps),
    runOp: inlineRunOp,
  });
  assert.equal(out.resolved, true);
});
