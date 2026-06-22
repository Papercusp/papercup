/**
 * learning_packs:set_enabled — mute/unmute one OR many packs' injection without
 * uninstalling (learning-packs-2026-06-11 P-009; bulk-standardized per
 * bulk-endpoint-standardization-2026-06-21). hive_settings-backed
 * (`learning-packs:disabled`); the pre-turn injection filters disabled packs.
 *
 * Bulk by default (the house keyed-array contract): flip ONE inline ({ hive,
 * pack, enabled }), MANY packs for the SAME hive+enabled (hive + packs:[…] +
 * enabled), or MANY heterogeneous (items:[{ hive, pack, enabled }]) → { ok,
 * results:[{ ok, hive, pack, enabled? | error }], counts }. Each result
 * self-describes its hive+pack; one failure never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { FLAG_OFF, learningPacksEnabled, text } from './_shared';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  hive: z.string().min(1).max(120),
  pack: z.string().min(1).max(120),
  enabled: z.boolean(),
});

interface FlipItem {
  hive: string;
  pack: string;
  enabled: boolean;
}

export default defineTool({
  name: 'learning_packs:set_enabled',
  capability: 'memory:write',
  description:
    "Enable or disable one OR many learning packs' injection for a hive WITHOUT uninstalling them — the rows stay stored; agents just stop recalling them. Cheap to flip, fully reversible. Single: { hive, pack, enabled }. Many packs same hive: { hive, packs:[…], enabled }. Many heterogeneous: items:[{ hive, pack, enabled }]. Returns { ok, results:[{ ok, hive, pack, enabled? | error }], counts } — correlate by hive+pack, not by position; one failure never fails the rest.",
  guidance: {
    when: 'Trying out whether a pack helps, or quarantining one that seems to misdirect agents — before reaching for uninstall. Flip several at once via packs:[…] or items:[…].',
    notWhen: 'Permanently removing a pack — learning_packs:uninstall.',
    chaining: 'learning_packs:list { hive } shows enabled state per installed pack. Bulk: single | items[] (or packs) → { ok, results, counts }; correlate by hive+pack not position; one failure never fails the rest.',
  },
  crossWorkspace: true,
  args: z
    .object({
      hive: z.string().min(1).max(120).optional().describe('the hive — for the inline pack / every pack in `packs`'),
      pack: z.string().min(1).max(120).optional().describe('single-flip shorthand: the pack id (use with `hive`, `enabled`)'),
      enabled: z.boolean().optional().describe('enabled state for the inline pack / every pack in `packs`'),
      packs: z.array(z.string().min(1).max(120)).min(1).max(200).optional().describe('flip MANY packs for the same `hive` + `enabled` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('flip many packs at once — each { hive, pack, enabled }'),
      workspace: z.string().max(120).optional(),
    })
    .refine(
      (a) =>
        (a.items?.length ?? 0) > 0 ||
        (Boolean(a.hive) && a.enabled !== undefined && ((a.packs?.length ?? 0) > 0 || Boolean(a.pack))),
      {
        message:
          'pass { hive, pack, enabled } for one, { hive, packs:[…], enabled } for many of the same hive, or items:[{ hive, pack, enabled }] for many',
      },
    ),
  async handler(args, ctx) {
    if (!(await learningPacksEnabled())) return text(FLAG_OFF);
    const workspaceId = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const { setPackEnabled } = await import('../../learning-packs/manage');

    const list: FlipItem[] = args.items?.length
      ? args.items
      : args.packs?.length
        ? args.packs.map((pack) => ({ hive: args.hive as string, pack, enabled: args.enabled as boolean }))
        : [{ hive: args.hive as string, pack: args.pack as string, enabled: args.enabled as boolean }];

    const env = await runBulk(
      list,
      async (it) => {
        // setPackEnabled returns { ok:true, disabled } or THROWS — a throw becomes
        // this item's { ok:false, hive, pack, error } via runBulk's keyOf catch.
        await setPackEnabled({
          workspaceId,
          hiveSlug: it.hive,
          packId: it.pack,
          enabled: it.enabled,
        });
        return { ok: true as const, hive: it.hive, pack: it.pack, enabled: it.enabled };
      },
      { keyOf: (it) => ({ hive: it.hive, pack: it.pack }) },
    );
    return bulkContent(env);
  },
});
