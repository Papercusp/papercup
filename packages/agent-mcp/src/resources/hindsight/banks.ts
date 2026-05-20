/**
 * `papercusp://hindsight/banks` — list Hindsight memory banks the
 * workspace's company has access to.
 *
 * Bank IDs follow `paperclip::<companyId>` per the workspace registry.
 * If the workspace has no `companyId`, returns degraded with no banks.
 * Same auth model as the `hindsight:recall` tool.
 */

import { join } from 'node:path';
import { getHostPlatform } from '@papercusp/host-platform';
import { defineResource } from '../../define-resource';
import type { ResourceContents } from '../../types';

interface WorkspaceRegistryEntry {
  id: string;
  name: string;
  companyId?: string | null;
}

function resolveCompanyId(workspaceId: string): string | null {
  const platform = getHostPlatform();
  const path = join(platform.homedir(), '.papercusp-workspaces', 'registry.json');
  const raw = platform.readTextFileSync(path);
  if (raw === null) return null;
  try {
    const reg = JSON.parse(raw) as { workspaces: WorkspaceRegistryEntry[] };
    return reg.workspaces.find((w) => w.id === workspaceId)?.companyId ?? null;
  } catch {
    return null;
  }
}

export default defineResource({
  name: 'hindsight:banks',
  uri: 'papercusp://hindsight/banks',
  capability: 'hindsight:read',
  mimeType: 'application/json',
  description:
    'Hindsight memory banks the current workspace can recall from. Bank IDs are auth-derived.',

  async read(uri, ctx): Promise<ResourceContents> {
    const companyId = resolveCompanyId(ctx.principal.workspaceId);
    if (!companyId) {
      return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            banks: [],
            degraded: true,
            degradedReason:
              'Workspace has no companyId in registry.json — Hindsight access not configured.',
          },
          null,
          2,
        ),
      };
    }
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          banks: [
            {
              id: `paperclip::${companyId}`,
              kind: 'paperclip',
              companyId,
            },
          ],
        },
        null,
        2,
      ),
    };
  },
});
