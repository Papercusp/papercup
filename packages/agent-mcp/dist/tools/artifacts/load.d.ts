/**
 * artifacts:load — read one OR many PG-canonical text artifacts for a harness.
 *
 * Same store as `apps/operator/lib/text-artifacts.ts` (Migration 035):
 * `harness_shared.harness_text_artifacts`, keyed (harness_slug, rel_path).
 * Used for memory/*.md, supervisor-notes.md, issues.md, and other free-
 * form per-harness text. Role-gated; agents may read across harnesses
 * by passing an explicit `slug`.
 *
 * The `rel_path` may be passed with or without a leading `.papercusp/`;
 * it's normalised to the bare relative-to-harness-dir form for lookup.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the artifact key is the COMPOUND
 * `(slug, rel_path)` (slug defaults to the spawn ctx's harness). Pass a single
 * `{ slug?, rel_path }` for n=1, or `items:[{ slug?, rel_path }]` for many →
 * { ok, results:[{ ok, slug, rel_path, found, content, updated_at | error }],
 * counts }. Each result self-describes its (slug, rel_path); a missing-slug /
 * invalid-slug item fails only itself.
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
