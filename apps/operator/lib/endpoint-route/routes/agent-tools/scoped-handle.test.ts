/**
 * P-062 Phase 4 — unit coverage for the agent-tools scoping decision matrix.
 * Pure logic, no PG: proves which DB handle each call shape resolves to.
 */
import { describe, expect, it } from 'vitest';
import {
  chooseScopedHandle,
  isWorkspaceIsolationEnabled,
  type ScopedHandleInput,
} from './scoped-handle';

const scope = (over: Partial<ScopedHandleInput> = {}): ScopedHandleInput => ({
  workspaceId: 'ws-A',
  isSuperuser: false,
  tool: {},
  ...over,
});

describe('chooseScopedHandle', () => {
  it('flag OFF → admin handle, even for a normal scoped call', () => {
    expect(chooseScopedHandle(scope(), { isolationOn: false })).toEqual({ kind: 'admin' });
  });

  it('flag ON + normal bearer call → workspace-scoped to its own workspace', () => {
    expect(chooseScopedHandle(scope({ workspaceId: 'ws-A' }), { isolationOn: true })).toEqual({
      kind: 'workspace',
      workspaceId: 'ws-A',
    });
  });

  it('flag ON + superuser → admin handle (SU/operator intentionally span workspaces)', () => {
    expect(chooseScopedHandle(scope({ isSuperuser: true }), { isolationOn: true })).toEqual({
      kind: 'admin',
    });
  });

  it('flag ON + crossWorkspace tool → admin handle (opt-out)', () => {
    expect(
      chooseScopedHandle(scope({ tool: { crossWorkspace: true } }), { isolationOn: true }),
    ).toEqual({ kind: 'admin' });
  });

  it('flag ON + no concrete workspace (undefined) → admin handle (withWorkspace would throw)', () => {
    expect(chooseScopedHandle(scope({ workspaceId: undefined }), { isolationOn: true })).toEqual({
      kind: 'admin',
    });
  });

  it("flag ON + '*' wildcard workspace → admin handle (matches no rows under GUC)", () => {
    expect(chooseScopedHandle(scope({ workspaceId: '*' }), { isolationOn: true })).toEqual({
      kind: 'admin',
    });
  });

  it('crossWorkspace:false is treated as scoped (only explicit true opts out)', () => {
    expect(
      chooseScopedHandle(scope({ tool: { crossWorkspace: false }, workspaceId: 'ws-B' }), {
        isolationOn: true,
      }),
    ).toEqual({ kind: 'workspace', workspaceId: 'ws-B' });
  });
});

describe('isWorkspaceIsolationEnabled', () => {
  it("returns true only when the env flag is exactly '1'", () => {
    expect(isWorkspaceIsolationEnabled({ PAPERCUSP_AGENT_TOOLS_WS_ISOLATION: '1' })).toBe(true);
  });
  it('defaults OFF when the flag is absent or any other value', () => {
    expect(isWorkspaceIsolationEnabled({})).toBe(false);
    expect(isWorkspaceIsolationEnabled({ PAPERCUSP_AGENT_TOOLS_WS_ISOLATION: '0' })).toBe(false);
    expect(isWorkspaceIsolationEnabled({ PAPERCUSP_AGENT_TOOLS_WS_ISOLATION: 'true' })).toBe(false);
  });
});
