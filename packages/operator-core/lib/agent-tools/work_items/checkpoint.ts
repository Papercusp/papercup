/**
 * work_items:checkpoint — the bee's work-item-scoped CHECKPOINT / carry-note write
 * (bee-context-efficiency-2026-06-14 Phase 3 / P-010·P-011·P-012; D-002, D-003).
 *
 * The bee translation of the Queen's self-authored carry-note: a bee writes a
 * compressed snapshot of its in-flight state at a task boundary / on graceful evict.
 * The NEXT invocation on the SAME work-item re-injects it in the spawn/wake-hydration
 * volatile tail (`### Carry-note (your last checkpoint)`, P-011) — so a re-woken bee OR
 * a SUCCESSOR bee after eviction resumes from the checkpoint instead of a cold start.
 * This is what lets fresh-context warm-inject (D-001) drop the grown transcript without
 * losing continuity: the transcript will NOT carry; the checkpoint is the continuity.
 *
 * setHiveCarryNote semantics (D-003): replace-on-write; omitted/blank/null ⇒ CLEARED
 * (the next invocation re-derives from the dossier alone — graceful degradation).
 * WORK-ITEM-scoped (D-002): the note lives on the item, so a successor inherits it.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { getWorkItem, markFeatureProgress } from '../../work-items';

export default defineTool({
  name: 'work_items:checkpoint',
  profile: 'engineer',
  description:
    'Write (or clear) this work-item\'s checkpoint — a compressed snapshot of your in-flight state. ' +
    'Your prior transcript does NOT carry across a task boundary / re-spawn; the checkpoint is your continuity, ' +
    're-injected on the next invocation of this item (yours or a successor\'s). Replace-on-write; blank/omitted clears.',
  guidance: {
    when:
      'At a task boundary or on graceful eviction, before you finish/yield: persist what a successor (or your ' +
      'next fresh-context wake) needs to continue — what is done, what is left, current approach, gotchas, open ' +
      'threads. Keep it COMPRESSED (a digest, not a transcript).',
    notWhen:
      'Mid-task scratch state that the live transcript already holds — checkpoint only the durable, cross-boundary ' +
      'gist. Do not dump file contents or full tool output.',
    chaining: 'work_items:checkpoint { id, checkpoint } before work_items:complete / on yield. Pass blank to clear a stale note.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    /** The compressed in-flight state. Blank / null / omitted ⇒ CLEAR the checkpoint. */
    checkpoint: z.string().max(32000).nullish(),
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // Resolve the harness the item lives under: explicit arg → the caller's scoped
    // harness → a work-item lookup (last resort). The checkpoint store keys on it.
    const c = ctx as { harnessSlug?: string | null; workspaceId?: string | null };
    let harness = args.harness ?? c.harnessSlug ?? null;
    if (!harness) {
      const item = await getWorkItem(args.id).catch(() => null);
      harness = item?.harness ?? null;
    }
    if (!harness) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: `could not resolve a harness for work_item '${args.id}' — pass { harness }` }),
          },
        ],
      };
    }
    try {
      const stored = await setWorkItemCheckpoint(
        { harness, workItemId: args.id, workspaceId: c.workspaceId ?? undefined },
        args.checkpoint,
      );
      // agent-activity-liveness-truth P-001 (D-001/D-004): a non-clear checkpoint write
      // is REAL item-scoped progress — credit it so the item reads as `progressing`, not
      // `stalled`. Fire-and-forget + fail-soft (markFeatureProgress swallows errors and
      // no-ops a holderless/issue row) so a progress bump never breaks the checkpoint write.
      if (stored !== null) void markFeatureProgress(harness, args.id);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, workItemId: args.id, harness, cleared: stored === null, length: stored?.length ?? 0, by: ident.ownerId }),
          },
        ],
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }] };
    }
  },
});
