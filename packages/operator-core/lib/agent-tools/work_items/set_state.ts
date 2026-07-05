/**
 * work_items:set_state — Lifecycle (D-003). Sets the kind-specific lifecycle state
 * (feature-family → status e.g. todo|in_progress|passed|failing; issue-family →
 * open|resolved|closed). Dispatches to the right kind-table.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): set ONE inline
 * ({ id, state }), MANY to the SAME state (ids:[…] + state), or MANY heterogeneous
 * (items:[{ id, state, harness?, decision? }]) → { ok, results:[{ ok, id, workItem?
 * | error }], counts }. The P-114 arm tripwire is evaluated PER item; the
 * plan-item reflect + rationale-reproject reactions fire per item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemState } from '../../work-items';
import { planWorkItemArm, commitWorkItemArm } from './arm-reversible-work-item';
import { runBulk, bulkContent } from '../_bulk';

// P-114: an AUTONOMOUS agent declares the action's risk/authority so the auto-revert
// tripwire arms faithfully to the upstream decision (the verb has no inherent item
// risk). Absent ⇒ fail-safe `critical`. Ignored for human callers.
const decisionSpec = z.object({
  riskTier: z.enum(['trivial', 'low', 'moderate', 'high', 'critical']).optional(),
  authority: z.enum(['system', 'owner']).optional(),
});

const itemSpec = z.object({
  id: z.string().min(1),
  state: z.string().min(1).max(40),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  decision: decisionSpec.optional(),
  completionRef: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      'Completion evidence (summary / commit / coord or plan-item ref) — REQUIRED alongside a terminal state (feature: passed|deprecated; issue: resolved|closed). Prefer work_items:complete for a structured completion record.',
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      'EI-7422: required to REOPEN an item that already carries a terminal completion (terminalOwner + terminalCompletionRef) — without it the write is REJECTED rather than silently discarding a peer\'s completion. Only needed when the target is already terminal AND you are deliberately reopening it.',
    ),
});

export default defineTool({
  name: 'work_items:set_state',
  profile: 'engineer',
  description:
    'Set the lifecycle state of one OR many work-items. feature-family: a feature status (todo|in_progress|passed|failing|deprecated…). issue-family: open|resolved|closed ONLY — the family has no blocked/needs-human/in_progress state, so those (and wip/todo/done/dropped) ALIAS onto open/resolved/closed instead of erroring; a per-item `aliasNote` in the result names the alias when one fired, so it never reads as a silent no-op. Reopening an item that already carries a terminal completion (terminalOwner + terminalCompletionRef) into a non-terminal state is REJECTED unless you pass `force: true` (EI-7422) — a stale claim racing past a peer\'s completion should not silently discard it. Single: { id, state }. Many same state: { ids:[…], state }. Many heterogeneous: items:[{ id, state, harness?, decision?, force? }]. Returns { ok, results:[{ ok, id, workItem?, aliasNote? | error }], counts } — correlate by id; a not-found item never fails the rest.',
  guidance: {
    when: 'You moved one or more work-items along the lifecycle (started, resolved, etc.). Flip a whole wave at once via { ids:[…], state } or items:[…]. To durably PARK an issue-family item (needs a human / blocked on something external), state:\'blocked\' aliases to \'open\' (it stays claimable) — use work_items:release { claimHold:true } to park it out of self-select, plus a comment for the reason. If this errors with "already terminally completed", a peer finished the item while you held a stale claim — read the named terminalOwner/terminalCompletionRef before deciding whether to `force: true` a genuine reopen.',
    chaining: 'work_items:claim → … → work_items:set_state { state }.',
    seeAlso: [
      'work_items:complete (terminal state WITH a structured completion record)',
      'work_items:release (drop a claim without changing state; claimHold:true parks an issue-family item out of claim_next self-select — WI-2797)',
      'work_items:set_priority (steer backlog order, not lifecycle state)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the work-item id (use with `state`)'),
      state: z.string().min(1).max(40).optional().describe('the lifecycle state applied to the inline id / every id in `ids`'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
      decision: decisionSpec.optional().describe('P-114 risk/authority for the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('set MANY items to the same `state` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('set many work-items at once — each { id, state, harness?, decision?, completionRef? }'),
      completionRef: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe('completion evidence applied to the inline id / every id in `ids` (see itemSpec.completionRef)'),
      force: z
        .boolean()
        .optional()
        .describe('applied to the inline id / every id in `ids` (see itemSpec.force) — required to reopen an already-terminally-completed item'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.state) && ((a.ids?.length ?? 0) > 0 || Boolean(a.id))), {
      message: 'pass { id, state } for one, { ids:[…], state } for many of the same state, or items:[{ id, state }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, state: args.state as string, harness: args.harness, decision: args.decision, completionRef: args.completionRef, force: args.force }))
        : [{ id: args.id as string, state: args.state as string, harness: args.harness, decision: args.decision, completionRef: args.completionRef, force: args.force }];
    const env = await runBulk(
      list,
      async (it) => {
        const harness = it.harness ?? args.harness;
        // P-114 arm-call-site: gate-FIRST (before the mutation) so the captured prior-state
        // handle is faithful; best-effort (never fails the verb); null on the common path.
        const armPlan = await planWorkItemArm(
          ctx,
          'work_items:set_state',
          'state',
          it.id,
          harness,
          it.decision,
        ).catch(() => null);
        // EI-7125 / WI-2573: capture a requested->resolved alias (e.g. issue-family
        // 'blocked' -> 'open') so the caller sees it instead of a silent no-op-looking
        // ok:true with the state unchanged from their ask.
        let aliasNote: string | undefined;
        const workItem = await setWorkItemState(it.id, it.state, {
          harness,
          by: ident.ownerId,
          completionRef: it.completionRef,
          force: it.force,
          onAlias: ({ requested, resolved }) => {
            aliasNote = `requested state '${requested}' has no distinct representation for this item's family — recorded as '${resolved}' instead.`;
          },
        });
        if (armPlan && workItem) await commitWorkItemArm(armPlan).catch(() => {});
        return workItem
          ? { ok: true as const, id: it.id, workItem, ...(aliasNote ? { aliasNote } : {}) }
          : { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
