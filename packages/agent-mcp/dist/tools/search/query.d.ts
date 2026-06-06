/**
 * Federated search across workspace state.
 *
 * Uses Postgres full-text search (tsvector + GIN, set up by 013-fts-indexes.sql)
 * when the `_search` column is available on each table. Falls back to ILIKE
 * substring search if the columns don't exist yet (i.e. before 013 is applied).
 *
 * jsonb columns (audit_log.details) are not searched in v1; FTS over jsonb
 * requires a generated text-flattened column deferred to v1.5.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
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
