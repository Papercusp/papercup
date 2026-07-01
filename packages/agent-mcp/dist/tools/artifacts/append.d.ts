/**
 * artifacts:append — append to one OR many PG-canonical text artifacts.
 *
 * Concatenates `suffix` to the existing `content`. If the row doesn't
 * exist yet, creates it with `suffix` as the initial content. Returns
 * the post-append byte length so callers can detect overflow without a
 * follow-up `load`.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the artifact key is the COMPOUND
 * `(slug, rel_path)` (slug defaults to the spawn ctx's harness), and `suffix`
 * rides per item. Pass a single `{ slug?, rel_path, suffix }` for n=1, or
 * `items:[{ slug?, rel_path, suffix }]` for many → { ok, results:[{ ok, slug,
 * rel_path, appended_bytes, total_bytes, updated_at | error }], counts }. Each
 * result self-describes its (slug, rel_path); a missing-slug / invalid-slug
 * item fails only itself.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef/src/types").RoleToolDefinition<z.ZodObject<{
    slug: z.ZodOptional<z.ZodString>;
    rel_path: z.ZodOptional<z.ZodString>;
    suffix: z.ZodOptional<z.ZodString>;
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
        slug: z.ZodOptional<z.ZodString>;
        rel_path: z.ZodString;
        suffix: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>, import("@papercusp/tooldef/src/tool-projection").EventsSchema>;
export default _default;
