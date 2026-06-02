/**
 * Recall memories from the workspace's Hindsight bank.
 *
 * **DEPRECATED 2026-05-09.** No live writers populate the Hindsight bank
 * for harness workflows; this tool returns useless empty results in
 * practice and competes with the `features:*` MCP tools (which are the
 * canonical agent-side memory surface). Scheduled for removal one
 * release after agent traffic is verified to have moved off it.
 *
 * If you reach this code from a tool dispatch in production, file an
 * issue with the calling agent so we can route them to `features:get`
 * / `features:history` / `features:search` instead.
 *
 * Bank ID is auth-derived: workspace registry's `companyId` field
 * resolves to `paperclip::<companyId>`. Body-supplied scope is rejected.
 * If the workspace has no `companyId`, returns degraded with empty
 * results — does not throw.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    query: z.ZodString;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
