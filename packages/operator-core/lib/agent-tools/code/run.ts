import { z } from 'zod';
import { withWorkspace, getOrgPg } from '@papercusp/db-org';
import { maybeEmptyMappingHint, EMPTY_MAPPING_METADATA_KEY } from '../../empty-mapping-hint';
import {
  defineTool,
  listAllProjectedTools,
  runToolOrchestration,
  roleScopedToolNames,
  generateToolFacadeTypes,
  listFacadeNamespaces,
  nearestByLevenshtein,
  AGENT_ROLES,
  type UnifiedToolContext,
  type WrapDispatch,
} from '@papercusp/agent-mcp';
import { PROJECTED_DEPS } from '../../projected-tool-deps';
import { FOREGROUND_TIMEOUT_CEILING_MS, clampForegroundTimeoutMs } from '../capability/inspect';
import { captureRecipe } from './capture-recipe';
import type { SimilarRecipe } from '../../code-recipes-search';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import {
  dispatchNeedsTx,
  effectiveDispatchWorkspace,
  synthesizeDispatchPrincipal,
} from '../../endpoint-route/routes/transport/role-principal-caps';

/**
 * `code:run` — execute a multi-step tool-orchestration SCRIPT in one call
 * (code-execution-tool-orchestration B-CX-2A).
 *
 * The script calls the agent's allowed tools as `tools.<ns>.<verb>(args)` (verbs camelCased:
 * `coord:wake-queue` → `tools.coord.wakeQueue`) or `tools.call('ns:verb', args)`, with real
 * control flow (loops / conditionals / retries / filtering). It runs in a vm sandbox; only the
 * script's RETURNED value re-enters your context — intermediate tool results stay in the runtime.
 * This collapses tool flows that would otherwise require multiple MODEL inference turns into ONE
 * `code:run` call and keeps intermediate payloads out of model context. Several independent direct
 * calls emitted together in one assistant response are already one inference turn; raw RPC count is
 * not the cost metric.
 *
 * SAFETY: the sandbox exposes only tools your role may call (the whitelist IS the boundary). Set
 * `dryRun: true` to PREVIEW mutations — `effect:'write'` tool calls are recorded (returned in
 * `plannedMutations`) but NOT executed; reads still run. Re-run without `dryRun` to commit.
 */
export default defineTool({
  name: 'code:run',
  description:
    'Run a multi-step tool-orchestration script (tools.ns.verb(args) + JS control flow) in ONE ' +
    'call, returning only the script\'s summary — collapsing N sequential model turns into one and ' +
    'keeping intermediate payloads out of context. Write the ' +
    'script directly; a wrong tool name returns typed signatures inline to fix. dryRun:true ' +
    'previews write-effect mutations before committing. Colon name → dotted call: `:`/`_` → `.` ' +
    '(sessions:read → tools.sessions.read); never invent a fourth spelling.',
  guidance: {
    when:
      'MANY tool calls with control flow — loop/branch/filter, fan-out reads, retry-until: ' +
      'orchestrate them in ONE call. Pass title+description so the run saves as a reusable ' +
      'RECIPE other agents in your hive can find.',
    notWhen:
      'A single call; a few independent calls you can emit together in this assistant turn; or a ' +
      'step that needs YOUR judgment mid-flow (read a result, then decide) — call tools directly.',
    chaining:
      'script → code:run { dryRun:true } → inspect plannedMutations → code:run. A correct tool ' +
      'name with a WRONG field mapping fails SILENTLY (ok:true, blank rows) — check the tool\'s ' +
      '`returns` (tools:find), or return one raw result before mapping a batch.',
    seeAlso: [
      'code:tools (typed signatures for a namespace — optional pre-check)',
      'recipes:run (run a saved composed recipe instead)',
    ],
  },
  // Role-gated tools gate on agentRoles (not capability); capability sets tier + write-effect.
  // code:run is as powerful as the shell capability — it can call any of the agent's write tools.
  capability: 'capability:bash',
  requirePrincipal: false,
  // ALL ROLES (owner directive 2026-06-25): code:run is open to every built-in role — not just
  // SU_ROLES + bee, which was the prior gate. Rationale: the grant is privilege-PRESERVING. The
  // facade is role-scoped (handler below: `roleScopedToolNames(all, ctx.role, …)`), so a role's
  // script can ONLY call tools that role may ALREADY call, and every inner call re-routes through
  // the real dispatcher (PROJECTED_DEPS → capability-envelope + quota + authz gating). Widening the
  // role gate therefore grants NO new reach — it just lets EVERY role collapse its own multi-call
  // flows into one round-trip (the token-frugality win that was inert for the high-repeat-call roles
  // worker/validator/reviewer/… while they were excluded here). A deployment that confines a role
  // away from capability:bash via a blueprint envelope still denies code:run at that envelope.
  // AGENT_ROLES is the complete built-in role universe; keep the companion tools (code:tools,
  // recipes:run/search/list/get) and CODE_RUN_CAPABLE_ROLES (the batch-nudge audience) in lockstep.
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    script: z
      .string()
      .min(1)
      .max(20_000)
      .describe(
        'JS/TS body. Call tools via `await tools.ns.verb(args)`; `return` a compact summary. ' +
          'No setTimeout/setInterval (not ambient in this sandbox) — use `await sleep(ms)` for a ' +
          'short bounded delay (e.g. write-then-reverify) instead.',
      ),
    title: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Short title for the reusable RECIPE saved on a successful run — make it discoverable ' +
          'by other agents (e.g. "triage stale work-items"). Optional: a fallback is derived ' +
          'from the script when omitted.',
      ),
    description: z
      .string()
      .max(2_000)
      .optional()
      .describe(
        'One/two lines on what this recipe does + when to reuse it. Optional: derived from the ' +
          'tool-set when omitted.',
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe('Preview: record effect:write tool calls without executing them (reads still run).'),
    timeoutSec: z
      .number()
      .int()
      .min(1)
      .max(120)
      .optional()
      .describe(
        `Wall-clock budget (default 30s). EI-9239: code:run has no run_in_background — every call is ` +
          `foreground, and the papercusp-su MCP transport hard-caps a foreground call at ~55s regardless ` +
          `of this value. A request above ${FOREGROUND_TIMEOUT_CEILING_MS / 1000}s is clamped down to it ` +
          `so the script gets a clean internal script_timeout (with whatever it returned so far) instead ` +
          `of an opaque transport request_timeout — the script itself may keep running server-side past ` +
          `that, but this call will not see the result. For work that genuinely needs longer, split it ` +
          `into multiple code:run calls or fall back to individual tool calls.`,
      ),
  }),
  async handler(args, ctx) {
    const all = listAllProjectedTools();
    // Scope the facade to tools this agent's role may call (mirrors the dispatcher role-allowlist);
    // exclude code:run itself so a script cannot recursively nest code-mode.
    const allowed = roleScopedToolNames(all, ctx.role, new Set(['code:run']));

    const result = await runToolOrchestration(args.script, {
      ctx,
      // Thread the host's REAL dispatch deps (B-CX-DEPS): inner tool calls route through
      // the same dispatcher pipeline as any MCP `tools/call` — so they are recordInvocation-
      // logged (visible to spend/quota, not invisible), quota-counted, capability-envelope-
      // gated, postInvoke/event-reaction-observed, and authz-audited — not just role-allowlisted.
      // Same singleton the in-process re-dispatch path (events/dispatch-reaction.ts) uses.
      deps: PROJECTED_DEPS,
      tools: all,
      allowed,
      dryRun: args.dryRun ?? false,
      // EI-9239: clamp below the ~55s MCP transport cap (mirrors capability:inspect's identical
      // EI-6073 fix) so a script_timeout fires cleanly here instead of the caller getting an
      // opaque transport-level request_timeout after the script's own budget was never reached.
      timeoutMs: args.timeoutSec ? clampForegroundTimeoutMs(args.timeoutSec * 1000) : undefined,
      wrapDispatch: bindInnerDispatch,
    });

    // CAPTURE + DEDUP (code-recipes-2026-06-21 P-003/P-004): every SUCCESSFUL, non-dry-run
    // code:run is saved as a reusable recipe (D-012), and the capture path ALSO returns the
    // top prior recipes that already do something similar (semantic + structural dedup, D-003).
    // Best-effort — wrapped so it can NEVER break the run (a dry-run is a preview, not an
    // execution, so it captures nothing). The await keeps the recipe durable before we return,
    // but maybeCaptureRecipe swallows every failure internally.
    //
    // similarRecipes is ADVISORY/SOFT: the run STILL ran + STILL captured. It tells the agent
    // "recipes X/Y already do this — next time recipes:run(X) instead of re-authoring".
    let similarRecipes: SimilarRecipe[] = [];
    // Don't SAVE a recipe that references an unknown tool (F8): the run may have limped through by
    // isolating the bad ref, but a captured recipe with a known-bad name is a poor thing to reuse.
    // EI-7669: also don't save one where a write-effect call reported ok:false — a "successful"
    // recipe that includes a known-rejected mutation is a poor thing to reuse verbatim.
    if (
      result.ok &&
      !(args.dryRun ?? false) &&
      !result.unknownRefs?.length &&
      !result.okFalseMutations?.length
    ) {
      similarRecipes = await maybeCaptureRecipe(args, ctx, all, allowed);
    }

    // P-007 (agent-tooling-token-efficiency): cut the discovery ritual. The old flow demanded a
    // code:tools {} → code:tools { namespaces } pre-call before you could safely author a script.
    // Instead, on a parse-check failure (the script referenced a tool not in your facade — a typo'd
    // verb or wrong namespace) hand back the typed signatures for the namespaces it touched IN THIS
    // SAME RESULT, so you fix the name + re-run rather than paying a separate code:tools round-trip.
    // dryRun safety is untouched: write-effect mutations still require the dryRun preview as before.
    // Surface the self-service fix whenever the script referenced an unknown tool — even if the run
    // limped through by isolating it (F8): the agent still wants the correct name for next time.
    const facadeHelp =
      result.unknownRefs?.length
        ? buildFacadeHelp(result.unknownRefs, all, allowed)
        : undefined;

    // WI-1377: keep the full plannedMutations echo ONLY under dryRun (the mutation preview the
    // agent inspects before committing). On a REAL run the writes already executed, so echoing
    // every call's full args back is pure waste that overflows the 100k result cap on a large
    // batch (e.g. 600+ set_priority calls) — even when the script's own `summary` is tiny — and
    // forces the agent to split one logical write across many code:run calls. shapeMutationEcho
    // swaps it for a compact { count, byTool } summary on a committing run.
    const shownResult = shapeCodeRunLogs(shapeMutationEcho(result));

    const payload =
      similarRecipes.length > 0 || facadeHelp
        ? {
            ...shownResult,
            ...(similarRecipes.length > 0 ? { similarRecipes } : {}),
            ...(facadeHelp ? { facadeHelp } : {}),
          }
        : shownResult;

    // EI-10892 (fleet telemetry half). The MCP handler already tells THIS agent, in
    // THIS response, when its script returned `ok:true` with every field blank — a
    // mis-mapped response shape. But an advisory only the caller sees cannot be
    // counted, so the dominant waste mode in the system stayed invisible fleet-wide:
    // the tool-efficiency panel grades hard failures (limit-rejections), code:run
    // adoption, and orient-dedup — every one of which reports HEALTHY while a fleet
    // burns round-trips on ok-but-empty results. You cannot fix what you cannot see.
    //
    // So stamp the detection into tool_invocations.metadata_json, the general-purpose
    // per-invocation metadata column that already exists (memory:search stamps its hit
    // `count` through this same ctx.metadata seam — no migration, no new table). The
    // empty-result-rate read/grade module aggregates it into a 4th panel axis.
    //
    // Detected HERE rather than reusing the handler's result because this is the one
    // place the payload is still a live object — the handler has to JSON.parse its own
    // response text to see it, and it cannot reach ctx.metadata (it never records the
    // invocation; the dispatch layer does). Same pure detector, same input, so the two
    // call sites cannot disagree.
    try {
      const body = (payload as { summary?: unknown }).summary ?? payload;
      // toolsUsed only enriches the agent-facing message text, which the stamp does
      // not use — so pass none, exactly as the handler does.
      const hint = maybeEmptyMappingHint(body, []);
      if (hint) {
        (ctx as { metadata?: (d: Record<string, unknown>) => void }).metadata?.({
          // Shared constant, not a literal: the panel axis's SQL reads this exact key
          // back. If the two sides drifted, the metric would read ZERO forever — which
          // is indistinguishable from healthy. See EMPTY_MAPPING_METADATA_KEY.
          [EMPTY_MAPPING_METADATA_KEY]: { rows: hint.rows, blankRows: hint.blankRows },
        });
      }
    } catch {
      // Telemetry is never allowed to fail a run that otherwise succeeded.
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});

/**
 * WI-1411: per-inner-call workspace/identity rebinding.
 *
 * `dispatch-binding.ts`'s `realDispatch(ctx, deps)` closes over ONE fixed `ctx`
 * for every call a `code:run` script makes — so a batch never gets the
 * per-call binding a DIRECT (non-batch) MCP dispatch of the same tool
 * receives from `_mcp-handler.ts`: the EI-30 superuser-per-call-`workspace`
 * hop (`effectiveDispatchWorkspace`), the workspace tx + synthesized
 * principal (`dispatchNeedsTx`/`synthesizeDispatchPrincipal`/`withWorkspace`),
 * and the ALS pin (`runWithWorkspaceIfConcrete`) so `activeWorkspaceId()`
 * resolves correctly inside the tool's own handler. Concretely: an unscoped
 * superuser session (`ctx.isSuperuser === true`, `ctx.workspaceId === '*'`)
 * running a `code:run` script that calls e.g. `tools.fleet.assignments({
 * workspace: 'X', ... })` intending the EI-30 hop had that per-call
 * `workspace` silently ignored — `resolveAgentIdentity(ctx)` (and any
 * `activeWorkspaceId()` fallback) saw the OUTER ctx's `'*'` — so the read
 * matched no real workspace and came back EMPTY (the reported "pgQuery /
 * fleet:assignments return EMPTY inside a code:run batch" symptom).
 *
 * This mirrors `_mcp-handler.ts`'s exact branch structure
 * (`crossWorkspace` → `needsTx` → plain) PER inner call, with a fast path:
 * when the effective workspace for THIS call is unchanged from the ctx
 * already bound (the common case — every non-superuser caller, and any
 * superuser call without a per-call `workspace` override), the outer
 * code:run dispatch already bound `ctx.tx`/`ctx.principal` correctly, so we
 * dispatch under the SAME ctx unchanged — no extra transaction per call.
 */
export const bindInnerDispatch: WrapDispatch = async (tool, _toolName, args, ctx, next) => {
  const spawnCtxLike = {
    workspaceId: ctx.workspaceId ?? '',
    role: ctx.role ?? '',
    isSuperuser: ctx.isSuperuser,
  };
  const effectiveWs = effectiveDispatchWorkspace(spawnCtxLike, args);

  if (tool.crossWorkspace === true) {
    const { sql: adminTx } = getOrgPg();
    const callCtx: UnifiedToolContext = {
      ...ctx,
      workspaceId: effectiveWs,
      tx: adminTx,
      principal: await synthesizeDispatchPrincipal(adminTx, { ...spawnCtxLike, workspaceId: effectiveWs }),
    };
    return runWithWorkspaceIfConcrete(effectiveWs, () => next(callCtx));
  }

  if (effectiveWs === spawnCtxLike.workspaceId) {
    // Already correctly bound by the outer code:run dispatch — reuse ctx as-is.
    return next(ctx);
  }

  // EI-30 hop fired: an unscoped superuser passed a concrete per-call
  // `workspace` that differs from the outer ctx. Re-derive the binding for
  // THIS call exactly as a direct (non-batch) MCP call would.
  const callSpawnCtx = { ...spawnCtxLike, workspaceId: effectiveWs };
  if (!dispatchNeedsTx(callSpawnCtx)) {
    return runWithWorkspaceIfConcrete(effectiveWs, () => next({ ...ctx, workspaceId: effectiveWs }));
  }
  return runWithWorkspaceIfConcrete(effectiveWs, () =>
    withWorkspace(effectiveWs, async (tx) => {
      const callCtx: UnifiedToolContext = {
        ...ctx,
        workspaceId: effectiveWs,
        tx,
        principal: await synthesizeDispatchPrincipal(tx, callSpawnCtx),
      };
      return next(callCtx);
    }),
  );
};

type OrchestrationRunResult = Awaited<ReturnType<typeof runToolOrchestration>>;

const DRY_RUN_MUTATION_PREVIEW_CHAR_BUDGET = 20_000;
const DRY_RUN_MUTATION_SAMPLE_LIMIT = 12;
const DRY_RUN_MUTATION_SAMPLE_PER_TOOL_LIMIT = 3;
const CODE_RUN_LOG_LINE_LIMIT = 80;
const CODE_RUN_LOG_LINE_CHAR_BUDGET = 1_000;

const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const ANSI_CSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_PATTERN = /\x1B[@-Z\\-_]|\x9B[0-?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

interface CodeRunLogsNotice {
  rawCount: number;
  shownCount: number;
  adjacentDuplicatesCollapsed: number;
  sanitizedLines: number;
  truncatedLines: number;
  droppedAfterLimit: number;
  note: string;
}

/**
 * WI-3127: the code:run sandbox does not expose require/process, so a script cannot shell out
 * with execSync. It can still write arbitrary console text, and that text is serialized back in
 * the agent-facing `logs` field. Shape that side channel here: keep the script's returned summary
 * untouched, but strip terminal/control noise and bound repetitive or oversized logs.
 */
export function shapeCodeRunLogs<T extends Record<string, unknown>>(
  result: T,
): T | (T & { logs: string[]; logsNotice: CodeRunLogsNotice }) {
  const logs = result.logs;
  if (!Array.isArray(logs)) return result;

  let sanitizedLines = 0;
  let truncatedLines = 0;
  let adjacentDuplicatesCollapsed = 0;
  const normalized = logs.map((entry) => {
    const raw = typeof entry === 'string' ? entry : String(entry);
    const sanitized = sanitizeCodeRunLogLine(raw);
    if (sanitized !== raw) sanitizedLines++;
    if (sanitized.length <= CODE_RUN_LOG_LINE_CHAR_BUDGET) return sanitized;
    truncatedLines++;
    return (
      sanitized.slice(0, CODE_RUN_LOG_LINE_CHAR_BUDGET) +
      `... [truncated ${sanitized.length - CODE_RUN_LOG_LINE_CHAR_BUDGET} chars]`
    );
  });

  const deduped: string[] = [];
  let previous: string | undefined;
  let repeatCount = 0;
  const flush = () => {
    if (previous === undefined) return;
    deduped.push(previous);
    if (repeatCount > 1) {
      const collapsed = repeatCount - 1;
      adjacentDuplicatesCollapsed += collapsed;
      deduped.push(`[previous code:run log line repeated ${collapsed} more time${collapsed === 1 ? '' : 's'}]`);
    }
  };
  for (const line of normalized) {
    if (line === previous) {
      repeatCount++;
      continue;
    }
    flush();
    previous = line;
    repeatCount = 1;
  }
  flush();

  const limited = deduped.slice(0, CODE_RUN_LOG_LINE_LIMIT);
  const droppedAfterLimit = Math.max(0, deduped.length - limited.length);
  if (
    sanitizedLines === 0 &&
    truncatedLines === 0 &&
    adjacentDuplicatesCollapsed === 0 &&
    droppedAfterLimit === 0
  ) {
    return result;
  }

  return {
    ...result,
    logs: limited,
    logsNotice: {
      rawCount: logs.length,
      shownCount: limited.length,
      adjacentDuplicatesCollapsed,
      sanitizedLines,
      truncatedLines,
      droppedAfterLimit,
      note:
        'code:run logs were shaped to keep terminal noise bounded; the script return value in `summary` is unchanged',
    },
  };
}

function sanitizeCodeRunLogLine(raw: string): string {
  return raw
    .replace(ANSI_OSC_PATTERN, '')
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_SINGLE_PATTERN, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(CONTROL_PATTERN, '');
}

/**
 * WI-1377 / WI-1410: shape the mutation echo for the agent-facing result envelope. The full
 * `plannedMutations` array (every effect:write call's tool + FULL args) is the decision-useful
 * PREVIEW under dryRun — until it gets so large that the preview itself overflows/truncates and is
 * no longer reviewable. On a REAL (committing) run those calls already executed, so echoing their
 * args back is pure waste. So: an empty array stays unchanged; a committing run with ≥1 write drops
 * `plannedMutations` for a compact `{ count, byTool }` summary; a dryRun keeps the full preview only
 * while it is still bounded, then swaps to a summarized dry-run preview with per-tool counts and a
 * representative sample.
 */
/**
 * EI-10951 — the honest failure warning.
 *
 * `plannedMutations` is recorded at DISPATCH time, so it includes calls that then threw.
 * The old warning counted all of them as "already executed", which made the most common
 * failure mode in practice — a script whose last call had a bad argument — report:
 *
 *     "1 write-effect call(s) already executed before this failure … do NOT blindly
 *      re-run; check what actually landed, to avoid a double-write."
 *
 * Nothing had landed. The agent then burned a round-trip verifying a write that never
 * happened (observed twice in one session, 2026-07-13). Worse, a warning that is wrong
 * on the common case trains agents to skip it on the rare case it is RIGHT — a real
 * partially-applied batch, which is precisely what it exists to catch.
 *
 * So classify honestly, and say only what is true:
 *   landed    — dispatched and returned without throwing. These DID take effect.
 *   rejected  — the dispatcher refused them before the handler ran (bad args, denied
 *               gate). These provably wrote NOTHING; re-running is safe.
 *   uncertain — threw for any other reason (handler error, timeout mid-flight). These
 *               MAY have landed, and are the ONLY set that still earns the loud warning.
 *
 * PURE — unit-tested without PG or a live dispatcher.
 */
export function buildFailureWarning(
  planned: readonly { tool: string }[],
  rejected: readonly { tool: string }[],
  uncertain: readonly { tool: string }[],
): Record<string, string> {
  const countBy = (ms: readonly { tool: string }[]): Record<string, number> => {
    const by: Record<string, number> = {};
    for (const m of ms) by[m.tool] = (by[m.tool] ?? 0) + 1;
    return by;
  };
  const render = (by: Record<string, number>): string =>
    Object.entries(by)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${t}×${n}`)
      .join(', ');
  const tally = (ms: readonly { tool: string }[]): string => render(countBy(ms));

  // What actually LANDED = dispatched, minus everything that threw. (Subtract per-tool, so
  // the tally names the tools that really took effect — not the one that was rejected.)
  const landedBy = countBy(planned);
  for (const m of [...rejected, ...uncertain]) {
    if (landedBy[m.tool]) landedBy[m.tool] -= 1;
  }
  const landedCount = Math.max(planned.length - rejected.length - uncertain.length, 0);

  // Nothing took effect and nothing is in doubt: say so plainly. This is the case the old
  // warning got backwards, and the case an agent hits most.
  if (landedCount === 0 && uncertain.length === 0) {
    if (rejected.length === 0) return {};
    return {
      warning:
        `${rejected.length} write-effect call(s) were REJECTED before execution (${tally(rejected)}) — ` +
        'the dispatcher refused them (bad args / denied gate), so NOTHING was written. ' +
        'No double-write risk: fix the call and re-run the script.',
    };
  }

  // Wording preserved from the original warning (WI-1377/EI-7174) for the case whose
  // semantics are UNCHANGED — a write that really did land still says exactly what it
  // always said. Only the false-alarm case (nothing landed) gets new text.
  const parts: string[] = [];
  if (landedCount > 0) {
    parts.push(
      `${landedCount} write-effect call(s) already executed before this failure (${render(landedBy)})`,
    );
  }
  if (uncertain.length > 0) {
    parts.push(
      `${uncertain.length} threw mid-flight and MAY have landed (${tally(uncertain)})`,
    );
  }
  const suffix =
    rejected.length > 0
      ? ` (${rejected.length} further call(s) were rejected before execution and wrote nothing.)`
      : '';
  return {
    warning:
      `${parts.join('; ')} — do NOT blindly re-run the whole script; check what actually ` +
      `landed before retrying, to avoid a double-write.${suffix}`,
  };
}

export function shapeMutationEcho(
  result: OrchestrationRunResult,
): OrchestrationRunResult | Record<string, unknown> {
  if (result.plannedMutations.length === 0) return result;
  if (result.dryRun) {
    const serialized = JSON.stringify(result.plannedMutations);
    if (serialized.length <= DRY_RUN_MUTATION_PREVIEW_CHAR_BUDGET) return result;

    const { plannedMutations, ...rest } = result;
    const byTool: Record<string, number> = {};
    const samplesPerTool: Record<string, number> = {};
    const sample: typeof plannedMutations = [];
    for (const m of plannedMutations) {
      byTool[m.tool] = (byTool[m.tool] ?? 0) + 1;
      if (sample.length >= DRY_RUN_MUTATION_SAMPLE_LIMIT) continue;
      const toolSamples = samplesPerTool[m.tool] ?? 0;
      if (toolSamples >= DRY_RUN_MUTATION_SAMPLE_PER_TOOL_LIMIT) continue;
      sample.push(m);
      samplesPerTool[m.tool] = toolSamples + 1;
    }

    return {
      ...rest,
      mutations: {
        dryRunPreview: true,
        count: plannedMutations.length,
        byTool,
        sample,
        sampleOmittedCount: plannedMutations.length - sample.length,
        note:
          'dryRun preview summarized to keep the result bounded and reviewable; sample shows a few representative writes per tool',
      },
    };
  }

  const { plannedMutations, okFalseMutations, rejectedMutations, uncertainMutations, ...rest } = result;
  // Defensive: fixture results built by hand (tests predating this field) omit it entirely.
  const okFalseMutationsList = okFalseMutations ?? [];
  const rejected = rejectedMutations ?? [];
  const uncertain = uncertainMutations ?? [];
  // EI-10951: `mutations.count` must count what LANDED, not what was dispatched — a
  // rejected call wrote nothing and reporting it as a mutation is the same lie as the
  // warning below. (A throw mid-flight stays counted: it may well have landed.)
  const landedByTool: Record<string, number> = {};
  for (const m of plannedMutations) landedByTool[m.tool] = (landedByTool[m.tool] ?? 0) + 1;
  for (const m of rejected) {
    const n = (landedByTool[m.tool] ?? 0) - 1;
    if (n > 0) landedByTool[m.tool] = n;
    else delete landedByTool[m.tool];
  }
  const landedCount = Math.max(plannedMutations.length - rejected.length, 0);
  return {
    ...rest,
    mutations: {
      count: landedCount,
      byTool: landedByTool,
      ...(rejected.length > 0 ? { rejectedCount: rejected.length, rejected } : {}),
      note: 'effect:write calls executed; per-call args omitted to keep the result bounded — re-run with dryRun:true to preview them',
    },
    // EI-7174: a script_timeout (or any other ok:false — a thrown error, a worker crash) does
    // NOT undo write-effect calls the script already dispatched before the failure — dispatch()
    // invokes the REAL tool immediately for every effect:write call, timeout or not. An agent
    // that only reads `error` and retries the whole script on a `ok:false` risks a double-write
    // (double-claim, double-post, …) for every mutation that already landed. Surface it at the
    // SAME top level as `error` — not just buried in `mutations.note` — so it can't be missed.
    //
    // EI-10951: but say something TRUE. This used to count every DISPATCHED write as
    // "already executed", including the one the dispatcher rejected on its args — so the
    // single most common failure (a typo'd argument) produced a false "1 write already
    // landed, do NOT re-run" and sent the agent to verify a write that never happened.
    // A safety warning that cries wolf on the common case gets ignored in the rare case it
    // is right. Now: `landed` = dispatched and did not throw; `rejected` = provably wrote
    // nothing (safe to re-run); `uncertain` = threw mid-flight and MAY have landed — the
    // only set that still earns the loud double-write warning.
    ...(!result.ok ? buildFailureWarning(plannedMutations, rejected, uncertain) : {}),
    // EI-7669: a write-effect call can dispatch fine (no throw) yet report its OWN semantic
    // rejection (ok: false in its result body — e.g. work_items:set_state's completion-integrity
    // check). Nothing in `result.ok` / `error` reflects this — the SCRIPT still ran to a normal
    // finish — so a batched script that doesn't inspect every individual result silently miscounts
    // a rejected write as executed. Surface it unconditionally (independent of result.ok) so it
    // can't be missed the way a bare `Promise.allSettled` count would miss it. Defensive `?? []`:
    // fixture results built by hand (tests predating this field) omit it — never let an older/
    // partial result object throw here instead of just showing no okFalse warning.
    ...(okFalseMutationsList.length > 0
      ? {
          // EI-7784: `partial: true` is ALSO on the result's top level (a structured signal a
          // caller can branch on programmatically) — this warning is the human-readable pointer
          // to it, not the only place it's surfaced.
          okFalseWarning:
            `${okFalseMutationsList.length} write-effect call(s) dispatched without throwing but reported ` +
            `ok:false in their own result (did NOT take effect): ` +
            `${okFalseMutationsList.map((m) => m.tool).join(', ')}. Check okFalseMutations for details — ` +
            'do not assume these succeeded just because the script did not throw. `partial: true` is set ' +
            'on this result for exactly this reason — check it, not just `ok`.',
          okFalseMutations: okFalseMutationsList,
        }
      : {}),
  };
}

/** Cap on how many "closest namespace" suggestions buildFacadeHelp surfaces (EI-7677). */
const FACADE_HELP_NAMESPACE_SUGGESTIONS = 3;

/**
 * P-007: turn a parse-check failure into a self-service fix. From the unknown `ns.verb` (or
 * `ns:verb`) refs the script used, render the typed `tools.ns.verb(args)` signatures for the
 * namespaces that DO exist in the caller's facade (fix a verb/arg typo), and — only when a referenced
 * namespace doesn't exist at all — surface the closest-matching known namespaces so the agent can
 * pick the right one. Same scoping/generators as code:tools, so the agent never needs to call
 * code:tools first.
 *
 * EI-7677: this used to spill the ENTIRE allowed namespace index (every ns × verb — observed
 * ~15k tokens for a superuser's full facade) whenever a script referenced even ONE unknown
 * namespace (a typo'd `tools.workItems` vs `tools.workitems`) — a single-line typo could blow a
 * session's context budget (one leader session hit 157%). Bounded now: rank every known
 * namespace by edit distance to the (first) unknown ref via the same `nearestByLevenshtein`
 * helper `fuzzyEnum` already uses for arg-value typos, and surface only the top
 * `FACADE_HELP_NAMESPACE_SUGGESTIONS` — with an explicit pointer to `code:tools {}` for the rare
 * case the agent genuinely needs to browse the full catalog.
 */
function buildFacadeHelp(
  unknownRefs: readonly string[],
  all: ReturnType<typeof listAllProjectedTools>,
  allowed: ReadonlySet<string>,
): { note: string; signatures?: string; namespaces?: ReturnType<typeof listFacadeNamespaces> } {
  const index = listFacadeNamespaces(all, allowed);
  const known = new Set(index.map((e) => e.ns));
  const byNs = new Map(index.map((e) => [e.ns, e]));

  const referencedNs = new Set<string>();
  for (const ref of unknownRefs) {
    const ci = ref.indexOf(':');
    const di = ref.indexOf('.');
    const sep = ci >= 0 ? ci : di; // tools.call('ns:verb') → colon; tools.ns.verb → dot
    referencedNs.add(sep > 0 ? ref.slice(0, sep) : ref);
  }

  const present = [...referencedNs].filter((ns) => known.has(ns));
  const missing = [...referencedNs].filter((ns) => !known.has(ns));
  const signatures = present.length
    ? generateToolFacadeTypes(all, { allowed, namespaces: present })
    : undefined;

  // Rank every known namespace by closeness to each missing ref; keep only the closest
  // FACADE_HELP_NAMESPACE_SUGGESTIONS overall (maxRatio:1 ⇒ always returns the top-k rather than
  // an empty set on a wildly-wrong name — a few "not quite it" suggestions still beat nothing).
  let namespaces: ReturnType<typeof listFacadeNamespaces> | undefined;
  if (missing.length && known.size) {
    const suggested = new Set<string>();
    for (const m of missing) {
      for (const s of nearestByLevenshtein(m, [...known], { k: FACADE_HELP_NAMESPACE_SUGGESTIONS, maxRatio: 1 })) {
        suggested.add(s);
      }
    }
    namespaces = [...suggested]
      .slice(0, FACADE_HELP_NAMESPACE_SUGGESTIONS)
      .map((ns) => byNs.get(ns)!)
      .sort((a, b) => a.ns.localeCompare(b.ns));
  }

  const note =
    'code:run accepts a script directly — no code:tools pre-call required. These refs were not in ' +
    'your allowed facade; fix the tools.ns.verb name/args and re-run. ' +
    (signatures ? 'Typed signatures for the namespaces you referenced are in `signatures`. ' : '') +
    (missing.length
      ? `Unknown namespace(s): ${missing.join(', ')} — the closest matches (with their verbs) are in ` +
        '`namespaces`; if none fit, call code:tools {} for the full catalog.'
      : '');

  return {
    note,
    ...(signatures ? { signatures } : {}),
    ...(namespaces ? { namespaces } : {}),
  };
}

/**
 * Resolve the capture deps (PG handle, embedder, hive resolver) + the acting
 * agent's identity from ctx, then upsert the recipe + run dedup. `getOrgPg` is
 * now a module-level import (WI-1411 needs it eagerly for `bindInnerDispatch`),
 * so only the embedder/hive-federation imports stay lazy; every step is
 * best-effort (captureRecipe itself try/catches).
 *
 * Returns the top similar PRIOR recipes (P-004 dedup) so the caller can surface
 * them SOFT in the code:run result. Returns [] on any wiring failure — capture +
 * dedup must NEVER break the run.
 */
async function maybeCaptureRecipe(
  args: { script: string; title?: string; description?: string },
  ctx: UnifiedToolContext,
  tools: ReturnType<typeof listAllProjectedTools>,
  allowed: ReadonlySet<string>,
): Promise<SimilarRecipe[]> {
  try {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) return []; // no workspace ⇒ nothing to scope a recipe to

    const { buildQueryEmbedder, interactiveEmbedAcquireBudgetMs } = await import('../search/embedder');
    const { potHomeSlugForHarness } = await import('../../hive-federation');
    const { resolveAgentIdentity } = await import('../coordination/identity');

    let ownerId: string | null = null;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      ownerId = null; // unattributable ctx (e.g. a test/in-process call) — still capture
    }

    const embedder = await buildQueryEmbedder({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() }).catch(() => null);

    const captured = await captureRecipe(
      {
        sql: getOrgPg().sql,
        embed: async (text) => (embedder ? embedder(text) : null),
        resolveHive: potHomeSlugForHarness,
        log: (msg) => ctx.log(msg),
      },
      {
        script: args.script,
        workspaceId,
        harness: ctx.harnessSlug ?? null,
        ownerId,
        role: ctx.role ?? null,
        title: args.title,
        description: args.description,
        tools,
        allowed,
      },
    );
    return captured?.similarRecipes ?? [];
  } catch (err) {
    ctx.log(`code:run recipe capture wiring failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
    return [];
  }
}
