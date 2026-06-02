/**
 * List issues across the workspace. Issues are validator-filed
 * complaints against tasks (per spec §state). Summary returns id +
 * task_id + filed_by; full returns the body.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    detail: z.ZodDefault<z.ZodEnum<{
        summary: "summary";
        full: "full";
    }>>;
    taskId: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
