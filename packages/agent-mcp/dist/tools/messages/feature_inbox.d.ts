/**
 * Read messages addressed to a specific feature within a harness.
 *
 * Used by:
 *   - The orchestrator's `feature-history.ts` for prompt injection of
 *     pending feature-addressed messages.
 *   - Agents that want to inspect a non-current feature's inbox via
 *     explicit MCP call.
 *
 * Visibility rule: the caller can ask about any (slug, feature) pair
 * they have `messages:read` for; the tool does not enforce
 * "only-your-own-feature" because the harness-level capability
 * already gates which workspaces a principal can read.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
    feature_id: z.ZodString;
    status: z.ZodDefault<z.ZodEnum<{
        pending: "pending";
        all: "all";
        acknowledged: "acknowledged";
        archived: "archived";
    }>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
