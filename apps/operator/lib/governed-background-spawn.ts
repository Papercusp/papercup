/**
 * Governed fire-and-forget background spawn of an invoke-once agent (RB-012).
 *
 * The scoper (harness-scoper.ts) spawns an invoke-once CLI agent DETACHED + unref'd,
 * then polls a result file for the
 * `__INVOCATION_DONE__` sentinel — it owns no handle on the child. This is the same
 * spawn shape, so it's lifted here with one governance point: when
 * PAPERCUSP_AGENT_GOVERNOR=1 the spawn first acquires a SHARED concurrency permit (so
 * these background agents don't pile onto a pipeline burst against the same provider
 * bucket), and releases it when the child exits. PACING ONLY — no re-spawn/retry (the CLI
 * self-retries; the director owns turn retries; re-spawning would amplify 429s).
 *
 * Flag OFF (default) = byte-identical to the legacy `spawn(...).unref()` (synchronous).
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { governorForBackend } from '@papercusp/papercup-shared/agent';

/** Cap (ms) on how long a background spawn waits for a permit before skipping (default 30m). */
const DEFAULT_MAX_WAIT_MS = Number(process.env.PAPERCUSP_AGENT_GOVERNOR_MAX_WAIT_MS ?? 1_800_000);

export interface GovernedBackgroundSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * The invoke-once result log the caller polls. On a governor bail (bucket paused past
   * maxWait) we append the DONE sentinel + an error line so the caller's file-poll ends
   * instead of hanging forever.
   */
  resultPath?: string;
  /** Provider bucket to pace under (default claude-code/anthropic, matching the orchestrator). */
  backend?: 'claude-code' | 'omp' | 'codex';
  maxWaitMs?: number;
}

/** Spawn the detached invoke-once child (the legacy shape). */
function spawnDetached(spec: GovernedBackgroundSpawnSpec) {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  return child;
}

export function spawnInvokeOnceBackground(spec: GovernedBackgroundSpawnSpec): void {
  // Flag OFF: byte-identical legacy path (synchronous detached spawn).
  if (process.env.PAPERCUSP_AGENT_GOVERNOR !== '1') {
    spawnDetached(spec);
    return;
  }
  // Flag ON: acquire a shared permit first, spawn, release on exit. Kept off the caller's
  // sync return path via a detached async IIFE (callers are already fire-and-forget).
  void (async () => {
    const gov = governorForBackend(spec.backend ?? 'claude-code', '');
    const release = await gov.acquire({}, { maxWaitMs: spec.maxWaitMs ?? DEFAULT_MAX_WAIT_MS });
    if (!release) {
      if (spec.resultPath) {
        try {
          appendFileSync(
            spec.resultPath,
            `\n[governed-spawn] rate-limit pause exceeded max wait; invocation skipped\n__INVOCATION_DONE__\n`,
          );
        } catch { /* best-effort: the poller will time out on its own otherwise */ }
      }
      return;
    }
    let released = false;
    const releaseOnce = () => {
      if (!released) { released = true; release(); }
    };
    const child = spawnDetached(spec);
    // The operator is long-lived, so it still receives these even after unref().
    child.on('close', releaseOnce);
    child.on('error', releaseOnce);
  })();
}
