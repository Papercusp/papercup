import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// One measured compiler, not whole-recipe qualification or publication.
// The old failed transaction supplies retained inputs only and is never resumed.
const repo = process.cwd();
const evidence = resolve('.papercusp/evidence/luna-bg-preparation-20261107-measure-v3');
const priorPath = resolve('.papercusp/evidence/luna-bg-preparation-20261106-v1/build-transaction-v2.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const controller = join(repo, 'scripts/source-preview.mjs');
assert.equal(digest(readFileSync(controller)), '5724cb3a81fc6ef73446d2f813540a6b010a1db193197bfd4ef352b6b7450d21');
const originalBytes = readFileSync(priorPath);
assert.equal(digest(originalBytes), 'c14efcce9a94207c82bfcd9602b76d14ed22a657601a93f45cccf6b9b4043bd2');
const original = JSON.parse(originalBytes);
assert.equal(original.contexts.invocations.length, 10);
assert.equal(original.contexts.record.prepared.source.sourceCommit, '72959875a3b38694f1f7ebaf78eb7b0782d954ab');
const env = { ...process.env };
const taskId = env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID;
const deadlineEpochMs = Number(env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS);
assert.match(taskId ?? '', /^[a-z0-9]+$/);
assert.ok(Number.isSafeInteger(deadlineEpochMs) && deadlineEpochMs > Date.now());
assert.notEqual(deadlineEpochMs, 1793949556845);
const api = await import(pathToFileURL(controller));
const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const stageLeaf = 'luna-measure-main-20261107-v3';
const stage = join(original.bank.path, stageLeaf);
const selected = original.contexts.invocations[0].invocation;
assert.ok(!selected.outputNamespace);
const invocation = { ...selected, argv: selected.argv.map(arg => arg.replaceAll(original.stage, stage)) };
assert.ok(!existsSync(stage), 'Measurement stage already exists: attach the original task instead');
const plan = [['probe.prepare', 401193], ['probe.begin', 511232], ['probe.compiler', 1233000]];
let completed = 0;
let active;
const admit = () => {
  const remaining = plan.slice(completed).reduce((sum, [phase, estimate]) => sum + Math.max(0,
    estimate - (active?.phase === phase ? Date.now() - active.startedAtMs : 0)), 0);
  api.admitVerifierCommandBudget({ remainingMs: Math.ceil((remaining + 120000) * 1.25),
    cleanupMs: 120000, unknownChild: false, recipePhases: plan.slice(completed) }, { env });
};
admit();
const phasePath = join(evidence, 'phases.jsonl');
const trace = api.verifierPhaseRunner(phasePath, env, join(evidence, 'child-diagnostics.json'));
const runPhase = async (phase, operation) => {
  const outer = phase.startsWith('probe.');
  if (phase !== 'bg.compiler.stop') admit();
  if (outer) {
    assert.equal(phase, plan[completed][0]);
    active = { phase, startedAtMs: Date.now() };
  }
  try {
    const result = await trace(phase, operation);
    if (outer) { completed++; active = undefined; }
    if (phase !== 'bg.compiler.stop') admit();
    return result;
  } finally {
    if (outer) active = undefined;
  }
};
const startedAtMs = Date.now();
save('attempt.json', { scope: 'one current maintained main compiler; no publication or acceptance', taskId,
  deadlineEpochMs, startedAtMs, controllerSha256: digest(readFileSync(controller)), priorPath,
  priorTransactionSha256: digest(originalBytes), sourceCommit: original.contexts.record.prepared.source.sourceCommit,
  stage, historicalProbePlan: plan, fullHistoricalForecastMs: 65721000,
  recurrenceGuards: ['exclusive fresh stage and evidence', 'original finite task deadline',
    'complete retained main command including native externals', 'unchanged original source/dependency receipt',
    'maintained consumed-byte and physical-identity fences', 'no frozen-asset mutation; no publication'] });
try {
  const transaction = await runPhase('probe.prepare', () => api.prepareBgVerifierBuildTransaction({
    prepared: original.contexts.record.prepared, dependencies: original.contexts.record.dependencies,
    invocations: [invocation], bank: original.bank.path, stageLeaf, outputs: original.outputs.slice(0, 2),
    recipe: { ...original.recipe, outfile: original.recipe.outfile.replace(original.stage, stage) },
  }));
  save('transaction.json', transaction);
  const binding = await runPhase('probe.begin', () => api.beginBgVerifierBuildTransaction({ transaction, ownerPid: process.pid }));
  save('binding.json', binding);
  const entry = binding.contexts.invocations[0];
  const receipt = await runPhase('probe.compiler', () => api.compileBgVerifierInvocation({
    record: { ...binding.contexts.record, invocation: entry.original }, invocation: entry.invocation,
    argv: entry.invocation.argv, expectedVersion: '0.25.0', runPhase,
  }));
  save('compiler-receipt.json', receipt);
  const measurements = api.readVerifierPhaseMeasurements(phasePath);
  const forecast = api.estimateVerifierCommandBudget(measurements, 0, { bgRecipe: { invocationCount: 10 } });
  save('terminal.json', { status: 'passed', taskId, deadlineEpochMs, startedAtMs, completedAtMs: Date.now(),
    measurements, forecast, phasePath, archivePath: trace.archivePath,
    scope: 'measurement only; no recipe publication, runtime acceptance or shipment' });
  console.log(JSON.stringify({ event: 'CURRENT_COMPILER_MEASURED', taskId, measurements, forecast }));
} catch (error) {
  save('terminal.json', { status: 'failed', taskId, deadlineEpochMs, startedAtMs, completedAtMs: Date.now(),
    phasePath, archivePath: trace.archivePath, error: String(error.stack || error),
    scope: 'measurement only; no recipe publication, runtime acceptance or shipment' });
  throw error;
}
