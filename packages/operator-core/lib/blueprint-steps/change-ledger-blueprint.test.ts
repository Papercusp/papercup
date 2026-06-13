/**
 * change-ledger as a DETERMINISTIC blueprint (deterministic-blueprints-migration-2026-06-13,
 * ratified reclassified loop). Pure bookkeeping (git-log + PG record, NO LLM, NO governor —
 * only the kill-switch flag). Proves the built-in loads + validates as a gateless deterministic
 * pipeline, `change-ledger:scan` is a registered known op, a full run reaches `done`, and the
 * flag gate carries through (dark stays dark).
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import '../coord-ops/index.js';
import './index.js';
import { coordOpNames } from '../coord-ops/registry.js';
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner.js';
import { makeFakeCaps, makeCtx } from '../coord-ops/test-support.js';
import { setChangeLedgerScanDeps } from './ops/change-ledger-scan.js';

afterEach(() => setChangeLedgerScanDeps(null));

const run = async () => {
  const { blueprint } = loadBuiltinBlueprint('change-ledger');
  const { caps } = makeFakeCaps();
  const ctx = makeCtx(caps, { workspaceId: 'ws-1', harnessSlug: 'pot' });
  return runProgramCore({ blueprint, payload: {}, ctx, runOp: inlineRunOp });
};

test('the change-ledger blueprint loads + validates as a gateless deterministic pipeline', () => {
  const { blueprint, validation } = loadBuiltinBlueprint('change-ledger');
  assert.equal(validation.ok, true, `validation errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(blueprint.spine.steps?.length, 1);
  assert.equal(blueprint.spine.steps?.[0]?.op, 'change-ledger:scan');
  assert.ok(!blueprint.spine.gate || blueprint.spine.gate.length === 0);
});

test('change-ledger:scan is a registered known op', () => {
  assert.ok(coordOpNames().has('change-ledger:scan'));
});

test('flag OFF → the deterministic step no-ops (kill-switch), pipeline still completes', async () => {
  setChangeLedgerScanDeps({ flag: async () => false });
  const out = await run();
  assert.equal(out.outcome, 'done');
  const r = out.scope?.scan as { ran: boolean; skipReason?: string } | undefined;
  assert.equal(r?.ran, false);
  assert.equal(r?.skipReason, 'flag-off');
});

test('flag ON → scans the git-log window and records (reaches a clean done)', async () => {
  setChangeLedgerScanDeps({
    flag: async () => true,
    runGitLog: async () => '', // empty window → 0 edits
    record: async () => null,
  });
  const out = await run();
  assert.equal(out.outcome, 'done');
  const r = out.scope?.scan as { ran: boolean; edits?: number } | undefined;
  assert.equal(r?.ran, true);
  assert.equal(r?.edits, 0);
});
