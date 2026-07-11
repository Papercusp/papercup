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
import {
  assessForceRelease,
  forceRefusalHint,
  notifyForceRelease,
  recordForceReleaseAudit,
  type ForceReleaseBasis,
} from './release-force-guard';

const itemSpec = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  claimHold: z
    .boolean()
    .optional()
    .describe('per-item claim-hold override (else the batch `claimHold` default)'),
  force: z.boolean().optional().describe('per-item override of the batch `force` default'),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe('per-item override of the batch `reason` (required when force clears a peer\'s claim)'),
});

export default defineTool({
  name: 'work_items:release',
  profile: 'engineer',
  description:
    'Release one OR many work-items (clear assignee / taken_by) so another agent can pick them up. Single: { id }. Many: { ids:[…] } or items:[{ id, harness? }]. Returns { ok, results:[{ ok, id, workItem? | error, holder? }], counts } — correlate by id; a not-found item never fails the rest. Refuses to clear ANOTHER agent\'s live claim: a non-holder caller gets `{ ok:false, error:"not_holder", holder }` per item. `force:true` is a CHECKED override (WI-4198), not a bypass: it clears a peer\'s claim only when the holder is NOT live (stale presence + no recent progress — the reaper case), or the caller is queen, or the caller LEADS THE HOLDER\'s fleet; it then REQUIRES `reason`, is audited (harness_shared.audit_log), and notifies the holder + owner. Anything else refuses with `force_unauthorized` naming what would authorize. A voluntary release records a short re-claim cooldown. `claimHold:true` (both families) ALSO durably parks the item out of claim_next/scheduler:get_next self-select (WI-2797) and stamps you as holder — it stays directly claimable by id; `claimHold:false` clears the hold. To hold WITHOUT releasing your claim, use work_items:hold_open.',
  guidance: {
    when: 'You claimed work-item(s) but are no longer working them. Release several at once via ids:[…]. Add claimHold:true when the item must NOT be opportunistically re-claimed by the next self-selecting agent (a recurring do-not-pick-up ticket) — plain release lets it re-surface immediately.',
    notWhen: 'A per-item `not_holder` means a LIVE peer currently holds it — coordinate with the `holder` (coord:send), do not blind-force. `force:true` is now CHECKED (WI-4198): on a live holder it only works for the queen or the HOLDER\'s own fleet leader, always needs a `reason`, and is audited + notifies holder/owner — it is for reclaiming a dead/stuck agent\'s item, not for clearing a peer\'s in-flight claim.',
    chaining: 'work_items:claim → … → work_items:release.',
    seeAlso: [
      'work_items:set_state { state:"blocked" } (feature-family park with a reason; issue-family aliases blocked back to open — release { claimHold:true } is the durable self-select exclusion)',
      'work_items:hold_open (hold the item open — stamps held_open_by + blocks non-holder terminal transitions — WITHOUT releasing your claim)',
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
          'default claim-hold for the inline id / every id in `ids` (both families): true excludes the item from claim_next/scheduler:get_next self-select until cleared; false clears a prior hold.',
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          'default force for the inline id / every id in `ids`: release even if held by ANOTHER agent. CHECKED override (WI-4198): allowed only when the holder is not live, or you are queen, or you lead the HOLDER\'s fleet — and a cross-holder force requires `reason` and is audited + notifies holder/owner. Default false: refuses with { error:"not_holder", holder } when the caller is not the current holder.',
        ),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe(
          'default reason for the inline id / every id in `ids` — REQUIRED when force clears another agent\'s claim; recorded in the audit row and both notifications.',
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
        ? args.ids.map((id) => ({ id, harness: args.harness, claimHold: args.claimHold, force: args.force, reason: args.reason }))
        : [{ id: args.id as string, harness: args.harness, claimHold: args.claimHold, force: args.force, reason: args.reason }];
    const env = await runBulk(
      list,
      async (it) => {
        const harness = it.harness ?? args.harness;
        const force = it.force ?? args.force ?? false;
        // WI-4198: force is a CHECKED override, not a bypass. Before releasing,
        // identify the holder; a cross-holder force must pass the authority/liveness
        // guard, carry a reason, and leave an audit + notification trail.
        let forced: { holder: string; basis: ForceReleaseBasis; reason: string } | undefined;
        if (force) {
          const current = await getWorkItem(it.id, harness);
          if (!current) return { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
          const holder = current.assignee?.trim();
          if (holder && holder !== ident.ownerId) {
            const reason = (it.reason ?? args.reason ?? '').trim();
            if (!reason) {
              return {
                ok: false as const,
                id: it.id,
                error: 'force_requires_reason',
                holder,
                hint: `force would clear ${holder}'s claim — pass a \`reason\` the holder and owner can audit (WI-4198).`,
              };
            }
            const verdict = await assessForceRelease({
              callerOwnerId: ident.ownerId,
              holderOwnerId: holder,
              workspaceId: ident.workspaceId ?? '',
              itemLastProgressAt:
                (current as { lastProgressAt?: string | Date | null }).lastProgressAt ?? null,
            });
            if (!verdict.allowed) {
              return {
                ok: false as const,
                id: it.id,
                error: 'force_unauthorized',
                holder,
                holderLiveness: verdict.holderLiveness,
                hint: forceRefusalHint(holder),
              };
            }
            forced = { holder, basis: verdict.basis as ForceReleaseBasis, reason };
          }
        }
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
        if (forced) {
          // Audit + notify AFTER the release landed — both are never-throw helpers.
          await recordForceReleaseAudit(ident.ownerId, it.id, {
            holder: forced.holder,
            basis: forced.basis,
            reason: forced.reason,
            harness: workItem.harness ?? null,
          });
          await notifyForceRelease(ident, {
            itemId: it.id,
            holder: forced.holder,
            basis: forced.basis,
            reason: forced.reason,
            harness: workItem.harness ?? null,
          });
        }
        const claimHold = it.claimHold ?? args.claimHold;
        if (claimHold === undefined) return { ok: true as const, id: it.id, workItem, forced };
        const held = await setWorkItemClaimHold(it.id, claimHold, { harness, by: ident.ownerId });
        return {
          ok: true as const,
          id: it.id,
          workItem,
          forced,
          claimHold: held?.applicable ? held.hold : undefined,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
