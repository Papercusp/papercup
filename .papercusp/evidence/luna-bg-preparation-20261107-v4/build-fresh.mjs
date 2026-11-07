import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Attempt driver only. The maintained verifier owns custody and publication.
const repo = process.cwd();
const evidence = resolve('.papercusp/evidence/luna-bg-preparation-20261107-v4');
const measurementRoot = resolve('.papercusp/evidence/luna-bg-preparation-20261107-measure-v3');
const priorPath = resolve('.papercusp/evidence/luna-bg-preparation-20261106-v1/build-transaction-v2.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const controller = join(repo, 'scripts/source-preview.mjs');
const controllerSha256 = '5724cb3a81fc6ef73446d2f813540a6b010a1db193197bfd4ef352b6b7450d21';
assert.equal(digest(readFileSync(controller)), controllerSha256);
const measurementBytes = readFileSync(join(measurementRoot, 'terminal.json'));
const measured = JSON.parse(measurementBytes);
const measuredAttempt = JSON.parse(readFileSync(join(measurementRoot, 'attempt.json'), 'utf8'));
assert.equal(measured.status, 'passed', 'Attach the original measurement; never substitute a historical forecast');
assert.equal(measured.taskId, '0mw5q8d8d86xfd2vls0');
assert.equal(measured.taskId, measuredAttempt.taskId);
assert.equal(measured.deadlineEpochMs, measuredAttempt.deadlineEpochMs);
assert.ok(measured.completedAtMs < measured.deadlineEpochMs);
assert.equal(measuredAttempt.controllerSha256, controllerSha256);
const originalBytes = readFileSync(priorPath);
assert.equal(digest(originalBytes), 'c14efcce9a94207c82bfcd9602b76d14ed22a657601a93f45cccf6b9b4043bd2');
const original = JSON.parse(originalBytes);
assert.equal(original.contexts.invocations.length, 10);
assert.equal(original.contexts.record.prepared.source.sourceCommit, '72959875a3b38694f1f7ebaf78eb7b0782d954ab');
const api = await import(pathToFileURL(controller));
const measurements = api.readVerifierPhaseMeasurements(join(measurementRoot, 'phases.jsonl'));
assert.deepEqual(measurements, measured.measurements, 'Completed measurement phase receipts changed');
const recipeForecast = api.estimateVerifierCommandBudget(measurements, 0, {
  bgRecipe: { invocationCount: original.contexts.invocations.length },
});
assert.deepEqual(recipeForecast, measured.forecast, 'Maintained measured forecast changed');
assert.ok(Number.isSafeInteger(measurements['probe.prepare']) && measurements['probe.prepare'] > 0);
// Add preparation margin to the maintained whole-recipe estimate, never reduce it.
const preparationReserveMs = Math.ceil(measurements['probe.prepare'] * 1.25 * 1.25);
const fullForecast = { ...recipeForecast, totalMs: recipeForecast.totalMs + preparationReserveMs,
  remainingMs: recipeForecast.remainingMs + preparationReserveMs, preparationReserveMs,
  requiredTimeoutMs: recipeForecast.requiredTimeoutMs + Math.ceil(preparationReserveMs / 1000) * 1000 };
const supportedTimeoutMs = 43_200_000;
assert.ok(fullForecast.requiredTimeoutMs <= supportedTimeoutMs,
  `Fresh whole-recipe forecast ${fullForecast.requiredTimeoutMs} exceeds supported timeout ${supportedTimeoutMs}; do not launch`);
if (process.argv.includes('--forecast')) {
  console.log(JSON.stringify({ scope: 'launch forecast only; no build effects', measurementTaskId: measured.taskId,
    measurementSha256: digest(measurementBytes), recipeForecast, fullForecast, supportedTimeoutMs }));
} else {
  assert.ok(process.argv.includes('--build'), 'Choose --forecast or --build');
  const env = { ...process.env };
  const taskId = env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID;
  const deadlineEpochMs = Number(env.PAPERCUSP_TASK_DEADLINE_EPOCH_MS);
  assert.match(taskId ?? '', /^[a-z0-9]+$/);
  assert.ok(Number.isSafeInteger(deadlineEpochMs) && deadlineEpochMs > Date.now());
  assert.notEqual(deadlineEpochMs, 1793949556845, 'Old failed transaction may never be resumed');
  assert.notEqual(taskId, measured.taskId);
  api.admitVerifierCommandBudget(fullForecast, { env, preparation: true });
  const stageLeaf = 'luna-generation-20261107-v4';
  const stage = join(original.bank.path, stageLeaf);
  const publicationLeaf = stageLeaf + '.publication.json';
  assert.ok(!existsSync(stage), 'Fresh stage exists: attach its original attempt');
  assert.ok(!existsSync(join(original.bank.path, publicationLeaf)), 'Publication already exists');
  const invocations = original.contexts.invocations.map(({ invocation }) => {
    assert.ok(!invocation.outputNamespace);
    return { ...invocation, argv: invocation.argv.map(arg => arg.replaceAll(original.stage, stage)) };
  });
  const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  const phasePath = join(evidence, 'phases.jsonl');
  const runPhase = api.verifierPhaseRunner(phasePath, env, join(evidence, 'child-diagnostics.json'));
  const startedAtMs = Date.now();
  save('attempt.json', { scope: 'fresh whole BG recipe; publication only, no activation or shipment', taskId,
    deadlineEpochMs, startedAtMs, controllerSha256, priorPath, priorTransactionSha256: digest(originalBytes),
    sourceCommit: original.contexts.record.prepared.source.sourceCommit,
    measurementTaskId: measured.taskId, measurementSha256: digest(measurementBytes), measurements,
    recipeForecast, fullForecast, supportedTimeoutMs, stage, publicationLeaf,
    recurrenceGuards: ['new independent original task clock', 'new exclusive stage and publication',
      'complete selected ten-command population and original order', 'original frozen source/dependency receipts',
      'maintained consumed-byte custody and physical identity fences', 'whole recipe plus preparation launch budget',
      'qualified physical paths remain unchanged', 'no service activation or inherited runtime claim'] });
  try {
    const transaction = await runPhase('bg.prepare.transaction', () => api.prepareBgVerifierBuildTransaction({
      prepared: original.contexts.record.prepared, dependencies: original.contexts.record.dependencies,
      invocations, bank: original.bank.path, stageLeaf, outputs: original.outputs, assets: original.assets,
      recipe: { ...original.recipe, outfile: original.recipe.outfile.replace(original.stage, stage) }, publicationLeaf,
    }));
    save('transaction.json', transaction);
    const transactionSha256 = digest(readFileSync(join(evidence, 'transaction.json')));
    const publication = await api.runBgVerifierBuildRecipe({ transaction, ownerPid: process.pid, runPhase,
      budget: { measurements, env } });
    save('publication.json', publication);
    save('terminal.json', { status: 'passed', taskId, deadlineEpochMs, startedAtMs, completedAtMs: Date.now(),
      transactionSha256, publication, phasePath, archivePath: runPhase.archivePath,
      measurements: api.readVerifierPhaseMeasurements(phasePath),
      scope: 'whole recipe publication verified; runtime activation and Luna shipment remain unqualified' });
    console.log(JSON.stringify({ event: 'FRESH_BG_PUBLICATION_VERIFIED', taskId, transactionSha256, publication }));
  } catch (error) {
    save('terminal.json', { status: 'failed', taskId, deadlineEpochMs, startedAtMs, completedAtMs: Date.now(),
      phasePath, archivePath: runPhase.archivePath, error: String(error.stack || error),
      scope: 'fresh BG attempt failed; no activation or shipment' });
    throw error;
  }
}
