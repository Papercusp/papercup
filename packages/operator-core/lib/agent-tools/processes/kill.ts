/**
 * processes:kill — send SIGTERM (or SIGKILL) to one OR many host pids.
 *
 * Tier 1 sensitive — bearer-required, capability-gated. Agents that
 * pass URL spawn-context (no principal) cannot reach this; only callers
 * with a real bearer (dashboard via superuser token, future per-user
 * sessions) can invoke. Handler enforces a kind allowlist on top of the
 * capability gate.
 *
 * Audit log: every call writes a row to harness_shared.audit_log before
 * the signal is sent, so the action is recorded even if the kill
 * cascades through dependent processes.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `pid` for one or `pids`
 * for several → { ok, results:[{ ok, pid, kind, signal | error }], counts }.
 * Each result self-describes its pid (killProcess already returns the pid +
 * verdict), so a protected/absent pid fails ONLY itself. `signal` is
 * batch-level.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { killProcess } from '../../process-kill';
import { killScopeUnit, killTask } from '../../task-manager/control';
import { toList, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';

export default defineTool({
  name: 'processes:kill',
  profile: 'engineer',
  description:
    'Send SIGTERM (or SIGKILL) in ONE call, addressed three ways. PREFER `taskId`/`taskIds` (from `processes:list`): kills the whole cgroup SUBTREE, leaves no orphaned grandchildren, and cannot hit a recycled pid. An explicitly supplied `scopeUnit`/`scopeUnits` is only for a live unaccounted Papercusp scope surfaced by `processes:list { live:true }`; systemd resolves and the handler re-probes its cgroup before reporting success. `pid`/`pids` is the legacy path for the six tracked agent kinds and re-verifies kernel identity before signalling. Results are keyed by taskId/scopeUnit/pid; one failure never fails the rest.',
  guidance: {
    when: 'End a task you can name. `taskId` is the right handle for anything this operator launched through the task manager — it takes the whole subtree. `pid` remains for an AGENT process (`run.sh | omp | claude`) you only have a pid for.',
    notWhen:
      'NEVER pattern-match a name to build a kill list (`pkill -f <binary>` has twice killed the owner\'s live desktop window and peers\' test instances — both addressing modes here exist to make that impossible). For a runaway BUILD/TEST job started outside the chokepoint, `pid` returns `unsupported_kind` — start such jobs via `capability:bash { run_in_background: true }` so you hold a real handle. To PAUSE rather than end, use `processes:freeze`.',
    chaining:
      '`processes:list` -> `taskId` or `live.unaccountedGroups[].scopeUnit` -> here. Add `includeSubtree:true` to taskId mode to also signal logically-nested tasks that got their own scopes (an agent and everything it spawned).',
    returns:
      '{ ok, results:[...], counts } — keyed, not positional. taskId `ok:true` is VERIFIED — the scope was re-probed (a bounded retry window, deep-walking nested cgroups too) and found empty before we report success; a signal that was sent but did not actually clear the subtree (re-parented/D-state/unkillable descendant) comes back `ok:false, error:"incomplete"` with a survivor count, and the row is left LIVE (not closed) so a retry or a fresh `processes:list` can still find it — never trust a bare "signalled" as "dead". scopeUnit is accepted only for a validated `pc-*.scope` returned by the live reconciler; its cgroup must be systemd-resolved under `papercusp.slice`, positively non-empty before signalling, and verified empty afterward. Other taskId failures: `identity_mismatch` = the pid now belongs to something else, so we REFUSED (not a bug — the rail working); `not_live` = already ended or a residue row; `unsupported`/`command_failed`. pid failures: `pid_not_found` = genuinely absent; `unsupported_kind` = ALIVE but outside the six tracked kinds (never read this as "gone" — EI-18698120633403217 was exactly that false claim); `protected_kind` = tracked but off-limits.',
  },
  capability: 'processes:kill',
  args: z
    .object({
      pid: z.number().int().positive().optional().describe('a single host pid (n=1 shorthand for pids:[pid])'),
      pids: z.array(z.number().int().positive()).min(1).max(100).optional().describe('host pids to signal (1–100)'),
      taskId: z.string().max(64).optional().describe('a single task-ledger id (n=1 shorthand for taskIds)'),
      taskIds: z
        .array(z.string().max(64))
        .min(1)
        .max(100)
        .optional()
        .describe('task-ledger ids from processes:list — kills each whole cgroup subtree'),
      scopeUnit: z
        .string()
        .max(160)
        .optional()
        .describe('one live unaccounted Papercusp scope unit from processes:list { live:true }'),
      scopeUnits: z
        .array(z.string().max(160))
        .min(1)
        .max(100)
        .optional()
        .describe('live unaccounted Papercusp scope units from processes:list { live:true }'),
      includeSubtree: z
        .boolean()
        .optional()
        .describe('also signal logically-nested tasks that got their own scopes (taskId mode only)'),
      escalateAfterMs: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .describe('SIGTERM, then SIGKILL after this long IF the scope still holds processes (taskId mode only)'),
      signal: z.enum(['SIGTERM', 'SIGKILL']).optional().describe('the signal to send (batch-level; default SIGTERM)'),
      reapTerminalResidue: z
        .boolean()
        .optional()
        .describe(
          'WI-37521: reap a TERMINAL row (taskId mode only) whose cgroup scope is POSITIVELY re-verified, in this call, to still hold live process(es) — the "row closed, payload kept running" class. Without this the normal `not_live` refusal applies unchanged. Refused for an unconfined row or a scope that is actually empty (nothing to reap).',
        ),
    })
    .refine(
      (a) =>
        Boolean(a.pid) ||
        (a.pids?.length ?? 0) > 0 ||
        Boolean(a.taskId) ||
        (a.taskIds?.length ?? 0) > 0 ||
        Boolean(a.scopeUnit) ||
        (a.scopeUnits?.length ?? 0) > 0,
      { message: 'pass `taskId`/`taskIds`, `scopeUnit`/`scopeUnits`, or `pid`/`pids`' },
    ),
  async handler(args, ctx) {
    // Task-addressed kills go through the cgroup: whole subtree, no recycled-pid
    // hazard. Pid-addressed kills keep the legacy tracked-kind path.
    const taskIds = [...new Set([...toList<string>(args.taskId), ...toList<string>(args.taskIds)])];
    const taskEnv = taskIds.length
      ? await runBulk(
          taskIds,
          async (taskId) =>
            killTask(taskId, {
              signal: args.signal,
              includeSubtree: args.includeSubtree,
              escalateAfterMs: args.escalateAfterMs,
              reapTerminalResidue: args.reapTerminalResidue,
            }),
          { keyOf: (taskId) => ({ taskId }) },
        )
      : null;

    const scopeUnits = [...new Set([...toList<string>(args.scopeUnit), ...toList<string>(args.scopeUnits)])];
    const scopeEnv = scopeUnits.length
      ? await runBulk(
          scopeUnits,
          async (scopeUnit) =>
            killScopeUnit(scopeUnit, {
              signal: args.signal,
              escalateAfterMs: args.escalateAfterMs,
            }),
          { keyOf: (scopeUnit) => ({ scopeUnit }) },
        )
      : null;

    const pids = [...new Set([...toList<number>(args.pid), ...toList<number>(args.pids)])];
    const pidEnv = pids.length
      ? await runBulk(
          pids,
          async (pid) => {
            const result = await killProcess({
              pid,
              signal: args.signal,
              actorSlug: ctx.principal.slug,
              workspaceId: ctx.principal.workspaceId,
            });
            // killProcess returns { ok, pid, kind, signal | error, detail? } — already
            // self-keyed by pid; surface it verbatim so a per-item failure rides through.
            return { ...result, ok: result.ok, pid: result.pid ?? pid };
          },
          { keyOf: (pid) => ({ pid }) },
        )
      : null;

    if (taskEnv && !pidEnv && !scopeEnv) return bulkContent(taskEnv);
    if (pidEnv && !taskEnv && !scopeEnv) return bulkContent(pidEnv);
    if (scopeEnv && !taskEnv && !pidEnv) return bulkContent(scopeEnv);
    // Multiple addressing modes in one call: merge the keyed result lists rather than picking one,
    // so a mixed batch reports every item instead of silently dropping half.
    const envs = [taskEnv, pidEnv, scopeEnv].filter(Boolean) as Array<NonNullable<typeof taskEnv>>;
    const base = envs[0]!;
    return bulkContent({
      ...base,
      results: envs.flatMap((env) => env.results ?? []),
      counts: {
        ok: envs.reduce((n, env) => n + (env.counts?.ok ?? 0), 0),
        failed: envs.reduce((n, env) => n + (env.counts?.failed ?? 0), 0),
      },
    } as typeof taskEnv);
  },
});
