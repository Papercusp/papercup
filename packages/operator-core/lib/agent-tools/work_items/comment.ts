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

/**
 * EI-10897: `comment` is an ACCEPTED ALIAS for `body` (the SAME field).
 *
 * The tool is CALLED `work_items:comment`, so `{ id, comment }` is the spelling an
 * agent reaches for first — and it was rejected, costing a round-trip to discover the
 * field is named `body`. Same class as WI-4492 (`body` silently dropped on create),
 * and the same remedy: accept the obvious spelling, reject a genuine conflict loudly.
 *
 * ⚠ The alias is resolved in the HANDLER — never with a zod `.transform()` here
 * (EI-10996). A trailing transform's OUTPUT is unrepresentable in JSON Schema, and
 * `z.toJSONSchema(def.args)` runs with NO try/catch at `defineTool` registration AND
 * in the MCP tools/list handlers (`endpoint-route/.../_mcp-handler.ts`,
 * `agent-mcp/src/server.ts`) — so ONE transform here crashes schema-gen for the WHOLE
 * tool catalog, not merely this tool. `limits.ts` already states this rule (it is why
 * `softText` clamps handler-side); the first cut of this alias broke it and red-pinned
 * the release gate. `.superRefine()` below is fine — REFINEMENTS are representable; it
 * is specifically a value-rewriting transform that is not. If one is ever genuinely
 * needed it must be `.transform(...).pipe(<schema>)`, whose output is the piped schema
 * (see `plans/list.ts`).
 */
const itemSpec = z
  .object({
    id: z.string().min(1),
    body: hardText(LIMITS.BODY).optional().describe('the comment text'),
    comment: hardText(LIMITS.BODY)
      .optional()
      .describe('alias for `body` — the comment text. Pass either; both-with-different-values is rejected (EI-10897).'),
    harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  })
  .superRefine((v, ctx) => {
    const body = v.body?.trim();
    const comment = v.comment?.trim();
    if (!body && !comment) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'a comment needs text — pass `body` (or its alias `comment`).',
      });
      return;
    }
    if (body && comment && body !== comment) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message:
          '`body` and `comment` are the SAME field and were both passed with DIFFERENT text — pass one (which did you mean?).',
      });
    }
  });

/** Resolve the `body`/`comment` alias (EI-10897). Handler-side by construction, so the
 *  advertised JSON Schema stays representable (EI-10996 — see the note above). The
 *  superRefine above already guarantees at least one of the two is present. */
const commentText = (v: { body?: string; comment?: string }): string => (v.body ?? v.comment) as string;

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
      // EI-10897: the tool is named `comment`, so `{ id, comment }` is what an agent
      // reaches for first. Accept it rather than making them re-call to learn `body`.
      comment: hardText(LIMITS.BODY)
        .optional()
        .describe('alias for `body` (EI-10897) — the comment text. Pass either; both-with-different-values is rejected.'),
      items: z.array(itemSpec).min(1).max(100).optional().describe('comment on many work-items at once — each { id, body|comment, harness? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.id) && Boolean(a.body ?? a.comment)), {
      message: 'pass { id, body } for one (or its alias { id, comment }), or items:[{ id, body }] for many',
    })
    .refine((a) => !(a.body?.trim() && a.comment?.trim() && a.body.trim() !== a.comment.trim()), {
      path: ['comment'],
      message: '`body` and `comment` are the SAME field and were both passed with DIFFERENT text — pass one.',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // Both paths resolve the `comment` alias the SAME way — handler-side (EI-10996).
    const items = args.items?.length
      ? args.items.map((it) => ({ ...it, body: commentText(it) }))
      : [{ id: args.id as string, body: commentText(args), harness: args.harness }];
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
