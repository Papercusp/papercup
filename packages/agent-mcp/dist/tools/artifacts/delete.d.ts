/**
 * artifacts:delete — remove one OR many PG-canonical text artifacts.
 *
 * Restricted to non-worker roles to keep workers from accidentally
 * dropping a sibling worker's notes mid-chunk. The legacy disk-mirror
 * lib intentionally does NOT unlink the on-disk file when the row is
 * deleted; this tool just drops the PG row. Anything still relying on
 * a stale on-disk copy will be addressed when the orchestrator's
 * prompt assembly is migrated to PG-direct reads.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the artifact key is the COMPOUND
 * `(slug, rel_path)` (slug defaults to the spawn ctx's harness). Pass a single
 * `{ slug?, rel_path }` for n=1, or `items:[{ slug?, rel_path }]` for many →
 * { ok, results:[{ ok, slug, rel_path, deleted | error }], counts }. Each
 * result self-describes its (slug, rel_path); a missing-slug / invalid-slug
 * item fails only itself.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef/src/types").RoleToolDefinition<z.ZodObject<{
    slug: z.ZodOptional<z.ZodString>;
    rel_path: z.ZodOptional<z.ZodString>;
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
        slug: z.ZodOptional<z.ZodString>;
        rel_path: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>, import("@papercusp/tooldef/src/tool-projection").EventsSchema>;
export default _default;
