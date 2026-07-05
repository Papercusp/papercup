import { z } from 'zod';
import { withWorkspace, getOrgPg } from '@papercusp/db-org';
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
 * This collapses many tool round-trips (each its own inference call re-reading your whole context)
 * into ONE `code:run` call.
 *
 * SAFETY: the sandbox exposes only tools your role may call (the whitelist IS the boundary). Set
 * `dryRun: true` to PREVIEW mutations — `effect:'write'` tool calls are recorded (returned in
 * `plannedMutations`) but NOT executed; reads still run. Re-run without `dryRun` to commit.
 */
export default defineTool({
  name: 'code:run',
  description:
    'Run a multi-step tool-orchestration script (tools.ns.verb(args) + JS control flow) in ONE ' +
    'call and get back ONLY the script\'s returned summary — collapsing N tool round-trips (each ' +
    're-reads your whole context) into one. WRITE THE SCRIPT DIRECTLY: no discovery pre-call ' +
    'is required — if you reference a tool name wrong, the result hands you the exact typed ' +
    'signatures inline to fix. Use dryRun:true to preview write-effect mutations before committing.',
  guidance: {
    when:
      'A task needs MANY tool calls with control flow — loop/branch/filter over results (list N ' +
      'items then act per item, fan-out reads, retry-until). Orchestrate them in ONE code:run and ' +
      'return a compact summary instead of paying a round-trip per call. Just write the script ' +
      'against tools.ns.verb(args) — you do NOT need a code:tools pre-call: a wrong name comes back ' +
      'with the typed signatures inline to fix (code:tools is there only if you want to pre-check ' +
      'shapes). Pass title+description so the run is saved as a reusable RECIPE other agents in your ' +
      'hive can find + reuse (every successful run is captured; the title+description make it ' +
      'discoverable instead of an auto-derived label).',
    notWhen:
      'A single tool call, or a step that needs YOUR judgment mid-flow (read a result, then ' +
      'decide) — call tools directly. Preview mutations with dryRun before a committing run.',
    chaining:
      'write the script → code:run { dryRun:true } → inspect plannedMutations → code:run. ' +
      '(Optional pre-check: code:tools { namespaces } for typed signatures — NOT required, a bad ' +
      'name returns them inline.)',
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
      .describe('JS/TS body. Call tools via `await tools.ns.verb(args)`; `return` a compact summary.'),
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
    timeoutSec: z.number().int().min(1).max(120).optional().describe('Wall-clock budget (default 30s).'),
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
      timeoutMs: args.timeoutSec ? args.timeoutSec * 1000 : undefined,
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
    const shownResult = shapeMutationEcho(result);

    const payload =
      similarRecipes.length > 0 || facadeHelp
        ? {
            ...shownResult,
            ...(similarRecipes.length > 0 ? { similarRecipes } : {}),
            ...(facadeHelp ? { facadeHelp } : {}),
          }
        : shownResult;
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

  const { plannedMutations, okFalseMutations, ...rest } = result;
  // Defensive: fixture results built by hand (tests predating this field) omit it entirely.
  const okFalseMutationsList = okFalseMutations ?? [];
  const byTool: Record<string, number> = {};
  for (const m of plannedMutations) byTool[m.tool] = (byTool[m.tool] ?? 0) + 1;
  return {
    ...rest,
    mutations: {
      count: plannedMutations.length,
      byTool,
      note: 'effect:write calls executed; per-call args omitted to keep the result bounded — re-run with dryRun:true to preview them',
    },
    // EI-7174: a script_timeout (or any other ok:false — a thrown error, a worker crash) does
    // NOT undo write-effect calls the script already dispatched before the failure — dispatch()
    // invokes the REAL tool immediately for every effect:write call, timeout or not. An agent
    // that only reads `error` and retries the whole script on a `ok:false` risks a double-write
    // (double-claim, double-post, …) for every mutation that already landed. Surface it at the
    // SAME top level as `error` — not just buried in `mutations.note` — so it can't be missed.
    ...(!result.ok
      ? {
          warning:
            `${plannedMutations.length} write-effect call(s) already executed before this failure ` +
            `(${Object.entries(byTool).map(([t, n]) => `${t}×${n}`).join(', ')}) — do NOT blindly ` +
            're-run the whole script; check what actually landed before retrying, to avoid a double-write.',
        }
      : {}),
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

    const { buildQueryEmbedder } = await import('../search/embedder');
    const { hiveHomeSlugForHarness } = await import('../../hive-federation');
    const { resolveAgentIdentity } = await import('../coordination/identity');

    let ownerId: string | null = null;
    try {
      ownerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      ownerId = null; // unattributable ctx (e.g. a test/in-process call) — still capture
    }

    const embedder = await buildQueryEmbedder().catch(() => null);

    const captured = await captureRecipe(
      {
        sql: getOrgPg().sql,
        embed: async (text) => (embedder ? embedder(text) : null),
        resolveHive: hiveHomeSlugForHarness,
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
