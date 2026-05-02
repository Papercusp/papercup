/**
 * Recall memories from the workspace's Hindsight bank.
 *
 * Bank ID is auth-derived: workspace registry's `companyId` field
 * resolves to `paperclip::<companyId>`. Body-supplied scope is rejected.
 * If the workspace has no `companyId`, returns degraded with empty
 * results — does not throw.
 */

import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '../../define-tool';

interface WorkspaceRegistryEntry {
  id: string;
  name: string;
  companyId?: string | null;
}

function resolveCompanyId(workspaceId: string): string | null {
  const path = join(homedir(), '.papercusp-workspaces', 'registry.json');
  if (!existsSync(path)) return null;
  try {
    const reg = JSON.parse(readFileSync(path, 'utf8')) as { workspaces: WorkspaceRegistryEntry[] };
    const ws = reg.workspaces.find((w) => w.id === workspaceId);
    return ws?.companyId ?? null;
  } catch {
    return null;
  }
}

export default defineTool({
  capability: 'hindsight:recall',
  args: z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(50).default(10),
  }),
  async handler(args, ctx) {
    const companyId = resolveCompanyId(ctx.principal.workspaceId);
    if (!companyId) {
      return {
        data: [],
        degraded: true,
        degradedReasons: ['hindsight_not_configured_for_workspace'],
      };
    }
    const bank = `paperclip::${companyId}`;
    // Hindsight client invocation. v1 wires through an HTTP shim if the
    // hindsight MCP isn't directly callable in-process; for now we
    // return a degraded placeholder describing the resolved bank so
    // pi/Operator can at least see what would be queried.
    return {
      data: [],
      degraded: true,
      degradedReasons: [
        `hindsight client not wired in v1; would query bank=${bank} query=${JSON.stringify(args.query)}`,
      ],
    };
  },
});
