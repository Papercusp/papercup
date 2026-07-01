/**
 * artifacts:save — upsert one OR many PG-canonical text artifacts.
 *
 * Replaces the entire `content` for (harness_slug, rel_path). PG is
 * canonical (per the "PG-canonical, no FS mirrors" project rule); no
 * disk write happens here. If a consumer needs the content on disk
 * (orchestrator prompt assembly, harness-CLI), it should read from PG
 * via `artifacts:load` rather than tail a file.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the artifact key is the COMPOUND
 * `(slug, rel_path)` (slug defaults to the spawn ctx's harness), and `content`
 * rides per item. Pass a single `{ slug?, rel_path, content }` for n=1, or
 * `items:[{ slug?, rel_path, content }]` for many → { ok, results:[{ ok, slug,
 * rel_path, bytes, updated_at | error }], counts }. Each result self-describes
 * its (slug, rel_path); a missing-slug / invalid-slug item fails only itself.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef/src/types").RoleToolDefinition<z.ZodObject<{
    slug: z.ZodOptional<z.ZodString>;
    rel_path: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
        slug: z.ZodOptional<z.ZodString>;
        rel_path: z.ZodString;
        content: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>, import("@papercusp/tooldef/src/tool-projection").EventsSchema>;
export default _default;
