/**
 * learning_packs:uninstall — remove a pack's rows from a hive's shared memory
 * (learning-packs-2026-06-11 P-009). Provenance-driven; user-edited rows are
 * kept by default (they're the user's words now).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAG_OFF, learningPacksEnabled, text } from './_shared';

export default defineTool({
  name: 'learning_packs:uninstall',
  capability: 'memory:write',
  description:
    "Remove a learning pack's rows from a hive's shared memory (provenance-driven). Rows the user edited since seeding are KEPT by default and reported; keepEdited: false removes those too. Organic (hive-learned) rows are never touched.",
  guidance: {
    when: 'The user wants a pack gone from a pot, or before re-installing a pack from scratch.',
    notWhen:
      'To temporarily mute a pack — learning_packs:set_enabled { enabled: false } keeps the rows and just stops injecting them.',
    chaining: 'learning_packs:list { pot } shows what remains; kept edited rows are listed in the response.',
    seeAlso: [
      'learning_packs:set_enabled (quarantine instead of removing)',
      'learning_packs:list (see what remains after)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    pot: z.string().min(1).max(120),
    pack: z.string().min(1).max(120),
    keepEdited: z.boolean().optional().describe('Default true — edited rows survive the uninstall.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args) {
    if (!(await learningPacksEnabled())) return text(FLAG_OFF);
    const { loadLearningPack } = await import('../../learning-packs/load-packs');
    const { uninstallPack } = await import('../../learning-packs/manage');
    const loaded = await loadLearningPack(args.pack);
    const result = await uninstallPack({
      hiveSlug: args.pot,
      packId: args.pack,
      pack: loaded?.pack ?? null,
      ...(args.keepEdited !== undefined ? { keepEdited: args.keepEdited } : {}),
    });
    return text({ ...result });
  },
});
