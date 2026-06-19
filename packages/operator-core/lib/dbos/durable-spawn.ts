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
 *   • a SYSTEM action that wants a durable child fire (EI-403-A) returns the fire
 *     request as `SystemActionResult.durableSpawns`; `routineFireWorkflow` drains it
 *     via `startDurableSpawns` AFTER the action's step, at the workflow layer where
 *     `startWorkflow` is legal — escaping the from-a-step limitation for the
 *     implement lane without making the fire fire-and-forget.
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

/**
 * HTTP statuses where the spawn TARGET IS PERMANENTLY GONE — the harness was
 * deleted, so its `/invoke` route will 404 (or 410) forever. The fire step does
 * NOT retry or DBOS-recover these: retrying a deleted-harness spawn can never
 * succeed and only amplifies one dead spawn into perpetual `→ HTTP 404` log spam
 * (observed on green for deleted harnesses like offsite-planner-demo). Every
 * other non-2xx (5xx, 429, network) stays transient → step-retry + recovery.
 */
const PERMANENT_SPAWN_STATUSES = new Set([404, 410]);

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
  /**
   * OPT-IN fleet:tree visibility (EI-403 round-2). When set, the durable workflow
   * writes a `spawned_agents` row (stable `spawn_id = durable-spawn:<idempotencyKey>`,
   * idempotent on conflict so a step retry / DBOS recovery replay never duplicates
   * it) BEFORE the fire and `finishSpawn`s it after — so a durably-fired launch
   * appears in fleet:tree, the same invariant the fire-and-forget fallback holds
   * (WI-108). Recording is best-effort: a bookkeeping failure never aborts the fire.
   * OMIT for callers whose spawn is recorded by another path (e.g. hive launches
   * write their own queen/bee rows — recording here too would double-count).
   */
  spawnRecord?: {
    workspaceId: string;
    harnessSlug?: string;
    childRole: string;
    /** Defaults to 'operator' — a parentless system launch (matches every root spawn). */
    parentRole?: string;
    parentSpawnId?: string | null;
    /** e.g. the improvement-lane `EI-NNN` the worker is fixing — shows in fleet:tree. */
    itemId?: string | null;
  };
}

export async function durableSpawnFireImpl(input: DurableSpawnFireInput): Promise<void> {
  const rec = input.spawnRecord;
  // Stable so a step retry / recovery replay updates the SAME row, not a new one.
  const spawnId = `durable-spawn:${input.idempotencyKey}`;

  // Make the durable launch visible in fleet:tree (opt-in), mirroring the
  // fire-and-forget fallback's recordSpawn (WI-108). Best-effort: a bookkeeping
  // failure must never abort the actual fire below.
  if (rec) {
    await DBOS.runStep(
      async () => {
        try {
          const { recordSpawn } = await import('../fleet/spawn-tree');
          const { getOrgPg } = await import('@papercusp/db-org');
          await recordSpawn(getOrgPg().sql, {
            spawnId,
            workspaceId: rec.workspaceId,
            harnessSlug: rec.harnessSlug,
            parentSpawnId: rec.parentSpawnId ?? null,
            parentRole: rec.parentRole ?? 'operator',
            childRole: rec.childRole,
            runId: input.idempotencyKey,
            itemId: rec.itemId ?? null,
            status: 'running',
          });
        } catch (e) {
          console.warn(
            `[durable-spawn] record-spawn failed (${input.label ?? ''}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
      { name: 'durable-spawn-record', retriesAllowed: false },
    );
  }

  let fireError: unknown = null;
  // The fire step returns a discriminated result (memoized by DBOS, so it
  // survives a recovery replay) instead of leaking via closure side-effects.
  let fireResult: { ok: true } | { ok: false; permanentStatus: number } | null = null;
  try {
    fireResult = await DBOS.runStep(
      async () => {
        const r = await loopbackFetch(input.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input.body),
        });
        if (r.ok) return { ok: true } as const;
        // Permanent (target-gone) failure: the harness was deleted, so retrying
        // (3×) + DBOS recovery (5×) can never succeed and just spams the log.
        // Return — the step SUCCEEDS, so neither retries nor recovery fire and the
        // workflow ends. Transient non-2xx (5xx, 429, network) throws → retry.
        if (PERMANENT_SPAWN_STATUSES.has(r.status)) {
          return { ok: false, permanentStatus: r.status } as const;
        }
        throw new Error(`durable-spawn fire ${input.label ?? ''} → HTTP ${r.status}`);
      },
      { name: 'durable-spawn-fire', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 10, backoffRate: 2 },
    );
  } catch (e) {
    fireError = e;
  }
  // A permanent failure is terminal but deliberately NOT thrown — throwing would
  // end the workflow ERROR and trigger DBOS recovery. Surface it once and let the
  // fleet:tree row close `failed` below.
  const permanentMsg =
    fireResult && !fireResult.ok
      ? `durable-spawn fire ${input.label ?? ''} → HTTP ${fireResult.permanentStatus} (permanent — spawn target gone; not retried)`
      : null;
  if (permanentMsg) {
    console.warn(`[durable-spawn] ${permanentMsg}`);
  }

  // Close the fleet:tree row — `done` when the fire landed, `failed` (with the
  // error) when it exhausted retries. The /invoke fire holds the connection for the
  // worker's run, so `done` ≈ the worker completed (matches the fallback's finish).
  if (rec) {
    await DBOS.runStep(
      async () => {
        try {
          const { finishSpawn } = await import('../fleet/spawn-tree');
          const { getOrgPg } = await import('@papercusp/db-org');
          await finishSpawn(getOrgPg().sql, {
            spawnId,
            workspaceId: rec.workspaceId,
            status: fireError || permanentMsg ? 'failed' : 'done',
            errorMessage: fireError
              ? fireError instanceof Error
                ? fireError.message
                : String(fireError)
              : permanentMsg,
          });
        } catch (e) {
          console.warn(
            `[durable-spawn] finish-spawn failed (${input.label ?? ''}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
      { name: 'durable-spawn-finish', retriesAllowed: false },
    );
  }

  // Preserve the original contract: a fully-failed fire throws so the workflow ends
  // ERROR (and DBOS recovery can retry it), exactly as before this change.
  if (fireError) throw fireError;
}

export const durableSpawnFireWorkflow = DBOS.registerWorkflow(durableSpawnFireImpl, {
  name: 'durableSpawnFire',
  maxRecoveryAttempts: 5,
});

export const durableSpawnQueue = new WorkflowQueue('durable-spawn-fire', { concurrency: 8 });

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

/**
 * Start a batch of durable spawns from a WORKFLOW context — the EI-403-A seam. A
 * system action that can't start a child workflow from inside its own step instead
 * RETURNS its fire requests (`SystemActionResult.durableSpawns`); the routine
 * workflow calls this AFTER the action's step, where `startWorkflow` is legal.
 *
 * Recovery-safe BY THE CALLER'S contract: the requests come from the step's
 * checkpointed return value, so a replay re-drains the same list, and each fire is
 * idempotency-keyed (`durable-spawn:<key>`) — a stable key dedups the re-fire, a
 * clock-derived key would double-dispatch (hence the SystemActionResult doc's
 * STABLE-key requirement). `durableSpawnFire` never throws, so one declined fire
 * (DBOS off, or a genuine enqueue error) never blocks the rest. Returns how many of
 * `total` were durably enqueued (the remainder are the caller's fire-and-forget /
 * cadence-recovery concern).
 */
export async function startDurableSpawns(
  spawns: DurableSpawnFireInput[] | undefined,
): Promise<{ enqueued: number; total: number }> {
  const reqs = spawns ?? [];
  let enqueued = 0;
  for (const req of reqs) {
    if (await durableSpawnFire(req)) enqueued += 1;
  }
  return { enqueued, total: reqs.length };
}
