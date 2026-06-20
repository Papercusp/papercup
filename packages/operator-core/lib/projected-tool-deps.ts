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
 * Serialize to a Postgres-`jsonb`-safe JSON string. Postgres `jsonb` (and `text`)
 * cannot represent a NUL byte (U+0000) and rejects the `::jsonb` cast with
 * `unsupported Unicode escape sequence`. Tool args/metadata occasionally carry NUL
 * bytes (binary-ish payloads, truncated file reads, terminal output), which made
 * the whole `tool_invocations` row throw — silently dropping that tool call's
 * telemetry (the catch in `recordInvocationImpl` swallows it). Strip every NUL
 * from each string VALUE during serialization via a replacer (non-NUL content is
 * left untouched).
 */
export function jsonbSafeStringify(value: unknown): string {
  // Referenced via fromCharCode so a raw NUL byte never appears in this source.
  const NUL = String.fromCharCode(0);
  return JSON.stringify(value, (_key, val) =>
    typeof val === 'string' && val.includes(NUL) ? val.split(NUL).join('') : val,
  );
}

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
  // P-003: telemetry writes are deferred (see below), so a prior call's
  // tool_invocations row may still be queued. Drain it before counting so a
  // quota'd tool never under-counts. Cheap — only quota'd tools reach here
  // (capability:bash et al. have no quota and skip this gate entirely).
  await flushPendingTelemetry();
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

interface RecordInvocationInput {
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
}

/* ─── P-003 deferred, batched telemetry writer ──────────────────────────────
 * recordTelemetry() is AWAITED in the dispatcher's `finally`
 * (runDispatchStack), so a synchronous per-call INSERT into
 * harness_shared.tool_invocations added a full PG round-trip (~10–50ms) to the
 * latency of EVERY tool call — the dominant per-call overhead for a tight
 * capability:bash loop (route-everything-through-definetool P-003; the quota
 * SELECT is already a no-op for no-quota tools like capability:bash).
 *
 * Telemetry is best-effort (errors already swallowed; NUL-byte rows already
 * dropped), so the write moves OFF the response path: each settled dispatch
 * SNAPSHOTS its row synchronously (cheap — JSON.stringify of args) and enqueues
 * it; a debounced background flusher writes the queue in BATCHED, per-workspace
 * transactions (one BEGIN/set_config/COMMIT amortized over many rows). The
 * awaited recordInvocation now resolves in ~microseconds.
 *
 * Correctness: readQuotaState drains the queue (flushPendingTelemetry) before
 * counting, so a quota'd tool never under-counts. Consumers needing synchronous
 * visibility (tests, llm-testing telemetry) can await flushPendingTelemetry().
 * The queue is hard-capped (drop-oldest) so a PG stall can never OOM the host. */

interface TelemetryRow {
  workspaceId: string;
  params: unknown[];
}

const TELEMETRY_INSERT_SQL = `INSERT INTO harness_shared.tool_invocations
   (workspace_id, harness_slug, plugin_name, tool_name, role,
    feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
    window_key, duration_ms, status, output_ref, output_size,
    error_message, args_json, transport, event_count, metadata_json,
    principal_kind, principal_auth_method, principal_trust, error_code)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16,$17::jsonb,$18,$19,$20::jsonb,$21,$22,$23,$24)`;

const TELEMETRY_MAX_PENDING = 5000; // hard cap → drop-oldest on PG stall, never OOM
const TELEMETRY_FLUSH_DEBOUNCE_MS = 10;
const TELEMETRY_MAX_BATCH = 200;

let telemetryQueue: TelemetryRow[] = [];
let telemetryFlushTimer: ReturnType<typeof setTimeout> | null = null;
let telemetryFlushInFlight: Promise<void> | null = null;
let telemetryDropped = 0;

function scheduleTelemetryFlush(): void {
  if (telemetryFlushTimer || telemetryFlushInFlight) return;
  telemetryFlushTimer = setTimeout(() => {
    telemetryFlushTimer = null;
    void flushPendingTelemetry();
  }, TELEMETRY_FLUSH_DEBOUNCE_MS);
  // Never keep the event loop alive just for a pending telemetry flush.
  (telemetryFlushTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * Drain the deferred telemetry queue, writing it in batched per-workspace
 * transactions. Best-effort: a failed batch is logged and dropped (matching the
 * pre-defer swallow). Re-entrant-safe — a single in-flight flush; a concurrent
 * caller awaits it. Exported so quota reads + telemetry consumers can force
 * synchronous visibility.
 */
export async function flushPendingTelemetry(): Promise<void> {
  if (telemetryFlushInFlight) return telemetryFlushInFlight;
  if (telemetryQueue.length === 0) return;
  const run = (async () => {
    try {
      const { sql } = getOrgPg();
      while (telemetryQueue.length > 0) {
        const batch = telemetryQueue.splice(0, TELEMETRY_MAX_BATCH);
        // Group by workspace — RLS needs one set_config('app.workspace_id') per tx.
        const byWorkspace = new Map<string, TelemetryRow[]>();
        for (const row of batch) {
          const list = byWorkspace.get(row.workspaceId);
          if (list) list.push(row);
          else byWorkspace.set(row.workspaceId, [row]);
        }
        for (const [workspaceId, rows] of byWorkspace) {
          try {
            await sql.begin(async (tx) => {
              await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
              for (const row of rows) {
                await tx.unsafe(TELEMETRY_INSERT_SQL, row.params as unknown[]);
              }
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              `[projected-tool-deps] telemetry flush batch failed (${rows.length} rows): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } finally {
      telemetryFlushInFlight = null;
    }
  })();
  telemetryFlushInFlight = run;
  return run;
}

/**
 * Build the tool_invocations row params snapshot for one settled dispatch.
 * Synchronous + cheap (JSON.stringify of args); null when there is no workspace
 * to scope to. Pulls Principal audit fields off ctx.principal when present
 * (only the bearer/MCP path populates a real Principal; migration 076 made the
 * columns nullable so legacy gaps surface as NULL/'unknown' in /dev).
 */
function buildTelemetryRow(input: RecordInvocationInput): TelemetryRow | null {
  if (!input.ctx.workspaceId) return null;
  const p = (input.ctx.principal ?? null) as null | {
    kind?: string;
    authMethod?: string;
    trust?: string;
  };
  const argsJson = (() => {
    if (input.args === undefined || input.args === null) return null;
    try {
      const s = jsonbSafeStringify(input.args);
      if (s.length > 32768) {
        return JSON.stringify({ _truncated: true, _size: s.length });
      }
      return s;
    } catch {
      return null;
    }
  })();
  // Audit the reaction cause-chain (event-reaction-system D-010) into
  // metadata_json so "why did this fire?" is answerable: a reaction row carries
  // metadata.reaction = { depth, chain, ruleId, rootRunId }.
  const metadataJson = (() => {
    const reaction = input.ctx.reactionCause;
    const meta = reaction ? { ...(input.metadataJson ?? {}), reaction } : input.metadataJson;
    return meta ? jsonbSafeStringify(meta) : null;
  })();
  return {
    workspaceId: input.ctx.workspaceId,
    params: [
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
      argsJson,
      // ctx.transport set by HTTP / MCP / IPC adapters. NULL for
      // direct-handler-call shims (the route shim path) where no transport is
      // actually involved at dispatch time.
      input.ctx.transport ?? null,
      input.eventCount ?? null,
      metadataJson,
      p?.kind ?? null,
      p?.authMethod ?? null,
      p?.trust ?? null,
      input.errorCode ?? null,
    ],
  };
}

async function recordInvocationImpl(input: RecordInvocationInput): Promise<void> {
  // Turn-level presence beat (liveness-hardening P-001): every settled dispatch
  // keeps its owner's presence warm, throttled per owner. Stays SYNCHRONOUS on
  // the hot path (cheap, throttled) — before the workspace guard, since a beat
  // needs an identity, not a workspace.
  maybeBeatPresenceOnDispatch(input.ctx);
  // P-003: snapshot the row synchronously, then enqueue + return. The actual PG
  // INSERT happens in a batched background flush, OFF the dispatcher's awaited
  // hot path.
  const row = buildTelemetryRow(input);
  if (!row) return;
  telemetryQueue.push(row);
  if (telemetryQueue.length > TELEMETRY_MAX_PENDING) {
    // Producer outran the PG writer (stall/backpressure) — shed oldest to keep
    // memory bounded. Telemetry is best-effort; a dropped row is acceptable.
    telemetryQueue.splice(0, telemetryQueue.length - TELEMETRY_MAX_PENDING);
    telemetryDropped++;
    if (telemetryDropped === 1 || telemetryDropped % 1000 === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[projected-tool-deps] telemetry queue overflow — dropped ${telemetryDropped} row(s)`);
    }
  }
  scheduleTelemetryFlush();
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
