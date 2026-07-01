/**
 * harness:status — live status of one OR many harnesses (current iteration
 * phase, recent activity, in-flight work). "What is harness X doing right now?"
 *
 * Resolves each slug against the **harness registry** first (the runtime
 * store-of-record `harness:create` writes), falling back to the org-level
 * `harness_shared.projects` row for status/budget when one exists. Before
 * autoloop-pot-operator-rebuild-2026-06-05 P-004 this tool read ONLY the
 * projects table, so a freshly-created harness's own read-back returned
 * "not found" — the Pot could create a harness it then couldn't see.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `slug` for one or
 * `slugs` for several → { ok, results:[{ ok, slug, ...status | error }], counts }.
 * Each result self-describes its slug, so a not-found harness never poisons the
 * rest and the Queen/overwatch polling all members reads by slug (not array
 * position). The registry is read ONCE for the whole batch.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodOptional<z.ZodString>;
    slugs: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>>;
export default _default;
