/**
 * cross_harness:supervisor_notes — read supervisor notes for a harness.
 *
 * Mirrors GET /api/harness/:slug/supervisor-notes.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readSupervisorNotes } from '../../cross-harness-data';

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
  name: 'cross_harness:supervisor_notes',
  profile: 'engineer',
  description: 'Read supervisor notes for a harness (id, body, source, created_at).',
  guidance: {
    when: 'You need the supervisor\'s annotations on a harness — context the supervisor logged that\'s not in audit_log.',
    notWhen: 'For escalation flags + raw notes from the on-disk files, use `harness:escalation`. supervisor_notes is the PG-backed view.',
  },
  capability: 'cross_harness:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z.object({
    slug: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  async handler(args, ctx) {
    const slug = args.slug ?? ctx.harnessSlug ?? '';
    if (!slug) throw new Error('cross_harness:supervisor_notes — slug required');
    const notes = await readSupervisorNotes(slug, args.limit);
    return { content: [{ type: 'text', text: JSON.stringify({ slug, notes }) }] };
  },
});
