/**
 * work_items:comment — Threadable (D-003). Append a comment to a work-item's thread
 * (creates the thread on first post) and fan out to its subscribers. Dispatches by
 * kind: issue-family rides issues-engineer.commentIssue; feature-family threads on
 * the feature ObjectRef.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): comment on ONE item
 * inline ({ id, body }) or MANY in one call (items:[{ id, body, harness? }]) →
 * { ok, results:[{ ok, id, post? | error }], counts }. Each result self-describes its
 * id; one not-found item never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { commentWorkItem, getWorkItem, isSettledWorkItemState } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';
import { hardText, LIMITS } from '../limits';

const itemSpec = z.object({
  id: z.string().min(1),
  body: hardText(LIMITS.BODY),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
});

/**
 * EI-8837: a completion-shaped thread post ("DONE + GREEN", "VM-VERIFIED", …)
 * left on a work-item whose `state` never actually transitioned is exactly
 * how a fully-fixed item gets handed back out by scheduler:get_next 24h
 * later — completion evidence lived only in prose, not the terminal-state
 * field claim_next actually gates on. This is a narrow, conservative match
 * (multi-word completion phrases, not bare "done"/"green") so it nudges on
 * genuine completion-sounding posts without flagging routine status chatter.
 */
const COMPLETION_LIKE_RE =
  /\b(done\s*(?:\+|and)?\s*green|vm[- ]?verified|fully\s+(?:fixed|implemented|resolved|done)|ready\s+to\s+close|closing\s+this\s+(?:out|item)|complete(?:d)?\s+(?:and|&)\s+(?:verified|tested|green)|all\s+tests?\s+(?:green|passing).{0,40}\bdone\b)/i;

/** A soft, non-blocking reminder attached to a result when a completion-shaped
 *  post lands on a still-open item — never fails the comment itself. */
const COMPLETION_STATE_HINT =
  'This reads like a completion, but the item is still non-terminal — if the work is actually done, ' +
  'also call work_items:set_state (or work_items:complete) so scheduler:get_next stops handing it back out.';

export default defineTool({
  name: 'work_items:comment',
  profile: 'engineer',
  description:
    'Comment on one OR many work-items (any kind) in one call. Single: { id, body }. Many: items:[{ id, body, harness? }]. Appends to each item\'s thread (created on first comment) and notifies its subscribers. Returns { ok, results:[{ ok, id, post? | error }], counts } — correlate by id; a not-found item never fails the rest.',
  guidance: {
    when: 'You have an update, finding, or question to post on one or more work-items. Comment on several at once via items:[…] instead of one call each.',
    notWhen: 'A contextual aside not tied to a work-item → coord:send. A structured completion → work_items:complete.',
    chaining: 'work_items:get → work_items:comment; work_items:subscribe to follow the thread.',
    seeAlso: [
      'work_items:subscribe (follow the thread you just posted on)',
      'work_items:complete (a structured completion, not a prose note)',
      'coord:send (an aside not tied to any work-item)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-comment shorthand: the work-item id (use with `body`)'),
      body: hardText(LIMITS.BODY).optional().describe('single-comment shorthand: the comment text (use with `id`)'),
      items: z.array(itemSpec).min(1).max(100).optional().describe('comment on many work-items at once — each { id, body, harness? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.id) && Boolean(a.body)), {
      message: 'pass { id, body } for one, or items:[{ id, body }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const items = args.items?.length
      ? args.items
      : [{ id: args.id as string, body: args.body as string, harness: args.harness }];
    const env = await runBulk(
      items,
      async (it) => {
        const post = await commentWorkItem(it.id, it.body, ident.ownerId, { harness: it.harness ?? args.harness });
        if (!post) return { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
        let hint: string | undefined;
        if (COMPLETION_LIKE_RE.test(it.body)) {
          // Best-effort only: never let the state re-lookup fail the comment
          // that already landed.
          try {
            const wi = await getWorkItem(it.id, it.harness ?? args.harness);
            if (wi && !isSettledWorkItemState(wi.state)) hint = COMPLETION_STATE_HINT;
          } catch {
            /* the comment already succeeded — swallow */
          }
        }
        return { ok: true as const, id: it.id, post, ...(hint ? { hint } : {}) };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
