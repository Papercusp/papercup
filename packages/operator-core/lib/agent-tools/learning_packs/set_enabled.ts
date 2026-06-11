/**
 * learning_packs:set_enabled — mute/unmute a pack's injection without
 * uninstalling (learning-packs-2026-06-11 P-009). hive_settings-backed
 * (`learning-packs:disabled`); the pre-turn injection filters disabled packs.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { FLAG_OFF, learningPacksEnabled, text } from './_shared';

export default defineTool({
  name: 'learning_packs:set_enabled',
  capability: 'memory:write',
  description:
    "Enable or disable a learning pack's injection for a hive WITHOUT uninstalling it — the rows stay stored; agents just stop recalling them. Cheap to flip, fully reversible.",
  guidance: {
    when: 'Trying out whether a pack helps, or quarantining one that seems to misdirect agents — before reaching for uninstall.',
    notWhen: 'Permanently removing a pack — learning_packs:uninstall.',
    chaining: 'learning_packs:list { hive } shows enabled state per installed pack.',
  },
  crossWorkspace: true,
  args: z.object({
    hive: z.string().min(1).max(120),
    pack: z.string().min(1).max(120),
    enabled: z.boolean(),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    if (!(await learningPacksEnabled())) return text(FLAG_OFF);
    const workspaceId = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const { setPackEnabled } = await import('../../learning-packs/manage');
    const result = await setPackEnabled({
      workspaceId,
      hiveSlug: args.hive,
      packId: args.pack,
      enabled: args.enabled,
    });
    return text({ ...result, pack: args.pack, enabled: args.enabled });
  },
});
