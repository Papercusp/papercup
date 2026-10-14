import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

/** Stop each owned resource even when another exit fence fails. Private state
 * remains available until every resource has a verified stop.
 * @param {import('./with-test-pg-cleanup.d.mts').CleanupOwnedTestStateOptions} state */
export async function cleanupOwnedTestState(state) {
  const { child, childLifetime, profileProcess, profileLifetime,
    pg, dataDir, runtimeRoot, isolatedRuntime, cleanupStage, observePrivatePgStop } = state;
  const failures = [];
  const attempt = async (stage, operation, detail = {}, finishedStage = stage + 'ped') => {
    try {
      await cleanupStage(stage, detail);
      await operation();
      await cleanupStage(finishedStage, detail);
    } catch (cause) {
      failures.push(new Error(stage + ': ' + (cause?.message ?? String(cause)), { cause }));
      await cleanupStage(stage + '-error', { ...detail, error: cause?.message ?? String(cause) });
    }
  };
  await cleanupStage('start');
  if (childLifetime) await attempt('child-group-stop', () => childLifetime.terminate(), { pid: child.pid });
  if (profileLifetime) await attempt('profile-stop', () => profileLifetime.terminate(), { pid: profileProcess.pid });
  if (state.stopManagedTasks) await attempt('managed-tasks-stop', state.stopManagedTasks);

  const stopObserving = observePrivatePgStop();
  // Waiting is a stage receipt, not evidence that a process has exited.
  const stopTimer = isolatedRuntime ? setInterval(() => cleanupStage('pg-stop-waiting'), 5000) : null;
  stopTimer?.unref();
  try {
    await attempt('pg-stop', () => pg?.stop(), { health: pg?.health?.() ?? null });
  } finally {
    if (stopTimer) clearInterval(stopTimer);
    stopObserving();
  }
  if (failures.length) {
    await cleanupStage('private-state-retained', { errors: failures.map(error => error.message),
      runtimeRemoved: !runtimeRoot || !existsSync(runtimeRoot), pgDataRemoved: !existsSync(dataDir) });
    throw new AggregateError(failures, 'private runtime cleanup has unverified resource stops');
  }

  await cleanupStage('remove-private-state');
  // Removal failures also need an unsuccessful exit and an exact residue receipt.
  await attempt('pg-data-remove', () => rm(dataDir, { recursive: true, force: true }), {}, 'pg-data-removed');
  if (runtimeRoot) await attempt('runtime-remove', () => rm(runtimeRoot, { recursive: true, force: true }), {}, 'runtime-removed');
  const removed = { runtimeRemoved: !runtimeRoot || !existsSync(runtimeRoot), pgDataRemoved: !existsSync(dataDir) };
  if (failures.length || !removed.runtimeRemoved || !removed.pgDataRemoved) {
    await cleanupStage('private-state-retained', { ...removed, errors: failures.map(error => error.message) });
    throw new AggregateError(failures, 'private runtime cleanup did not remove all owned state');
  }
  await cleanupStage('complete', removed);
}
