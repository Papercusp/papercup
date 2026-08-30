/** Real-PG regression for successor-author acceptance continuity. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { areAcceptanceLineageRelated, isAcceptanceAuthorIdentity } from './acceptance-author-identity';

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
    const spawns = [
      {
        spawn_id: 'spawn-author',
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        parent_spawn_id: null,
        parent_role: 'su',
        child_role: 'su',
        run_id: 'run-author',
        status: 'finished',
        session_owner: 'su-author',
      },
      {
        spawn_id: 'spawn-child-1',
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        parent_spawn_id: 'spawn-author',
        parent_role: 'su',
        child_role: 'judge',
        run_id: 'run-child-1',
        status: 'finished',
        session_owner: 'su-child-1',
      },
      {
        spawn_id: 'spawn-grandchild',
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        parent_spawn_id: 'su-child-1',
        parent_role: 'judge',
        child_role: 'judge',
        run_id: 'run-grandchild',
        status: 'finished',
        session_owner: 'su-grandchild',
      },
      {
        spawn_id: 'spawn-sibling-a',
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        parent_spawn_id: 'su-common-parent',
        parent_role: 'su',
        child_role: 'judge',
        run_id: 'run-sibling-a',
        status: 'finished',
        session_owner: 'su-sibling-a',
      },
      {
        spawn_id: 'spawn-sibling-b',
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        parent_spawn_id: 'su-common-parent',
        parent_role: 'su',
        child_role: 'judge',
        run_id: 'run-sibling-b',
        status: 'finished',
        session_owner: 'su-sibling-b',
      },
      {
        spawn_id: 'spawn-cross-tenant-child',
        workspace_id: 'different-workspace',
        harness_slug: 'h-a',
        parent_spawn_id: 'su-author',
        parent_role: 'su',
        child_role: 'judge',
        run_id: 'run-cross-tenant-child',
        status: 'finished',
        session_owner: 'su-cross-tenant-child',
      },
    ];
    await db.adminSql`INSERT INTO harness_shared.spawned_agents ${db.adminSql(spawns)}`;
    const sessions = [
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-psu-child',
        launch_spec: { launchedBy: 'su-author' },
      },
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-psu-grandchild',
        launch_spec: { launchedBy: 'su-psu-child' },
      },
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-psu-sibling-a',
        launch_spec: { launchedBy: 'su-psu-common-parent' },
      },
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-psu-sibling-b',
        launch_spec: { launchedBy: 'su-psu-common-parent' },
      },
      {
        workspace_id: 'different-workspace',
        mode: 'console',
        coord_owner_id: 'su-cross-tenant-psu-child',
        launch_spec: { launchedBy: 'su-author' },
      },
    ];
    await db.adminSql`INSERT INTO harness_shared.adv_sessions ${db.adminSql(sessions)}`;
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

  it('treats descendants, ancestors, and rebind successors as related but keeps siblings and tenants separate', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    await expect(areAcceptanceLineageRelated('su-author', 'su-child-1', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-author', 'su-grandchild', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-grandchild', 'su-author', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-author', 'su-successor-2', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-author', 'su-psu-grandchild', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-psu-grandchild', 'su-author', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-sibling-a', 'su-sibling-b', opts)).resolves.toBe(false);
    await expect(areAcceptanceLineageRelated('su-psu-sibling-a', 'su-psu-sibling-b', opts)).resolves.toBe(false);
    await expect(areAcceptanceLineageRelated('su-author', 'su-unrelated', opts)).resolves.toBe(false);
    await expect(areAcceptanceLineageRelated('su-author', 'su-cross-tenant-child', opts)).resolves.toBe(false);
    await expect(areAcceptanceLineageRelated('su-author', 'su-cross-tenant-psu-child', opts)).resolves.toBe(false);
  });
});
