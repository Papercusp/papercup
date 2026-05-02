/**
 * Federated search across workspace state.
 *
 * v1: Postgres LIKE-based search across text columns. Phase E upgrades
 * to FTS via tsvector indexes. jsonb columns (audit details) are
 * excluded in v1; deferred to v1.5 with generated text columns.
 */
import { z } from 'zod';
declare const _default: import("../..").ToolDefinition<z.ZodObject<{
    query: z.ZodString;
    kinds: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        messages: "messages";
        projects: "projects";
        goals: "goals";
        tasks: "tasks";
        audit: "audit";
    }>>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
