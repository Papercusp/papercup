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
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    to: z.ZodArray<z.ZodString>;
    kind: z.ZodDefault<z.ZodString>;
    subject: z.ZodString;
    body: z.ZodString;
    parentMessageId: z.ZodOptional<z.ZodString>;
    reason: z.ZodString;
}, z.core.$strip>>;
export default _default;
