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
import { queueConcurrency } from './queue-concurrency';
import { dbosOrchestratorActive } from './dbos-flags';
import { loopbackFetch } from '../loopback-fetch';
import { agentProducedTurn, type SpawnFailureClass } from '../fleet/invoke-outcome';

/**
 * HTTP statuses where retrying the IDENTICAL replayed request can never succeed,
 * so the fire step does NOT retry or DBOS-recover them — it returns a terminal
 * result, closes the fleet:tree row `failed`, and stops.
 *
 * Two deterministic-failure families:
 *   • TARGET GONE (404/410): the harness was deleted, so `/invoke` 404s forever
 *     (observed on green for deleted harnesses like offsite-planner-demo).
 *   • CLIENT ERROR (other 4xx): the persisted request is malformed for the target
 *     — e.g. WI-262/D1: a durable replay after a bg-host restart lost its resolved
 *     workspace and re-fires with `workspace:"*"` → 400 `unknown_workspace`. The
 *     same persisted body 400s on every replay, so 3 step-retries × 5 DBOS
 *     recoveries spam `→ HTTP 400` every ~1s and hold a zombie row. Deterministic
 *     → terminal.
 *
 * EXCEPT the genuinely transient 4xx — 408 (timeout) + 429 (rate-limit / gateway
 * pacing) — which stay retryable, as do all 5xx + network errors.
 */
export function isPermanentSpawnStatus(status: number): boolean {
  if (status === 408 || status === 429) return false; // transient 4xx
  return status >= 400 && status < 500;
}

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

export const DURABLE_SPAWN_FINISH_CUSHION_MS = 60_000;
const CONTROL_PLANE_USAGE_LIMIT_PAUSE_MS = 10 * 60_000;

export function durableSpawnWorkflowTimeoutMs(input: DurableSpawnFireInput): number | undefined {
  const timeoutMs = input.body?.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return Math.trunc(timeoutMs) + DURABLE_SPAWN_FINISH_CUSHION_MS;
}

function isCodexModelSpec(spec: unknown): boolean {
  if (typeof spec !== 'string') return false;
  const id = spec.trim().toLowerCase();
  return id.startsWith('openai-codex/') || id.startsWith('chatgpt:') || /^gpt-\d/.test(id);
}

function parseInvokeTarget(input: DurableSpawnFireInput): { role: string; harnessSlug: string; workspaceId: string } | null {
  try {
    const u = new URL(input.url);
    const role = (u.searchParams.get('role') ?? '').trim();
    const workspaceId = (input.spawnRecord?.workspaceId ?? u.searchParams.get('ws') ?? '').trim();
    const m = u.pathname.match(/\/api\/harness\/([^/]+)\/invoke$/);
    const harnessSlug = m?.[1] ? decodeURIComponent(m[1]) : '';
    if (!role || !workspaceId || !harnessSlug) return null;
    return { role, workspaceId, harnessSlug };
  } catch {
    return null;
  }
}

function parseInvokeResultBody(bodyText: string): {
  ok?: unknown;
  rawStdoutTail?: unknown;
} | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText);
    return parsed && typeof parsed === 'object' ? parsed as { ok?: unknown; rawStdoutTail?: unknown } : null;
  } catch {
    return null;
  }
}

function runIdFromWrapperTail(rawStdoutTail: unknown): string | null {
  if (typeof rawStdoutTail !== 'string') return null;
  const m =
    rawStdoutTail.match(/\/([0-9]{10,}-[A-Za-z0-9_-]+)\.(?:out|jsonl|err)\b/) ??
    rawStdoutTail.match(/\brun(?:Id)?[=:]\s*["']?([0-9]{10,}-[A-Za-z0-9_-]+)/i);
  return m?.[1] ?? null;
}

async function enrichInvokeBodyWithPgRunOutput(bodyText: string, input: DurableSpawnFireInput): Promise<string> {
  const parsed = parseInvokeResultBody(bodyText);
  if (!parsed || typeof parsed.ok !== 'boolean') return bodyText;
  const runId = runIdFromWrapperTail(parsed.rawStdoutTail);
  if (!runId) return bodyText;
  const target = parseInvokeTarget(input);
  if (!target) return bodyText;

  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;
    if (typeof sql !== 'function') return bodyText;
    const rows = await sql<Array<{ diagnostic: string | null }>>`
      SELECT left(concat_ws(E'\n', jsonl_body, err_body, out_body), 4000) AS diagnostic
      FROM harness_shared.harness_run_output
      WHERE workspace_id = ${target.workspaceId}
        AND harness_slug = ${target.harnessSlug}
        AND run_id = ${runId}
      LIMIT 1
    `;
    const diagnostic = rows?.[0]?.diagnostic?.trim();
    if (!diagnostic) return bodyText;
    const rawTail = typeof parsed.rawStdoutTail === 'string' ? parsed.rawStdoutTail : '';
    return JSON.stringify({
      ...parsed,
      rawStdoutTail: `${rawTail}\n[pgRunOutput:${runId}]\n${diagnostic}`,
    });
  } catch {
    return bodyText;
  }
}

async function refreshControlPlaneSpawnModel(input: DurableSpawnFireInput): Promise<Record<string, unknown>> {
  const existing = input.body.spawnModel;
  if (typeof existing === 'string' && existing.trim()) return input.body;

  const target = parseInvokeTarget(input);
  if (!target || (target.role !== 'queen' && target.role !== 'overwatch')) return input.body;

  try {
    const { getOwnerSteering } = await import('../owner-steering');
    const steering = await getOwnerSteering(target.workspaceId, target.harnessSlug);
    let spawnModel: string | null | undefined = null;
    if (target.role === 'overwatch') {
      spawnModel = steering.modelOverrides?.overwatch;
    } else {
      const [{ readAgentConfig }, { effectiveTierConfig, resolveRoleOwnModelSpec }] = await Promise.all([
        import('../agent-config'),
        import('../fleet/model-tiers'),
      ]);
      const cfg = await readAgentConfig().catch(() => null);
      spawnModel = resolveRoleOwnModelSpec('queen', effectiveTierConfig(cfg, steering));
    }
    return typeof spawnModel === 'string' && spawnModel.trim()
      ? { ...input.body, spawnModel: spawnModel.trim() }
      : input.body;
  } catch {
    return input.body;
  }
}

async function recordControlPlaneCodexUsageLimit(
  input: DurableSpawnFireInput,
  fireBody: Record<string, unknown>,
): Promise<void> {
  if (!isCodexModelSpec(fireBody.spawnModel)) return;
  const target = parseInvokeTarget(input);
  if (!target) return;

  try {
    const [{ selectSpawnAccount, updateAccountPool }, { recordAccountPenalty }] = await Promise.all([
      import('../deployment/account-pool-store'),
      import('../deployment/account-pool'),
    ]);
    const accountId = await selectSpawnAccount(
      target.workspaceId,
      target.harnessSlug,
      undefined,
      'codex',
    );
    if (!accountId) return;
    const now = Date.now();
    const pausedUntil = now + CONTROL_PLANE_USAGE_LIMIT_PAUSE_MS;
    await updateAccountPool(
      (pool) => recordAccountPenalty(pool, accountId, now, { pausedUntil }),
      target.workspaceId,
    );
    console.warn(
      `[durable-spawn] marked Codex account '${accountId}' paused after control-plane usage_limit (${target.harnessSlug}/${target.role})`,
    );
  } catch (e) {
    console.warn(
      `[durable-spawn] Codex usage_limit account feedback failed (${input.label ?? ''}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export async function durableSpawnFireImpl(input: DurableSpawnFireInput): Promise<void> {
  const rec = input.spawnRecord;
  // Stable so a step retry / recovery replay updates the SAME row, not a new one.
  const spawnId = `durable-spawn:${input.idempotencyKey}`;
  const initialFireBody = await refreshControlPlaneSpawnModel(input);
  const initialSpawnModel =
    typeof initialFireBody.spawnModel === 'string' && initialFireBody.spawnModel.trim()
      ? initialFireBody.spawnModel.trim()
      : null;

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
            modelSpec: initialSpawnModel,
            status: 'running',
          });
          // EI-85/P-033 false-reclaim fix: stamp the FIRING process's pid (THIS long-lived
          // operator host, which holds the loopback /invoke connection for the agent's whole run)
          // so the reclaim sweep can /proc-liveness-check this row (kind='launch' for durable-spawn
          // rows — see spawn-reclaim.ts). Without a pid the sweep CANNOT verify liveness and
          // UNCONDITIONALLY reclaims the row as "host presumed dead" the moment its heartbeat goes
          // stale under load — false-reclaiming a still-alive durable launch (the Queen + the
          // EI-403-A implement workers were the observed victims, 2026-06-23 D-011).
          const { recordSpawnPid } = await import('../fleet/spawn-reclaim');
          await recordSpawnPid(getOrgPg().sql, spawnId, process.pid);
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
  let fireResult:
    | { ok: true }
    | { ok: false; permanentStatus: number; detail: string }
    | { ok: false; failureClass: SpawnFailureClass; detail: string }
    | null = null;
  try {
    fireResult = await DBOS.runStep(
      async () => {
        const fireBody = await refreshControlPlaneSpawnModel(input);
        const r = await loopbackFetch(input.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fireBody),
        }, { launch: true });
        if (r.ok) {
          // D-007/D-010 fail-loud: the fire holds the connection for the agent's run, so r.ok
          // ≈ "the run finished" — but HTTP 200 does NOT mean the agent actually RAN. On an
          // unstable/restarting launcher host the invoke returns ok-shaped while the agent
          // never produced a turn (the ~3s, 0-token Queen/overwatch wakes that were recorded
          // 'done' → silent placement/scorecard stalls). Inspect the invoke body (the route
          // returns { ok: exitCode===0 && !timedOut, agentOutput, ... }): treat a parseable
          // result reporting the agent did NOT complete a turn (route ok:false, OR empty
          // agentOutput — blueprint roles ALWAYS emit a decision line, so empty ⇒ no turn) as
          // an infra-loss recorded `failed`, not `done`. An unreadable/unparseable body ⇒ keep
          // the OLD 'done' behavior — never flip on uncertainty (most load-bearing path).
          // HTTP 200 ≠ the agent ran. Judge the invoke body with the SHARED rule
          // (fleet/invoke-outcome) so this path and launch-blueprint classify a
          // no-turn death identically — a 429'd/dead-launcher spawn is `failed`
          // (infra_loss), never silently `done` (docs-audit 2026-06-23 #1).
          const rawBodyText = typeof r.text === 'function' ? await r.text().catch(() => '') : '';
          const bodyText = await enrichInvokeBodyWithPgRunOutput(rawBodyText, input);
          const prelim = agentProducedTurn(bodyText, input.label ?? '');
          if (prelim.ran) return { ok: true } as const;
          // No turn. Corroborate with the LIVE gateway state to tell a CAPACITY-SHED
          // (the all-accounts 429 storm killed the agent mid-turn — RETRYABLE) from a
          // genuine launcher-host loss (terminal). H13/P-006: a capacity shed was being
          // mislabeled `infra_loss` / "host dead/unstable" → sent debuggers hunting a
          // phantom host bug (~2h) when the real cause was the gateway storm.
          const { gatewayWholesaleThrottled } = await import('../inference-gateway/observability');
          const gatewayThrottled = isCodexModelSpec(fireBody.spawnModel)
            ? false
            : await gatewayWholesaleThrottled().catch(() => false);
          const outcome = agentProducedTurn(bodyText, input.label ?? '', { gatewayThrottled });
          if (outcome.failureClass === 'capacity_shed') {
            // RETRYABLE: THROW so the step retry (maxAttempts:3, 10s/20s backoff) re-fires
            // through the PACED gateway once capacity returns — instead of recording a
            // terminal phantom host death. The `capacity_shed:` prefix makes the persisted
            // error self-diagnosing (capacity event, NOT infra_loss). After the retries
            // exhaust it lands `failed` with the capacity_shed label, never "host dead".
            throw new Error(`capacity_shed:${outcome.detail.trim()}`);
          }
          return {
            ok: false,
            failureClass: outcome.failureClass ?? 'infra_loss',
            detail: outcome.detail,
          } as const;
        }
        // Capture the response body so a non-2xx fire is self-diagnosing: the bare
        // status (`→ HTTP 400`) tells the watchdog/operator nothing about WHICH
        // install or WHY the /invoke route rejected the spawn, so a recurring 400
        // (observed: papercup/papercup-hive queen fires) is undebuggable from the
        // persisted error alone. Mirrors the describeFetchError convention for
        // network errors (loopback-fetch.ts). Bounded + whitespace-collapsed to
        // keep the persisted workflow_status error row small.
        // Defensive: the diagnostic read must never itself break the fire step,
        // so guard that `.text` exists (real Response always has it) and swallow
        // any read error.
        const body =
          typeof r.text === 'function' ? await r.text().catch(() => '') : '';
        const detail = body ? ` — ${body.replace(/\s+/g, ' ').trim().slice(0, 300)}` : '';
        // Deterministic failure (target gone 404/410, or a non-retryable 4xx like
        // the workspace:"*" 400 — see isPermanentSpawnStatus): retrying (3×) + DBOS
        // recovery (5×) can never succeed and just spams the log. Return — the step
        // SUCCEEDS, so neither retries nor recovery fire and the workflow ends.
        // Transient non-2xx (5xx, 408, 429, network) throws → retry.
        if (isPermanentSpawnStatus(r.status)) {
          return { ok: false, permanentStatus: r.status, detail } as const;
        }
        throw new Error(`durable-spawn fire ${input.label ?? ''} → HTTP ${r.status}${detail}`);
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
      ? 'failureClass' in fireResult
        ? `${fireResult.failureClass}:${fireResult.detail}`
        : `durable-spawn fire ${input.label ?? ''} → HTTP ${fireResult.permanentStatus}${fireResult.detail} (permanent client/target error — not retried)`
      : null;
  if (permanentMsg) {
    console.warn(`[durable-spawn] ${permanentMsg}`);
    if (
      fireResult &&
      !fireResult.ok &&
      'failureClass' in fireResult &&
      fireResult.failureClass === 'usage_limit'
    ) {
      await recordControlPlaneCodexUsageLimit(input, initialFireBody);
    }
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

export const durableSpawnQueue = new WorkflowQueue('durable-spawn-fire', { concurrency: queueConcurrency(8) });

/**
 * Durably fire an autonomous agent launch. Returns `true` when the durable workflow
 * was enqueued, `false` when the caller should do its existing fire-and-forget
 * (DBOS off, or a durable start isn't possible here). Never throws; never blocks on
 * the agent's lifetime.
 */
export async function durableSpawnFire(input: DurableSpawnFireInput): Promise<boolean> {
  if (!dbosOrchestratorActive()) return false;
  const id = `durable-spawn:${input.idempotencyKey}`;
  const timeoutMS = durableSpawnWorkflowTimeoutMs(input);
  try {
    await DBOS.startWorkflow(durableSpawnFireWorkflow, {
      workflowID: id,
      queueName: durableSpawnQueue.name,
      ...(timeoutMS ? { timeoutMS } : {}),
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
  // COOPERATIVE YIELD between fires (event-loop-lag root fix). A big drain
  // (the implement lane / a Queen's batch placement) runs N `DBOS.startWorkflow`
  // enqueues back-to-back; under DBOS catch-up load each can be synchronous-heavy,
  // and the unbroken loop starves the routine ticker → the CPU-bound-main-thread
  // restart loop that reclaim-kills queen/bee spawns. Yield the macrotask queue
  // between fires so the ticker interleaves (quiet drain ≈ free; a saturated loop
  // yields every iteration via loopPressure()).
  const { cooperativeYield } = await import('../event-loop-lag-monitor');
  let yielded = 0;
  for (const req of reqs) {
    if (await durableSpawnFire(req)) enqueued += 1;
    yielded = await cooperativeYield(yielded);
  }
  return { enqueued, total: reqs.length };
}
