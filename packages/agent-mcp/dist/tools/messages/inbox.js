/**
 * messages:inbox — read messages addressed to a harness, or (with
 * `feature_id`) to a specific feature's pipeline lane within it.
 *
 * Reads `harness_<slug>.messages`:
 *   - no feature_id  → harness-level messages (to_feature_id IS NULL):
 *                      directives, worker replies, harness notes.
 *   - feature_id set → that feature's thread (to_feature_id = feature_id).
 *
 * (Subsumes the old `messages:feature_inbox` — one verb, optional feature
 * scope.)
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
// No dots: the slug feeds a schema IDENTIFIER below, and a dot would survive
// into it (postgres-js splits dotted identifiers into qualified parts) —
// harness slugs are [a-z0-9-] per migration 044's derivation (audit P-029).
const SLUG_RE = /^[a-z0-9_-]+$/i;
const FEATURE_ID_RE = /^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$/;
export default defineTool({
    name: 'messages:inbox',
    capability: 'messages:read',
    guidance: {
        when: 'What\'s pending for me? Harness-level messages (directives, worker replies) — or pass `feature_id` for one feature\'s thread.',
        notWhen: 'For sent items use `messages:outbox`. To soft-hide a handled message use `messages:dismiss`.',
    },
    args: z.object({
        slug: z.string().min(1),
        /** Scope to one feature's thread. Omit for harness-level messages. */
        feature_id: z.string().regex(FEATURE_ID_RE, 'feature_id must match F-XXX[-NNN]').optional(),
        detail: z.enum(['summary', 'full']).default('summary'),
        status: z.enum(['pending', 'acknowledged', 'archived', 'all']).default('pending'),
        limit: z.number().int().positive().max(200).default(50),
    }),
    // Output schema (token-efficient-tool-result-formats P-011) — mirrors
    // audit:list: the default `summary` shape is a flat array of scalar rows,
    // which unlocks CSV (the densest format) + the MCP `outputSchema`
    // advertisement. `detail: 'full'` returns the wider raw rows (incl.
    // `body`/`parent_message_id`); the serializer's runtime flatness check
    // downgrades those to TOON gracefully, so declaring the summary shape is
    // correct + lossless for both modes. `feature` is nullable (harness-level
    // messages have no feature lane).
    result: z.array(z.object({
        id: z.string(),
        from: z.string(),
        feature: z.string().nullable(),
        kind: z.string(),
        subject: z.string(),
    })),
    async handler(args, ctx) {
        if (!SLUG_RE.test(args.slug)) {
            return {
                data: [],
                degraded: true,
                degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`],
            };
        }
        // Per-harness schemas are `harness_<lower-slug, hyphens→underscores>`
        // (migration 044's `'harness_' || lower(replace(slug,'-','_'))`). Slug
        // is validated above; the catch-all replace additionally guarantees the
        // identifier is a single plain segment (resources/harness/issues.ts
        // pattern, audit P-029).
        const schemaIdent = ctx.tx(`harness_${args.slug.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`);
        const statusFilter = args.status === 'all' ? null : args.status;
        const featureFilter = args.feature_id ?? null;
        let rows = [];
        try {
            rows = await ctx.tx `
        SELECT id, created_at, from_slug, from_feature_id, to_role, to_feature_id,
               kind, subject, body, status, parent_message_id
          FROM ${schemaIdent}.messages
         WHERE (${statusFilter}::text IS NULL OR status = ${statusFilter})
           AND ( (${featureFilter}::text IS NULL AND to_feature_id IS NULL)
                  OR to_feature_id = ${featureFilter} )
         ORDER BY created_at DESC
         LIMIT ${args.limit}
      `;
        }
        catch (err) {
            return {
                data: [],
                degraded: true,
                degradedReasons: [
                    `harness_${args.slug}.messages not readable: ${err instanceof Error ? err.message : String(err)}`,
                ],
            };
        }
        if (args.detail === 'summary') {
            return {
                data: rows.map((r) => ({
                    id: r.id,
                    from: r.from_slug,
                    feature: r.to_feature_id,
                    kind: r.kind,
                    subject: r.subject,
                })),
            };
        }
        return { data: rows };
    },
});
