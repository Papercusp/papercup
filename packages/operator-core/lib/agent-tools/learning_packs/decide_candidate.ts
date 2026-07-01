/**
 * learning_packs:decide_candidate — the owner's adopt/dismiss on one OR many
 * staged fleet→pack candidates (self-improvement-consume-edges-2026-06-12 P-032,
 * brief B-11; bulk-standardized per bulk-endpoint-standardization-2026-06-21).
 *
 * Adoption materializes the (optionally owner-edited) draft into the
 * fleet-lessons pack under the installed packs root and bumps the pack's
 * patch version — it NEVER writes a hive's memory pool. Hives adopt the new
 * item through the existing learning_packs:install/upgrade conflict review.
 *
 * Bulk by default (the house keyed-array contract): decide ONE inline ({ id,
 * action, note?, title?, text? }), MANY with the SAME action (ids:[…] + action),
 * or MANY heterogeneous (items:[{ id, action, note?, title?, text? }]) → { ok,
 * results:[{ ok, id, action?, … | error }], counts }. Each result self-describes
 * its id; one bad candidate never fails the rest. Owner-edited title/text apply
 * per-candidate, so use the inline single or items[] form when editing.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { getSessionUserOrDefault } from '../../auth';
import { FLAG_OFF, learningPacksEnabled, text } from './_shared';
import { runBulk, bulkContent } from '../_bulk';
import { hardText, softText, clampText, LIMITS } from '../limits';

const ACTION = z.enum(['adopt', 'dismiss']);

const itemSpec = z.object({
  id: z.string().min(1).max(80).describe('Candidate id (from learning_packs:candidates).'),
  action: ACTION,
  note: softText(LIMITS.ANNOTATION).optional().describe('Decision note recorded on the candidate. Auto-truncated to 2000 chars if longer.'),
  title: hardText(LIMITS.SHORT_TITLE).optional().describe('Owner-edited title (adopt only).'),
  text: hardText(8000).optional().describe('Owner-edited lesson body (adopt only).'),
});

type DecideItem = z.infer<typeof itemSpec>;

const ADOPT_HINT =
  'Adopted into the fleet-lessons pack. Hives with the pack installed now show updateAvailable (adopt via learning_packs:upgrade); others can learning_packs:install it — both through the normal conflict review.';

export default defineTool({
  name: 'learning_packs:decide_candidate',
  capability: 'memory:write',
  description:
    'Decide one OR many pending learning-pack candidates: adopt (write it into the fleet-lessons pack — version bumps so hives see updateAvailable; optionally edit title/text first) or dismiss (terminal — the signature never re-stages). This is an OWNER decision; candidates are never auto-published. Single: { id, action, note?, title?, text? }. Many same action: { ids:[…], action }. Many heterogeneous: items:[{ id, action, note?, title?, text? }]. Returns { ok, results:[{ ok, id, action?, … | error }], counts } — correlate by id, not by position; one bad candidate never fails the rest.',
  guidance: {
    when:
      'The owner has reviewed pending candidate(s) (learning_packs:candidates) and says adopt/dismiss — or asks you to apply their edits while adopting. Decide several at once via ids:[…]+action or items:[…].',
    notWhen:
      'To seed a lesson into a hive pool directly (adoption only updates the PACK; hives adopt via learning_packs:install/upgrade). Unprompted bulk adoption — each candidate is an explicit owner call.',
    chaining:
      'learning_packs:candidates first (ids + drafts). After adopt: hives with fleet-lessons installed show updateAvailable → learning_packs:upgrade { hive, pack: "fleet-lessons" }; others via learning_packs:install. Bulk: single | items[] (or ids) → { ok, results, counts }; correlate by id not position; one failure never fails the rest.',
    seeAlso: [
      'learning_packs:candidates (the candidate pool + drafts)',
      'learning_packs:upgrade (hives adopt the accepted item)',
    ],
  },
  crossWorkspace: true,
  args: z
    .object({
      id: z.string().min(1).max(80).optional().describe('single-decide shorthand: the candidate id'),
      action: ACTION.optional().describe('applies to the inline id / every id in `ids`'),
      note: softText(LIMITS.ANNOTATION).optional().describe('decision note for the inline id / every id in `ids`. Auto-truncated to 2000 chars if longer.'),
      title: hardText(LIMITS.SHORT_TITLE).optional().describe('Owner-edited title for the inline id (adopt only).'),
      text: hardText(8000).optional().describe('Owner-edited lesson body for the inline id (adopt only).'),
      ids: z.array(z.string().min(1).max(80)).min(1).max(100).optional().describe('decide MANY candidates with the same `action` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(100).optional().describe('decide many candidates at once — each { id, action, note?, title?, text? }'),
      workspace: z.string().max(120).optional(),
    })
    .refine(
      (a) => (a.items?.length ?? 0) > 0 || (Boolean(a.action) && ((a.ids?.length ?? 0) > 0 || Boolean(a.id))),
      {
        message: 'pass { id, action } for one, { ids:[…], action } for many of the same action, or items:[{ id, action }] for many',
      },
    ),
  async handler(args, ctx) {
    if (!(await learningPacksEnabled())) return text(FLAG_OFF);
    const workspaceId = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const by = (await getSessionUserOrDefault()).id;
    const { decideLearningPackCandidate } = await import('../../learning-packs/candidates');

    const list: DecideItem[] = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, action: args.action as z.infer<typeof ACTION>, note: args.note }))
        : [{ id: args.id as string, action: args.action as z.infer<typeof ACTION>, note: args.note, title: args.title, text: args.text }];

    const env = await runBulk(
      list,
      async (it) => {
        const result = await decideLearningPackCandidate({
          id: it.id,
          action: it.action,
          by,
          ...(it.note ? { note: clampText(it.note, LIMITS.ANNOTATION) } : {}),
          ...(it.title ? { title: it.title } : {}),
          ...(it.text ? { text: it.text } : {}),
          workspaceId,
        });
        if (!result.ok) {
          return { ok: false as const, id: it.id, reason: result.reason, ...(result.error ? { error: result.error } : {}) };
        }
        // Spread the core result FIRST, then pin the bulk key fields so they win.
        return {
          ...result,
          ...(result.action === 'adopt' ? { hint: ADOPT_HINT } : {}),
          ok: true as const,
          id: it.id,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
