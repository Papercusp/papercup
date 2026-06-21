import { z } from 'zod';
import {
  defineTool,
  listAllProjectedTools,
  runToolOrchestration,
  roleScopedToolNames,
  SU_ROLES,
} from '@papercusp/agent-mcp';
import { PROJECTED_DEPS } from '../../projected-tool-deps';

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
    'Run a multi-step tool-orchestration script (tools.ns.verb(args) + JS control flow) in one ' +
    'call; returns ONLY the script\'s returned summary. Collapses many tool round-trips into one. ' +
    'Use dryRun:true to preview write-effect mutations without executing them.',
  guidance: {
    when:
      'A task needs MANY tool calls with control flow — loop/branch/filter over results (e.g. ' +
      'list N items then act per item, fan-out reads, retry-until). Orchestrate them in ONE ' +
      'code:run and return a compact summary instead of paying a round-trip per call. Call ' +
      'code:tools first to fetch the exact typed tools.ns.verb(args) signatures for the ' +
      'namespaces you will use (fewer arg-shape errors).',
    notWhen:
      'A single tool call, or a step that needs YOUR judgment mid-flow (read a result, then ' +
      'decide) — call tools directly. Preview mutations with dryRun before a committing run.',
    chaining:
      'code:tools { namespaces } → write the script against the typed signatures → ' +
      'code:run { dryRun:true } → inspect plannedMutations → code:run { dryRun:false }',
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

    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});
