/**
 * Close a task — sets status to 'done' or 'cancelled'.
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    harnessSlug: z.ZodString;
    id: z.ZodString;
    outcome: z.ZodEnum<{
        done: "done";
        cancelled: "cancelled";
    }>;
    reason: z.ZodString;
}, z.core.$strip>>;
export default _default;
