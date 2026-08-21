/** Real-PG regression for successor-author acceptance continuity. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { isAcceptanceAuthorIdentity } from './acceptance-author-identity';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('isAcceptanceAuthorIdentity (audited coord rebind lineage)', () => {
  let db: OrgTestDb;
  const workspaceId = 'acceptance-author-lineage-ws';

  beforeAll(async () => {
    db = await createOrgTestDb();
    const rows = [
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        plugin_name: 'agentmcp',
        tool_name: 'coord:rebind-identity',
        role: 'su',
        spawn_id: 'spawn-1',
        window_key: 'w-1',
        status: 'ok',
        args_json: { from: 'su-author', to: 'su-successor-1' },
        coord_owner_id: 'su-successor-1',
      },
      {
        workspace_id: workspaceId,
        harness_slug: 'h-b',
        plugin_name: 'agentmcp',
        tool_name: 'coord:rebind-identity',
        role: 'su',
        spawn_id: 'spawn-2',
        window_key: 'w-2',
        status: 'ok',
        // Production permits omitting `to`; the successful caller is the target.
        args_json: { from: 'su-successor-1' },
        coord_owner_id: 'su-successor-2',
      },
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        plugin_name: 'agentmcp',
        tool_name: 'coord:rebind-identity',
        role: 'su',
        spawn_id: 'spawn-refused',
        window_key: 'w-refused',
        status: 'error',
        args_json: { from: 'su-author', to: 'su-refused' },
        coord_owner_id: 'su-refused',
      },
      {
        workspace_id: 'different-workspace',
        harness_slug: 'h-a',
        plugin_name: 'agentmcp',
        tool_name: 'coord:rebind-identity',
        role: 'su',
        spawn_id: 'spawn-cross-tenant',
        window_key: 'w-cross-tenant',
        status: 'ok',
        args_json: { from: 'su-author', to: 'su-cross-tenant' },
        coord_owner_id: 'su-cross-tenant',
      },
    ];
    await db.adminSql`INSERT INTO harness_shared.tool_invocations ${db.adminSql(rows)}`;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('accepts exact, direct, and multi-hop successors but rejects failed, unrelated, and cross-workspace edges', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-author', opts)).resolves.toBe(true);
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-successor-1', opts)).resolves.toBe(true);
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-successor-2', opts)).resolves.toBe(true);
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-refused', opts)).resolves.toBe(false);
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-unrelated', opts)).resolves.toBe(false);
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-cross-tenant', opts)).resolves.toBe(false);
  });
});
