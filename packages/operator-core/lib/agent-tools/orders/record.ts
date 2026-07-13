/**
 * orders:record — file an explicit OWNER DIRECTIVE, verbatim, into the
 * first-class owner-directives store (EI-11484).
 *
 * Recording is agent-EXPLICIT by owner ruling ("lets just have the agent
 * record the directive. they should decide what to keep") — there is no
 * auto-capture and no imperative detection. What the agent judges to be an
 * owner order gets filed HERE, not demoted to checkpoint prose: an open row
 * renders ABOVE the loop agenda in every wake, every orient, and every
 * post-compaction anchor until orders:disposition closes it — the re-injection
 * surface fresh owner directives lacked (the priority inversion that buried
 * the 2026-07-13 resume-sessions order).
 *
 * PROVENANCE: the verbatim text is verified server-side against the caller's
 * own transcript's HUMAN turns (the relay-provenance tier-3 machinery). A miss
 * still records — refusing would re-create the drop — but the result carries a
 * loud `unverified` so a paraphrase can't masquerade as owner words.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  recordOwnerDirective,
  countOpenOwnerDirectives,
  OWNER_DIRECTIVE_VERBATIM_MAX,
} from '../../owner-directives';

export default defineTool({
  name: 'orders:record',
  profile: 'engineer',
  description:
    "Record an explicit OWNER DIRECTIVE verbatim into the durable owner-directives store. The open row renders ABOVE your loop agenda in every wake, orient, and post-compaction anchor — across session death — until orders:disposition closes it. The verbatim text is verified against your transcript's human turns (a miss records loudly as unverified).",
  guidance: {
    when:
      "The owner just issued you an order/directive ('do X', 'stop Y', 'implement Z now') — file it THE MOMENT it lands, verbatim, before starting the work. You decide what rises to a directive; when in doubt about whether it will survive your loop agenda, record it.",
    notWhen:
      'Your own notes-to-self or self-imposed discipline (loop:checkpoint / work_items:checkpoint), a peer request (coord messages), a standing conclusion (facts:assert). Never paraphrase — the field is the owner\'s literal words.',
    chaining:
      'orders:record when the order lands → work it → orders:disposition { id, status, note } when done or declined. orders:list { open: true } shows what you still owe.',
    seeAlso: ['orders:disposition (close one)', 'orders:list (open set)', 'orders:get (full verbatim)'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    verbatim: z
      .string()
      .min(4)
      .max(OWNER_DIRECTIVE_VERBATIM_MAX)
      .describe("The owner's directive VERBATIM — their literal words, never your paraphrase."),
    sourceTurnRef: z
      .string()
      .max(300)
      .optional()
      .describe('Optional pointer to the OWNER (interactive) turn it came from (session id / turn ts / msg id).'),
    ownerName: z
      .string()
      .max(120)
      .optional()
      .describe("Who gave the order (default 'owner' — the single-owner default)."),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId() ?? 'default';

    // Tier-3 provenance: does this exact text appear as a HUMAN turn in the
    // caller's own transcript? Best-effort — an IO miss degrades the stamp,
    // never blocks the record (a dropped record is the failure this tool fixes).
    let provenance = 'unverified';
    let sessionRef: string | null = null;
    let verifiedTurnRef: string | null = null;
    try {
      const { resolveRelayProvenance } = await import('../coordination/relay-provenance-resolve');
      const { stamp } = await resolveRelayProvenance(identity, { relayQuote: args.verbatim });
      if (stamp?.tier === 'owner-verified-transcript' || stamp?.tier === 'owner-verified-turn') {
        provenance = stamp.tier;
        sessionRef = stamp.sessionId ?? null;
        verifiedTurnRef = [stamp.sessionId, 'turnTs' in stamp ? stamp.turnTs : null].filter(Boolean).join('@') || null;
      }
    } catch {
      /* stamp stays unverified */
    }

    const row = await recordOwnerDirective({
      workspaceId,
      ownerId: args.ownerName,
      sessionRef,
      sourceTurnRef: args.sourceTurnRef ?? verifiedTurnRef,
      verbatimText: args.verbatim,
      recordedBy: identity.ownerId,
    });
    const openCount = await countOpenOwnerDirectives(workspaceId).catch(() => null);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            id: row.id,
            provenance,
            ...(openCount != null ? { openCount } : {}),
            note:
              provenance === 'unverified'
                ? 'RECORDED, but the text was NOT found as a human turn in your transcript — confirm these are the owner\'s literal words, not your paraphrase. It renders above your agenda every wake until orders:disposition.'
                : 'Recorded (owner-turn verified). It renders above your agenda every wake until orders:disposition closes it.',
          }),
        },
      ],
    };
  },
});
