/**
 * harness:phase_path — resolve the on-disk path for a harness slug
 * + phase (staging | testing | production). Looks up the project in
 * the harness registry, then defers to phasePath() for the
 * convention/config-override resolution.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { phasePath } from '../../harness-phases';
import { loadHarnessRegistry } from '../../harness-registry';

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
  name: 'harness:phase_path',
  profile: 'engineer',
  description: 'Resolve the on-disk path for a (harness_slug, phase) pair. Phase = staging|testing|production.',
  guidance: {
    when: 'You need the absolute filesystem path for a harness phase before reading files inside it.',
    notWhen: 'For listing files INSIDE the phase dir, use `harness:markdown_index` or `harness:list_features`. This tool only resolves the dir path.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    harnessSlug: z.string().optional(),
    phase: z.enum(['staging', 'testing', 'production']),
  }),
  async handler(args, ctx) {
    const slug = args.harnessSlug ?? ctx.harnessSlug ?? '';
    if (!slug) {
      throw new Error('harness:phase_path — harness slug required (passed or in spawn ctx)');
    }
    const reg = await loadHarnessRegistry();
    const project = (reg.projects ?? []).find((p) => p.slug === slug);
    if (!project) {
      return { content: [{ type: 'text', text: JSON.stringify({ slug, phase: args.phase, found: false, path: null }) }] };
    }
    const path = phasePath(project, args.phase);
    return { content: [{ type: 'text', text: JSON.stringify({ slug, phase: args.phase, found: true, path }) }] };
  },
});
