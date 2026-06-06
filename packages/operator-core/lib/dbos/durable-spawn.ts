/**
 * dbos/durable-spawn — the reusable DURABLE-SPAWN wrapper
 * (unify-agent-spawn-chokepoint-2026-06-06, P-010 / D-003 / D-007).
 *
 * Generalizes the feature pipeline's durable-step pattern (a registered DBOS
 * workflow + a retried step + a dedup-keyed start) into a reusable primitive for
 * the AUTONOMOUS launches that used to `void loopbackFetch(/invoke)` and LOSE the
 * agent on a host crash. `durableSpawnFire(input)` wraps the `/invoke` fire in a
 * registered, step-retried, dedup-keyed DBOS workflow: a host crash mid-fire is
 * resumed by DBOS recovery and the fire re-runs once, instead of silently vanishing.
 *
 * Degrade-safe by spawn class / DBOS state (D-003 / D-007). `durableSpawnFire`
 * returns `false` — so the caller keeps its existing fire-and-forget — when:
 *   • DBOS is OFF (`PAPERCUSP_DBOS_ORCHESTRATOR=0`), or
 *   • it cannot start a durable workflow here (e.g. it was called from inside
 *     another DBOS step, where starting a child workflow is disallowed).
 * It NEVER throws and NEVER blocks on the agent's lifetime — the durable workflow
 * runs detached, exactly like the fire-and-forget it replaces.
 *
 * Per-class durability (D-003 — the class is the dial, not a global on/off):
 *   • launch-blueprints (release cadence, event reactions, git-sync merge-resolver)
 *     fire top-level → this wrapper makes them durable.
 *   • the routine bare-role fire runs INSIDE a durable `routineFireWorkflow` step;
 *     its recovery is the routine cadence (the next due tick re-fires) — it stays
 *     as-is (a child-workflow can't start from inside a step anyway).
 *   • `fleet:spawn` (operator-spawn) keeps the durable nursery row + the P-011
 *     reclaim sweeper (fail-loud + free the ceiling on a dead host) — chosen to
 *     preserve `fleet:cancel`'s in-process abort and because a one-shot
 *     operator-initiated spawn should not silently re-run on a host restart.
 *
 * Registered in bootstrap.ts under `dbosOrchestratorActive()` — BEFORE
 * `DBOS.launch()`, like the feature-pipeline + coord-program workflows.
 */
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import { dbosOrchestratorActive } from './dbos-flags';
import { loopbackFetch } from '../loopback-fetch';

export interface DurableSpawnFireInput {
  /** The `/invoke?role=<role>` URL to POST. */
  url: string;
  /** The POST body (kickoff, extra, timeoutMs, …). Plain data → DBOS-serializable. */
  body: Record<string, unknown>;
  /** Unique-per-fire key → the DBOS workflow ID + dedup ID. A crash recovers THIS
   *  fire by this id; two distinct fires must use distinct keys. */
  idempotencyKey: string;
  /** For logging — "<slug>/<role>". */
  label?: string;
}

async function durableSpawnFireImpl(input: DurableSpawnFireInput): Promise<void> {
  await DBOS.runStep(
    async () => {
      const r = await loopbackFetch(input.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input.body),
      });
      // A non-2xx is a transient fire failure → throw so the step retries (and a
      // host crash mid-run is resumed by DBOS recovery, re-firing once).
      if (!r.ok) {
        throw new Error(`durable-spawn fire ${input.label ?? ''} → HTTP ${r.status}`);
      }
    },
    { name: 'durable-spawn-fire', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 10, backoffRate: 2 },
  );
}

// Idempotent registration (see orchestrator-workflow.ts for the full rationale):
// the workflow + queue are PROCESS-GLOBAL DBOS registrations that throw on a duplicate
// name, so a vi.resetModules() re-import would crash. Cache the handles on a globalThis
// symbol (resetModules doesn't clear it); a no-op in production (loads once).
const _dbosRegistryCache = globalThis as unknown as Record<symbol, unknown>;
function _registerDurableSpawnFire() {
  return DBOS.registerWorkflow(durableSpawnFireImpl, {
    name: 'durableSpawnFire',
    maxRecoveryAttempts: 5,
  });
}
export const durableSpawnFireWorkflow = (_dbosRegistryCache[
  Symbol.for('papercusp.dbos.durableSpawnFireWorkflow')
] ??= _registerDurableSpawnFire()) as ReturnType<typeof _registerDurableSpawnFire>;

export const durableSpawnQueue = (_dbosRegistryCache[
  Symbol.for('papercusp.dbos.durable-spawn-fire-queue')
] ??= new WorkflowQueue('durable-spawn-fire', { concurrency: 8 })) as WorkflowQueue;

/**
 * Durably fire an autonomous agent launch. Returns `true` when the durable workflow
 * was enqueued, `false` when the caller should do its existing fire-and-forget
 * (DBOS off, or a durable start isn't possible here). Never throws; never blocks on
 * the agent's lifetime.
 */
export async function durableSpawnFire(input: DurableSpawnFireInput): Promise<boolean> {
  if (!dbosOrchestratorActive()) return false;
  const id = `durable-spawn:${input.idempotencyKey}`;
  try {
    await DBOS.startWorkflow(durableSpawnFireWorkflow, {
      workflowID: id,
      queueName: durableSpawnQueue.name,
      enqueueOptions: { deduplicationID: id },
    })(input);
    return true;
  } catch (e) {
    // Cannot start a durable workflow in this context (called from inside a step,
    // or DBOS not launched) → caller falls back to fire-and-forget.
    console.warn(
      `[durable-spawn] could not enqueue durable fire (${input.label ?? ''}); falling back to fire-and-forget: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}
