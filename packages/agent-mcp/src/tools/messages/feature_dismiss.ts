/**
 * Mark a feature-addressed message as archived (the "dismiss" UX).
 *
 * Routes through executeAction("mark_message_status", ...) so the
 * caller-bearer → from_slug binding and audit row are emitted by the
 * existing path. Tool-side validation: only allow the 'archived'
 * status transition (we don't expose 'acknowledged' as a separate UX
 * verb yet — agents acknowledge implicitly by reading + acting).
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  name: 'messages:feature_dismiss',
  capability: 'messages:write',
  args: z.object({
    /** Message UUID returned by `messages:feature_inbox`. */
    message_id: z.string().min(1),
    reason: z.string().min(10),
  }),
  async handler(args, _ctx) {
    const bearer = process.env.AGENT_MCP_BEARER ?? '';
    const base = process.env.OPERATOR_BASE_URL ?? 'http://localhost:3055';
    const r = await fetch(`${base}/api/admin/execute-action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        op: 'mark_message_status',
        messageId: args.message_id,
        status: 'archived',
        reason: args.reason,
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      return { data: null, degraded: true, degradedReasons: [`execute-action ${r.status}: ${text.slice(0, 200)}`] };
    }
    let parsed: unknown = {};
    try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    return { data: parsed };
  },
});
