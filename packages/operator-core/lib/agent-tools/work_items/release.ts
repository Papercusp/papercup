/**
 * work_items:release — Claimable (D-003). Unassigns the work-item.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): release ONE inline
 * ({ id }), or MANY (ids:[…] / items:[{ id, harness? }]) → { ok, results:[{ ok, id,
 * workItem? | error }], counts }. Each result self-describes its id; one not-found
 * item never fails the rest. The plan-item reflect rules (flip the converted plan
 * item back to todo + drop the lease) fire per released item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { releaseWorkItem, setWorkItemClaimHold, getWorkItem } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  claimHold: z
    .boolean()
    .optional()
    .describe('per-item claim-hold override (else the batch `claimHold` default)'),
  force: z.boolean().optional().describe('per-item override of the batch `force` default'),
});

export default defineTool({
  name: 'work_items:release',
  profile: 'engineer',
  description:
    'Release one OR many work-items (clear assignee / taken_by) so another agent can pick them up. Single: { id }. Many: { ids:[…] } or items:[{ id, harness? }]. Returns { ok, results:[{ ok, id, workItem? | error, holder? }], counts } — correlate by id; a not-found item never fails the rest. Refuses (loudly) to clear ANOTHER agent\'s live claim: when the caller is not the current holder, a per-item result comes back `{ ok:false, error:"not_holder", holder }` instead of silently dropping their claim — pass `force:true` (leader/reaper override only, NOT for routine members) to release it anyway. A voluntary release records short cooldown provenance so the releasing agent does not immediately re-claim the same row. Pass `claimHold:true` (issue-family only) to ALSO durably park the item out of claim_next/scheduler:get_next self-select — for a do-not-opportunistically-claim item (needs a dedicated owner, out of repo scope, …) that would otherwise keep resurfacing to the next self-selecting agent (WI-2797); it stays directly claimable by id. `claimHold:false` clears a prior hold.',
  guidance: {
    when: 'You claimed work-item(s) but are no longer working them. Release several at once via ids:[…]. Add claimHold:true when the item must NOT be opportunistically re-claimed by the next self-selecting agent (a recurring do-not-pick-up ticket) — plain release lets it re-surface immediately.',
    notWhen: 'A per-item `not_holder` means a LIVE peer currently holds it — coordinate with the `holder` (coord:send), do not blind-force. `force:true` exists for the legitimate leader/reaper override path (reclaiming a dead/stuck agent\'s item), not for routine members clearing a peer\'s in-flight claim.',
    chaining: 'work_items:claim → … → work_items:release.',
    seeAlso: [
      'work_items:set_state { state:"blocked" } (feature-family park with a reason; issue-family aliases blocked back to open — release { claimHold:true } is the durable self-select exclusion for issue-family)',
      'work_items:claim (re-take it later, or claim a held item directly by id — a hold only excludes self-select)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-release shorthand: the work-item id'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('release many work-items at once (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('release many, each { id, harness?, claimHold? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
      claimHold: z
        .boolean()
        .optional()
        .describe(
          'default claim-hold for the inline id / every id in `ids` (issue-family only): true excludes the item from claim_next/scheduler:get_next self-select until cleared; false clears a prior hold.',
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          'default force for the inline id / every id in `ids`: release even if held by ANOTHER agent (leader/reaper override — routine members should not set this). Default false: refuses with { error:"not_holder", holder } when the caller is not the current holder.',
        ),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, harness: args.harness, claimHold: args.claimHold, force: args.force }))
        : [{ id: args.id as string, harness: args.harness, claimHold: args.claimHold, force: args.force }];
    const env = await runBulk(
      list,
      async (it) => {
        const harness = it.harness ?? args.harness;
        const force = it.force ?? args.force ?? false;
        // EI-7588: compare-and-release — the UPDATE itself only touches an unclaimed row
        // or one already held by `ident.ownerId` (unless `force`), so a peer's live claim
        // can never be silently cleared. A null return here is either "not found" or "held
        // by someone else" — re-read to tell them apart and report an honest error.
        const workItem = await releaseWorkItem(it.id, {
          harness,
          expectedAssignee: force ? undefined : ident.ownerId,
        });
        if (!workItem) {
          const current = await getWorkItem(it.id, harness);
          if (!current) return { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
          const holder = current.assignee?.trim();
          if (holder && holder !== ident.ownerId) {
            return {
              ok: false as const,
              id: it.id,
              error: 'not_holder',
              holder,
              workItem: current,
              hint: `Held by ${holder}, not you (${ident.ownerId}) — release refused so a live peer's claim isn't silently cleared. Coordinate with the holder (coord:send), or pass force:true (leader/reaper override only) to release it anyway.`,
            };
          }
          return { ok: false as const, id: it.id, error: 'release_failed', workItem: current };
        }
        const claimHold = it.claimHold ?? args.claimHold;
        if (claimHold === undefined) return { ok: true as const, id: it.id, workItem };
        const held = await setWorkItemClaimHold(it.id, claimHold, { harness });
        return {
          ok: true as const,
          id: it.id,
          workItem,
          claimHold: held?.applicable ? held.hold : undefined,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
