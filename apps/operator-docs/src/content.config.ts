import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

/**
 * Normative-insight classification fields (unified-agent-state-plane-2026-07-27
 * P-022, per D-028).
 *
 * Starlight's `docsSchema()` is a Zod object, and Zod STRIPS keys it does not
 * declare — so a frontmatter field that is not listed here is invisible to every
 * Astro-side consumer no matter what the .mdx says. These three are declared so
 * the classification survives into the built docs rather than being silently
 * dropped at parse time.
 *
 * All three are OPTIONAL, and `normative`'s absence means "not a convention".
 * That default-off is deliberate and is NOT a dark feature flag: this classifies
 * existing prose, it does not gate shipped behavior, so the repo's
 * flags-default-ON mandate does not apply.
 *
 * Deliberately NOT declared here: the corpus's existing `discovered` / `tags` /
 * `status` / `documents` fields. They are also stripped today, but declaring them
 * would newly VALIDATE 626 pre-existing docs — one out-of-enum `status:` or
 * unparseable `discovered:` would fail the whole `astro build`. Widening the
 * schema to cover them is a separate, sweep-first change.
 */
const normativeInsightFields = z.object({
  /**
   * True when this doc is a CONVENTION (a rule that can be violated), not an
   * explanatory runbook. Absent ⇒ explanatory, the corpus default.
   * `normative: true` REQUIRES `governs` — enforced by
   * `npm run lint:insight-normative`, since a Zod schema cannot express a
   * conditional-required field without changing this into a union.
   */
  normative: z.boolean().optional(),
  /**
   * The trigger/surface the convention binds to — what an agent is DOING when
   * this rule applies (e.g. "editing a migration", "adding an MCP tool").
   * Accepts a single scalar or a list; the corpus writes lists as block lists.
   */
  governs: z.union([z.string(), z.array(z.string())]).optional(),
  /**
   * Slugs of insights this convention REPLACES. Lets a superseded rule keep
   * pointing forward instead of silently competing with its replacement.
   */
  supersedes: z.union([z.string(), z.array(z.string())]).optional(),
});

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({ extend: normativeInsightFields }),
  }),
};
