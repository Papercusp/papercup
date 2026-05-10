/**
 * Feature-to-feature message send.
 *
 * Workers on F-X can leave a structured note for F-Y's next worker.
 * Pull-only by design — no scheduler wakes F-Y; it picks up the
 * message when the orchestrator next dispatches a role for F-Y, via
 * the prompt-injected "Messages from other features" section.
 *
 * Routes through executeAction("send_message", ...) so identity
 * binding (caller bearer → from_slug), audit, and rate-limiting are
 * preserved — no parallel persistence path.
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

const SLUG_RE = /^[a-z0-9._-]+$/i;
const FEATURE_ID_RE = /^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$/;

export default defineTool({
  name: 'messages:feature_send',
  capability: 'messages:write',
  args: z.object({
    /** Recipient harness slug. Usually the same harness as the sender. */
    to_slug: z.string().min(1),
    /** Recipient feature ID (the feature being addressed). */
    to_feature_id: z.string().regex(FEATURE_ID_RE, 'feature_id must match F-XXX[-NNN]'),
    /** Sender's feature ID (where the calling worker was operating). */
    from_feature_id: z.string().regex(FEATURE_ID_RE, 'feature_id must match F-XXX[-NNN]'),
    /** Message kind — defaults to 'feature-note' for the per-feature lane. */
    kind: z.string().default('feature-note'),
    subject: z.string().min(1),
    body: z.string().min(1),
    parent_message_id: z.string().optional(),
    reason: z.string().min(10),
  }),
  async handler(args, ctx) {
    if (!SLUG_RE.test(args.to_slug)) {
      return { data: null, degraded: true, degradedReasons: [`invalid slug ${JSON.stringify(args.to_slug)}`] };
    }
    const bearer = process.env.AGENT_MCP_BEARER ?? '';
    const base = process.env.OPERATOR_BASE_URL ?? 'http://localhost:3055';
    const r = await fetch(`${base}/api/admin/execute-action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        op: 'send_message',
        to: [args.to_slug],
        toFeatureId: args.to_feature_id,
        fromFeatureId: args.from_feature_id,
        kind: args.kind,
        subject: args.subject,
        body: args.body,
        parentMessageId: args.parent_message_id,
        reason: args.reason,
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      return { data: null, degraded: true, degradedReasons: [`execute-action ${r.status}: ${text.slice(0, 200)}`] };
    }
    let parsed: unknown = {};
    try { parsed = JSON.parse(text); } catch { /* server returned non-JSON */ }
    return { data: parsed };
  },
});
