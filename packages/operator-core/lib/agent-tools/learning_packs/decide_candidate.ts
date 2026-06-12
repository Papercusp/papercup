/**
 * learning_packs:decide_candidate — the owner's adopt/dismiss on one staged
 * fleet→pack candidate (self-improvement-consume-edges-2026-06-12 P-032,
 * brief B-11).
 *
 * Adoption materializes the (optionally owner-edited) draft into the
 * fleet-lessons pack under the installed packs root and bumps the pack's
 * patch version — it NEVER writes a hive's memory pool. Hives adopt the new
 * item through the existing learning_packs:install/upgrade conflict review.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { getSessionUserOrDefault } from '../../auth';
import { FLAG_OFF, learningPacksEnabled, text } from './_shared';

export default defineTool({
  name: 'learning_packs:decide_candidate',
  capability: 'memory:write',
  description:
    'Decide one pending learning-pack candidate: adopt (write it into the fleet-lessons pack — version bumps so hives see updateAvailable; optionally edit title/text first) or dismiss (terminal — the signature never re-stages). This is an OWNER decision; candidates are never auto-published.',
  guidance: {
    when:
      'The owner has reviewed a pending candidate (learning_packs:candidates) and says adopt/dismiss — or asks you to apply their edits while adopting.',
    notWhen:
      'To seed a lesson into a hive pool directly (adoption only updates the PACK; hives adopt via learning_packs:install/upgrade). Unprompted bulk adoption — each candidate is an explicit owner call.',
    chaining:
      'learning_packs:candidates first (ids + drafts). After adopt: hives with fleet-lessons installed show updateAvailable → learning_packs:upgrade { hive, pack: "fleet-lessons" }; others via learning_packs:install.',
  },
  crossWorkspace: true,
  args: z.object({
    id: z.string().min(1).max(80).describe('Candidate id (from learning_packs:candidates).'),
    action: z.enum(['adopt', 'dismiss']),
    note: z.string().max(2000).optional().describe('Decision note recorded on the candidate.'),
    title: z.string().min(1).max(300).optional().describe('Owner-edited title (adopt only).'),
    text: z.string().min(1).max(8000).optional().describe('Owner-edited lesson body (adopt only).'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    if (!(await learningPacksEnabled())) return text(FLAG_OFF);
    const workspaceId = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const { decideLearningPackCandidate } = await import('../../learning-packs/candidates');
    const result = await decideLearningPackCandidate({
      id: args.id,
      action: args.action,
      by: (await getSessionUserOrDefault()).id,
      ...(args.note ? { note: args.note } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.text ? { text: args.text } : {}),
      workspaceId,
    });
    if (!result.ok) return text({ ok: false, reason: result.reason, ...(result.error ? { error: result.error } : {}) });
    return text({
      ...result,
      ...(result.action === 'adopt'
        ? {
            hint:
              'Adopted into the fleet-lessons pack. Hives with the pack installed now show updateAvailable (adopt via learning_packs:upgrade); others can learning_packs:install it — both through the normal conflict review.',
          }
        : {}),
    });
  },
});
