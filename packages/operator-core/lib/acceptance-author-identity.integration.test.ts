/** Real-PG regression for successor-author acceptance continuity. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  areAcceptanceLineageRelated,
  isAcceptanceAuthorIdentity,
  lineagePartyKeys,
  resolvePlanImplementerIdentities,
} from './acceptance-author-identity';

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
    const planWorkItems = [
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        feature_id: 'WI-split-terminal',
        item_kind: 'bug',
        status: 'done',
        source_plan_slug: 'split-role-plan',
        terminal_owner: 'su-plan-terminal-owner',
        taken_by: 'su-plan-current-owner',
        last_released_by: 'su-plan-released-owner',
        worked_by_history: [
          { owner: 'su-plan-prior-owner', at: '2026-09-04T10:00:00.000Z' },
          'su-plan-string-history-owner',
        ],
      },
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        feature_id: 'WI-split-current',
        item_kind: 'change',
        status: 'open',
        source_plan_slug: 'split-role-plan',
        terminal_owner: null,
        taken_by: 'su-plan-current-owner-2',
      },
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        feature_id: 'WI-split-blank',
        item_kind: 'task',
        status: 'open',
        source_plan_slug: 'split-role-plan',
        terminal_owner: ' ',
        taken_by: ' ',
      },
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        feature_id: 'WI-other-plan',
        item_kind: 'bug',
        status: 'done',
        source_plan_slug: 'other-plan',
        terminal_owner: 'su-other-plan-owner',
        taken_by: null,
      },
      {
        workspace_id: 'different-workspace',
        harness_slug: 'h-a',
        feature_id: 'WI-cross-tenant-plan',
        item_kind: 'bug',
        status: 'done',
        source_plan_slug: 'split-role-plan',
        terminal_owner: 'su-cross-tenant-owner',
        taken_by: null,
      },
    ];
    await db.adminSql`INSERT INTO harness_shared.work_items ${db.adminSql(
      planWorkItems.map((row) => ({ last_released_by: null, worked_by_history: [], ...row })),
    )}`;
    await db.adminSql`
      INSERT INTO harness_shared.plan_audits
        (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
         activation, audited_plan_revision_id, audited_plan_revision_seq,
         audited_plan_content_hash)
      VALUES
        (${workspaceId}, 'h-a', 'split-role-plan', 1, 'su-plan-activation-auditor',
         'activation', '{}'::jsonb, 1, 1, ${'a'.repeat(64)}),
        (${workspaceId}, 'h-a', 'split-role-plan', 2, 'su-plan-completion-auditor',
         'completion', NULL, NULL, NULL, NULL),
        ('different-workspace', 'h-a', 'split-role-plan', 1, 'su-cross-tenant-auditor',
         'completion', NULL, NULL, NULL, NULL)
    `;
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

  it('resolves current, historical, released, terminal, and audit owners, workspace-scoped', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    await expect(resolvePlanImplementerIdentities('split-role-plan', opts)).resolves.toEqual([
      'su-plan-activation-auditor',
      'su-plan-completion-auditor',
      'su-plan-current-owner',
      'su-plan-current-owner-2',
      'su-plan-prior-owner',
      'su-plan-released-owner',
      'su-plan-string-history-owner',
      'su-plan-terminal-owner',
    ]);
    await expect(resolvePlanImplementerIdentities('other-plan', opts)).resolves.toEqual(['su-other-plan-owner']);
    await expect(resolvePlanImplementerIdentities('missing-plan', opts)).resolves.toEqual([]);
    await expect(resolvePlanImplementerIdentities(' ', opts)).resolves.toEqual([]);
  });

  it('fails closed when append-only worker history has an unreadable shape', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    await db.adminSql`
      UPDATE harness_shared.work_items
         SET worked_by_history = '{}'::jsonb
       WHERE workspace_id = ${workspaceId}
         AND feature_id = 'WI-split-current'
    `;
    try {
      await expect(resolvePlanImplementerIdentities('split-role-plan', opts)).rejects.toThrow(
        /acceptance_lineage_unreadable/,
      );
    } finally {
      await db.adminSql`
        UPDATE harness_shared.work_items
           SET worked_by_history = '[]'::jsonb
         WHERE workspace_id = ${workspaceId}
           AND feature_id = 'WI-split-current'
      `;
    }
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

  /**
   * D-008 / P-005. These MUST be real-PG: `lineagePartyKeys` fails toward "no
   * pairs found", which a stubbed test reads as a clean "no duplicate parties"
   * while the guard is silently inert — the same class of invisible-malformed-
   * query D-007 hit. Only executing the recursive CTE proves it composes.
   */
  describe('lineagePartyKeys', () => {
    const opts = () => ({ sql: db.adminSql, workspaceId });

    it('groups a spawn chain and a launch chain into one party each, keyed by CALLER order', async () => {
      const keys = await lineagePartyKeys(['su-author', 'su-child-1', 'su-grandchild', 'su-unrelated'], opts());
      expect(keys.get('su-author')).toBe('su-author');
      expect(keys.get('su-child-1')).toBe('su-author');
      expect(keys.get('su-grandchild')).toBe('su-author');
      // An id with no edge into the set is its own party, never merged by default.
      expect(keys.get('su-unrelated')).toBe('su-unrelated');

      const launched = await lineagePartyKeys(['su-author', 'su-psu-grandchild'], opts());
      expect(launched.get('su-psu-grandchild')).toBe('su-author');
    });

    it('the key is the EARLIEST caller-order member, so a ranked pool keeps its best-ranked face', async () => {
      // Reversing the input must reverse the representative — that is what makes
      // "collapse a ranked pool" keep the top-ranked candidate rather than an
      // arbitrary one. A key derived from the ledger instead of caller order
      // would return 'su-author' both times and pass the test above regardless.
      const forward = await lineagePartyKeys(['su-author', 'su-child-1'], opts());
      const reversed = await lineagePartyKeys(['su-child-1', 'su-author'], opts());
      expect(forward.get('su-child-1')).toBe('su-author');
      expect(reversed.get('su-author')).toBe('su-child-1');
    });

    it('keeps SIBLINGS apart when their shared parent is not in the set (not connected components)', async () => {
      // The calibration for the over-merge below: sharing a parent is not lineage,
      // so an undirected-reachability implementation would wrongly merge these and
      // this is the only assertion that would catch it.
      const spawned = await lineagePartyKeys(['su-sibling-a', 'su-sibling-b'], opts());
      expect(spawned.get('su-sibling-a')).toBe('su-sibling-a');
      expect(spawned.get('su-sibling-b')).toBe('su-sibling-b');

      const launchedSiblings = await lineagePartyKeys(['su-psu-sibling-a', 'su-psu-sibling-b'], opts());
      expect(launchedSiblings.get('su-psu-sibling-a')).toBe('su-psu-sibling-a');
      expect(launchedSiblings.get('su-psu-sibling-b')).toBe('su-psu-sibling-b');
    });

    it('DISCLOSED (D-008): siblings DO merge once their shared parent is also a candidate', async () => {
      // Union-find over in-set pairs, so the parent bridges its children. Asserted
      // deliberately: this over-EXCLUDES, the safe direction for an independence
      // guard, and recording it stops a later reader "fixing" it into an
      // under-exclusion that would re-open the n=2 self-review path.
      const keys = await lineagePartyKeys(
        ['su-psu-common-parent', 'su-psu-sibling-a', 'su-psu-sibling-b'],
        opts(),
      );
      expect(keys.get('su-psu-sibling-a')).toBe('su-psu-common-parent');
      expect(keys.get('su-psu-sibling-b')).toBe('su-psu-common-parent');
    });

    it('never merges across workspaces, and short-circuits below two ids', async () => {
      const crossTenant = await lineagePartyKeys(
        ['su-author', 'su-cross-tenant-child', 'su-cross-tenant-psu-child'],
        opts(),
      );
      expect(crossTenant.get('su-cross-tenant-child')).toBe('su-cross-tenant-child');
      expect(crossTenant.get('su-cross-tenant-psu-child')).toBe('su-cross-tenant-psu-child');

      await expect(lineagePartyKeys([], opts())).resolves.toEqual(new Map());
      await expect(lineagePartyKeys(['su-author'], opts())).resolves.toEqual(new Map([['su-author', 'su-author']]));
      // Blank/duplicate ids are dropped rather than becoming their own parties.
      await expect(lineagePartyKeys(['su-author', ' ', null, 'su-author'], opts())).resolves.toEqual(
        new Map([['su-author', 'su-author']]),
      );
    });
  });
});
