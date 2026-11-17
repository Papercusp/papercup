/**
 * POST /api/agent-mcp/tool-guard
 * POST /api/agent-mcp/stop-context
 * POST /api/agent-mcp/compaction-context
 *
 * The three identity hook ports (portable-identity-packages-2026-09-26 P-011,
 * plan Decisions D-023 + D-024). The client half is the one shared dispatcher
 * (apps/operator/scripts/hooks/inject/, ports.mjs `pre-tool` / `stop` /
 * `compaction`); every response is `{ ok, text }`, and an empty text means the
 * hook emits nothing.
 *
 * ── THE GUARD IS THE ONLY PORT THAT VOTES, AND IT ONLY VOTES NO ──
 * tool-guard's text is a refusal reason, rendered by the adapters ONLY as a deny
 * for the one pending call. Where it fails is decided by what failed (D-023 §3):
 *   - a guard that cannot EVALUATE (a throw, input over the bound, a worn pin
 *     that no longer parses) refuses, naming the identity and rule — that is
 *     `evaluatePreToolGuards`, which is pure and fail-closed;
 *   - the applied artifact being UNREADABLE fails open: no rule can be named,
 *     and closing there would deny every tool call fleet-wide on a DB hiccup.
 *
 * Turn-start and post-tool rules ride the two original ports
 * (turn-start-memory.ts, mid-turn-context.ts); these three cover the sinks
 * those cannot reach.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { defineTool } from '@papercusp/agent-mcp';
import { withPriorityOrgPg } from '@papercusp/db-org';
import { PG_ACQUIRE_TIMING_LIMIT, pgAcquireTimingSnapshot, pgResultDiagnosticSnapshot,
  withPgAcquireDiagnostics, type PgAcquireTimingSnapshot } from '@papercusp/db-org/acquire-registry';
import { withNamedQueryDiagnosticContext } from '../../../agent-tools/db-diagnostic-correlation-wiring';
import { tagTurnForInjection } from '../../../turn-provenance/turn-provenance';
import type { MemoryFragmentOffer } from '../../../memory/session-epoch-ledger';
import { checkPlanExecutionGuard, type PlanExecutionRefusal, type PlanExecutionTimingObserver } from '../../../agent-tools/plans/plan-execution-guard';
import { withBoundedTimeout } from '../../../bounded-timeout';
import {
  evaluateHookContextSink,
  evaluateToolGuard,
  pgHookTurnStore,
  readAppliedWornRules,
  type GuardVerdict,
  type HookTurnStore,
  type IdentityRuleReadTimingObserver,
  type IdentityRuleReadBudget,
  type PendingToolCall,
  type WornSyncRules,
} from '../../../agent-identities/sync-hook-rules';

/** Stop and compaction sinks get this long, inside the hook's own 2.5s wall. */
const CONTEXT_SINK_BUDGET_MS = 2000;

/** Leave transport room inside the native pre-tool port's fixed 1.5s wall. */
const NATIVE_PLAN_READINESS_BUDGET_MS = 1000;

/** The SessionStart sources whose context is fresh without question. */
const ALWAYS_FRESH_SOURCES = new Set(['compact', 'clear']);

interface HookBody {
  owner?: string;
  workspace?: string;
  client?: string;
  // pre-tool
  tool?: string;
  input?: unknown;
  inputTruncated?: boolean;
  guardRequestId?: string;
  // compaction
  source?: string;
  memoryReceiptMode?: boolean;
  confirmedMemoryDeliveries?: unknown;
}

async function readBody(req: Request): Promise<HookBody | null> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === 'object' ? (body as HookBody) : null;
  } catch {
    return null;
  }
}

async function resolveWorkspace(body: HookBody): Promise<string> {
  const workspace = (body.workspace ?? '').trim();
  if (workspace && workspace !== '*') return workspace;
  const { activeWorkspaceId } = await import('../../../workspace-registry');
  return activeWorkspaceId();
}

const empty = (): Response => Response.json({ ok: true, text: '' });

/**
 * One context sink under the port's wall. The wall covers the wearer and
 * worn-rule reads too, not only the evaluation the signal reaches, so a slow
 * read degrades to no text inside the hook's own timeout.
 */
async function boundedContextSinkText(input: { ownerId: string; workspaceId: string; sink: 'stop' | 'compaction' }): Promise<string> {
  const { withBoundedTimeout } = await import('../../../bounded-timeout');
  const bounded = await withBoundedTimeout(
    (signal) => evaluateHookContextSink({ ...input, signal }),
    { fallback: { text: '', result: null }, timeoutMs: CONTEXT_SINK_BUDGET_MS, label: `identity-hook:${input.sink}` },
  );
  return bounded.value.text;
}

/** The refusal a client shows for a deny verdict; empty for no verdict. */
export function guardRefusalText(verdict: GuardVerdict): string {
  if (verdict.decision !== 'deny') return '';
  return `Refused by identity ${verdict.identityId} rule ${verdict.ruleId}: ${verdict.reason}`;
}

/** Same-request completed results only; neither timing is pure SQL or CPU time. */
function toolGuardPgTimings(requestId: string) {
  try {
    return {
      coverage: 'retained-completed-results-only',
      preBuildTiming: 'first-query-handle-to-build-excludes-lazy-time',
      timing: 'query-build-to-terminal-not-acquisition',
      pools: ['org-admin-priority', 'org-app-priority'].map(pool => {
        const snapshot = pgResultDiagnosticSnapshot(pool);
        const matched = snapshot.results.filter(query => query.correlation?.requestId === requestId);
        return {
          pool, capacity: snapshot.capacity, poolDroppedResults: snapshot.dropped,
          omittedMatched: Math.max(0, matched.length - 8),
          queries: matched.slice(-8).map(({ connectionId, queryId, backendPid, queryFamily, elapsedMs, preBuildMs, status }) =>
            ({ connectionId, queryId, backendPid, queryFamily, elapsedMs, preBuildMs, status })),
        };
      }),
    };
  } catch {
    // Diagnostic collection must never replace the authority verdict.
    return { coverage: 'unavailable' };
  }
}

/** Only this request's instrumented waits are visible; bare SQL users remain outside coverage. */
function toolGuardPgAcquisitions(snapshot: typeof pgAcquireTimingSnapshot) {
  try {
    const timing = snapshot();
    return timing ? {
      coverage: 'instrumented-acquisition-seam-only',
      timing: 'begin-to-acquired-or-release-not-query-time',
      pendingAcquisitions: Array.isArray(timing.pending) ? 'request-scoped-active-tickets-only' : 'not-retained',
      ...timing,
    } : { coverage: 'unavailable' };
  } catch {
    // A failed diagnostic cannot change the guard's verdict or original error.
    return { coverage: 'unavailable' };
  }
}

/** Copy only bounded pool wait durations into route telemetry; omit request ids and operation labels. */
function recordToolGuardAcquisitionTimings(snapshot: PgAcquireTimingSnapshot | null,
  record: (phase: string, durationMs: number) => void): void {
  if (!snapshot || !Array.isArray(snapshot.acquisitions)) return;
  const counts = { org_admin: 0, org_app: 0 };
  const limit = Math.max(0, Math.min(PG_ACQUIRE_TIMING_LIMIT, snapshot.capacity));
  for (const acquisition of snapshot.acquisitions.slice(0, limit)) {
    const pool = acquisition.pool.startsWith('org-admin') ? 'org_admin'
      : acquisition.pool.startsWith('org-app') ? 'org_app' : null;
    if (!pool || !Number.isFinite(acquisition.elapsedMs) || acquisition.elapsedMs < 0) continue;
    const outcome = acquisition.outcome === 'acquired' ? 'acquired'
      : acquisition.outcome === 'released-before-acquire' ? 'released' : null;
    if (!outcome) continue;
    const ordinal = ++counts[pool];
    try { record('guard_pg_acquire_' + pool + '_' + outcome + '_' + ordinal, acquisition.elapsedMs); }
    catch { /* Diagnostics must never affect the guard verdict. */ }
  }
}

/**
 * The guard verdict for one pending call. Never throws. The always-worn kernel
 * safety rails refuse first, whatever is worn (R-11); after them an unreadable
 * applied artifact is no verdict (fail open), while a worn guard that cannot
 * evaluate is already a named refusal inside `evaluatePreToolGuards`.
 */
export async function toolGuardText(
  input: { ownerId: string; workspaceId: string; call: PendingToolCall },
  readWornRules: (ownerId: string, workspaceId: string, observeTiming?: IdentityRuleReadTimingObserver,
    budget?: IdentityRuleReadBudget) => Promise<WornSyncRules | null> = readAppliedWornRules,
  recordTiming?: (phase: 'plan' | 'identity', durationMs: number) => void,
  observePlanTiming?: PlanExecutionTimingObserver,
  observeIdentityTiming?: IdentityRuleReadTimingObserver,
): Promise<string> {
  // These authoritative reads are independent. Serializing them adds their
  // latencies against the native hook's fixed wall. Keep plan refusal first,
  // without making it wait for a stalled identity read or caching either vote.
  const readinessDeadlineAtMs = performance.now() + NATIVE_PLAN_READINESS_BUDGET_MS;
  const identityController = new AbortController();
  const identityBudget = { signal: identityController.signal, deadlineAtMs: readinessDeadlineAtMs };
  const identityUnavailable = 'tool_authority_unavailable: Native identity authority did not finish within the hook budget; this call was not performed. Retry after authority reads recover.';
  let planRefused = false;
  const plan = (async () => {
    const startedAt = performance.now();
    let timingRecorded = false;
    const recordPlanTiming = () => {
      if (timingRecorded) return;
      timingRecorded = true;
      recordTiming?.('plan', performance.now() - startedAt);
    };
    try {
      // Binding and goal reads happen before readiness itself. Bound the whole
      // authority computation so none of those reads can exhaust the client wall.
      // Start the check now and publish immediate refusals before the speculative
      // identity microtask; the timeout wrapper must not delay that fast path.
      const check = checkPlanExecutionGuard({ ownerId: input.ownerId, workspaceId: input.workspaceId,
        toolName: input.call.tool, args: input.call.input, observeTiming: observePlanTiming, readinessDeadlineAtMs })
        .then(refusal => { planRefused = Boolean(refusal); recordPlanTiming(); return refusal; },
          error => { recordPlanTiming(); throw error; });
      const bounded = await withBoundedTimeout<PlanExecutionRefusal | null>(
        check,
        { timeoutMs: Math.max(1, readinessDeadlineAtMs - performance.now()), warn: false,
          label: 'native-plan-execution-authority',
          fallback: { code: 'plan_execution_not_ready', blockers: ['plan_authority_unavailable'],
            reason: 'Native plan execution authority did not finish within the hook budget; this call was not performed. Retry after authority reads recover.' } },
      );
      if (bounded.reason === 'error') throw bounded.error;
      planRefused = Boolean(bounded.value);
      return bounded.value;
    } finally { recordPlanTiming(); }
  })();
  // Settle the speculative read immediately, including rejection, so an early
  // plan refusal cannot leave an unhandled identity failure behind.
  const identityRead = Promise.allSettled([Promise.resolve().then(async () => {
    // An already available refusal needs no speculative identity read.
    if (planRefused) return '';
    const startedAt = performance.now();
    try {
      return guardRefusalText(await evaluateToolGuard(input.call,
        () => readWornRules(input.ownerId, input.workspaceId, observeIdentityTiming, identityBudget)));
    } finally { recordTiming?.('identity', performance.now() - startedAt); }
  })]);
  try {
    const refused = await plan;
    if (refused) return `${refused.code}: ${refused.reason}`;
    const remainingMs = readinessDeadlineAtMs - performance.now();
    if (remainingMs <= 0) return identityUnavailable;
    const bounded = await withBoundedTimeout(identityRead, {
      timeoutMs: Math.ceil(remainingMs), warn: false, label: 'native-identity-authority',
      fallback: [{ status: 'fulfilled', value: identityUnavailable }] as Awaited<typeof identityRead>,
    });
    // An acquisition deadline can reject just before this timer runs. Its
    // unreadable-artifact fallback must never turn expiration into permission.
    if (performance.now() >= readinessDeadlineAtMs) return identityUnavailable;
    const [identity] = bounded.value;
    if (identity.status === 'rejected') throw identity.reason;
    return identity.value;
  } finally {
    // Also ends speculative work after a plan refusal, without canceling another
    // request's active SQL or keeping a late reservation after this verdict.
    identityController.abort(new Error('native authority operation ended'));
  }
}

/**
 * Whether a SessionStart opens a fresh context the compaction rules should
 * re-seed. compact and clear always do. startup does only for an owner that has
 * taken a hook turn before — a respawned session on a carry document — never a
 * first launch (D-024 §3). An unreadable turn store is no signal.
 */
export async function compactionSinkDue(
  input: { ownerId: string; workspaceId: string; source: string },
  turns: Pick<HookTurnStore, 'exists'> = pgHookTurnStore(),
): Promise<boolean> {
  if (ALWAYS_FRESH_SOURCES.has(input.source)) return true;
  if (input.source !== 'startup') return false;
  try {
    return await turns.exists(input.ownerId, input.workspaceId);
  } catch {
    return false;
  }
}

/**
 * In-flight verdicts by native-hook request id (EI-28856216485629340). The
 * hook's split-wall hedge re-sends the same guardRequestId to its second
 * origin once half its wall has passed. On staging both origins (:9171 proxy,
 * :3170 direct) reach this one process, so under load each slow verdict was
 * computed twice (measured 2026-11-15 12:20Z: 199 of 245 ids arrived twice in
 * 10 min). A duplicate whose whole request matches joins the running
 * computation; a different body under a reused id is computed on its own.
 */
const toolGuardInFlight = pinModuleState('@papercusp/operator-core.tool-guard-in-flight',
  () => new Map<string, { fingerprint: string; verdict: Promise<Awaited<ReturnType<typeof toolGuardText>>> }>());

function toolGuardFingerprint(ownerId: string, workspaceId: unknown,
  body: { tool?: unknown; client?: unknown; inputTruncated?: unknown; input?: unknown }): string {
  return createHash('sha256').update(JSON.stringify([ownerId, workspaceId, body.tool ?? null,
    body.client ?? null, body.inputTruncated === true, body.input ?? null])).digest('hex');
}

const toolGuard = defineTool({
  method: 'POST',
  path: '/agent-mcp/tool-guard',
  auth: 'loopback',
  async handler(req, ctx) {
    const startedAt = performance.now();
    const body = await readBody(req);
    const ownerId = (body?.owner ?? '').trim();
    const tool = typeof body?.tool === 'string' ? body.tool : '';
    if (!body || !ownerId || !tool) return empty();
    // Correlate a timed-out native hook with its eventual handler phases. Never
    // log inputs or accept arbitrary caller prose as a diagnostic identifier.
    const guardRequestId = typeof body.guardRequestId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.guardRequestId)
      ? body.guardRequestId : null;
    const phases: Partial<Record<'plan' | 'identity', number>> = {};
    const planStages: Record<string, number> = {};
    const identityStages: Record<string, number> = {};
    const observeIdentityTiming: IdentityRuleReadTimingObserver = ({ stage, durationMs }) => {
      if (!['applied_revision', 'applied_artifact', 'local_rules'].includes(stage) ||
          !Number.isFinite(durationMs) || durationMs < 0) return;
      identityStages[stage] = (identityStages[stage] ?? 0) + durationMs;
    };
    const observePlanTiming: PlanExecutionTimingObserver = ({ stage, durationMs }) => {
      // Keep the existing bounds plus the exact snapshot names with hyphens.
      // These timing-only labels contain no owner, plan, input or verdict content.
      if (!(/^[a-z_]{1,32}$/.test(stage) ||
          /^start_gate_snapshot_(?:plan-items|work-contracts|lineage-parties)$/.test(stage)) ||
          !Number.isFinite(durationMs) || durationMs < 0) return;
      // Preserve the 41 guard, snapshot, goal and canonical-reader phases,
      // including late revision rechecks; keep future labels bounded at 48.
      if (!(stage in planStages) && Object.keys(planStages).length >= 48) return;
      planStages[stage] = (planStages[stage] ?? 0) + durationMs;
    };
    const workspaceId = await resolveWorkspace(body);
    const setupMs = performance.now() - startedAt;
    let text;
    let joinedInFlight = false;
    let requestAcquireSnapshot: typeof pgAcquireTimingSnapshot = () => null;
    let acquisitionSnapshotRead = false;
    let acquisitionSnapshot: PgAcquireTimingSnapshot | null = null;
    const readAcquireSnapshot = () => {
      if (!acquisitionSnapshotRead) {
        acquisitionSnapshotRead = true;
        acquisitionSnapshot = requestAcquireSnapshot();
      }
      return acquisitionSnapshot;
    };
    try {
      const run = () => withPriorityOrgPg(() => toolGuardText({
        ownerId,
        workspaceId,
        call: {
          tool,
          input: body.inputTruncated === true ? null : body.input ?? null,
          client: typeof body.client === 'string' ? body.client : '',
          ...(body.inputTruncated === true ? { inputTruncated: true } : {}),
        },
      }, readAppliedWornRules, (phase, durationMs) => { phases[phase] = durationMs; }, observePlanTiming, observeIdentityTiming));
      const compute = () => guardRequestId
        ? withPgAcquireDiagnostics('native-tool-guard', () => {
          // Finally resumes outside this context; late callbacks may run in a
          // different request too. Retain the originating request, not its caller.
          requestAcquireSnapshot = AsyncLocalStorage.bind(pgAcquireTimingSnapshot);
          return withNamedQueryDiagnosticContext('native-tool-guard', run, guardRequestId);
        })
        : run();
      const fingerprint = guardRequestId ? toolGuardFingerprint(ownerId, workspaceId, body) : null;
      const inFlight = guardRequestId ? toolGuardInFlight.get(guardRequestId) : undefined;
      if (inFlight && inFlight.fingerprint === fingerprint) {
        // The hedge re-sent this exact request: share the running verdict.
        joinedInFlight = true;
        text = await inFlight.verdict;
      } else if (guardRequestId && fingerprint && !inFlight) {
        const entry = { fingerprint, verdict: compute() };
        toolGuardInFlight.set(guardRequestId, entry);
        try { text = await entry.verdict; } finally {
          if (toolGuardInFlight.get(guardRequestId) === entry) toolGuardInFlight.delete(guardRequestId);
        }
      } else {
        text = await compute();
      }
    } finally {
      const totalMs = performance.now() - startedAt;
      if (totalMs >= 500) {
        const recordRoutePhase = (phase: string, durationMs: number) => {
          try { ctx?.routeDiagnostics?.record?.(phase, durationMs); } catch { /* diagnostics only */ }
        };
        recordRoutePhase('guard_setup', setupMs);
        if (phases.plan !== undefined) recordRoutePhase('guard_plan_total', phases.plan);
        if (phases.identity !== undefined) recordRoutePhase('guard_identity_total', phases.identity);
        for (const [stage, durationMs] of Object.entries(planStages))
          recordRoutePhase('guard_plan_' + stage, durationMs);
        for (const [stage, durationMs] of Object.entries(identityStages))
          recordRoutePhase('guard_identity_' + stage, durationMs);
        try { recordToolGuardAcquisitionTimings(readAcquireSnapshot(), recordRoutePhase); }
        catch { /* A diagnostic read must not change the guard result. */ }
      }
      // Keep attribution after the client has aborted too. No tool inputs, plan
      // content or refusal text belongs in this timing-only diagnostic.
      if (totalMs >= 500) console.warn('[tool-guard-timing]', JSON.stringify({
        ...(guardRequestId ? { guardRequestId } : {}),
        totalMs: Math.round(totalMs), setupMs: Math.round(setupMs),
        planMs: phases.plan === undefined ? null : Math.round(phases.plan),
        identityMs: phases.identity === undefined ? null : Math.round(phases.identity),
        aborted: req.signal.aborted,
        ...(joinedInFlight ? { joinedInFlight: true } : {}),
        ...(Object.keys(planStages).length ? { planStages } : {}),
        ...(Object.keys(identityStages).length ? { identityStages } : {}),
        ...(guardRequestId ? { pgTimings: toolGuardPgTimings(guardRequestId),
          pgAcquisitions: toolGuardPgAcquisitions(readAcquireSnapshot) } : {}),
      }));
    }
    const timings = { guard: performance.now() - startedAt, setup: setupMs, ...phases,
      ...Object.fromEntries(Object.entries(planStages).map(([stage, duration]) => ['plan_' + stage, duration])),
      ...Object.fromEntries(Object.entries(identityStages).map(([stage, duration]) => ['identity_' + stage, duration])) };
    // Native clients render the refusal text, not response headers. Retain the
    // same validated opaque id there so a server verdict can be matched to its
    // diagnostic log too. Empty text must stay empty: it means no refusal.
    const responseText = text && guardRequestId
      ? `${text}\nGuard diagnostic: requestId=${guardRequestId}.` : text;
    return Response.json({ ok: true, text: responseText }, { headers: {
      ...(guardRequestId ? { 'X-Papercusp-Guard-Request-Id': guardRequestId } : {}),
      'Server-Timing': Object.entries(timings).map(([phase, duration]) => `${phase};dur=${duration.toFixed(1)}`).join(', '),
    } });
  },
});

const stopContext = defineTool({
  method: 'POST',
  path: '/agent-mcp/stop-context',
  auth: 'loopback',
  async handler(req) {
    const body = await readBody(req);
    const ownerId = (body?.owner ?? '').trim();
    if (!body || !ownerId) return empty();
    const workspaceId = await resolveWorkspace(body);
    // Both share the hook's wall. The held-work refusal leads: it is the one the agent must act on.
    const [heldWorkText, identityText] = await Promise.all([
      boundedTurnEndHeldWorkText({ ownerId, workspaceId }),
      boundedContextSinkText({ ownerId, workspaceId, sink: 'stop' }),
    ]);
    const text = [heldWorkText, identityText].filter((t) => t.length > 0).join('\n\n');
    const deliveredText =
      body.client === 'codex' && text
        ? (
            await tagTurnForInjection({
              sid: ownerId,
              origin: 'stop-hook',
              text,
            })
          ).taggedText
        : text;
    return Response.json({ ok: true, text: deliveredText });
  },
});

/**
 * The turn-end held-work refusal (WI-6554700010015550) under the same wall as the identity
 * sink: a slow read degrades to no text, never to a late or blocked stop.
 */
async function boundedTurnEndHeldWorkText(input: { ownerId: string; workspaceId: string }): Promise<string> {
  const [{ withBoundedTimeout }, { evaluateTurnEndHeldWorkStop }] = await Promise.all([
    import('../../../bounded-timeout'),
    import('../../../events/await/turn-end-held-work-guard'),
  ]);
  const bounded = await withBoundedTimeout(() => evaluateTurnEndHeldWorkStop(input), {
    fallback: '',
    timeoutMs: CONTEXT_SINK_BUDGET_MS,
    label: 'identity-hook:stop:held-work',
  });
  return bounded.value;
}

/** The Codex SessionStart dispatcher owns this epoch boundary. Claude uses
 * session-recovery-brief instead. Keep carry, recall and receipt IO inside one
 * wall; a late carry read must never start a new epoch after the hook returned. */
async function boundedCompactMemory(input: { ownerId: string; workspaceId: string; confirmations: unknown }) {
  type MemoryResponse = { text: string; deliveryToken?: string; memoryFragmentOffers?: MemoryFragmentOffer[] };
  const none: MemoryResponse = { text: '' };
  const { withBoundedTimeout } = await import('../../../bounded-timeout');
  const bounded = await withBoundedTimeout<MemoryResponse>(async signal => {
    const [{ buildCarryBrief }, { buildCompactReprimeBlock }, { withMemoryEmissionReceipt }, { getOrgPg }] = await Promise.all([
      import('../../../carry-brief'), import('../../../memory/compact-reprime'),
      import('../../../memory/session-epoch-ledger'), import('@papercusp/db-org'),
    ]);
    if (signal.aborted) return none;
    const response = await withMemoryEmissionReceipt(getOrgPg().sql, input.ownerId, input.confirmations, async () => {
      // Closing this inner scope at the outer deadline prevents abandoned
      // builders from collecting or staging fragments in a late response.
      const prepared = await withBoundedTimeout(async childSignal => {
        const brief = await buildCarryBrief(input.ownerId, { workspaceId: input.workspaceId });
        if (childSignal.aborted) return '';
        return await buildCompactReprimeBlock({
          ownerId: input.ownerId, workspaceId: input.workspaceId,
          heldItems: brief.heldItems.map(({ id, title, harness }) => ({ id, title, harness })),
          fleetSlug: brief.fleet?.slug ?? null, awaits: brief.awaits, facts: brief.facts,
        }) ?? '';
      }, { fallback: '', timeoutMs: CONTEXT_SINK_BUDGET_MS, signal, label: 'identity-hook:compaction:reprime' });
      return { content: [{ type: 'text' as const, text: prepared.value }] };
    });
    if (signal.aborted) return none;
    const offer = response._meta?.['papercusp/memoryEmission'] as
      { token: string; fragments: MemoryFragmentOffer[] } | undefined;
    return { text: response.content[0]!.text,
      ...(offer ? { deliveryToken: offer.token, memoryFragmentOffers: offer.fragments } : {}) };
  }, { fallback: none, timeoutMs: CONTEXT_SINK_BUDGET_MS, label: 'identity-hook:compaction:memory' });
  return bounded.value;
}

const compactionContext = defineTool({
  method: 'POST',
  path: '/agent-mcp/compaction-context',
  auth: 'loopback',
  async handler(req) {
    const body = await readBody(req);
    const ownerId = (body?.owner ?? '').trim();
    const source = typeof body?.source === 'string' ? body.source : '';
    if (!body || !ownerId || !source) return empty();
    const workspaceId = await resolveWorkspace(body);
    if (!(await compactionSinkDue({ ownerId, workspaceId, source }))) return empty();
    const [identityText, memory] = await Promise.all([
      boundedContextSinkText({ ownerId, workspaceId, sink: 'compaction' }),
      body.client === 'codex' && body.memoryReceiptMode === true
        ? boundedCompactMemory({ ownerId, workspaceId, confirmations: body.confirmedMemoryDeliveries })
        : Promise.resolve({ text: '' }),
    ]);
    const { text: memoryText, ...delivery } = memory;
    const text = [identityText, memoryText].filter(Boolean).join('\n\n');
    return Response.json({ ok: true, text, ...delivery });
  },
});

export default [toolGuard, stopContext, compactionContext];
