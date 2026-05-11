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
import { generated, schemaOf } from '@restart/db-org';
import { defineTool } from '../../define-tool';

const goals = generated.goalsInHarness_shared;
const GoalSelect = schemaOf(goals).select;
type GoalRow = z.infer<typeof GoalSelect>;

export default defineTool({
  name: 'goals:list',
  capability: 'goals:read',
  guidance: {
    when: 'User asks "what are we trying to do?", "what are my goals?", or you need a goal id before calling `goals:get`.',
    notWhen: 'For TASKS (concrete TODOs), use `tasks:list`. Goals are the higher-level intent; tasks are how you get there.',
    chaining: 'Pair with `goals:get` for the full body.',
  },
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    limit: z.number().int().positive().max(200).default(50),
  }),
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
      })
      .from(goals)
      .orderBy(desc(goals.createdAt))
      .limit(args.limit)) as Pick<GoalRow, 'id' | 'title' | 'body' | 'parent_id' | 'budget_cents' | 'created_at'>[];
    if (args.detail === 'summary') {
      return { data: rows.map((r) => ({ id: r.id, title: r.title })) };
    }
    return { data: rows };
  },
});
