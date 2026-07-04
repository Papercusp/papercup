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
import { mergeRoleQuota } from './quota-overrides';
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

import { getOverride, PASS_THROUGH as TESTING_SHELL_PASS_THROUGH } from '@papercusp/testing-shell/llm';
import { recordToolAuthzEvent } from './tool-authz-audit';
import { maybeBeatPresenceOnDispatch } from './agent-tools/coordination/dispatch-heartbeat';
import { evaluateCapabilityEnvelope, ROLE_ENVELOPES } from './capability-envelope/policy';
// live-configurability-audit-2026-06-20 P-009 — runtime envelope overrides (D-010 sync-cache).
// Getters return empty when the dark flag is off ⇒ byte-identical envelope resolution.
import { envelopeRoleOverrides, envelopeProtectedAdditions } from './capability-envelope-overrides';
// live-configurability-audit-2026-06-20 P-020 — runtime telemetry-buffer sizing (D-010 sync-cache).
// Returns the baked defaults when the kill-switch flag is off / no override ⇒ byte-identical.
import { telemetryBufferConfig } from './telemetry-buffer-config';
import { recordDecisionLedger } from './decision-ledger/emit';
import { resolveAgentIdentity } from './agent-tools/coordination/identity';

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
  // Captured into a local so the narrowing survives into the `sql.begin` closure below —
  // TS does not narrow a property access (`ctx.workspaceId`) across a function boundary.
  const workspaceId = ctx.workspaceId;
  if (!workspaceId) return null;
  // P-003: telemetry writes are deferred (see below), so a prior call's
  // tool_invocations row may still be queued. Drain it before counting so a
  // quota'd tool never under-counts. Cheap — only quota'd tools reach here
  // (capability:bash et al. have no quota and skip this gate entirely).
  await flushPendingTelemetry();
  try {
    const { sql } = getOrgPg();
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      return await tx.unsafe(
        `SELECT count(*)::int AS n FROM harness_shared.tool_invocations
          WHERE workspace_id = $1
            AND tool_name = $2
            AND role = $3
            AND window_key = $4
            AND status = 'ok'`,
        [workspaceId, toolName, ctx.role ?? '', windowKey],
      );
    });
    // postgres.js's tx.unsafe() resolves a RowList<Row[]> whose structural shape doesn't
    // sufficiently overlap with `{n:number}[]` for a direct `as` cast — go through `unknown`.
    const n = (result as unknown as Array<{ n: number }>)[0]?.n ?? 0;
    return { count: n };
  } catch (err) {
     
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

/* invoked_at is stamped EXPLICITLY (EI-7040): the writer is deferred + batched,
 * and Postgres `now()` is transaction-stable — leaving the column to its
 * DEFAULT gave every row in a flush batch ONE identical microsecond timestamp
 * (up to debounceMs after the actual call). That skewed time-series reads and
 * made batch-mates look like duplicate inserts (EI-7040's "2 identical rows"
 * were the statusline double-call sharing a flush). $26 carries the real
 * dispatch-settle time captured in buildTelemetryRow. */
const TELEMETRY_INSERT_SQL = `INSERT INTO harness_shared.tool_invocations
   (workspace_id, harness_slug, plugin_name, tool_name, role,
    feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
    window_key, duration_ms, status, output_ref, output_size,
    error_message, args_json, transport, event_count, metadata_json,
    principal_kind, principal_auth_method, principal_trust, error_code,
    coord_owner_id, invoked_at)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16,$17::jsonb,$18,$19,$20::jsonb,$21,$22,$23,$24,$25,$26::timestamptz)`;

// P-020: the telemetry-buffer sizing (maxPending / debounceMs / maxBatch) is now runtime-settable
// via telemetryBufferConfig() (canonical defaults TELEMETRY_BUFFER_DEFAULTS live in
// telemetry-buffer-config.ts). Kill-switch OFF / empty override ⇒ those defaults ⇒ byte-identical.

let telemetryQueue: TelemetryRow[] = [];
let telemetryFlushTimer: ReturnType<typeof setTimeout> | null = null;
let telemetryFlushInFlight: Promise<void> | null = null;
let telemetryDropped = 0;

function scheduleTelemetryFlush(): void {
  if (telemetryFlushTimer || telemetryFlushInFlight) return;
  telemetryFlushTimer = setTimeout(() => {
    telemetryFlushTimer = null;
    void flushPendingTelemetry();
  }, telemetryBufferConfig().debounceMs);
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
        const batch = telemetryQueue.splice(0, telemetryBufferConfig().maxBatch);
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
                // `TelemetryRow.params` is `unknown[]` (each row's values are snapshotted
                // generically at capture time); `tx.unsafe`'s param array type doesn't
                // sufficiently overlap with `unknown[]` for a direct cast, so go through
                // `unknown` first — derived from `tx` itself so this file need not import
                // postgres.js's ParameterOrJSON type.
                await tx.unsafe(TELEMETRY_INSERT_SQL, row.params as unknown as Parameters<typeof tx.unsafe>[1]);
              }
            });
          } catch (err) {
             
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
  // WI-1279: stamp the calling agent's coordination owner id so dev:sessions can
  // attribute/group a session by its agent (su-… interactive SU, the bee's s-…
  // spawn id, pus-… power-user). resolveAgentIdentity THROWS on an unattributable
  // ctx; telemetry is best-effort, so a throw → NULL (never breaks a tool call).
  let coordOwnerId: string | null = null;
  try {
    coordOwnerId = resolveAgentIdentity(input.ctx).ownerId ?? null;
  } catch {
    coordOwnerId = null;
  }
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
      coordOwnerId,
      // invoked_at (EI-7040): the dispatch-settle wall-clock, NOT the flush
      // time — see the note on TELEMETRY_INSERT_SQL.
      new Date().toISOString(),
    ],
  };
}

/**
 * EI-2112 — read-shaped board polls from the loopback command-palette bridge are
 * UI refresh, not agent activity, and must NOT be telemetered.
 *
 * `lib/capabilities/invoke.ts` stamps `ctx.spawnId='palette'` for every desktop
 * command-palette / dock invoke. The dock's wake-board pane POLLS a couple of
 * read-only coord board tools on a refresh tick; each poll wrote one
 * `harness_shared.tool_invocations` row, and together `coord:wake-queue{list}` +
 * `coord:wake-mode` (read) were ~817K rows/24h = 74.5% of the WHOLE telemetry
 * table (polled ~6.6×/sec, 24/7). The table is meant to reflect AGENT tool calls,
 * so those UI poll-reads are dropped at the sink.
 *
 * The predicate keys on the READ shape of each tool's args (`coord:wake-queue` is
 * read when `action` is absent or `list`; `coord:wake-mode` is read when `mode` is
 * absent). Scoped tight so it never hides real activity:
 *   - only the palette bridge identity (`spawn_id='palette'`) — a real agent spawn
 *     reading the board IS activity and still records;
 *   - only the READ shape — a palette ACTION through the same tool (a wake
 *     release/skip, a wake-mode set, …) is not read-shaped and still records, so
 *     the human-initiated audit trail is intact.
 *
 * Add a tool here only when it is BOTH (a) polled by a palette/dock UI surface on
 * a tick and (b) cleanly read-vs-write separable by args. Pure + exported for
 * unit tests.
 */
const PALETTE_POLL_READ_TOOLS: Record<string, (args: Record<string, unknown>) => boolean> = {
  // Wake-board snapshot: `list` (the default action) is the read; release / skip /
  // release_all / skip_all mutate and must stay audited.
  'coord:wake-queue': (a) => a.action === undefined || a.action === 'list',
  // Wake-mode: a read omits `mode` (a set carries one); agent absent = the GLOBAL
  // default read the board polls.
  'coord:wake-mode': (a) => a.mode === undefined,
};

export function isPaletteUiPollRead(input: {
  toolName: string;
  ctx: Pick<UnifiedToolContext, 'spawnId'>;
  args?: unknown;
}): boolean {
  if (input.ctx.spawnId !== 'palette') return false;
  const isRead = PALETTE_POLL_READ_TOOLS[input.toolName];
  if (!isRead) return false;
  const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<string, unknown>;
  return isRead(args);
}

async function recordInvocationImpl(input: RecordInvocationInput): Promise<void> {
  // Turn-level presence beat (liveness-hardening P-001): every settled dispatch
  // keeps its owner's presence warm, throttled per owner. Stays SYNCHRONOUS on
  // the hot path (cheap, throttled) — before the workspace guard, since a beat
  // needs an identity, not a workspace.
  maybeBeatPresenceOnDispatch(input.ctx);
  // EI-2112: a pure UI poll-READ from the command-palette bridge (the desktop
  // dock's wake-board refresh tick, spawn_id='palette') is UI refresh, not agent
  // activity — it was 74.5% of the whole tool_invocations table. Drop it from
  // telemetry AFTER the presence beat (the dock surface still proves liveness);
  // the palette's mutating ACTIONS through the same tools are not read-shaped and
  // still record.
  if (isPaletteUiPollRead(input)) return;
  // P-003: snapshot the row synchronously, then enqueue + return. The actual PG
  // INSERT happens in a batched background flush, OFF the dispatcher's awaited
  // hot path.
  const row = buildTelemetryRow(input);
  if (!row) return;
  telemetryQueue.push(row);
  const maxPending = telemetryBufferConfig().maxPending;
  if (telemetryQueue.length > maxPending) {
    // Producer outran the PG writer (stall/backpressure) — shed oldest to keep
    // memory bounded. Telemetry is best-effort; a dropped row is acceptable.
    telemetryQueue.splice(0, telemetryQueue.length - maxPending);
    telemetryDropped++;
    if (telemetryDropped === 1 || telemetryDropped % 1000 === 0) {
       
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
  // P-009 (D-010): merge the runtime per-role overrides OVER the baked ROLE_ENVELOPES (per-role
  // replace) and union the tighten-only protected-floor additions. Both getters are SYNC and
  // return empty unless papercusp-capability-envelope-overrides is ON ⇒ off = byte-identical.
  const roleOverrides = envelopeRoleOverrides();
  const protectedAdditions = envelopeProtectedAdditions();
  const decision = evaluateCapabilityEnvelope({
    toolName: input.toolName,
    capabilities: input.capabilities,
    ctx: input.ctx,
    envelopes: Object.keys(roleOverrides).length > 0 ? { ...ROLE_ENVELOPES, ...roleOverrides } : undefined,
    protectedAdditions: protectedAdditions.length > 0 ? protectedAdditions : undefined,
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
const overrideToolImpl: ToolDispatchOverrideFn = async (toolName, args, ctx) => {
  const uic = ctx.uiClientId;
  if (typeof uic !== 'string' || !uic.startsWith('llm-testing/')) return PASS_THROUGH;
  const runId = uic.slice('llm-testing/'.length);
  const override = getOverride(runId);
  if (!override) return PASS_THROUGH;
  const result = await override.override(toolName, args);
  // `@papercusp/testing-shell`'s ToolDispatchOverride and `@papercusp/agent-mcp`'s
  // ToolDispatchOverrideFn each define their OWN `Symbol('PASS_THROUGH')` sentinel —
  // two distinct `unique symbol` values (a real bug the typecheck caught, not just a
  // type annoyance: dispatch-stack.ts's invokeStep compares the override's return
  // against the tooldef PASS_THROUGH via `!==`, so testing-shell's sentinel passing
  // through UNTRANSLATED would fail that comparison and be rendered as a bogus
  // ToolResult instead of falling through to the real handler). Translate at this
  // boundary so both packages can keep their own symbol without a new cross-package
  // dependency.
  return result === TESTING_SHELL_PASS_THROUGH ? PASS_THROUGH : result;
};

/** Shared deps singleton. Same object reference is safe to pass to
 *  multiple dispatchers — the impls are stateless. */
export const PROJECTED_DEPS: DispatchProjectedDeps = {
  // Papercusp quota windowing: workers→chunk/perChunk, power-user→session,
  // everyone else→run/perRun (plan P-011, formerly baked in the engine).
  // P-018: a runtime per-(tool,role) override (quota:set_tool) is MERGED over the baked
  // rolesQuota[role] before the window/ceiling is resolved — empty override map ⇒ byte-identical.
  computeQuotaWindow: (ctx, roleQuota, toolName) =>
    papercuspComputeQuotaWindow(ctx, toolName ? mergeRoleQuota(roleQuota, toolName, ctx.role) : roleQuota),
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
