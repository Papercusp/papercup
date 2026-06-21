/**
 * work_items:create_batch — BULK create (work-queue-completeness Phase B,
 * unified-work-item-ledger). Create up to 100 work-items in one round-trip, each
 * through the SAME per-item core as `work_items:create` (`createOneWorkItem`): the
 * EI-316 mirror-guard, EI-728 workspace resolution, the D-019/D-020 hive-scope gate,
 * and the B-LOOP-4 atomic create+claim all apply per item, identically to the
 * single-item tool.
 *
 * NEVER throws on a single item — a per-item failure (mirror duplicate, hive_required,
 * a createWorkItem rejection) is collected as `{ ok: false, error, title }` and the
 * loop continues; one bad item never poisons the batch. Returns
 * `{ ok: true, created: [...], counts: { ok, failed } }`.
 *
 * Per-item assignee precedence: `item.assign_to` ?? (assign_all_to_self ? you : undefined).
 * `harness` is a batch-level DEFAULT applied to items that omit their own.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { WORK_ITEM_KINDS } from '../../work-items';
import { hiveArg } from '../_hive-scope';
import { createOneWorkItem } from './_create-core';

/** One per-item create spec — the same shape `work_items:create` accepts (per item). */
const itemSpec = z.object({
  kind: z.enum([...WORK_ITEM_KINDS] as [string, ...string[]]),
  title: z.string().min(1).max(200),
  summary: z.string().max(8000).optional().describe('body / summary text'),
  harness: z.string().max(80).optional().describe('harness slug — required for feature/research-task/chunk; sets scope for bug/change. Falls back to the batch `harness` default.'),
  hive: hiveArg,
  severity: z.enum(['critical', 'major', 'minor', 'nit']).optional().describe('issue-family (bug/change) only'),
  parent: z.string().max(80).optional().describe('parent work-item id (feature-family; required-shape for a chunk)'),
  topics: z.array(z.string().min(1)).max(8).optional().describe('topic slugs to tag (topics:list)'),
  payload: z.record(z.string(), z.unknown()).optional().describe('kind-specific data (feature-family)'),
  assign_to: z
    .string()
    .max(120)
    .optional()
    .describe('Atomically CLAIM this item for this agent id in the SAME create (B-LOOP-4). Overrides assign_all_to_self for this item.'),
});

export default defineTool({
  name: 'work_items:create_batch',
  profile: 'engineer',
  description:
    'BULK-create up to 100 work-items in one call — each item goes through the same path as work_items:create (mirror-guard, workspace resolution, hive-scope gate, atomic create+claim). One bad item never fails the batch: every item returns { ok, id?, error?, title }. Use `harness` as a default for items that omit one, and `assign_all_to_self` to claim every item for yourself (per-item `assign_to` overrides it). Dedup with work_items:list/search first.',
  guidance: {
    when: 'You want to file several work-items at once (e.g. fan a plan out into many chunks, or seed a backlog) without a round-trip per item.',
    notWhen: 'A single item → work_items:create. Mutating existing items in bulk → work_items:batch.',
    chaining: 'work_items:list (dedup) → work_items:create_batch → work_items:claim_next (count) to pick them up.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    items: z.array(itemSpec).min(1).max(100).describe('The work-items to create (1–100).'),
    assign_all_to_self: z
      .boolean()
      .optional()
      .describe('Claim every created item for YOU (your ownerId) at creation — unless the item carries its own assign_to.'),
    harness: z.string().max(80).optional().describe('Default harness for items that omit `harness` (per-item harness wins).'),
    workspace: z.string().max(120).optional().describe('Target workspace id for all items — defaults to the request workspace (MCP ?workspace=). Same EI-728 routing as work_items:create.'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const createCtx = {
      ownerId: ident.ownerId,
      workspaceId: ctx.workspaceId,
      harnessSlug: ctx.harnessSlug,
    };
    const created: { ok: boolean; id?: string; error?: string; title: string }[] = [];
    let okCount = 0;
    let failed = 0;
    for (const item of args.items) {
      // Per-item assignee: the item's own assign_to, else self when assign_all_to_self,
      // else undefined (lands unclaimed). Batch-level `harness`/`workspace` are defaults
      // the per-item value overrides.
      const assignTo = item.assign_to ?? (args.assign_all_to_self ? ident.ownerId : undefined);
      const res = await createOneWorkItem(
        {
          ...item,
          harness: item.harness ?? args.harness,
          workspace: args.workspace,
          assign_to: assignTo,
        },
        createCtx,
      );
      if (res.ok) {
        okCount += 1;
        created.push({ ok: true, id: res.workItem.id, title: item.title });
      } else {
        failed += 1;
        created.push({ ok: false, error: res.error, title: item.title });
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, created, counts: { ok: okCount, failed } }),
        },
      ],
    };
  },
});
