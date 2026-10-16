import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type SpawnOptions } from 'node:child_process';
import { killSpawnedProcessTree } from '../../../../scripts/lib/batch-watchdog.mjs';

/** Establish attribution before source preparation or provider allocation. */
export function nativeBootstrapEnvironment(env: NodeJS.ProcessEnv, ledgerUrl: string): NodeJS.ProcessEnv {
  const workspace = env.PAPERCUSP_TEST_RUN_WORKSPACE || env.PAPERCUSP_WORKSPACE_ID || env.PAPERCUSP_WORKSPACE;
  assert.ok(workspace?.trim(), 'PAPERCUSP_TEST_RUN_WORKSPACE is required before native allocation');
  assert.ok(ledgerUrl.trim(), 'PAPERCUSP_TEST_RUNS_DB_URL is required before native allocation');
  return { ...env, PAPERCUSP_TEST_RUNS_DB_URL: ledgerUrl, PAPERCUSP_TEST_RUN_WORKSPACE: workspace,
    PAPERCUSP_TEST_RUN_GROUP: env.PAPERCUSP_TEST_RUN_GROUP?.trim() || `dao-hr-native-${randomUUID()}` };
}

/** Join the whole verifier tree before fixtures can be torn down or a test can finish. */
export async function runNativeVerifier(command: string, args: string[], options: SpawnOptions & {
  signal: AbortSignal; timeoutMs: number; killGraceMs?: number;
}): Promise<number | null> {
  const { signal, timeoutMs, killGraceMs = 30_000, ...spawnOptions } = options;
  signal.throwIfAborted();
  assert.ok(timeoutMs > 0, 'Native bootstrap exhausted its preparation budget before verifier launch');
  const child = spawn(command, args, { ...spawnOptions, detached: true });
  let failure: Error | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: Error) => {
    if (failure) return;
    failure = reason;
    killSpawnedProcessTree(child, 'SIGTERM');
    escalation = setTimeout(() => killSpawnedProcessTree(child, 'SIGKILL'), killGraceMs);
  };
  const abort = () => stop(new Error('Native verifier cancelled with its enclosing test', { cause: signal.reason }));
  const deadline = setTimeout(() => stop(new Error(`Native verifier exceeded its remaining ${timeoutMs}ms budget`)), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => failure ? reject(failure) : resolve(code));
    });
  } finally {
    clearTimeout(deadline);
    if (escalation) clearTimeout(escalation);
    signal.removeEventListener('abort', abort);
  }
}
