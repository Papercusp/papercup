/**
 * dev:pg_health — embedded-pg health summary.
 *
 * Returns version + total/active/idle connection counts. Cheap read-only
 * query; safe for periodic polling.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { pgHealth } from '../../dev-data';

export default defineTool({
  name: 'dev:pg_health',
  profile: 'engineer',
  description: 'PostgreSQL version + connection counts (total/active/idle) for the operator database.',
  capability: 'intel:read',
  guidance: {
    when: `Diagnostic snapshot of PG health — connections, longest query, lock count. For the /dev/pg dashboard.`,
    notWhen: `For application-level health, use \`harness:health\`. pg_health is the database layer.`,
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'bee'],
  args: z.object({}),
  async handler() {
    const result = await pgHealth();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
