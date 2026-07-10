/**
 * work_items:hold_open — hold a work-item OPEN in place, WITHOUT releasing your
 * claim (fleet-deltas-leader-primitives-2026-07-10 P-006; EI-8993 / EI-8973).
 *
 * The gap this closes: release { claimHold:true } is release-and-hold — the
 * leader pattern (WI-3548) is "I keep working/gating this item, but nobody may
 * close it or self-select it out from under me". hold_open stamps
 * `held_open_by` + `held_open_reason` on the payload (setWorkItemClaimHold):
 *   - claim_next / scheduler:get_next skip it (both claim floors honor _claimHold),
 *   - a TERMINAL transition by a NON-holder is refused (setWorkItemState's
 *     held-open guard) until the holder clears or closes it themselves,
 *   - the claim itself is untouched — the holder keeps working it.
 * `clear:true` lifts the hold (holder or force). The lifecycle note is
 * best-effort: a coord hiccup never un-holds the item.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import { getWorkItem, setWorkItemClaimHold, readWorkItemHeldOpenBy } from '../../work-items';

export default defineTool({
  name: 'work_items:hold_open',
  profile: 'engineer',
  description:
    'Hold a work-item OPEN without releasing your claim: stamps you as held_open_by (+ reason), excludes it from ' +
    'claim_next/scheduler self-select, and makes a terminal transition (done/resolved/closed/dropped) by anyone ELSE ' +
    'refuse until you clear it. { id, reason } to hold; { id, clear:true } to lift. Clearing another agent\'s hold ' +
    'needs force:true (leader override). Returns { ok, id, held, heldBy, reason }.',
  guidance: {
    when:
      'You are gating an item — verifying, awaiting evidence, or keeping a recurring/leader item alive — and peers must ' +
      'neither close it nor self-select it while you do. Your claim stays; work continues.',
    notWhen:
      'You are WALKING AWAY from the item — that is work_items:park (checkpoint + release) or release { claimHold:true } ' +
      '(release + hold). Blocked on a dependency → set_state{blocked}. Done → complete (a holder completing their own held item is allowed).',
    chaining:
      'work_items:hold_open { id, reason } → work → complete/set_state yourself (holder passes the guard), or hold_open { id, clear:true } to hand it back to normal lifecycle.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).describe('the work-item id to hold open (or clear)'),
      reason: z.string().min(1).max(500).optional().describe('why it must stay open — stamped as held_open_reason + broadcast (required unless clear:true)'),
      clear: z.boolean().optional().describe('true lifts the hold instead of setting it'),
      force: z.boolean().optional().describe('clear ANOTHER agent\'s hold (leader override only; default false refuses with not_holder)'),
      harness: z.string().max(80).optional().describe('harness the item lives under (else resolved from the item)'),
    })
    .refine((a) => a.clear === true || Boolean(a.reason), { message: 'pass { reason } to hold, or { clear:true } to lift' }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null };
    const hint = args.harness ?? c.harnessSlug ?? undefined;
    const hintHarness = hint && hint !== '*' ? hint : undefined;
    const fail = (payload: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, id: args.id, ...payload }) }],
    });
    const item = await getWorkItem(args.id, hintHarness).catch(() => null);
    if (!item) return fail({ error: `work_item '${args.id}' not found` });
    const prior = readWorkItemHeldOpenBy(item.payload);
    if (args.clear) {
      if (prior && prior.by !== ident.ownerId && !args.force) {
        return fail({
          error: 'not_holder',
          heldBy: prior.by,
          reason: prior.reason,
          hint: `Held open by ${prior.by}, not you — coordinate with the holder (coord:send) or pass force:true (leader override).`,
        });
      }
      const cleared = await setWorkItemClaimHold(args.id, false, { harness: item.harness ?? undefined });
      if (!cleared) return fail({ error: 'clear_failed' });
      await sendMessage(ident, {
        to: ['*'],
        summary: `🔓 ${args.id} hold-open CLEARED by ${ident.ownerId}${prior && prior.by !== ident.ownerId ? ` (was ${prior.by}, forced)` : ''} — normal lifecycle resumes`,
        harnessSlug: item.harness ?? undefined,
        extra: { auto: true, lifecycle: 'hold_open_clear', work_item: args.id },
      }).catch(() => {});
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id, held: false, clearedFrom: prior?.by ?? null }) },
        ],
      };
    }
    const held = await setWorkItemClaimHold(args.id, true, {
      harness: item.harness ?? undefined,
      by: ident.ownerId,
      reason: args.reason,
    });
    if (!held) return fail({ error: 'hold_failed' });
    await sendMessage(ident, {
      to: ['*'],
      summary: `🔒 ${args.id} HELD OPEN by ${ident.ownerId} — no terminal transition by others until cleared: ${(args.reason ?? '').slice(0, 140)}`,
      harnessSlug: item.harness ?? undefined,
      extra: { auto: true, lifecycle: 'hold_open', work_item: args.id },
    }).catch(() => {});
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            id: args.id,
            held: true,
            heldBy: ident.ownerId,
            reason: args.reason,
            note: prior && prior.by !== ident.ownerId ? `re-stamped (was held by ${prior.by})` : undefined,
          }),
        },
      ],
    };
  },
});
