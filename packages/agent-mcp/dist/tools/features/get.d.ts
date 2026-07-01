/**
 * features:get — fetch one OR many features by (harness slug, feature id).
 *
 * Returns the full row from `harness_shared.harness_features_consolidated`.
 * For agent use when prompt-injected feature history was capped or when
 * inspecting a non-current feature (cross-feature exploration).
 *
 * Typed via `schemaOf(harness_features_consolidated).select`.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the feature key is the COMPOUND
 * `(slug, feature_id)`. Pass a single `{ slug, feature_id }` for n=1, or
 * `items:[{ slug, feature_id }]` for many → { ok, results:[{ ok, slug,
 * feature_id, feature? | error }], counts }. Each result self-describes its
 * (slug, feature_id), so a not-found / invalid-slug item never poisons the rest
 * and the agent correlates by key (not array position).
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodOptional<z.ZodString>;
    feature_id: z.ZodOptional<z.ZodString>;
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
        slug: z.ZodString;
        feature_id: z.ZodString;
    }, z.core.$strip>>>;
}, z.core.$strip>>;
export default _default;
