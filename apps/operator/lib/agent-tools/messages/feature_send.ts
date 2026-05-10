/**
 * messages:feature_send — send a message addressed to a specific
 * feature within a recipient harness (per-feature lane).
 *
 * Calls executeAction() in lib/execute-action.ts directly — no HTTP
 * roundtrip. Same identity-binding + audit path as messages:send.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { executeAction } from '@/lib/execute-action';

function newActionId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
  );
}

const SLUG_RE = /^[a-z0-9._-]+$/i;
const FEATURE_ID_RE = /^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$/;

export default defineTool({
  name: 'messages:feature_send',
  capability: 'messages:write',
  args: z.object({
    to_slug: z.string().min(1),
    to_feature_id: z.string().regex(FEATURE_ID_RE, 'feature_id must match F-XXX[-NNN]'),
    from_feature_id: z.string().regex(FEATURE_ID_RE, 'feature_id must match F-XXX[-NNN]'),
    kind: z.string().default('feature-note'),
    subject: z.string().min(1),
    body: z.string().min(1),
    parent_message_id: z.string().optional(),
    reason: z.string().min(10),
  }),
  async handler(args, ctx) {
    if (!SLUG_RE.test(args.to_slug)) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [`invalid slug ${JSON.stringify(args.to_slug)}`],
      };
    }
    const result = await executeAction(ctx.principal.slug, {
      actionId: newActionId(),
      action: {
        op: 'send_message',
        to: [args.to_slug],
        toFeatureId: args.to_feature_id,
        fromFeatureId: args.from_feature_id,
        kind: args.kind,
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
    return { data: result };
  },
});
