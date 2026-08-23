/**
 * processes:list — the PROVENANCE inventory of running tasks
 * (task-manager-no-escape-2026-07-27, P-013).
 *
 * Deliberately not a `ps` replacement, and deliberately not a widening of
 * `dev:processes` (which stays frozen at its six agent kinds — plan D-002 explains
 * why that decision is untouched). `ps` and `dev:processes` both answer a
 * KERNEL-shaped question: what processes exist. This answers the one neither can —
 * who launched it, for which work-item and plan, under what budget and deadline,
 * where its log is, and what it is costing right now. That is a join over
 * `harness_shared.task_ledger`, not a process-table read.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listTasks } from '../../task-manager/store';
import { isTaskManagerEnabled } from '../../task-manager/enabled';
import { reconcileTick } from '../../task-manager/reconcile-tick';
import { defaultForeignSignature } from '../../task-manager/scan';
import { REPO_ROOT } from '../docs/_repo-paths';
import { TASK_STATES } from '../../task-manager/types';
import { redactSensitiveText } from '../../sensitive-text';

function mb(bytes: number | null | undefined): number | null {
  return bytes == null ? null : Math.round(bytes / 1048576);
}

function ageSec(startedAt: string): number {
  const t = Date.parse(startedAt);
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : 0;
}

function safeDiagnosticText(text: string, maxChars?: number): string {
  const redacted = redactSensitiveText(text);
  return maxChars === undefined ? redacted : redacted.slice(0, maxChars);
}

const taskResultSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean().optional(),
  reason: z.string().optional(),
  counts: z.object({
    total: z.number().int().nonnegative(),
    byState: z.record(z.string(), z.number().int().nonnegative()),
    byClass: z.record(z.string(), z.number().int().nonnegative()),
  }),
  // `live` is the reconciler's deliberately extensible diagnostic summary. Keep
  // it lossless for structured callers rather than duplicating its evolving
  // shape here; the human-facing text remains the same JSON envelope.
  live: z.record(z.string(), z.unknown()).optional(),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      class: z.string(),
      title: z.string(),
      state: z.string(),
      launchedBy: z.string(),
      workItemId: z.string().nullable().optional(),
      planSlug: z.string().nullable().optional(),
      parentTaskId: z.string().nullable().optional(),
      rootTaskId: z.string(),
      ageSec: z.number().int().nonnegative(),
      rssMb: z.number().int().nonnegative().nullable(),
      peakRssMb: z.number().int().nonnegative().nullable(),
      cpuSec: z.number().int().nonnegative().nullable(),
      pids: z.number().int().nonnegative().nullable(),
      confined: z.boolean(),
      scopeUnit: z.string().nullable().optional(),
      memoryMaxMb: z.number().int().nonnegative().nullable(),
      deadlineAt: z.string().nullable().optional(),
      exitCode: z.number().int().nullable().optional(),
      exitReason: z.string().nullable().optional(),
      logPath: z.string().nullable().optional(),
    }),
  ),
});

export default defineTool({
  name: 'processes:list',
  profile: 'engineer',
  // @not-a-cell live state, but a SINGLE DOOR: `listTasks()` (task-manager/store.ts) is the one
  // derivation of the ledger join, and the only other surface over it — the /admin/tasks route —
  // already CONSUMES that same function rather than re-deriving it, which is axis 5 satisfied
  // without a registry entry. Nothing answers this question twice: `ps` and `dev:processes` answer
  // the KERNEL-shaped question (what exists), frozen at six agent kinds by task-manager D-002, and
  // `scheduler:running` answers bee-run liveness. Registering a cell here would add a door without
  // removing one — the D-010 failure this gate exists to prevent (see WI-6464 and the exemption's
  // reason-class (ii)). Revisit the moment a SECOND surface derives the inventory independently.
  description:
    'Ledger-backed inventory of tasks this operator launched, with PROVENANCE `ps` cannot give: who launched each one, its work-item/plan, budget + deadline, log path, live RSS/CPU/pid-count, and whether it is cgroup-confined. Also surfaces `unaccounted` rows — processes inside our slice that no chokepoint registered — and verifier-owned systemd scopes in `live.verifierGroups`. Pass `live:true` to reconcile against the kernel first (slower, authoritative).',
  capability: 'intel:read',
  guidance: {
    when: 'You want to know WHAT IS RUNNING AND WHY — which agent started a job, what a work-item is costing, which task is eating memory, or whether anything bypassed the spawn chokepoint. Also the honest answer to "is my background job still alive" for anything started through managedSpawn.',
    notWhen:
      'NOT a `ps` substitute — a process nothing in this operator launched is invisible unless it landed in our cgroup slice. For the six tracked AGENT process kinds use `dev:processes`; for a raw host process list, plain `ps`/`pgrep` is correct and is never gated. For a capability:bash job\'s OUTPUT use `capability:bash_output`.',
    chaining:
      'Read `taskId`, then act with `processes:kill { taskId }` (kills the whole cgroup subtree). For an unaccounted live group, read its `scopeUnit` from `live.unaccountedGroups` and pass `processes:kill { scopeUnit }`; `processes:freeze` pauses a ledger task without losing work, and `processes:limit` retunes its budget live.',
    returns:
      '{ ok, counts:{ byState, byClass }, tasks:[{ taskId, class, title, state, launchedBy, workItemId, planSlug, ageSec, rssMb, peakRssMb, cpuSec, pids, confined, scopeUnit, deadlineAt, logPath }], live? } — unfiltered `live:true` reads include `live.verifierGroups` and other reconciler groups; a task-filtered live read keeps the compact reconciliation summary but omits unrelated global group samples. `confined:false` means the task is ledgered but NOT cgroup-isolated, so a kill falls back to a pid signal and freeze is unavailable.',
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    state: z.enum(TASK_STATES).optional().describe('filter by one lifecycle state (shorthand for `states: [state]`)'),
    states: z.array(z.enum(TASK_STATES)).optional().describe('filter by one or more lifecycle states'),
    classes: z.array(z.string().min(1)).max(20).optional().describe('filter by task class'),
    launchedBy: z.string().max(120).optional().describe('only tasks this agent id launched'),
    workItemId: z.string().max(120).optional().describe('only tasks attributed to this work-item'),
    rootTaskId: z.string().max(64).optional().describe('one task tree'),
    includeEnded: z.boolean().optional().describe('include finished tasks (the "what ran overnight" read)'),
    live: z
      .boolean()
      .optional()
      .describe('reconcile against the kernel before answering — authoritative, ~100ms slower, writes nothing'),
    limit: z.number().int().positive().max(2000).optional(),
  }),
  // Keep the lossless object available as MCP structuredContent for programmatic
  // callers (ptool / MCP clients that request `_meta.structured`). The text body
  // still goes through the ordinary result door for model-facing calls, but a
  // door-truncated JSON string is not a valid machine-readable response.
  result: taskResultSchema,
  async handler(args) {
    // WI-6499: with the task manager flag-OFF nothing enrols, so the ledger is
    // frozen at whatever it last held. Serving those rows would be worse than
    // serving none — they read as "what is running" while describing processes
    // that exited long ago. Say the subsystem is off instead.
    if (!(await isTaskManagerEnabled('processes:list'))) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                ok: true,
                enabled: false,
                reason:
                  'The task manager is disabled (papercusp-task-manager is off), so no spawns are being ledgered and the reconciler is not running. Use `ps`/`pgrep` for a raw host process list, or `dev:processes` for the tracked agent kinds.',
                counts: { total: 0, byState: {}, byClass: {} },
                tasks: [],
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const hasTaskSelector =
      args.state !== undefined ||
      (args.states?.length ?? 0) > 0 ||
      (args.classes?.length ?? 0) > 0 ||
      args.launchedBy !== undefined ||
      args.workItemId !== undefined ||
      args.rootTaskId !== undefined;

    let live: unknown;
    if (args.live) {
      const tick = await reconcileTick({
        dryRun: true,
        scanOptions: { foreignSignature: defaultForeignSignature(REPO_ROOT) },
      });
      const liveSummary = {
        ...tick.summary,
        degraded: tick.degraded,
        degradedReason: tick.degradedReason,
      };
      // EI-20974969153018746: a task selector answers a narrow ledger question.
      // Keep reconciliation health visible, but do not spend the result budget on
      // unrelated host-wide process samples. Call without a selector to request
      // the full live group inventory used by the kill/chaining workflow.
      live = hasTaskSelector
        ? {
            ...liveSummary,
            diagnosticsOmitted: 'global process groups omitted because a task selector is active',
          }
        : {
            ...liveSummary,
            scannedProcesses: tick.scan.processes,
            foreignTruncated: tick.scan.foreignTruncated,
            unaccountedGroups: tick.result.unaccounted.map((g) => ({
              cgroupPath: g.cgroupPath,
              scopeUnit: g.scopeUnit,
              pids: g.pids,
              sample: safeDiagnosticText(g.sampleCmdline, 160),
            })),
            foreignGroups: tick.result.foreign.map((g) => ({
              cgroupPath: g.cgroupPath,
              pids: g.pids,
              sample: safeDiagnosticText(g.sampleCmdline, 160),
            })),
            verifierGroups: tick.result.verifierScope.map((g) => ({
              cgroupPath: g.cgroupPath,
              scopeUnit: g.scopeUnit,
              pids: g.pids,
              sample: safeDiagnosticText(g.sampleCmdline, 160),
            })),
          };
    }

    const rows = await listTasks({
      states: args.states ?? (args.state == null ? undefined : [args.state]),
      classes: args.classes,
      launchedBy: args.launchedBy,
      workItemId: args.workItemId,
      rootTaskId: args.rootTaskId,
      includeEnded: args.includeEnded,
      limit: args.limit,
    });

    const byState: Record<string, number> = {};
    const byClass: Record<string, number> = {};
    for (const r of rows) {
      byState[r.state] = (byState[r.state] ?? 0) + 1;
      byClass[r.class] = (byClass[r.class] ?? 0) + 1;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ok: true,
              counts: { total: rows.length, byState, byClass },
              ...(live ? { live } : {}),
              tasks: rows.map((r) => ({
                taskId: r.taskId,
                class: r.class,
                title: safeDiagnosticText(r.title),
                state: r.state,
                launchedBy: r.launchedBy,
                workItemId: r.workItemId,
                planSlug: r.planSlug,
                parentTaskId: r.parentTaskId,
                rootTaskId: r.rootTaskId,
                ageSec: ageSec(r.startedAt),
                rssMb: mb(r.lastMemoryBytes),
                peakRssMb: mb(r.peakMemoryBytes),
                cpuSec: r.cpuUsec == null ? null : Math.round(r.cpuUsec / 1_000_000),
                pids: r.pidsCurrent,
                confined: r.confined,
                scopeUnit: r.scopeUnit,
                memoryMaxMb: mb(r.memoryMaxBytes),
                deadlineAt: r.deadlineAt,
                exitCode: r.exitCode,
                exitReason: r.exitReason == null ? r.exitReason : safeDiagnosticText(r.exitReason),
                logPath: r.logPath == null ? r.logPath : safeDiagnosticText(r.logPath),
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
