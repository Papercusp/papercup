/**
 * Get a single feature by (harness slug, feature id).
 *
 * Returns the full row from `harness_shared.harness_features_consolidated`.
 * For agent use when prompt-injected feature history was capped or when
 * inspecting a non-current feature (cross-feature exploration).
 *
 * Typed via `schemaOf(harness_features_consolidated).select`.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
    feature_id: z.ZodString;
}, z.core.$strip>>;
export default _default;
