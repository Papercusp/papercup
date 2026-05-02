/**
 * Create a task in a harness. Delegates to the existing executeAction
 * verb so identity binding and audit are preserved.
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    harnessSlug: z.ZodString;
    title: z.ZodString;
    summary: z.ZodOptional<z.ZodString>;
    goalId: z.ZodOptional<z.ZodString>;
    estimatedCostCents: z.ZodOptional<z.ZodNumber>;
    reason: z.ZodString;
}, z.core.$strip>>;
export default _default;
