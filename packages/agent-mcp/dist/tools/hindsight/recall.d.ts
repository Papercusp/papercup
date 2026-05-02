/**
 * Recall memories from the workspace's Hindsight bank.
 *
 * Bank ID is auth-derived: workspace registry's `companyId` field
 * resolves to `paperclip::<companyId>`. Body-supplied scope is rejected.
 * If the workspace has no `companyId`, returns degraded with empty
 * results — does not throw.
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    query: z.ZodString;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
