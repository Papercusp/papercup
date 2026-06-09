/**
 * List audit log entries for the current workspace.
 *
 * v1 is COARSE high-tier: returns every audit row in the workspace.
 * Per-row capability filtering (where an agent sees only rows whose
 * underlying capability they hold) is deferred to v1.5; it requires a
 * `required_capability` column on every audit producer (substrate +
 * plugins), which is fan-out work. For v1, `audit:read` is gated as
 * high-tier in capability-tiers.ts, so the install-time consent prompt
 * surfaces this as substantial trust.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    detail: z.ZodDefault<z.ZodEnum<{
        full: "full";
        summary: "summary";
    }>>;
    actor: z.ZodOptional<z.ZodString>;
    action: z.ZodOptional<z.ZodString>;
    sinceTs: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
    workspace: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export default _default;
