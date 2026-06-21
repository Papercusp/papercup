/**
 * work_items:batch — BULK MUTATION dispatcher (work-queue-completeness Phase B,
 * unified-work-item-ledger). Apply ONE mutation `op` to up to 200 items in a single
 * round-trip. The op is fixed for the whole call; each item carries its `id` plus the
 * op-specific fields. Every item is collected independently — a single-item failure
 * NEVER throws and never poisons the rest of the batch.
 *
 * Supported ops (each maps cleanly to an existing work-items.ts engine fn — the same
 * one the single-op tool calls):
 *   - claim        → claimWorkItem(id, assignee?)        item: { id, assignee? }
 *   - release      → releaseWorkItem(id)                 item: { id }
 *   - set_state    → setWorkItemState(id, state)         item: { id, state }
 *   - set_priority → setWorkItemPriority(id, priority)   item: { id, priority }
 *                    OR bumpWorkItemPriority(id, pos)     item: { id, position:'top'|'bottom' }
 *   - tag          → tagWorkItem / untagWorkItem(id, t)  item: { id, topic, remove? }
 *   - subscribe    → subscribeWorkItem(you, id, mode)    item: { id, mode? }
 *
 * Returns `{ ok: true, op, results: [...], counts: { ok, failed } }` — each result is
 * `{ ok, id, error? }` (plus the op's natural payload, e.g. workItem / priority).
 *
 * NOTE — bulk CREATE is a separate tool (work_items:create_batch): create needs the
 * mirror-guard + hive-scope gate, not the id-keyed mutation shape here.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  claimWorkItem,
  releaseWorkItem,
  setWorkItemState,
  setWorkItemPriority,
  bumpWorkItemPriority,
  tagWorkItem,
  untagWorkItem,
  subscribeWorkItem,
} from '../../work-items';

const BATCH_OPS = ['claim', 'release', 'set_state', 'set_priority', 'tag', 'subscribe'] as const;
type BatchOp = (typeof BATCH_OPS)[number];

/** A single batch item — `id` is always required; the rest are op-specific (validated per-op). */
const itemSchema = z.object({
  id: z.string().min(1),
  // claim
  assignee: z.string().max(120).optional().describe('claim: target assignee (default: you)'),
  // set_state
  state: z.string().min(1).max(40).optional().describe('set_state: the lifecycle state'),
  // set_priority
  priority: z.number().int().nullable().optional().describe('set_priority: explicit feature_order (null clears)'),
  position: z.enum(['top', 'bottom']).optional().describe("set_priority: bump to 'top'/'bottom' of the backlog"),
  // tag
  topic: z.string().min(1).max(80).optional().describe('tag: the topic slug'),
  remove: z.boolean().optional().describe('tag: untag instead of tag'),
  // subscribe
  mode: z.enum(['full', 'digest', 'mention']).optional().describe('subscribe: delivery mode (default full)'),
  // per-item harness override (else the batch-level harness)
  harness: z.string().max(80).optional(),
});

type BatchItem = z.infer<typeof itemSchema>;

interface ItemResult {
  ok: boolean;
  id: string;
  error?: string;
  [k: string]: unknown;
}

/** Apply ONE op to ONE item. Pure dispatch over the engine fns; the caller wraps thrown errors. */
async function applyOp(
  op: BatchOp,
  item: BatchItem,
  harness: string | undefined,
  ownerId: string,
): Promise<ItemResult> {
  const opts = { harness: item.harness ?? harness };
  switch (op) {
    case 'claim': {
      const wi = await claimWorkItem(item.id, item.assignee ?? ownerId, opts);
      return wi ? { ok: true, id: item.id, workItem: wi } : { ok: false, id: item.id, error: 'not_claimable_or_not_found' };
    }
    case 'release': {
      const wi = await releaseWorkItem(item.id, opts);
      return wi ? { ok: true, id: item.id, workItem: wi } : { ok: false, id: item.id, error: `work_item '${item.id}' not found` };
    }
    case 'set_state': {
      if (!item.state) return { ok: false, id: item.id, error: 'set_state requires `state`' };
      const wi = await setWorkItemState(item.id, item.state, { ...opts, by: ownerId });
      return wi ? { ok: true, id: item.id, workItem: wi } : { ok: false, id: item.id, error: `work_item '${item.id}' not found` };
    }
    case 'set_priority': {
      // Explicit `priority` wins (null clears); else `position` bumps to head/tail.
      if (item.priority !== undefined) {
        const res = await setWorkItemPriority(item.id, item.priority, opts);
        return res
          ? { ok: true, id: item.id, priority: res.priority, applicable: res.applicable, ...(res.proposed ? { proposed: true } : {}) }
          : { ok: false, id: item.id, error: `work_item '${item.id}' not found` };
      }
      if (item.position) {
        const res = await bumpWorkItemPriority(item.id, item.position, opts);
        return res
          ? { ok: true, id: item.id, priority: res.priority, applicable: res.applicable, ...(res.proposed ? { proposed: true } : {}) }
          : { ok: false, id: item.id, error: `work_item '${item.id}' not found` };
      }
      return { ok: false, id: item.id, error: 'set_priority requires `priority` or `position`' };
    }
    case 'tag': {
      if (!item.topic) return { ok: false, id: item.id, error: 'tag requires `topic`' };
      const res = item.remove
        ? await untagWorkItem(item.id, item.topic, opts)
        : await tagWorkItem(item.id, item.topic, { ...opts, by: ownerId });
      return 'error' in res ? { ok: false, id: item.id, error: res.error } : { ok: true, id: item.id, topic: item.topic };
    }
    case 'subscribe': {
      const res = await subscribeWorkItem(ownerId, item.id, item.mode ?? 'full', opts);
      return 'error' in res ? { ok: false, id: item.id, error: res.error } : { ok: true, id: item.id };
    }
  }
}

export default defineTool({
  name: 'work_items:batch',
  profile: 'engineer',
  description:
    'BULK-mutate up to 200 work-items with ONE op in a single call. op ∈ {claim, release, set_state, set_priority, tag, subscribe}; each item carries its `id` plus that op\'s fields (claim:{assignee?}, set_state:{state}, set_priority:{priority|position}, tag:{topic,remove?}, subscribe:{mode?}). One bad item never fails the batch — every item returns { ok, id, error? }. For bulk CREATE use work_items:create_batch (it needs the mirror-guard + hive-scope gate).',
  guidance: {
    when: 'You need to apply the SAME mutation to many work-items (e.g. claim a swath, retag a set, reprioritize a wave, close a batch).',
    notWhen: 'Creating items in bulk → work_items:create_batch. A single mutation → the single-op tool (work_items:claim / set_state / …).',
    chaining: 'work_items:list → work_items:batch { op, items }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    op: z.enum(BATCH_OPS).describe('The mutation to apply to every item.'),
    items: z.array(itemSchema).min(1).max(200).describe('The items to mutate (1–200); each carries its id plus the op-specific fields.'),
    harness: z.string().max(80).optional().describe('Default harness for items that omit one (per-item `harness` wins).'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const results: ItemResult[] = [];
    let okCount = 0;
    let failed = 0;
    for (const item of args.items) {
      // NEVER throw on a single item — wrap any engine rejection into the per-item
      // result so the rest of the batch still applies.
      let res: ItemResult;
      try {
        res = await applyOp(args.op, item, args.harness, ident.ownerId);
      } catch (e) {
        res = { ok: false, id: item.id, error: e instanceof Error ? e.message : String(e) };
      }
      if (res.ok) okCount += 1;
      else failed += 1;
      results.push(res);
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, op: args.op, results, counts: { ok: okCount, failed } }),
        },
      ],
    };
  },
});
