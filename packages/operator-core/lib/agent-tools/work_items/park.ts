/**
 * work_items:park — shelve a work-item RESUMABLY: checkpoint + release + a
 * one-line coord note, atomically-in-intent (modes-and-intake-ux-2026-07-05
 * P-004; owner idea #0, 2026-07-05).
 *
 * Formalizes the observed fleet vocabulary "parked with a complete resume
 * checkpoint" (the neologism-miner pattern: recurring prose with no
 * primitive). Before this verb, parking was a 2–3 tool dance
 * (work_items:checkpoint → work_items:release → maybe a coord:send) that each
 * agent improvised and nothing could count. park is the named composite:
 *   1. write the checkpoint (the resume state a successor is re-injected with),
 *   2. release the claim (item stays claimable; state untouched — parking is
 *      NOT blocking: use set_state{blocked} for a dependency wall),
 *   3. broadcast a one-line lifecycle note so peers/the Queen see the shelf.
 * The note is best-effort: a coord hiccup never un-parks the item.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { disclosureSubject } from '../_disclosure-subject';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import type { WorkItemCheckpointWithPriorResult } from '../../work-item-checkpoint';
import { blockerDecisionInputSchema, prepareBlockerDecision, type BlockerDecisionRecord } from '../../blocker-resolution-decision';
import { blockerBoundaryContext } from '../../blocker-resolution-evidence';
import {
  CHECKPOINT_BODY_CAP_CHARS,
  mergeCarryRows,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
  withCarryNoteChecks,
  withCarryNoteWalls,
} from '../../carry-note';
import { releaseWorkItem } from '../../work-items';
import { lookupWorkItem } from './_lookup';

/**
 * WI-10004456: park used to REPLACE the whole checkpoint, destroying the history and
 * carried check/wall rows that work_items:checkpoint preserves. Append the update to
 * the prior narrative and merge the structured rows, composed against the locked prior.
 */
function appendParkCheckpoint(prior: string | null, update: string): string {
  const rows = mergeCarryRows({ priorNote: prior, baseNote: update, hasNoteWrite: true, mode: 'merge' });
  if (rows.droppedChecks.length || rows.droppedWalls.length) {
    throw new Error('Parking would drop carried checkpoint rows; checkpoint unchanged and claim retained');
  }
  const priorBody = splitCarryNoteWalls(splitCarryNoteChecks(prior).body).body;
  const body = priorBody ? `${priorBody}\n\n---\n\n${rows.narrativeBody}` : rows.narrativeBody;
  return withCarryNoteWalls(withCarryNoteChecks(body, rows.checks), rows.walls);
}

export default defineTool({
  name: 'work_items:park',
  profile: 'engineer',
  description:
    'Park a work-item to resume later: appends the resume CHECKPOINT, releases your claim, and broadcasts a one-line ' +
    'note — one verb for the checkpoint→release→announce dance. { id, checkpoint, reason, harness? }. The item stays ' +
    'claimable (state untouched); the checkpoint is re-injected on the next pickup (yours or a successor’s).',
  guidance: {
    when:
      'You are deliberately shelving in-flight work to pick something else up (a redirect, a higher-priority item, ' +
      'end of a stint) and intend it to be RESUMED — by you or anyone. The checkpoint should let a cold successor ' +
      'continue without re-deriving: done / left / approach / gotchas.',
    notWhen:
      'The item is DONE (work_items:complete), blocked on an external condition (work_items:set_blocker records the typed reason), ' +
      'blocked by another work-item (work_items:link { rel:"blocks" } records the dependency), ' +
      'or you are abandoning it as wrong/obsolete (set_state{dropped}). Park = "good work, paused on purpose".',
    chaining:
      'work_items:park { id, checkpoint, reason } → later work_items:claim/pickup re-injects the checkpoint. ' +
      'For a do-not-self-select shelf add work_items:release { claimHold:true } semantics via a follow-up release call.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('the work-item id to park'),
    checkpoint: z
      .string()
      .min(20)
      .max(32000)
      .describe('resume update (done / left / approach / gotchas), appended to the existing checkpoint'),
    reason: z.string().min(1).max(500).describe('why you are parking it — broadcast to peers in the park note'),
    harness: z.string().max(80).optional().describe('harness the item lives under (else resolved from the item)'),
    blockerDecision: blockerDecisionInputSchema.optional().describe('Required when parking work with an unresolved blocker; investigation and evidenced resolution or deferral.'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null; workspaceId?: string | null };
    // EI-8805: key the parked checkpoint by the ITEM's OWN harness so it round-trips
    // on re-claim/re-injection. A harness-null item (an EI from an unscoped session)
    // must not be keyed under the session harness — the store canonicalizes a null
    // harness to the shared wildcard namespace the read side resolves it under.
    const hint = args.harness ?? c.harnessSlug ?? undefined;
    const hintHarness = hint && hint !== '*' ? hint : undefined;
    // WI-6746: park's whole purpose is to SAVE state, so a silent loss is the worst
    // outcome here. When the read fails we do not know the item's own harness, and the
    // old fallback wrote the checkpoint under the caller's HINT instead — a different
    // key namespace, which reads back as null forever (the EI-8805 loss mode) while
    // still reporting ok. Refuse loudly and keep the text in the caller's hands: an
    // agent that still has its state can retry, one that trusted a false ok cannot.
    const lookup = await lookupWorkItem(args.id, hintHarness);
    if (lookup.status === 'unreadable') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              id: args.id,
              error:
                `work_item_unreadable — could not read '${args.id}' to resolve its harness (${lookup.error}). ` +
                'Refusing rather than writing your checkpoint under a possibly-wrong harness key, where it would ' +
                'read back as null while reporting success. Your checkpoint text was NOT saved — retry (it is a ' +
                'READ FAILURE, not a missing item).',
            }),
          },
        ],
      };
    }
    const item = lookup.status === 'found' ? lookup.item : null;
    if (!item && !hintHarness) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, id: args.id, error: `could not resolve a harness for work_item '${args.id}' — pass { harness }` }) },
        ],
      };
    }
    const harness: string | null = item ? item.harness ?? null : hintHarness ?? null;
    if (!item) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, id: args.id,
      error: 'not_found', note: 'Checkpoint unchanged; no canonical work-item to park.' }) }] };
    const effect = { park: true, checkpoint: args.checkpoint, reason: args.reason };
    if (args.blockerDecision) {
      const prepared = prepareBlockerDecision(item.payload, args.blockerDecision, {
        ownerId: ident.ownerId, sessionId: ident.ownerId, workItemId: args.id, custodianId: item.assignee,
      }, { effect });
      if (!prepared.ok) return { content: [{ type: 'text' as const, text: JSON.stringify({ ...prepared, id: args.id }) }] };
      if (prepared.replayed) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true,
        id: args.id, blockerDecision: prepared.record, replayed: true }) }] };
    }
    // EI-8824: same wildcard-workspace bug as work_items:checkpoint — c.workspaceId
    // is '*' for an unscoped superuser session and must never be persisted literally.
    let saved: WorkItemCheckpointWithPriorResult | undefined;
    let receipt: { record: BlockerDecisionRecord; replayed: boolean } | undefined;
    let released;
    try {
      released = await releaseWorkItem(args.id, {
        harness: harness ?? undefined, expectedAssignee: ident.ownerId, releasingOwnerId: ident.ownerId,
        blockerEvidenceContext: await blockerBoundaryContext(ctx, ident.ownerId, harness),
        ...(args.blockerDecision ? { blockerDecision: { input: args.blockerDecision,
          sessionId: ident.ownerId, effect } } : {}),
        onBlockerDecision: (value) => { receipt = value; },
        checkpoint: { update: args.checkpoint, onStored: (value) => { saved = value; }, options: {
          latestUpdate: args.checkpoint,
          // Compose against the authoritative locked prior, never a racy pre-read.
          guard: (prior) => {
            const merged = appendParkCheckpoint(prior, args.checkpoint);
            return merged.length > CHECKPOINT_BODY_CAP_CHARS ? 'checkpoint_capacity_exceeded' : null;
          },
          transform: (prior) => appendParkCheckpoint(prior, args.checkpoint),
          // P-012 / D-006: a parker holding a restricted disclosure stores a sealed stub.
          writerOwnerId: disclosureSubject(c),
        } },
      });
    } catch (error) {
      const problem = error as Error & { code?: string; missing?: unknown; nextAction?: unknown; priorLength?: number };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, id: args.id,
        error: problem.code ?? problem.message, missing: problem.missing, nextAction: problem.nextAction,
        priorLength: problem.priorLength,
        note: 'Park did not return a commit receipt; read the canonical work-item and checkpoint before retrying.' }) }] };
    }
    if (receipt?.replayed) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true,
      id: args.id, blockerDecision: receipt.record, replayed: true }) }] };
    if (!released || !saved) return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false,
      id: args.id, error: 'not_holder', note: 'Checkpoint unchanged and current custody retained.' }) }] };
    const { stored, priorLength } = saved;
    // Best-effort lifecycle note (never un-parks on failure).
    let noted = false;
    try {
      await sendMessage(ident, {
        to: ['*'],
        summary: `🅿 ${args.id} parked by ${ident.ownerId} — resume checkpoint saved (${stored?.length ?? 0} chars): ${args.reason.slice(0, 140)}`,
        harnessSlug: harness ?? undefined,
        extra: { auto: true, lifecycle: 'park', work_item: args.id },
      });
      noted = true;
    } catch { /* fail-soft */ }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            id: args.id,
            harness,
            priorLength,
            checkpointChars: stored?.length ?? 0,
            released: Boolean(released),
            noted,
            by: ident.ownerId,
            ...(receipt ? { blockerDecision: receipt.record } : {}),
          }),
        },
      ],
    };
  },
});
