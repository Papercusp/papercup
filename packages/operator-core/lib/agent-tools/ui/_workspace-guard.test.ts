/**
 * _workspace-guard.test.ts — workspace-data-isolation-leaks-2026-06-17 F-M7.
 * The cross-workspace UI guard: blocks a dispatch/read into another workspace's ui_client
 * when the flag is ON; a no-op (byte-identical to today) when OFF; fail-open on infra error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  flagOn: false,
  ws: 'ws-active',
  rows: [] as Array<{ workspace_id: string }>,
  throwOnQuery: false,
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => h.flagOn }));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: async () => {
      if (h.throwOnQuery) throw new Error('pg down');
      return h.rows;
    },
  }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../../flag-distinct-id', () => ({ systemDistinctId: () => 'sys' }));

const { uiCrossWorkspaceBlock } = await import('./_workspace-guard');

beforeEach(() => {
  h.flagOn = false;
  h.ws = 'ws-active';
  h.rows = [];
  h.throwOnQuery = false;
});

describe('uiCrossWorkspaceBlock (F-M7)', () => {
  it('flag OFF → allow (null), no workspace check at all', async () => {
    h.flagOn = false;
    h.rows = [{ workspace_id: 'ws-other' }]; // even a cross-workspace client is allowed when OFF
    expect(await uiCrossWorkspaceBlock('c1')).toBeNull();
  });

  it('flag ON + client in ANOTHER workspace → blocked (error names both workspaces)', async () => {
    h.flagOn = true;
    h.ws = 'ws-active';
    h.rows = [{ workspace_id: 'ws-other' }];
    const msg = await uiCrossWorkspaceBlock('c1');
    expect(msg).toContain('cross_workspace_client');
    expect(msg).toContain('ws-other');
    expect(msg).toContain('ws-active');
  });

  it('flag ON + client in the SAME workspace → allow (null)', async () => {
    h.flagOn = true;
    h.ws = 'ws-active';
    h.rows = [{ workspace_id: 'ws-active' }];
    expect(await uiCrossWorkspaceBlock('c1')).toBeNull();
  });

  it('flag ON + client not found → allow (null) — can\'t prove a violation', async () => {
    h.flagOn = true;
    h.rows = [];
    expect(await uiCrossWorkspaceBlock('c1')).toBeNull();
  });

  it('flag ON + lookup throws → allow (null), fail-open (never wedge a dispatch on infra error)', async () => {
    h.flagOn = true;
    h.throwOnQuery = true;
    expect(await uiCrossWorkspaceBlock('c1')).toBeNull();
  });
});
