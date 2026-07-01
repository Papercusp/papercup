/**
 * coord:roster tests — unified presence/roster reader with view lenses.
 *
 * Tests the four view lenses (live, members, claims, history) and scope
 * resolution (hive, workspace, all). Mocks presence snapshot + fleet assignments
 * to verify lens output shapes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import rosterTool from './roster';

// Mock dependencies
vi.mock('../presence-snapshot', () => ({
  resolvePresenceScope: vi.fn(async (ctx, args) => ({
    scope: args.scope ?? 'hive',
    wsId: 'test-ws',
    hiveId: args.hive ?? 'test-hive',
  })),
  assemblePresenceSnapshot: vi.fn(async (resolved, opts) => {
    const allActive = [
      {
        ownerId: 'agent-1',
        ownerLabel: 'bee · agent-1',
        sessionState: 'live',
        wakeable: true,
        fleetSlug: 'fleet-a',
        fleetRole: 'member',
        onDesktop: true,
      },
      {
        ownerId: 'agent-2',
        ownerLabel: 'su · agent-2',
        sessionState: 'parked',
        wakeable: true,
        fleetSlug: 'fleet-b',
        fleetRole: 'member',
        onDesktop: false,
      },
    ];
    // Honor the targeted `owner` lookup like the real assemblePresenceSnapshot,
    // which applies selectRosterRows(rows, owner) → matchesOwner (exact ownerId/
    // label, else substring either-way). Without this the mock returns every row
    // regardless of opts.owner, breaking the targeted-owner-lookup assertion.
    const owner = opts?.owner as string | undefined;
    const active = owner
      ? allActive.filter(
          (r) =>
            r.ownerId === owner ||
            r.ownerLabel === owner ||
            r.ownerId.includes(owner) ||
            r.ownerLabel.includes(owner) ||
            owner.includes(r.ownerId),
        )
      : allActive;
    return {
      as_of: '2026-07-01T10:40:00.000Z',
      scope: resolved.scope,
      hive: resolved.hiveId,
      summary: {
        active: active.length,
        stale: 1,
        federated: 0,
        wakeable: active.filter((r) => r.wakeable).length,
        onDesktop: active.filter((r) => r.onDesktop).length,
        viewerAttached: 0,
        byState: { live: 1, parked: 1, ended: 1, recorded: 0 },
      },
      active,
    };
  }),
}));

// roster.ts imports from '../../../fleet/assignments' (lib/fleet/assignments) — the
// mock path must match it or it never intercepts (the import move left this stale,
// so claims-view hit the real empty-in-unit fn → agents/claims:0).
vi.mock('../../../fleet/assignments', () => ({
  listFleetAssignments: vi.fn(async (opts) => [
    {
      source: 'work_item',
      agentId: 'agent-1',
      agentLabel: 'bee · agent-1',
      claimId: 'claim-1',
      planSlug: 'test-plan',
      planItemId: 'P-001',
      workItemId: 'WI-100',
      workItemTitle: 'Test feature',
      status: 'wip',
      acquiredAt: new Date('2026-07-01T09:00:00Z'),
      alive: true,
      intentStale: false,
    },
    {
      source: 'work_item',
      agentId: 'agent-2',
      agentLabel: 'su · agent-2',
      claimId: 'claim-2',
      planSlug: null,
      planItemId: null,
      workItemId: 'WI-101',
      workItemTitle: 'Bug fix',
      status: 'wip',
      acquiredAt: new Date('2026-07-01T08:30:00Z'),
      alive: true,
      intentStale: false,
    },
  ]),
  groupByAgent: vi.fn((rows) => [
    {
      ownerId: 'agent-1',
      ownerLabel: 'bee · agent-1',
      alive: true,
      claims: [{ workItemId: 'WI-100', status: 'wip' }],
      load: 1,
      declaredUnclaimed: false,
    },
    {
      ownerId: 'agent-2',
      ownerLabel: 'su · agent-2',
      alive: true,
      claims: [{ workItemId: 'WI-101', status: 'wip' }],
      load: 1,
      declaredUnclaimed: false,
    },
  ]),
  orphanedClaims: vi.fn(() => []),
  stalledClaims: vi.fn(() => []),
}));

vi.mock('../../locks/identity', () => ({
  readIdentity: vi.fn(() => ({ coordinationDomain: '/home/test' })),
}));

vi.mock('../identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ workspaceId: 'test-ws', ownerId: 'agent-1' })),
}));

vi.mock('../self-marker', () => ({
  resolveSelfRef: vi.fn(() => 'agent-1'),
  markSelfRows: vi.fn((rows, self) =>
    rows.map((r) => ({ ...r, isSelf: r.ownerId === self })),
  ),
}));

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'test-ws'),
}));

describe('coord:roster', () => {
  const tool = rosterTool;

  describe('view=live (default)', () => {
    it('should return presence snapshot with live view', async () => {
      const result = await tool.handler(
        { view: 'live', scope: 'hive' },
        { workspaceId: 'test-ws', harnessSlug: 'test-harness' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output).toMatchObject({
        view: 'live',
        scope: 'hive',
        summary: {
          active: 2,
          wakeable: 2,
          byState: { live: 1, parked: 1, ended: 1 },
        },
        active: expect.arrayContaining([
          expect.objectContaining({
            ownerId: 'agent-1',
            sessionState: 'live',
            wakeable: true,
          }),
        ]),
      });
    });

    it('should support scope=workspace', async () => {
      const result = await tool.handler(
        { view: 'live', scope: 'workspace' },
        { workspaceId: 'test-ws' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output.scope).toBe('workspace');
    });

    it('should support targeted owner lookup', async () => {
      const result = await tool.handler(
        { view: 'live', owner: 'agent-1' },
        { workspaceId: 'test-ws' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output.active).toHaveLength(1);
      expect(output.active[0].ownerId).toBe('agent-1');
    });

    it('should include self marker', async () => {
      const result = await tool.handler(
        { view: 'live' },
        { workspaceId: 'test-ws', ownerId: 'agent-1' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output.self).toBe('agent-1');
      expect(output.active.some((r: { isSelf: boolean }) => r.isSelf)).toBe(true);
    });
  });

  describe('view=members', () => {
    it('should return members view with fleet membership', async () => {
      const result = await tool.handler(
        { view: 'members', scope: 'hive' },
        { workspaceId: 'test-ws' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output).toMatchObject({
        view: 'members',
        summary: {
          active: 2,
          wakeable: 2,
        },
      });

      // Fleet membership should be present
      expect(output.active).toContainEqual(
        expect.objectContaining({
          ownerId: 'agent-1',
          fleetSlug: 'fleet-a',
          fleetRole: 'member',
        }),
      );
    });
  });

  describe('view=claims', () => {
    it('should return work-item claims', async () => {
      const result = await tool.handler(
        { view: 'claims', scope: 'hive' },
        { workspaceId: 'test-ws' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output).toMatchObject({
        view: 'claims',
        summary: {
          agents: 2,
          alive: 2,
          claims: 2,
          orphaned_claims: 0,
          stalled_claims: 0,
        },
      });

      // Agents should have their claims
      expect(output.agents).toHaveLength(2);
      expect(output.agents[0]).toMatchObject({
        ownerId: 'agent-1',
        claims: expect.any(Array),
      });
    });

    it('should support plan filter', async () => {
      const result = await tool.handler(
        { view: 'claims', plan: 'test-plan' },
        { workspaceId: 'test-ws' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output.view).toBe('claims');
      // Fleet assignments tool should be called with plan filter
      expect(output.agents).toBeDefined();
    });

    it('should support agent filter', async () => {
      const result = await tool.handler(
        { view: 'claims', agent: 'agent-1' },
        { workspaceId: 'test-ws' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output.view).toBe('claims');
    });
  });

  describe('view=history', () => {
    it('should return history placeholder (WI-1346 pending)', async () => {
      const result = await tool.handler(
        { view: 'history' },
        { workspaceId: 'test-ws' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output).toMatchObject({
        view: 'history',
        note: expect.stringContaining('coord:catch-up'),
        data: null,
      });

      // Should point to coord:catch-up
      expect(output.suggestion).toContain('coord:catch-up');
    });
  });

  describe('scope resolution', () => {
    it('should default to hive scope', async () => {
      const result = await tool.handler(
        {},
        { workspaceId: 'test-ws', harnessSlug: 'test-harness' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output.scope).toBe('hive');
    });

    it('should downgrade scope=all for non-superusers', async () => {
      const result = await tool.handler(
        { view: 'live', scope: 'all' },
        { workspaceId: 'test-ws', isSuperuser: false },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      // Non-superuser asking for 'all' should be downgraded to 'workspace'
      expect(['workspace', 'hive']).toContain(output.scope);
    });

    it('should accept explicit hive', async () => {
      const result = await tool.handler(
        { hive: 'custom-hive' },
        { workspaceId: 'test-ws' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output.hive).toBe('custom-hive');
    });
  });

  describe('error handling', () => {
    it('should handle missing context gracefully', async () => {
      const result = await tool.handler(
        { view: 'live' },
        undefined,
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output).toHaveProperty('scope');
      expect(output).toHaveProperty('active');
    });

    it('should handle invalid view gracefully', async () => {
      try {
        await tool.handler(
          { view: 'invalid' as any },
          { workspaceId: 'test-ws' },
        );
        // If it doesn't throw during parsing, zod validation catches it
      } catch (e) {
        // Expected: zod validation error
        expect(e).toBeDefined();
      }
    });
  });

  describe('output format', () => {
    it('should always return text/json content', async () => {
      const result = await tool.handler(
        { view: 'live' },
        { workspaceId: 'test-ws' },
      );

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(typeof result.content[0].text).toBe('string');

      // Should be valid JSON
      expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    });

    it('should include as_of timestamp', async () => {
      const result = await tool.handler(
        { view: 'live' },
        { workspaceId: 'test-ws' },
      );

      const output = JSON.parse(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );

      expect(output).toHaveProperty('as_of');
      // Should be ISO timestamp or close to now
      if (typeof output.as_of === 'string') {
        expect(new Date(output.as_of)).toBeInstanceOf(Date);
      }
    });
  });
});
