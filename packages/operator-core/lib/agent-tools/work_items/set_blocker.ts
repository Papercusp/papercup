/**
 * work_items:set_blocker — typed non-work-item dependencies.
 *
 * Internal work dependencies remain `work_items:link { rel:'blocks' }` (and plan
 * `blocked-by`) so their history/graph semantics stay intact. This surface is
 * specifically for conditions that are not work-items: events, gates, runtime
 * state, and human decisions. Clearing marks history; it never deletes it.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { runBulk, bulkContent } from '../_bulk';
import {
  getWorkItem,
  mergeWorkItemPayload,
  setWorkItemClaimHold,
  setWorkItemStateWithAliasInfo,
} from '../../work-items';
import {
  activeExternalBlockers,
  updateExternalBlockerHistory,
  type ExternalBlockerKind,
} from '../../external-blockers';

const BLOCKER_KIND = z.enum(['event', 'gate', 'runtime', 'human']);
const fields = {
  kind: BLOCKER_KIND,
  ref: z.string().min(1).max(300),
  summary: z.string().max(1000).optional(),
  evidence: z.string().max(4000).optional(),
  nextVerb: z.string().max(300).optional(),
  clear: z.boolean().optional(),
  harness: z.string().max(80).optional(),
};
const itemSpec = z.object({ id: z.string().min(1), ...fields }).strict();

const TERMINAL = new Set(['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']);

export default defineTool({
  name: 'work_items:set_blocker',
  profile: 'engineer',
  description:
    "Set or clear a TYPED external blocker on one or many work-items: event, gate, runtime, or human. This is for dependencies that are NOT work-items; internal work dependencies stay in work_items:link{rel:'blocks'} / plan blocked-by. Active blockers park the item out of self-selection. clear:true marks the record cleared but PRESERVES its history. Returns activeBlockers + full blockerHistory and the applied lifecycle/claim-hold result.",
  guidance: {
    when:
      'Work cannot proceed until a named event fires, a gate changes, runtime/external state becomes ready, or a human decides. Use a stable ref (event key, gate id, service/runtime id, or decision id) and name the concrete nextVerb when one exists.',
    notWhen:
      "Another work-item must finish first — use work_items:link with rel:'blocks' (blocker id as source, blocked item as target), preserving the dependency graph. A vague concern with no actual stop condition is a comment, not a blocker.",
    chaining:
      "work_items:set_blocker {id,kind,ref,…} → await the named event/gate rather than polling → work_items:set_blocker {id,kind,ref,clear:true,evidence}. Clearing the last external blocker returns a feature from blocked→todo or removes the issue-family claim hold.",
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional(),
      kind: BLOCKER_KIND.optional(),
      ref: z.string().min(1).max(300).optional(),
      summary: z.string().max(1000).optional(),
      evidence: z.string().max(4000).optional(),
      nextVerb: z.string().max(300).optional(),
      clear: z.boolean().optional(),
      harness: z.string().max(80).optional(),
      items: z.array(itemSpec).min(1).max(100).optional(),
    })
    .strict()
    .refine(
      (args) =>
        (args.items?.length ?? 0) > 0 ||
        (Boolean(args.id) && Boolean(args.kind) && Boolean(args.ref)),
      { message: 'pass { id, kind, ref, summary? } for one, or items:[{ id, kind, ref, … }]' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const items = args.items?.length
      ? args.items
      : [
          {
            id: args.id as string,
            kind: args.kind as ExternalBlockerKind,
            ref: args.ref as string,
            summary: args.summary,
            evidence: args.evidence,
            nextVerb: args.nextVerb,
            clear: args.clear,
            harness: args.harness,
          },
        ];
    const env = await runBulk(
      items,
      async (input) => {
        const workItem = await getWorkItem(input.id, input.harness);
        if (!workItem) return { ok: false as const, id: input.id, error: `work_item '${input.id}' not found` };
        if (!input.clear && TERMINAL.has(workItem.state.toLowerCase())) {
          return {
            ok: false as const,
            id: input.id,
            error: `work_item '${input.id}' is already terminal ('${workItem.state}') — reopen it explicitly before adding an active blocker`,
          };
        }

        const history = updateExternalBlockerHistory(
          workItem.payload,
          {
            kind: input.kind,
            ref: input.ref,
            summary: input.summary,
            evidence: input.evidence,
            nextVerb: input.nextVerb,
            clear: input.clear,
          },
          identity.ownerId,
        );
        if (!history.changed) {
          return {
            ok: true as const,
            id: input.id,
            changed: false,
            workItem,
            activeBlockers: activeExternalBlockers(workItem.payload),
            blockerHistory: history.blockers,
          };
        }

        const active = history.blockers.filter((blocker) => blocker.status === 'active');
        const updated = await mergeWorkItemPayload(
          input.id,
          { externalBlockers: history.blockers },
          { harness: input.harness },
        );
        if (!updated) {
          return { ok: false as const, id: input.id, error: 'blocker payload write did not return the work-item' };
        }

        let lifecycle: unknown = null;
        try {
          if (active.length > 0) {
            lifecycle = await setWorkItemStateWithAliasInfo(input.id, 'blocked', {
              harness: input.harness,
              by: identity.ownerId,
            });
          } else if (updated.family === 'feature' && updated.state === 'blocked') {
            lifecycle = await setWorkItemStateWithAliasInfo(input.id, 'todo', {
              harness: input.harness,
              by: identity.ownerId,
            });
          } else if (updated.family === 'issue') {
            lifecycle = await setWorkItemClaimHold(input.id, false, {
              harness: input.harness,
              by: identity.ownerId,
              reason: `external blocker ${input.kind}:${input.ref} cleared`,
            });
          }
        } catch (error) {
          return {
            ok: false as const,
            id: input.id,
            error: `typed blocker persisted, but lifecycle parking failed: ${error instanceof Error ? error.message : String(error)}`,
            activeBlockers: active,
            blockerHistory: history.blockers,
          };
        }

        return {
          ok: true as const,
          id: input.id,
          changed: true,
          workItem: updated,
          activeBlockers: active,
          blockerHistory: history.blockers,
          lifecycle,
          ...(input.kind === 'event' && !input.clear ? { await: { event: input.ref } } : {}),
        };
      },
      { keyOf: (input) => ({ id: input.id, kind: input.kind, ref: input.ref }) },
    );
    return bulkContent(env);
  },
});
