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
 *     `deriveNext` drives the next pipeline action. Same autonomous launch the autoloop's
 *     `fireDirector` + the role-routine branch use; fire-and-forget. Touches no work-item
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
import { loadBuiltinBlueprint, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { resolveProjectDir } from '../spawn-config';
import { loopbackFetch } from '../loopback-fetch';
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { checkFireGate, recordFire } from '../autoloop';
import { getEffectiveBlueprint } from './project-to-pg';
import { fireLaunchBlueprint } from './launch-blueprint';

const operatorBase = (): string => process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';

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
      (r) => recordFire(installSlug, role, r.ok ? 'ok' : `error: HTTP ${r.status}`, r.ok ? 'ok' : 'error'),
      (e) => {
        const detail = String(e instanceof Error ? e.message : e).slice(0, 180);
        console.warn(`[blueprint-run] decider fire failed (${installSlug}/${role}): ${detail}`);
        return recordFire(installSlug, role, `error: ${detail}`, 'error');
      },
    )
    .catch(() => {});
};

/** Lazily-loaded built-in `coding` blueprint — the fallback when a harness has no blueprint
 *  (behavior-preserving for every pre-blueprint harness: decider `director`, kind `feature`). */
let _codingFallback: Blueprint | null = null;
function codingFallback(): Blueprint {
  return (_codingFallback ??= loadBuiltinBlueprint('coding').blueprint);
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
    `INSERT INTO harness_shared.harness_features_consolidated (
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

/** The registered `system:blueprint-run` handler. */
export async function handleBlueprintRun(ctx: SystemActionCtx): Promise<void> {
  const { installSlug, workspaceId, payloadTemplate } = ctx;

  // unify-agent-launches-as-blueprints D-002: a routine may name a STANDALONE
  // launch blueprint to fire (e.g. the `scan` cadence routine seeds
  // `{ blueprintId: 'scan' }`). The launch becomes declarative — the role + model
  // resolve from the named blueprint via the launch-blueprint primitive, not a
  // hardcoded invoke-caller. (Omitting `blueprintId` keeps the original behavior:
  // fire the HARNESS's own effective blueprint decider — the harness:create
  // `triggers.schedule` materialization path.)
  const launchId = typeof payloadTemplate?.blueprintId === 'string' ? payloadTemplate.blueprintId.trim() : '';
  if (launchId) {
    const kickoff =
      typeof payloadTemplate?.kickoff === 'string' && payloadTemplate.kickoff.trim()
        ? payloadTemplate.kickoff
        : `Scheduled launch of blueprint '${launchId}' for '${installSlug}'.`;
    // A scheduled launch may need far more than the invoke route's 90s default —
    // a workspace `scan` runs many turns (P-009 smoke: 300s SIGTERMed a real scan
    // with zero output). The routine's payload_template carries the budget;
    // fireLaunchBlueprint forwards it as the route's `timeoutMs`.
    const timeoutMs = Number(payloadTemplate?.timeoutMs);
    const target = await fireLaunchBlueprint(launchId, {
      installSlug,
      workspaceId,
      kickoff,
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    });
    console.log(`[blueprint-run] ${installSlug}: fired launch blueprint '${launchId}' (role ${target.role})`);
    return;
  }

  const resolve = _resolver ?? resolveBlueprint;
  const bp = (await resolve(installSlug, workspaceId)) ?? codingFallback();
  const mode = typeof payloadTemplate?.mode === 'string' ? payloadTemplate.mode : 'run';

  if (mode === 'work-item') {
    await createWorkItem(ctx, bp);
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
