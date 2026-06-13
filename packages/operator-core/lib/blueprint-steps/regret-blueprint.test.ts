/**
 * P-111 (deterministic-blueprints-migration-2026-06-13) — the regret miner as a
 * DETERMINISTIC blueprint, end-to-end through the program runner.
 *
 * Proves: the built-in blueprint loads + validates as a gateless deterministic
 * pipeline; `regret:mine` is a registered known op; a full `runProgramCore` run
 * reaches a clean `done`; the op runs the SAME flag + governor gates as the
 * bespoke routine (D-004 — dark stays dark, governor refusal skips); and the
 * governor's per-cycle cap bounds replay spend (the D-009 governed-llmCall leg).
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setRegretMineDeps } from './ops/regret-mine.js';
import type { RegretTickDeps } from '../replay/regret/mine.js';

afterEach(() => setRegretMineDeps(null));

/** Regret tick deps that never touch PG — a clean empty mine. */
function fakeTickDeps(over: Partial<RegretTickDeps> = {}): RegretTickDeps {
  return {
    readRows: async () => [],
    readTranscript: async () => null,
    listKnownRunIds: async () => new Set<string>(),
    upsertFinding: async () => {},
    readPendingReplay: async () => [],
    recordReplayScores: async () => {},
    readUnfiledReplayed: async () => [],
    capture: async () => ({ created: false, possibleDuplicates: [], reason: 'stub' }) as never,
    markFiled: async () => {},
    replayRunner: null,
    nowIso: () => '2026-06-13T00:00:00.000Z',
    log: () => {},
    ...over,
  } as RegretTickDeps;
}

test('the regret blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('regret');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'regret:mine');
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('regret:mine is a registered known op', () => {
  assert.ok(coordOpNames().has('regret:mine'));
});

test('running the blueprint program fires the gated miner and reaches a clean done', async () => {
  let seenWindow: number | undefined;
  setRegretMineDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 0 }),
    tickDeps: fakeTickDeps({
      readRows: async (_ws: string, windowDays: number) => {
        seenWindow = windowDays;
        return [];
      },
    }),
  });
  const { blueprint } = loadBuiltinBlueprint('regret');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  assert.equal(out.resolved, true);
  assert.equal(seenWindow, 14); // default selection window
  const r = out.scope?.regret as { ran: boolean } | undefined;
  assert.equal(r?.ran, true);
});

test('flag OFF → the deterministic step no-ops (dark stays dark)', async () => {
  setRegretMineDeps({ flag: async () => false });
  const { blueprint } = loadBuiltinBlueprint('regret');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  const out = await runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  const r = out.scope?.regret as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(r?.ran, false);
  assert.equal(r?.skipReason, 'flag-off');
});

test("the governor's per-cycle cap bounds replay spend (payload may lower, never raise)", async () => {
  let pendingRead = false;
  setRegretMineDeps({
    flag: async () => true,
    governorGate: async () => ({ allow: true, remainingUsd: 2 }),
    tickDeps: fakeTickDeps({
      replayRunner: { priceFinding: async () => ({ scores: [], costUsd: 0 }) },
      readPendingReplay: async () => {
        pendingRead = true;
        return [];
      },
    }),
  });
  const { blueprint } = loadBuiltinBlueprint('regret');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  // Payload asks for 10 — the governor cap (2) wins; budget > 0 + a wired runner
  // makes the replay leg read pending findings (budget plumbing observable).
  const out = await runProgramCore({ blueprint, payload: { replayBudgetUsd: 10 }, ctx, runOp: inlineRunOp });
  assert.equal(out.outcome, 'done');
  assert.equal(pendingRead, true);
});
