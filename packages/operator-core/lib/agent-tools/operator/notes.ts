/**
 * operator:notes — read or append feature-scoped operator notes.
 *
 * Phase A "Steer" primitive: notes stored at
 * `<projectDir>/.papercusp/notes/<featureId>.md`. The worker prompt's
 * Required Reads pulls them on each invocation.
 *
 *   - { op: 'read',   slug?, featureId }
 *   - { op: 'append', slug?, featureId, content, author? }
 *
 * `slug` defaults to ctx.harnessSlug from the spawn context.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { appendOperatorNote, readOperatorNotes } from '../../operator-notes';

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
  name: 'operator:notes',
  profile: 'engineer',
  description: 'Read or append feature-scoped operator notes (Steer primitive). { op: read|append, slug?, featureId, content?, author? }.',
  capability: 'operator:write',
  guidance: {
    when: `Read or update the operator's free-form note buffer — long-running scratch the user adds via /settings.`,
    notWhen: `For HINDSIGHT (cross-agent memory), use \`hindsight:recall\`. Notes is operator-only, user-editable.`,
  },
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  rolesQuota: { worker: { perChunk: 10 }, architect: { perRun: 50 }, operator: { perRun: 200 } },
  args: z.discriminatedUnion('op', [
    z.object({
      op: z.literal('read'),
      slug: z.string().optional(),
      featureId: z.string().min(1),
    }),
    z.object({
      op: z.literal('append'),
      slug: z.string().optional(),
      featureId: z.string().min(1),
      content: z.string().min(1),
      author: z.string().optional(),
    }),
  ]),
  async handler(args, ctx) {
    const slug = args.slug ?? ctx.harnessSlug ?? '';
    if (!slug) {
      throw new Error('operator:notes — slug required (passed or in spawn ctx)');
    }
    if (args.op === 'read') {
      const result = await readOperatorNotes(slug, args.featureId);
      if ('error' in result) {
        throw new Error(`operator:notes read failed: ${result.error}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    const result = await appendOperatorNote({
      slug,
      featureId: args.featureId,
      content: args.content,
      author: args.author,
    });
    if ('error' in result) {
      throw new Error(`operator:notes append failed: ${result.error}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...result }) }] };
  },
});
