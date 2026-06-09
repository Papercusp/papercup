/**
 * coord:wake-queue — review a manual-mode agent's STAGED wakes (the pause/edit
 * gate's review surface, hive-agent-tabs-psu-tui-2026-06-09 P-009 / D-005).
 *
 *   list    — the agent's pending wakes, oldest-first.
 *   release — deliver ONE (as-is, or `edited` content) to the agent as its next
 *             turn (emits the inbox-wake), then drops it from the queue.
 *   skip    — discard ONE without delivering.
 *
 * Wakes land here only when the agent's wake-mode is `manual` AND HIVE_AGENT_TABS
 * is on (the staging happens in wakeRecipients, P-007) — so this is inert until
 * that gate stages something.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../roles';
import { listPendingWakes, releasePendingWake } from '../pending-wakes';
import { inboxWakeKey } from '../inbox-wake';
import { emitAwaitedEvent } from '../../../events/await/engine';

export default defineTool({
  name: 'coord:wake-queue',
  description:
    "Review a manual-mode agent's STAGED wakes: list them, release one (deliver as-is or edited as the agent's next turn), or skip one (discard). The pause/edit gate's review surface (hive-agent-tabs D-005 / P-009).",
  guidance: {
    when: "Reviewing a manual-mode agent's staged wakes from its pane — releasing the ones to deliver (optionally edited) and skipping the rest.",
    notWhen: 'An auto-mode agent — its wakes fire immediately, nothing is staged. Changing the mode itself — that\'s coord:wake-mode.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z.string().min(1).describe('The agent owner id whose staged wakes to act on.'),
    action: z
      .enum(['list', 'release', 'skip'])
      .default('list')
      .describe('list (default) | release (deliver) | skip (discard).'),
    id: z
      .number()
      .int()
      .optional()
      .describe('The pending-wake id — required for release / skip.'),
    edited: z
      .string()
      .optional()
      .describe('Edited content to deliver instead of the staged summary (release only).'),
  }),
  async handler(args) {
    if (args.action === 'list') {
      const pending = await listPendingWakes(args.agent);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, pending }) }],
      };
    }
    if (args.id == null) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, reason: 'id-required', action: args.action }),
          },
        ],
      };
    }
    if (args.action === 'skip') {
      await releasePendingWake(args.id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, skipped: args.id }) }],
      };
    }
    // release: find the staged wake, deliver it (emit the inbox-wake — this bypasses
    // the manual gate because the owner has explicitly chosen to release), then drop it.
    const pw = (await listPendingWakes(args.agent)).find((p) => p.id === args.id);
    if (!pw) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'not-found', id: args.id }) },
        ],
      };
    }
    const res = await emitAwaitedEvent({
      key: inboxWakeKey(args.agent),
      summary: args.edited ?? pw.summary ?? undefined,
      payload: pw.payload,
      source: pw.source ?? undefined,
      workspaceId: pw.workspaceId ?? undefined,
    });
    await releasePendingWake(args.id);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: true, released: args.id, woken: res.woken }) },
      ],
    };
  },
});
