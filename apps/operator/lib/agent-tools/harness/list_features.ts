/**
 * harness:list_features — list features for a harness slug (with phase
 * variant). Read-only projection of harness-features.
 *
 * Calls listFeaturesForHarness() in lib/harness-readers.ts directly.
 * The hono /:slug/status route returns a superset of fields including
 * features; this tool returns just the features array since that's what
 * the registry-residual command exposes.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { phasePhaseLabel } from '@/lib/harness-phases';
import { listFeaturesForHarness } from '@/lib/harness-readers';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

export default defineTool({
  name: 'harness:list_features',
  profile: 'engineer',
  description: 'List features for a harness slug (optionally for a specific phase: staging, testing, production).',
  guidance: {
    when: 'User asks "what features does sheets have?" or you need a feature id before calling `features:get`. Pass a phase to scope (staging = upcoming, testing = in-flight, production = done).',
    notWhen: 'For ONE feature\'s detail, use `features:get`. For the harness as a whole, use `harness:list`/`harness:get`.',
    chaining: 'Pair with `features:get` for body, `features:history` for change log.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  roles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().min(1),
    status: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
    phase: z.enum(['staging', 'testing', 'production']).optional(),
  }),
  async handler(args) {
    const result = await listFeaturesForHarness(args.slug, phasePhaseLabel(args.phase ?? 'staging'));
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }] };
    }
    let features = result.data.features as Array<Record<string, unknown>>;
    if (args.status) features = features.filter((f) => f.status === args.status);
    features = features.slice(0, args.limit ?? 50);
    const projected = features.map((f) => ({
      id: f.id,
      title: f.title,
      status: f.status,
      claims: f.claims,
      attempts: f.attempts,
    }));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ slug: args.slug, count: projected.length, features: projected }),
        },
      ],
    };
  },
});
