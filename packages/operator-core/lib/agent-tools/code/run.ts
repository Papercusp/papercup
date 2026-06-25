import { z } from 'zod';
import {
  defineTool,
  listAllProjectedTools,
  runToolOrchestration,
  roleScopedToolNames,
  generateToolFacadeTypes,
  listFacadeNamespaces,
  SU_ROLES,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { PROJECTED_DEPS } from '../../projected-tool-deps';
import { captureRecipe } from './capture-recipe';
import type { SimilarRecipe } from '../../code-recipes-search';

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
    'one re-reads your whole context) into one. WRITE THE SCRIPT DIRECTLY: no discovery pre-call ' +
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
  },
  // Role-gated tools gate on agentRoles (not capability); capability sets tier + write-effect.
  // code:run is as powerful as the shell capability — it can call any of the agent's write tools.
  capability: 'capability:bash',
  requirePrincipal: false,
  // SU_ROLES + `bee` (code-execution-tool-orchestration B-CX-3): the spawned-bee base already
  // carries the CODE_RUN_NUDGE, and the generic hive `bee` is the dominant fleet worker doing the
  // high-volume multi-tool work this collapses — yet it was the one role excluded here, so the nudge
  // was inert for it. The grant is privilege-PRESERVING (the facade is role-scoped — a bee's script
  // can only call tools the bee may already call) and capability-safe (bees hold capability:bash
  // since the 2026-06-14 confinement lift; a hive that re-confines its bees via a blueprint
  // allow-list still denies bash → code:run at the envelope). Same `[...SU_ROLES, 'bee']` shape the
  // plans:* write tools use.
  agentRoles: [...SU_ROLES, 'bee'],
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
    if (result.ok && !(args.dryRun ?? false)) {
      similarRecipes = await maybeCaptureRecipe(args, ctx, all, allowed);
    }

    // P-007 (agent-tooling-token-efficiency): cut the discovery ritual. The old flow demanded a
    // code:tools {} → code:tools { namespaces } pre-call before you could safely author a script.
    // Instead, on a parse-check failure (the script referenced a tool not in your facade — a typo'd
    // verb or wrong namespace) hand back the typed signatures for the namespaces it touched IN THIS
    // SAME RESULT, so you fix the name + re-run rather than paying a separate code:tools round-trip.
    // dryRun safety is untouched: write-effect mutations still require the dryRun preview as before.
    const facadeHelp =
      !result.ok && result.unknownRefs?.length
        ? buildFacadeHelp(result.unknownRefs, all, allowed)
        : undefined;

    const payload =
      similarRecipes.length > 0 || facadeHelp
        ? {
            ...result,
            ...(similarRecipes.length > 0 ? { similarRecipes } : {}),
            ...(facadeHelp ? { facadeHelp } : {}),
          }
        : result;
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});

/**
 * P-007: turn a parse-check failure into a self-service fix. From the unknown `ns.verb` (or
 * `ns:verb`) refs the script used, render the typed `tools.ns.verb(args)` signatures for the
 * namespaces that DO exist in the caller's facade (fix a verb/arg typo), and — only when a referenced
 * namespace doesn't exist at all — also return the cheap namespace index so the agent can pick the
 * right one. Same scoping/generators as code:tools, so the agent never needs to call code:tools first.
 */
function buildFacadeHelp(
  unknownRefs: readonly string[],
  all: ReturnType<typeof listAllProjectedTools>,
  allowed: ReadonlySet<string>,
): { note: string; signatures?: string; namespaces?: ReturnType<typeof listFacadeNamespaces> } {
  const index = listFacadeNamespaces(all, allowed);
  const known = new Set(index.map((e) => e.ns));

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

  const note =
    'code:run accepts a script directly — no code:tools pre-call required. These refs were not in ' +
    'your allowed facade; fix the tools.ns.verb name/args and re-run. ' +
    (signatures ? 'Typed signatures for the namespaces you referenced are in `signatures`. ' : '') +
    (missing.length
      ? `Unknown namespace(s): ${missing.join(', ')} — pick the right one from \`namespaces\`.`
      : '');

  return {
    note,
    ...(signatures ? { signatures } : {}),
    // Only spill the full namespace index when a referenced namespace doesn't exist (so the agent can
    // find the right one); otherwise the verb list already in `signatures` is enough.
    ...(missing.length ? { namespaces: index } : {}),
  };
}

/**
 * Resolve the capture deps (PG handle, embedder, hive resolver) + the acting
 * agent's identity from ctx, then upsert the recipe + run dedup. Lazy imports
 * keep projected-tool-deps' early load free of db-org / embedder / hive-federation
 * cycles, and every step is best-effort (captureRecipe itself try/catches).
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

    const { getOrgPg } = await import('@papercusp/db-org');
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
