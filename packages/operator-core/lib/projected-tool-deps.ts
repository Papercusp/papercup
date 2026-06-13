/**
 * Shared DispatchProjectedDeps for the @papercusp/agent-mcp dispatcher.
 *
 * Both transports (HTTP via app/api/[transport]/route.ts AND IPC via
 * lib/endpoint-ipc/server.ts) need to plumb invocations into
 * harness_shared.tool_invocations for audit + quota lookup. This lives
 * here so adding a third transport doesn't fork the SQL.
 *
 * The IPC transport landed initially with deps:{} — no telemetry rows
 * landed for IPC calls and they were invisible to /dev → Sessions.
 * Wiring this shared deps closes deferred item 4 from the audit.
 *
 * Note: pending submodule migration to add a `transport` column on
 * tool_invocations, IPC calls cannot be distinguished from HTTP calls
 * at the SQL level. Telemetry consumers should infer transport from
 * spawn_id prefix (`ipc-` for IPC, none for HTTP/MCP) until the
 * column lands.
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  PASS_THROUGH,
  papercuspComputeQuotaWindow,
  type CapabilityEnvelopeVerdict,
  type DispatchProjectedDeps,
  type PostInvokeEvent,
  type PreconditionFireRequest,
  type ToolDispatchOverrideFn,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

import { getOverride } from '@papercusp/testing-shell/llm';
import { recordToolAuthzEvent } from './tool-authz-audit';
import { maybeBeatPresenceOnDispatch } from './agent-tools/coordination/dispatch-heartbeat';
import { evaluateCapabilityEnvelope } from './capability-envelope/policy';
import { recordDecisionLedger } from './decision-ledger/emit';

/**
 * The event-reaction system installs its `postInvoke` handler here at startup
 * (`lib/events` calls `setReactionPostInvoke`). Kept as a setter indirection —
 * not a direct import of the engine — so projected-tool-deps (loaded very early
 * by every transport) does NOT import the events module, avoiding the cycle
 * `events → dispatch-reaction → projected-tool-deps`. Unset ⇒ no reactions.
 */
let reactionPostInvoke: ((event: PostInvokeEvent) => void) | null = null;
export function setReactionPostInvoke(handler: ((event: PostInvokeEvent) => void) | null): void {
  reactionPostInvoke = handler;
}

/**
 * The PRECONDITION FIRE PORT (`requires:` auto-correct — autoloop-pot-operator-
 * rebuild D-006). Installed by `lib/events` alongside the postInvoke handler —
 * the corrective fire rides the SAME dispatch path as reactions
 * (`fireReactionInProcess`: auth-gated, audited, cause-chained). Same setter
 * indirection as above to avoid the `events → dispatch-reaction →
 * projected-tool-deps` cycle. Unset ⇒ auto-correct preconditions FAIL CLOSED
 * (the dispatcher rejects with a message naming the uninstalled port).
 */
let preconditionFire: ((req: PreconditionFireRequest) => Promise<void>) | null = null;
export function setPreconditionFire(
  handler: ((req: PreconditionFireRequest) => Promise<void>) | null,
): void {
  preconditionFire = handler;
}

async function readQuotaStateImpl(
  toolName: string,
  ctx: UnifiedToolContext,
  windowKey: string,
): Promise<{ count: number } | null> {
  if (!ctx.workspaceId) return null;
  try {
    const { sql } = getOrgPg();
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [ctx.workspaceId]);
      return await tx.unsafe(
        `SELECT count(*)::int AS n FROM harness_shared.tool_invocations
          WHERE workspace_id = $1
            AND tool_name = $2
            AND role = $3
            AND window_key = $4
            AND status = 'ok'`,
        [ctx.workspaceId, toolName, ctx.role ?? '', windowKey],
      );
    });
    const n = (result as Array<{ n: number }>)[0]?.n ?? 0;
    return { count: n };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[projected-tool-deps] readQuotaState failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function recordInvocationImpl(input: {
  toolName: string;
  pluginName: string;
  ctx: UnifiedToolContext;
  windowKey: string;
  durationMs: number;
  status: 'ok' | 'error' | 'quota-exceeded' | 'role-not-allowed' | 'timeout' | 'invalid-input';
  outputRef?: string | null;
  outputSize?: number | null;
  errorMessage?: string | null;
  /** Dispatcher error CLASS (P-007): persisted to harness_shared.tool_invocations.error_code. NULL on success. */
  errorCode?: string | null;
  args?: unknown;
  eventCount?: number;
  metadataJson?: Record<string, unknown> | null;
}): Promise<void> {
  // Turn-level presence beat (liveness-hardening P-001): every settled
  // dispatch keeps its owner's presence warm, throttled per owner. Before the
  // workspace guard — a beat needs an identity, not a workspace.
  maybeBeatPresenceOnDispatch(input.ctx);
  if (!input.ctx.workspaceId) return;
  try {
    const { sql } = getOrgPg();
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [input.ctx.workspaceId]);
      // Pull Principal audit fields off ctx.principal when present.
      // The UnifiedToolContext inline subset doesn't carry the full
      // {kind, authMethod, trust} shape today; only the bearer/MCP path
      // populates a real Principal. Migration 076 added these columns
      // as nullable so legacy gaps surface as 'unknown' in /dev.
      const p = (input.ctx.principal ?? null) as null | {
        kind?: string;
        authMethod?: string;
        trust?: string;
      };
      await tx.unsafe(
        `INSERT INTO harness_shared.tool_invocations
           (workspace_id, harness_slug, plugin_name, tool_name, role,
            feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
            window_key, duration_ms, status, output_ref, output_size,
            error_message, args_json, transport, event_count, metadata_json,
            principal_kind, principal_auth_method, principal_trust, error_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 $16,$17::jsonb,$18,$19,$20::jsonb,$21,$22,$23,$24)`,
        [
          input.ctx.workspaceId,
          input.ctx.harnessSlug ?? '',
          input.pluginName,
          input.toolName,
          input.ctx.role ?? '',
          input.ctx.featureId ?? null,
          input.ctx.chunkId ?? null,
          input.ctx.runId ?? null,
          input.ctx.spawnId ?? '',
          input.ctx.parentSpawnId ?? null,
          input.windowKey,
          input.durationMs,
          input.status,
          input.outputRef ?? null,
          input.outputSize ?? null,
          input.errorMessage ?? null,
          (() => {
            if (input.args === undefined || input.args === null) return null;
            try {
              const s = JSON.stringify(input.args);
              if (s.length > 32768) {
                return JSON.stringify({ _truncated: true, _size: s.length });
              }
              return s;
            } catch {
              return null;
            }
          })(),
          // ctx.transport set by HTTP / MCP / IPC adapters. NULL for
          // direct-handler-call shims (the route shim path) where no
          // transport is actually involved at dispatch time.
          input.ctx.transport ?? null,
          input.eventCount ?? null,
          // Audit the reaction cause-chain (event-reaction-system D-010) into
          // metadata_json so "why did this fire?" is answerable: a reaction row
          // carries metadata.reaction = { depth, chain, ruleId, rootRunId }.
          (() => {
            const reaction = input.ctx.reactionCause;
            const meta = reaction ? { ...(input.metadataJson ?? {}), reaction } : input.metadataJson;
            return meta ? JSON.stringify(meta) : null;
          })(),
          p?.kind ?? null,
          p?.authMethod ?? null,
          p?.trust ?? null,
          input.errorCode ?? null,
        ],
      );
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[projected-tool-deps] recordInvocation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Capability-envelope port impl (agent-capability-confinement-2026-06-13 B-06 / P-012).
 * Runs the cheap, static, per-role evaluator; only on a beyond-envelope hit does it read
 * the enforce flag, so the within-envelope hot path stays pure-sync. Exempt callers
 * (SU / power-user / non-fleet / roleless) → null (the dispatch step no-ops). Enforce vs
 * observe is the CAPABILITY_ENVELOPE flag (default OFF ⇒ observe/shadow: annotate + log,
 * never block).
 */
async function checkCapabilityEnvelopeImpl(input: {
  toolName: string;
  capabilities: readonly string[];
  ctx: UnifiedToolContext;
  args: unknown;
}): Promise<CapabilityEnvelopeVerdict | null> {
  const decision = evaluateCapabilityEnvelope({
    toolName: input.toolName,
    capabilities: input.capabilities,
    ctx: input.ctx,
  });
  if (!decision.applied) return null; // exempt — no verdict; ledger records posture 'auto'
  if (decision.withinEnvelope) return { decision: 'allow', posture: 'auto', applied: true };
  const enforce = await getFlag(FLAGS.CAPABILITY_ENVELOPE, 'system');
  return enforce
    ? { decision: 'deny', posture: 'rejected', applied: true, reason: decision.reason }
    : { decision: 'observe', posture: 'gated', applied: true, reason: decision.reason };
}

/**
 * Per-call override lookup. The llm-testing framework registers a
 * `ToolDispatchOverride` for a runId via lib/llm-testing/dispatch-override.
 * Here we connect the dispatcher to that registry: parse ctx.uiClientId
 * for the `llm-testing/<runId>` prefix and consult the registry by
 * runId. Anything else passes through.
 *
 * The override fires for EVERY dispatch under a tagged ctx — including
 * nested tool calls the brain makes during operator:converse — because
 * the dispatcher's uiClientId auto-fill (Phase 0) propagates the tag.
 *
 * Plan §10.4.
 */
const overrideToolImpl: ToolDispatchOverrideFn = (toolName, args, ctx) => {
  const uic = ctx.uiClientId;
  if (typeof uic !== 'string' || !uic.startsWith('llm-testing/')) return PASS_THROUGH;
  const runId = uic.slice('llm-testing/'.length);
  const override = getOverride(runId);
  if (!override) return PASS_THROUGH;
  return override.override(toolName, args);
};

/** Shared deps singleton. Same object reference is safe to pass to
 *  multiple dispatchers — the impls are stateless. */
export const PROJECTED_DEPS: DispatchProjectedDeps = {
  // Papercusp quota windowing: workers→chunk/perChunk, power-user→session,
  // everyone else→run/perRun (plan P-011, formerly baked in the engine).
  computeQuotaWindow: papercuspComputeQuotaWindow,
  readQuotaState: readQuotaStateImpl,
  recordInvocation: recordInvocationImpl,
  overrideTool: overrideToolImpl,
  // Capability-envelope port (agent-capability-confinement B-06 / P-012). Evaluates the
  // cheap per-role envelope at the dispatch chokepoint; SU/non-fleet callers are exempt
  // (D-002). Enforce-vs-observe is the CAPABILITY_ENVELOPE flag (default OFF ⇒ shadow).
  checkCapabilityEnvelope: checkCapabilityEnvelopeImpl,
  // Event-reaction observation point (event-reaction-system D-001). Fires after
  // every tool settles; the host engine matches rules + schedules reactions.
  // Best-effort + non-blocking — swallow throws so a reaction never breaks its
  // trigger. The handler is installed by `lib/events` at startup.
  postInvoke: (event) => {
    try {
      reactionPostInvoke?.(event);
    } catch {
      // a reaction must never break its trigger
    }
    // Decision-ledger action-chokepoint emit (agent-capability-confinement B-06 / P-011 ⨯
    // queen-autonomy D-012). Fire-and-forget; recordDecisionLedger swallows its own errors,
    // but guard anyway so the ledger can never break its trigger.
    try {
      recordDecisionLedger(event);
    } catch {
      // the ledger must never break its trigger
    }
  },
  // RFC tooldef-auth Phase 1b: persist every authorize allow/deny + policy bypass.
  auditAuth: (event) => {
    void recordToolAuthzEvent(event);
  },
  // Precondition auto-correct fire port (`requires:` — D-006). AWAITED by the
  // dispatcher's `preconditions` step; a throw (incl. "not installed") rejects
  // the trigger fail-closed. Installed by `lib/events` at startup.
  firePrecondition: async (req) => {
    if (!preconditionFire) {
      throw new Error('precondition fire port not installed (lib/events not loaded)');
    }
    await preconditionFire(req);
  },
  // RFC tooldef-auth Phase 3 (D1): default-deny ON. Audited 2026-05-31 — every built-in
  // is type-certain gated (defineTool requires `capability`; defineUITool routes through
  // it) and every bundled plugin tool declares capabilities + roles. So this denies
  // nothing currently registered. Its purpose is the fail-closed floor for a FUTURE /
  // third-party tool that forgets to declare a gate: it gets a loud `ungated` 403 (not
  // silent), telling the author to declare a capability/roles/requireRoles/authorize — or
  // mark the tool `public`. To re-verify before/after adding plugins: run
  // listUngatedProjectedTools() against the live registry (empty = clean). Reversible:
  // set false to revert to allow-by-omission.
  defaultDeny: true,
};
