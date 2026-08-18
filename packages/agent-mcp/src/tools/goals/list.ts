/**
 * List goals in the current workspace.
 *
 * Demonstrates the drizzle-zod pattern for MCP tools: response rows are
 * typed via `schemaOf(table).select` so the data sent back to the agent
 * matches the column shape declared in the migration — no hand-typed
 * `Record<string, unknown>`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';
import {
  blockerStatusKey,
  goalReadiness,
  readGoalBlockedByEdges,
  resolveBlockerStatuses,
  type GoalBlockerEndpoint,
} from './goal-deps';

const goals = generated.goalsInHarnessShared;
const GoalSelect = schemaOf(goals).select;
type GoalRow = z.infer<typeof GoalSelect>;

export default defineTool({
  name: 'goals:list',
  capability: 'goals:read',
  guidance: {
    when: 'User asks "what are we trying to do?", "what are my goals?", "which goals are doable right now?" (read `actionable`), or you need a goal id before calling `goals:get`.',
    notWhen: 'For TASKS (concrete TODOs), use `tasks:list`. Goals are the higher-level intent; tasks are how you get there.',
    chaining: 'Pair with `goals:get` for the full body + per-blocker verdicts.',
  },
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    limit: z.number().int().positive().max(200).default(50),
  }),
  // Output schema (token-efficient-tool-result-formats P-013) — flat scalar
  // array (default `summary` shape) → unlocks CSV + outputSchema advertisement.
  // actionable / premiseInvalidated: goal-dag-shared-substrate-2026-08-18 P-003
  // — derived on read from the shared dependency substrate (D-006).
  result: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      actionable: z.boolean(),
      premiseInvalidated: z.boolean(),
    }),
  ),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const rows = (await txDb
      .select({
        id: goals.id,
        title: goals.title,
        body: goals.body,
        parent_id: goals.parentId,
        budget_cents: goals.budgetCents,
        created_at: goals.createdAt,
        workspace_id: goals.workspaceId,
        status: goals.status,
      })
      .from(goals)
      .orderBy(desc(goals.createdAt))
      .limit(args.limit));

    // Readiness fold (P-003, D-002/D-003): one edge read + one batched status
    // resolve per workspace present in the page (normally exactly one). Derived
    // on read — goal cardinality is tiny (D-006).
    const readinessById = new Map<
      string,
      { actionable: boolean; premiseInvalidated: boolean }
    >();
    for (const ws of new Set(rows.map((r) => r.workspace_id))) {
      const wsRows = rows.filter((r) => r.workspace_id === ws);
      const edges = await readGoalBlockedByEdges(ctx.tx, ws);
      const union: GoalBlockerEndpoint[] = [];
      const seen = new Set<string>();
      for (const r of wsRows) {
        for (const b of edges.get(r.id) ?? []) {
          const key = blockerStatusKey(b);
          if (seen.has(key)) continue;
          seen.add(key);
          union.push(b);
        }
      }
      const statuses =
        union.length > 0
          ? await resolveBlockerStatuses(ctx.tx, ws, union)
          : new Map<string, string>();
      for (const r of wsRows) {
        const view = (edges.get(r.id) ?? []).map((b) => ({
          ...b,
          status: statuses.get(blockerStatusKey(b)) ?? null,
        }));
        const folded = goalReadiness(view);
        readinessById.set(r.id, {
          actionable: folded.actionable,
          premiseInvalidated: folded.premiseInvalidated,
        });
      }
    }
    const readinessOf = (id: string) =>
      readinessById.get(id) ?? { actionable: true, premiseInvalidated: false };

    if (args.detail === 'summary') {
      return {
        data: rows.map((r) => ({ id: r.id, title: r.title, ...readinessOf(r.id) })),
      };
    }
    return { data: rows.map((r) => ({ ...r, ...readinessOf(r.id) })) };
  },
});
