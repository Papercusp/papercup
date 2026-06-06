/**
 * Get the live status of a harness — current iteration phase, recent
 * activity, in-flight work. Useful for "what is harness X doing right now?"
 *
 * Resolves the slug against the **harness registry** first (the runtime
 * store-of-record `harness:create` writes), falling back to the org-level
 * `harness_shared.projects` row for status/budget when one exists. Before
 * autoloop-pot-operator-rebuild-2026-06-05 P-004 this tool read ONLY the
 * projects table, so a freshly-created harness's own read-back returned
 * "not found" — the Pot could create a harness it then couldn't see.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
}, z.core.$strip>>;
export default _default;
