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
    when: 'Forward a DURABLE note/directive to another agent (operator → "tell the worker to retry"). Feature-scoped: pass `to_feature_id` (+`from_feature_id`) to post on a feature\'s pipeline thread.',
    notWhen: 'A transient agent↔agent ping/handoff → `coord:send` (the live coord inbox); messages:send is the DURABLE supervisor→agent path (supervisor_notes), a SEPARATE inbox — don\'t cross-wire (coordination-unification-2026-06-23 P-010). Dispatch WORK via a `<spawn>` tag, not a message.',
    chaining: 'Read replies with `messages:inbox`; soft-hide a handled one with `messages:dismiss`.',
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
  // Output schema (token-efficient-tool-result-formats P-011): a flat,
  // non-redundant PROJECTION of the send result — `recipients` + `kind` +
  // the new `messageIds`. Declaring it advertises the MCP `outputSchema`
  // and unlocks field projection / the compact wire formats. Replaces the
  // old `executed: <raw ExecuteActionResult>` blob, which nested an always-
  // empty `actionId` and a `recipient` already echoed in `recipients` —
  // pure token tax (no caller reads the MCP tool's wrapper; OperatorPanel
  // reads the raw HTTP `result.inserted` directly, not this).
  result: z.object({
    recipients: z.array(z.string()),
    kind: z.string(),
    messageIds: z.array(z.string()),
    placeholderReason: z.boolean().optional(),
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
    const executed = await executeAction(ctx.principal.slug, {
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
    if (!executed.ok) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [`executeAction: ${executed.error}${executed.detail ? ` (${executed.detail})` : ''}`],
      };
    }
    // doSendMessage returns result.inserted = [{ recipient, messageId }];
    // project to just the new ids (recipients is echoed above). `?.` keeps
    // it robust to callers/mocks that resolve a bare `{ ok: true }`.
    const inserted = (executed.result?.inserted ?? []) as Array<{ recipient: string; messageId: string }>;
    return {
      data: {
        recipients: args.to,
        kind,
        messageIds: inserted.map((row) => row.messageId),
        ...(executed.result?.placeholder_reason_flag ? { placeholderReason: true } : {}),
      },
    };
  },
});
