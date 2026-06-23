/**
 * messages:send — send a message to one or more recipient harnesses.
 *
 * Optionally feature-scoped: set `to_feature_id` (+ `from_feature_id`) to
 * address a specific feature's pipeline lane within the recipient; omit
 * them for a harness-level message. (This subsumes the old
 * `messages:feature_send` — one verb, optional feature scope.)
 *
 * Operator uses kind='Directive' (the default for harness-level sends) to
 * instruct a harness to run a role — the existing flow (Directive →
 * supervisor_notes → orchestrator wakes → role runs) does the rest.
 * Feature-scoped sends default to kind='feature-note'.
 *
 * Goes through executeAction (send_message) so identity binding,
 * provenance, and audit are preserved — no HTTP roundtrip.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { executeAction } from '../../execute-action';

function newActionId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
  );
}

const SLUG_RE = /^[a-z0-9._-]+$/i;
const FEATURE_ID_RE = /^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$/;

export default defineTool({
  name: 'messages:send',
  capability: 'messages:write',
  guidance: {
    when: 'Forward a note/directive to another agent. Harness-level: operator → "tell the worker to retry". Feature-scoped: pass `to_feature_id` (+ `from_feature_id`) to post on one feature\'s pipeline thread. Always paraphrase + confirm out loud first; sends are durable.',
    notWhen: 'For a transient agent↔agent ping or handoff use `coord:send` (the live coord_event_log inbox) — messages:send is the DURABLE supervisor→agent directive path (supervisor_notes), a SEPARATE inbox; don\'t cross-wire them (coordination-unification-2026-06-23 P-010). For dispatching WORK use a `<spawn>` tag — messages are notes, spawns are work. For replying in the user\'s chat, just speak. To read replies use `messages:inbox` (feature-scoped via `feature_id`).',
    chaining: 'Read replies with `messages:inbox`; soft-hide a handled message with `messages:dismiss`.',
  },
  args: z.object({
    to: z.array(z.string().min(1)).min(1),
    /** Address the message to a specific feature's lane in the recipient. Omit for a harness-level message. */
    to_feature_id: z.string().regex(FEATURE_ID_RE, 'feature_id must match F-XXX[-NNN]').optional(),
    /** Mark the sending feature (when the author is a feature agent). */
    from_feature_id: z.string().regex(FEATURE_ID_RE, 'feature_id must match F-XXX[-NNN]').optional(),
    /** Defaults to 'Directive' (harness-level) or 'feature-note' (when to_feature_id is set). */
    kind: z.string().optional(),
    subject: z.string().min(1),
    body: z.string().min(1),
    parent_message_id: z.string().optional(),
    reason: z.string().min(10),
  }),
  async handler(args, ctx) {
    const bad = args.to.find((s) => !SLUG_RE.test(s));
    if (bad) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [`invalid slug ${JSON.stringify(bad)}`],
      };
    }
    const kind = args.kind ?? (args.to_feature_id ? 'feature-note' : 'Directive');
    const result = await executeAction(ctx.principal.slug, {
      actionId: newActionId(),
      action: {
        op: 'send_message',
        to: args.to,
        toFeatureId: args.to_feature_id,
        fromFeatureId: args.from_feature_id,
        kind,
        subject: args.subject,
        body: args.body,
        parentMessageId: args.parent_message_id,
        reason: args.reason,
      },
    });
    if (!result.ok) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [`executeAction: ${result.error}${result.detail ? ` (${result.detail})` : ''}`],
      };
    }
    return {
      data: { recipients: args.to, kind, executed: result },
    };
  },
});
