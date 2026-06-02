/**
 * Return the tag vocabulary for a harness — every distinct tag with
 * its usage count, ordered by count DESC.
 *
 * Useful for:
 *   - Scoper proposing new features: pick from existing tags rather
 *     than inventing variants ("auth" vs "Auth" vs "authentication").
 *   - Operator UI tag-input autocomplete.
 *   - Tag-governance review: spot near-duplicate tags before they sprawl.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    slug: z.ZodString;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
