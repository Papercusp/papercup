/**
 * Update a task in a harness.
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    harnessSlug: z.ZodString;
    id: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    summary: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodString>;
    reason: z.ZodString;
}, z.core.$strip>>;
export default _default;
