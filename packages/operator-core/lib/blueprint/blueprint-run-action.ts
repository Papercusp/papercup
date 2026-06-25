/**
 * The `system:blueprint-run` routine action (harness-blueprint-orchestration-2026-06-03
 * P-021 / D-018).
 *
 * A blueprint declares `triggers.schedule: [{ cron, action }]` defaults; `harness:create`
 * materializes each into a `harness_shared.routines` row whose `target_role` is the action
 * (default `system:blueprint-run` — see `materialize-triggers.ts`). The shipped DBOS
 * `routinesTick` dispatches a due `system:<action>` routine to the registered handler
 * INLINE as one durable step (`system-actions.ts`) — NOT through a `pending_events`
 * consumer (that hop is retired, `git-sync-auto-commit` D-006). This module registers that
 * handler. Blueprint ⟂ scheduler: one seam onto the existing engine, no second scheduler.
 *
 * The handler is blueprint-aware: it resolves the harness's effective blueprint and acts
 * per the routine's `payload_template.mode`:
 *
 *   - `'run'` (default) — fires the blueprint's declared decider role (`spine.decider`) for
 *     the harness via the invoke route. This "starts a blueprint run": the decider wakes,
 *     `deriveNext` drives the next pipeline action. Same autonomous launch the
 *     routines-workflow role-routine branch uses; fire-and-forget. Touches no work-item
 *     table, so it is independent of P-020. Replaying the durable step just re-fires the
 *     decider (idempotent in effect — the decider is fired on a cadence anyway).
 *
 *   - `'work-item'` — creates a work-item of the blueprint's declared `workItem.kind`. v1 is
 *     scoped to `kind === 'feature'` (a normal feature insert into the canonical base
 *     `harness_features_consolidated`); non-feature kinds (e.g. `research-task`) await P-020
 *     generalizing the base into `work_items(kind, payload)` — until then they log + no-op
 *     (coordinated with the P-020 owner: this module does NOT write the `kind` column).
 *
 * Runs as ONE durable step (the `system-actions.ts` contract), so it must be safe to re-run
 * from the top — both modes are (see the per-mode notes above).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { loadBuiltinBlueprint, isProgramSpine, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { resolveProjectDir } from '../spawn-config';
import { loopbackFetch } from '../loopback-fetch';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from '../harness/routines/system-actions';
import { checkFireGate, recordFire } from '../autoloop';
import { getEffectiveBlueprint } from './project-to-pg';
import { resolveLaunchBlueprint, buildLaunchSpawnRequest } from './launch-blueprint';
import { operatorApiBase } from '../operator-api-base';
import { readHarnessRegistryFor } from '../device-harnesses';
import '../coord-ops/index'; // register coord ops (program-mode spine steps)
import '../blueprint-steps/index'; // register deterministic step-ops (P-010)
import { runProgramCore, inlineRunOp } from '../coord-ops/program-runner';
import { buildCoordOpCtx } from '../coord-ops/prod-caps';

const operatorBase = operatorApiBase;

// ── EI-1575: self-heal orphaned routines for deleted harnesses/hives ──────────
// A per-install routine left armed after its harness/hive is deleted fires
// forever — each tick queues a durable blueprint launch whose
// `/api/harness/<slug>/invoke` 404s, so it can never succeed. Rather than rely
// on every deletion path remembering to disarm (and leaving already-orphaned
// rows firing), the firing seam itself disarms when it detects the target is
// gone.

type InstallGoneFn = (workspaceId: string, installSlug: string) => Promise<boolean>;
type DisarmRoutinesFn = (workspaceId: string, installSlug: string) => Promise<number>;
let _installGone: InstallGoneFn | null = null;
let _disarmRoutines: DisarmRoutinesFn | null = null;

/** Test seam (EI-1575): override the orphaned-install existence check + disarm. */
export function setOrphanRoutineSeams(seams: {
  installGone?: InstallGoneFn | null;
  disarm?: DisarmRoutinesFn | null;
}): void {
  if ('installGone' in seams) _installGone = seams.installGone ?? null;
  if ('disarm' in seams) _disarmRoutines = seams.disarm ?? null;
}

/**
 * True when `installSlug` names a harness/hive that no longer exists in the
 * workspace registry, so its routines are orphaned and should be disarmed.
 * Deliberately conservative — it returns false (NOT gone) when:
 *   - the slug is a reserved `@`-prefixed harness-LESS host (e.g. the
 *     `@singleton` learning-loop routines, which legitimately have no harness), or
 *   - the slug is the workspace sentinel itself (workspace-scoped hive/learning
 *     routines use this harness-less install host), or
 *   - the registry reads back empty (a transient unreadable registry must never
 *     be mistaken for "every harness was deleted" → mass-disarm).
 */
async function installIsGone(workspaceId: string, installSlug: string): Promise<boolean> {
  if (installSlug.startsWith('@')) return false; // reserved harness-less host
  if (installSlug === workspaceId) return false; // reserved workspace-scoped harness-less host
  try {
    const projects = await readHarnessRegistryFor(workspaceId);
    if (projects.length === 0) return false; // registry empty/unreadable — don't risk a false disarm
    return !projects.some((p) => p.slug === installSlug);
  } catch {
    // A transient registry-read failure must never be read as "gone" (→ disarm)
    // nor crash the routine step. Treat as not-gone; the next fire re-checks.
    return false;
  }
}

/** Disarm (deactivate) every active routine of a gone install. Returns the count. */
async function disarmInstallRoutines(workspaceId: string, installSlug: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.routines
       SET active = false, next_fire_at = NULL, updated_at = now()
     WHERE workspace_id = ${workspaceId}
       AND install_slug = ${installSlug}
       AND active = true
    RETURNING id
  `;
  return rows.length;
}

/**
 * The decider-fire seam — injectable so tests capture the dispatch without a real HTTP
 * call (the codebase's `setPipelineInvokeRunner` pattern). Default = the invoke route.
 */
export type DeciderFireFn = (input: {
  installSlug: string;
  workspaceId: string;
  role: string;
  kickoff: string;
}) => void | Promise<void>;

let _fire: DeciderFireFn | null = null;
/** Override the decider-fire fn (tests). Pass `null` to restore the default invoke fire. */
export function setBlueprintRunFire(fn: DeciderFireFn | null): void {
  _fire = fn;
}

const defaultFire: DeciderFireFn = ({ installSlug, workspaceId, role, kickoff }) => {
  // Validate role name — reject invalid characters before sending the request (EI-212).
  // The invoke route validates with /^[A-Za-z0-9_-]+$/, so ensure it matches.
  if (!/^[A-Za-z0-9_-]+$/.test(role)) {
    const detail = `invalid role name '${role}' — allowed: [A-Za-z0-9_-]`;
    console.warn(`[blueprint-run] decider fire skipped (${installSlug}/${role}): ${detail}`);
    void recordFire(installSlug, role, `error: ${detail}`, 'error').catch(() => {});
    return;
  }
  const ws = encodeURIComponent(workspaceId);
  const url = `${operatorBase()}/api/harness/${encodeURIComponent(installSlug)}/invoke?role=${encodeURIComponent(role)}&ws=${ws}`;
  // Fire-and-forget: the invoke route runs the agent to completion (up to its timeout); a
  // scheduled run must NOT block the durable step on the whole agent lifetime — the next
  // due tick re-fires (the routine cadence model). Mirrors routines-workflow.ts's
  // role-routine branch + the git-sync merge-resolver dispatch.
  //
  // P-009 (D-009): the dispatch + its eventual settle are recorded into
  // harness_shared.autoloop_state, so consecutive_errors feeds the fire gate —
  // a repeatedly-failing decider backs off instead of re-firing at full cadence.
  void recordFire(installSlug, role, 'firing', 'attempt').catch(() => {});
  void loopbackFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kickoff }),
  })
    .then(
      async (r) => {
        if (r.ok) return recordFire(installSlug, role, 'ok', 'ok');
        // EI-212: keep a snippet of the error body — a bare "HTTP 400" left the
        // root cause unidentifiable (the gym E2E chased it for a day).
        const body = await r
          .text()
          .then((t) => t.replace(/\s+/g, ' ').slice(0, 160))
          .catch(() => '');
        return recordFire(
          installSlug,
          role,
          `error: HTTP ${r.status}${body ? ` — ${body}` : ''}`,
          'error',
        );
      },
      (e) => {
        const detail = String(e instanceof Error ? e.message : e).slice(0, 180);
        console.warn(`[blueprint-run] decider fire failed (${installSlug}/${role}): ${detail}`);
        return recordFire(installSlug, role, `error: ${detail}`, 'error');
      },
    )
    .catch(() => {});
};

/** Lazily-loaded built-in `coding-factory` blueprint — the fallback when a harness has no blueprint
 *  (behavior-preserving for every pre-blueprint harness: decider `director`, kind `feature`). */
let _codingFallback: Blueprint | null = null;
function codingFallback(): Blueprint {
  return (_codingFallback ??= loadBuiltinBlueprint('coding-factory').blueprint);
}

/**
 * The effective-blueprint resolver seam — injectable so unit tests stay hermetic (no PG /
 * registry). Default = `resolveBlueprint` (PG cache + lazy file projection).
 */
export type BlueprintResolverFn = (installSlug: string, workspaceId: string) => Promise<Blueprint | null>;
let _resolver: BlueprintResolverFn | null = null;
/** Override the blueprint resolver (tests). Pass `null` to restore the default. */
export function setBlueprintResolver(fn: BlueprintResolverFn | null): void {
  _resolver = fn;
}

/**
 * Resolve the harness's effective blueprint: PG cache first, lazily projecting the
 * git-canonical `.papercusp/blueprint.yaml` on a miss (`getEffectiveBlueprint`). Returns null
 * when neither a cache row nor a source file exists — the caller falls back to `coding`.
 * Fail-safe: any error → null (a scheduled fire never throws on resolution).
 */
async function resolveBlueprint(installSlug: string, workspaceId: string): Promise<Blueprint | null> {
  const { sql } = getOrgPg();
  let blueprintPath: string | null = null;
  try {
    const dir = await resolveProjectDir(installSlug, workspaceId);
    if (dir) {
      const f = join(dir, '.papercusp', 'blueprint.yaml');
      if (existsSync(f)) blueprintPath = f;
    }
  } catch {
    /* dir unresolved — a cache hit may still satisfy below */
  }
  try {
    return await getEffectiveBlueprint(sql, { workspaceId, harnessSlug: installSlug, blueprintPath });
  } catch (e) {
    console.warn(`[blueprint-run] effective-blueprint resolve failed (${installSlug}): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** A short uppercase random suffix for an auto work-item id. */
function randSuffix(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

/**
 * mode='work-item': create a work-item of the blueprint's declared kind. Writes go to the
 * work_items BASE table `harness_features_consolidated` (P-020 / migration 135 — `work_items`
 * is a read VIEW over the base); `item_kind` is the work-item discriminator and `payload` is
 * kind-specific data. Supports any kind (`feature`, `research-task`, …) with a MINIMAL insert:
 * the base's federation/needs-design triggers are still feature-tuned and fire on every row,
 * so we set only the work-item columns and do NOT rely on trigger side-effects for non-feature
 * kinds (kind-aware triggers are a deferred P-020 follow-on, coordinated w/ that owner).
 *
 * `ON CONFLICT DO NOTHING` makes an explicit-id create replay-safe; an auto-id create matches
 * the existing (non-idempotent) feature-create behavior (execute-action.ts).
 */
async function createWorkItem(ctx: SystemActionCtx, bp: Blueprint): Promise<void> {
  const { installSlug, workspaceId, payloadTemplate } = ctx;
  const wi = (payloadTemplate?.workItem ?? {}) as Record<string, unknown>;
  const itemKind = bp.workItem.kind; // 'feature' | 'research-task' | …
  const idPrefix = bp.workItem.idPrefix || 'W';
  const explicitId = typeof wi.id === 'string' && wi.id.trim() ? wi.id.trim() : null;
  const featureId =
    explicitId ?? `${idPrefix}-SCHED-${Date.now().toString(36).toUpperCase()}${randSuffix()}`;
  const title =
    typeof wi.title === 'string' && wi.title.trim() ? wi.title.trim() : `Scheduled work item (${installSlug})`;
  const summary = typeof wi.summary === 'string' ? wi.summary : null;
  const payload =
    wi.payload && typeof wi.payload === 'object' ? (wi.payload as Record<string, unknown>) : null;
  const now = Date.now();

  const { sql } = getOrgPg();
  // Admin pool (RLS-bypassed) with workspace_id set explicitly — no GUC needed. The jsonb
  // payload is bound as `$N::text::jsonb` (the JSON.stringify'd value), the client-agnostic
  // form that stores a real jsonb object under BOTH the getOrgPg runtime pool AND a
  // fresh/testcontainer pool (agent-insights/postgres-js-jsonb-binding).
  await sql.unsafe(
    `INSERT INTO harness_shared.work_items (
       harness_slug, feature_id, title, summary, status, attempts,
       item_kind, payload, needs_human_review, workspace_id, ts, created_ts, updated_ts
     ) VALUES (
       $1, $2, $3, $4, 'todo', 0,
       $5, $6::text::jsonb, FALSE, $7, $8, $9, $10
     )
     ON CONFLICT (harness_slug, feature_id) DO NOTHING`,
    [installSlug, featureId, title, summary, itemKind, payload ? JSON.stringify(payload) : null, workspaceId, now, now, now],
  );
  console.log(`[blueprint-run] ${installSlug}: created scheduled work-item ${featureId} (item_kind=${itemKind})`);
}

/**
 * Run a PROGRAM-mode blueprint (a migrated deterministic / hybrid learning loop —
 * deterministic-blueprints-migration-2026-06-13 P-011) inline as this durable
 * step, via the pure `runProgramCore` + `inlineRunOp`. Behavior-neutral with the
 * bespoke loops, which also ran inline in their `system:<loop>` step (D-004): the
 * whole steps+gate program runs to completion in one step; a crash replays it
 * (the loops are idempotent / cadence-recovered). A HYBRID loop's agent step
 * (`orchestrator:spawn-roles`) still routes through `coordSpawnRunner` →
 * `spawnInvokeOnce`, THE governed launch chokepoint (D-005) — so blueprint-izing
 * closes the eval-battery second-spawn-path seam for free.
 *
 * `inlineRunOp` runs each op directly (no nested `DBOS.runStep`) — required,
 * since the system action IS already one DBOS step (nested steps are illegal).
 * Never throws: a program failure logs + returns (the durable-step contract).
 */
async function runScheduledProgram(
  bp: Blueprint,
  opts: { installSlug: string; workspaceId: string; payload?: Record<string, unknown> | null },
): Promise<void> {
  const payload = opts.payload && typeof opts.payload === 'object' ? opts.payload : {};
  const ctx = buildCoordOpCtx({
    identity: { ownerId: 'system:blueprint-run', ownerLabel: 'blueprint-run' },
    workspaceId: opts.workspaceId,
    harnessSlug: opts.installSlug,
    depth: 0,
  });
  try {
    const outcome = await runProgramCore({ blueprint: bp, payload, ctx, runOp: inlineRunOp });
    console.log(
      `[blueprint-run] ${opts.installSlug}: ran program '${bp.id}' → ${outcome.outcome} (resolved=${outcome.resolved})`,
    );
  } catch (e) {
    console.warn(
      `[blueprint-run] ${opts.installSlug}: program '${bp.id}' FAILED: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** The registered `system:blueprint-run` handler. */
export async function handleBlueprintRun(ctx: SystemActionCtx): Promise<void | SystemActionResult> {
  const { installSlug, workspaceId, payloadTemplate } = ctx;

  // EI-1575: stop firing for a DELETED harness/hive. Each tick of an orphaned
  // routine queues a durable blueprint launch (e.g. the 'coding' queen) whose
  // `/api/harness/<slug>/invoke` 404s — a perpetual, useless 404 + DBOS churn.
  // When the target install is gone from the registry, disarm ALL of its
  // routines and stop. This self-heals already-orphaned rows on their next
  // fire, independent of which deletion path missed the cleanup. (Reserved
  // `@singleton` hosts + an empty/unreadable registry are never "gone" — see
  // installIsGone.)
  const installGone = _installGone ?? installIsGone;
  if (await installGone(workspaceId, installSlug)) {
    const disarm = _disarmRoutines ?? disarmInstallRoutines;
    const n = await disarm(workspaceId, installSlug);
    console.warn(
      `[blueprint-run] ${installSlug}: target harness/hive is gone — disarmed ${n} orphaned routine(s); will not re-fire (EI-1575)`,
    );
    return;
  }

  // unify-agent-launches-as-blueprints D-002: a routine may name a STANDALONE
  // launch blueprint to fire (e.g. the `scan` cadence routine seeds
  // `{ blueprintId: 'scan' }`). The launch becomes declarative — the role + model
  // resolve from the named blueprint via the launch-blueprint primitive, not a
  // hardcoded invoke-caller. (Omitting `blueprintId` keeps the original behavior:
  // fire the HARNESS's own effective blueprint decider — the harness:create
  // `triggers.schedule` materialization path.)
  const launchId = typeof payloadTemplate?.blueprintId === 'string' ? payloadTemplate.blueprintId.trim() : '';
  if (launchId) {
    // A PROGRAM-mode launch (a migrated deterministic / hybrid loop, e.g.
    // `{ blueprintId: 'negative-space' }`) has no single decider to fire — run its
    // steps+gate program inline instead of `fireLaunchBlueprint` (P-011). Resolve
    // through the same seam fireLaunchBlueprint uses; a resolve failure falls
    // through to the launch path (which logs its own error).
    let launchBp: Blueprint | null = null;
    try {
      launchBp = await resolveLaunchBlueprint(launchId);
    } catch (e) {
      console.warn(`[blueprint-run] ${installSlug}: could not resolve launch blueprint '${launchId}': ${e instanceof Error ? e.message : e}`);
    }
    if (launchBp && isProgramSpine(launchBp.spine)) {
      await runScheduledProgram(launchBp, {
        installSlug,
        workspaceId,
        payload: (payloadTemplate?.payload as Record<string, unknown> | undefined) ?? null,
      });
      return;
    }
    const kickoff =
      typeof payloadTemplate?.kickoff === 'string' && payloadTemplate.kickoff.trim()
        ? payloadTemplate.kickoff
        : `Scheduled launch of blueprint '${launchId}' for '${installSlug}'.`;
    // A scheduled launch may need far more than the invoke route's 90s default —
    // a workspace `scan` runs many turns (P-009 smoke: 300s SIGTERMed a real scan
    // with zero output). The routine's payload_template carries the budget,
    // forwarded as the route's `timeoutMs`.
    const timeoutMs = Number(payloadTemplate?.timeoutMs);
    // EI-995: fire via the EI-403-A durableSpawns SEAM, NOT `fireLaunchBlueprint`
    // inline. This handler runs as ONE DBOS step; firing inline → durableSpawnFire
    // hits "startWorkflow from within a step" → falls back to a fire-and-forget that
    // AWAITS the worker run, which the step does NOT keep alive → the autonomous Queen
    // (and Overwatch) returned in ~80ms, orphaned, placing nothing (the live :3070
    // no-op). Returning the request lets the routine workflow start it DURABLY after
    // the step, where startWorkflow is legal (system-actions.ts → startDurableSpawns).
    // The handler is a checkpointed step, so this per-fire key is stable on replay.
    const idempotencyKey = `blueprint-run:${installSlug}:${launchId}:${Date.now()}`;
    const durableSpawn = await buildLaunchSpawnRequest(
      launchId,
      {
        installSlug,
        workspaceId,
        kickoff,
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
      },
      idempotencyKey,
    );
    console.log(
      `[blueprint-run] ${installSlug}: queued durable launch '${launchId}' (role ${durableSpawn.spawnRecord?.childRole ?? '?'})`,
    );
    return { durableSpawns: [durableSpawn] };
  }

  const resolve = _resolver ?? resolveBlueprint;
  const bp = (await resolve(installSlug, workspaceId)) ?? codingFallback();
  const mode = typeof payloadTemplate?.mode === 'string' ? payloadTemplate.mode : 'run';

  if (mode === 'work-item') {
    await createWorkItem(ctx, bp);
    return;
  }
  // A harness whose OWN effective blueprint is program-mode (a deterministic /
  // hybrid loop) runs its program inline rather than firing a decider (P-011).
  if (isProgramSpine(bp.spine)) {
    await runScheduledProgram(bp, {
      installSlug,
      workspaceId,
      payload: (payloadTemplate?.payload as Record<string, unknown> | undefined) ?? null,
    });
    return;
  }
  // mode === 'run' (default): start a blueprint run by firing the declared decider.
  const role = bp.spine.decider;
  // P-009 (D-009): the error-backoff fire gate — a decider with accumulating
  // consecutive_errors is re-fired on an exponential backoff (circuit-open past
  // the threshold ⇒ ~one probe per cap window), not at full cadence.
  const gate = await checkFireGate(installSlug, role);
  if (!gate.allow) {
    console.warn(
      `[blueprint-run] ${installSlug}: decider '${role}' fire WITHHELD (${gate.reason}, ` +
        `consecutive_errors=${gate.consecutiveErrors}, retry in ~${gate.retryAfterSec}s)`,
    );
    return;
  }
  const fire = _fire ?? defaultFire;
  await fire({
    installSlug,
    workspaceId,
    role,
    kickoff: `Scheduled blueprint run for '${installSlug}' (decider ${role}).`,
  });
  console.log(`[blueprint-run] ${installSlug}: fired decider '${role}' (scheduled blueprint run)`);
}

registerSystemAction('blueprint-run', handleBlueprintRun);
