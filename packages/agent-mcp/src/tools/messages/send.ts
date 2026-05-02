/**
 * Send a message to one or more recipient harnesses. Delegates to the
 * existing `send_message` executeAction verb so identity binding,
 * provenance, and audit are preserved.
 *
 * Operator uses this tool with kind='Directive' to instruct a harness
 * to run a role; the existing flow (Directive → supervisor_notes →
 * orchestrator wakes → role runs) does the rest. v5 explicitly chose
 * this over a new dispatch_role verb.
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  capability: 'messages:write',
  args: z.object({
    to: z.array(z.string().min(1)).min(1),
    kind: z.string().default('Directive'),
    subject: z.string().min(1),
    body: z.string().min(1),
    parentMessageId: z.string().optional(),
    reason: z.string().min(10),
  }),
  async handler(args, ctx) {
    // We want to call the existing executeAction("send_message", { ... })
    // path so all the identity-binding and audit logic in execute-action.ts
    // runs. The bearer used here is the calling principal's bearer; the
    // server derives from_slug = principal.slug.
    //
    // For in-process calls (Operator/Oracle), we'd ideally invoke
    // executeAction() directly. v5 ships a wire-call to /api/admin/execute-action
    // for now to keep the substrate's audit path single-sourced; future
    // optimization may add a typed in-process entrypoint.
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
        to: args.to,
        kind: args.kind,
        subject: args.subject,
        body: args.body,
        parentMessageId: args.parentMessageId,
        reason: args.reason,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return {
        data: null,
        degraded: true,
        degradedReasons: [`executeAction returned ${r.status}: ${text}`],
      };
    }
    const result = await r.json().catch(() => ({}));
    return {
      data: {
        recipients: args.to,
        kind: args.kind,
        executed: result,
      },
    };
  },
});
