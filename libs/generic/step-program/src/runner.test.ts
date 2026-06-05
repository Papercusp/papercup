/**
 * The program runner. Pins step execution + result-binding, the gate decision,
 * the injected `runOp` seam (op label format + ctx pass-through), the recursion
 * guard, and the `isResolved` predicate — all with an in-memory fake op map (no
 * I/O, no durability runtime).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runProgram, type OpCall, type RunOp } from './runner.js';
import type { Program } from './types.js';

/** A fake op registry: op name → (args) → result. The `runOp` seam resolves it. */
function fakeRunner(ops: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: OpCall[] = [];
  const runOp: RunOp = async (call) => {
    calls.push(call);
    const fn = ops[call.op];
    if (!fn) throw new Error(`unknown op ${call.op}`);
    return fn(call.args);
  };
  return { runOp, calls };
}

test('runs steps, binds results, fires the resolving gate', async () => {
  const { runOp, calls } = fakeRunner({
    'open-thread': () => ({ conversation_id: 'conv-1' }),
    collect: () => ({ posts: 3 }),
    resolve: (args) => ({ resolved: true, decision: args.decision }),
  });
  const program: Program = {
    steps: [
      { id: 'open', op: 'open-thread', args: {}, bind: 'thread' },
      { id: 'collect', op: 'collect', args: { conversation_id: '{{ thread.conversation_id }}' }, bind: 'collected' },
    ],
    gate: [
      { when: 'collected.posts >= 2', op: 'resolve', args: { decision: 'go' } },
      { else: true, op: 'escalate', args: {} },
    ],
  };
  const out = await runProgram({ program, scope: { payload: {} }, ctx: null, runOp });
  assert.equal(out.outcome, 'resolve');
  assert.equal(out.resolved, true);
  assert.equal(out.decision, 'go');
  // the collect step saw the bound thread id (interpolation across steps)
  assert.deepEqual(calls[1]?.args, { conversation_id: 'conv-1' });
  // op-call labels
  assert.deepEqual(calls.map((c) => c.label), ['op-open', 'op-collect', 'gate-resolve']);
});

test('gate fallback → non-resolved outcome', async () => {
  const { runOp } = fakeRunner({
    collect: () => ({ posts: 0 }),
    resolve: () => ({ resolved: true }),
    escalate: () => ({ resolved: false }),
  });
  const program: Program = {
    steps: [{ id: 'c', op: 'collect', args: {}, bind: 'collected' }],
    gate: [
      { when: 'collected.posts >= 2', op: 'resolve', args: {} },
      { else: true, op: 'escalate', args: { summary: 'split' } },
    ],
  };
  const out = await runProgram({ program, scope: {}, ctx: null, runOp });
  assert.equal(out.outcome, 'escalate');
  assert.equal(out.resolved, false);
});

test('a false `when` skips the step (its bind stays unset)', async () => {
  const { runOp, calls } = fakeRunner({
    ask: () => ({ answered: false }),
    vote: () => ({ resolved: true }),
    resolve: () => ({ resolved: true }),
  });
  const program: Program = {
    steps: [
      { id: 'ask', op: 'ask', args: {}, bind: 'asked' },
      { id: 'vote', op: 'vote', args: {}, bind: 'voted', when: 'asked.answered' }, // false → skip
    ],
    gate: [{ else: true, op: 'resolve', args: {} }],
  };
  const out = await runProgram({ program, scope: {}, ctx: null, runOp });
  // vote was skipped → only ask + the gate ran
  assert.deepEqual(calls.map((c) => c.op), ['ask', 'resolve']);
  assert.equal(out.resolved, true);
});

test('ctx is threaded opaquely to every runOp call', async () => {
  const seen: unknown[] = [];
  const ctx = { who: 'caller-1' };
  const runOp: RunOp<typeof ctx> = async (_call, c) => {
    seen.push(c);
    return { resolved: true };
  };
  const program: Program = { steps: [{ id: 's', op: 'x', args: {} }], gate: [{ else: true, op: 'resolve', args: {} }] };
  await runProgram({ program, scope: {}, ctx, runOp });
  assert.equal(seen.length, 2);
  assert.equal(seen.every((c) => c === ctx), true);
});

test('recursion guard: depth past maxDepth aborts before running anything', async () => {
  let ran = false;
  const runOp: RunOp = async () => {
    ran = true;
    return {};
  };
  const program: Program = { steps: [{ id: 's', op: 'x', args: {} }], gate: [{ else: true, op: 'resolve', args: {} }] };
  const out = await runProgram({ program, scope: {}, ctx: null, runOp, depth: 3, maxDepth: 2 });
  assert.equal(out.outcome, 'recursion-exceeded');
  assert.equal(out.resolved, false);
  assert.equal(ran, false); // aborted before any op ran
});

test('depth === maxDepth still runs (strict > guard)', async () => {
  const { runOp } = fakeRunner({ x: () => ({}), resolve: () => ({ resolved: true }) });
  const program: Program = { steps: [{ id: 's', op: 'x', args: {} }], gate: [{ else: true, op: 'resolve', args: {} }] };
  const out = await runProgram({ program, scope: {}, ctx: null, runOp, depth: 2, maxDepth: 2 });
  assert.equal(out.resolved, true);
});

test('no gate branch matched (no fallback) → no-gate-match, unresolved', async () => {
  const { runOp } = fakeRunner({ x: () => ({}), resolve: () => ({ resolved: true }) });
  const program: Program = {
    steps: [{ id: 's', op: 'x', args: {} }],
    gate: [{ when: 'never.true', op: 'resolve', args: {} }],
  };
  const out = await runProgram({ program, scope: {}, ctx: null, runOp });
  assert.equal(out.outcome, 'no-gate-match');
  assert.equal(out.resolved, false);
});

test('default isResolved keys off gateResult.resolved; a custom one can widen it', async () => {
  // The gate op returns no `resolved` flag — default predicate → not resolved.
  const { runOp } = fakeRunner({ done: () => ({ decision: 'x' }) });
  const program: Program = { steps: [{ id: 's', op: 'done', args: {} }], gate: [{ else: true, op: 'done', args: {} }] };
  const def = await runProgram({ program, scope: {}, ctx: null, runOp });
  assert.equal(def.resolved, false);
  // A host predicate that treats the op name `done` as terminal → resolved.
  const widened = await runProgram({
    program,
    scope: {},
    ctx: null,
    runOp,
    isResolved: (op) => op === 'done',
  });
  assert.equal(widened.resolved, true);
});

test('empty steps throws (structural error)', async () => {
  const { runOp } = fakeRunner({});
  await assert.rejects(
    () => runProgram({ program: { steps: [], gate: [] }, scope: {}, ctx: null, runOp, programId: 'empty' }),
    /no program steps/,
  );
});
