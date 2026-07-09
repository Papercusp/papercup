/**
 * learning_packs:list — the pack catalog + (optionally) one hive's installed
 * state (learning-packs-2026-06-11 P-009).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { FLAG_OFF, learningPacksEnabled, text } from './_shared';

export default defineTool({
  name: 'learning_packs:list',
  capability: 'memory:read',
  description:
    "List resolvable learning packs (builtin + Comb-installed) and, when `pot` is given, that hive's installed state: per-pack rows present/edited, enabled/disabled, and whether a newer pack version is adoptable.",
  guidance: {
    when:
      "Before learning_packs:install/upgrade (what's available + what's already in the hive), or when the user asks what learnings their hive carries.",
    notWhen:
      'To read the actual learning texts — learning.hive backs the Learnings UI, and memory:list { hive_slug } returns the rows.',
    chaining:
      'learning_packs:install { pot, pack } to add one; learning_packs:upgrade when updateAvailable; learning_packs:set_enabled to mute a pack without uninstalling.',
    seeAlso: [
      'learning_packs:install (add a pack)',
      'learning_packs:upgrade (when a pack shows updateAvailable)',
      'learning_packs:set_enabled (mute a pack without uninstalling)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    pot: z.string().max(120).optional().describe("Pot home slug — include this pot's installed state."),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    if (!(await learningPacksEnabled())) return text(FLAG_OFF);
    const workspaceId = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const { listLearningPacks } = await import('../../learning-packs/load-packs');
    const packs = await listLearningPacks();

    if (!args.pot) return text({ ok: true, packs });

    const [{ readHiveLearnings }, { getMemoryBackend }, { loadLearningPack }, { disabledPacksFor }] =
      await Promise.all([
        import('../../sync-resolver/learning-hive-read'),
        import('../../memory/backend'),
        import('../../learning-packs/load-packs'),
        import('../../learning-packs/manage'),
      ]);
    const snap = await readHiveLearnings(args.pot, {
      listPool: async (scope) => {
        const backend = getMemoryBackend();
        const avail = await backend.available();
        if (!avail.ok) throw new Error(avail.reason);
        return backend.list({ scope });
      },
      loadPack: (id) => loadLearningPack(id),
    });
    const { semverGt } = await import('../../learning-packs/pack-format');
    const disabled = await disabledPacksFor(workspaceId, args.pot);
    const installed = snap.packs.map((p) => {
      const availableVersion = packs.find((a) => a.id === p.packId)?.version;
      return {
        ...p,
        enabled: !disabled.includes(p.packId),
        updateAvailable: semverGt(availableVersion, p.packVersion),
        availableVersion,
      };
    });
    return text({
      ok: true,
      packs,
      pot: args.pot,
      installed,
      organicCount: snap.organicCount,
      ...(snap.unavailable ? { unavailable: true } : {}),
    });
  },
});
