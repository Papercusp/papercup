/**
 * Unit tests for buildRoleLaunchSpec (agent-launch-unification P-003).
 * Mocks the two shared leaves (assembleRolePrompt + signSpawnParams) so
 * the test asserts the COMPOSITION + the role-scoped signed-URL shape,
 * not the leaves' internals (those have their own tests).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const assembleRolePromptMock = vi.fn();

vi.mock('@papercusp/orchestrator/role-prompt', () => ({
  assembleRolePrompt: (...args: unknown[]) => assembleRolePromptMock(...args),
}));
// Deterministic signer: append a fixed exp+sig so the URL is assertable.
vi.mock('@/lib/spawn-signing', () => ({
  signSpawnParams: vi.fn(async (params: URLSearchParams) => {
    params.set('exp', '9999999999');
    params.set('sig', 'TESTSIG');
    return { exp: 9999999999, sig: 'TESTSIG' };
  }),
}));
vi.mock('@/lib/spawn-config', () => ({
  resolveProjectDir: vi.fn(async (slug: string) => `/registry/${slug}`),
}));

import { buildRoleLaunchSpec } from '@/lib/role-launch-spec';
import { resolveProjectDir } from '@/lib/spawn-config';

beforeEach(() => {
  vi.clearAllMocks();
  assembleRolePromptMock.mockReturnValue({
    text: 'WORKER PROMPT BODY',
    meta: { role: 'worker', promptFile: '/h/prompts/worker.md', projectDir: '/proj/papercup', stateDir: '/proj/papercup/.harness', harnessDir: '/h', runId: 'worker-F-001-123' },
  });
});

describe('buildRoleLaunchSpec', () => {
  it('composes assembleRolePrompt + a signed role-scoped MCP URL', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      featureId: 'F-001',
    });

    // prompt comes from the shared assembler, in chat mode, WITH the
    // in-process workspace-aware projectDir (so the assembler skips its
    // workspace-blind lookupProjectDir / curl-to-:3055 fallback).
    expect(assembleRolePromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'papercup', role: 'worker', mode: 'chat', featureId: 'F-001', projectDir: '/registry/papercup' }),
    );
    expect(spec.promptText).toBe('WORKER PROMPT BODY');
    expect(spec.runId).toBe('worker-F-001-123');
    expect(spec.cwd).toBe('/proj/papercup');

    // The MCP URL is role-scoped (role=worker, NOT ?superuser=1) + signed
    // + carries the feature/harness/workspace the dispatch layer checks.
    const u = new URL(spec.mcpUrl);
    expect(u.pathname).toBe('/api/mcp');
    expect(u.searchParams.get('role')).toBe('worker');
    expect(u.searchParams.get('harness')).toBe('papercup');
    expect(u.searchParams.get('workspace')).toBe('default');
    expect(u.searchParams.get('feature')).toBe('F-001');
    expect(u.searchParams.get('spawn')).toBe(spec.spawnId);
    expect(u.searchParams.get('sig')).toBe('TESTSIG');
    expect(u.searchParams.has('superuser')).toBe(false);

    // .mcp.json wraps the same URL.
    const mcp = JSON.parse(spec.mcpJsonContents);
    expect(mcp.mcpServers.papercusp.url).toBe(spec.mcpUrl);
    expect(mcp.mcpServers.papercusp.type).toBe('http');
  });

  it('omits the feature param for a no-feature role', async () => {
    assembleRolePromptMock.mockReturnValue({
      text: 'SCOPER PROMPT',
      meta: { role: 'scoper', promptFile: '/h/prompts/scoper.md', projectDir: '/proj/papercup', stateDir: '', harnessDir: '/h', runId: 'scoper-123' },
    });
    const spec = await buildRoleLaunchSpec({
      role: 'scoper',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.featureId).toBeNull();
    expect(new URL(spec.mcpUrl).searchParams.has('feature')).toBe(false);
  });

  it('propagates a harness-not-registered throw from assembleRolePrompt', async () => {
    assembleRolePromptMock.mockImplementation(() => {
      throw new Error('assembleRolePrompt: harness "ghost" not registered');
    });
    await expect(
      buildRoleLaunchSpec({ role: 'worker', workspaceId: 'default', harnessSlug: 'ghost', operatorBaseUrl: 'http://x' }),
    ).rejects.toThrow(/not registered/);
  });

  it('throws (before calling the assembler) when the harness is not in the workspace', async () => {
    // resolveProjectDir → null means the harness isn't registered in this
    // workspace; we must surface that in-process, not let the assembler fall
    // back to its workspace-blind lookup.
    vi.mocked(resolveProjectDir).mockResolvedValueOnce(null);
    await expect(
      buildRoleLaunchSpec({ role: 'scoper', workspaceId: 'papercusp-workspace', harnessSlug: 'papercup', operatorBaseUrl: 'http://x' }),
    ).rejects.toThrow(/not registered in workspace "papercusp-workspace"/);
    expect(assembleRolePromptMock).not.toHaveBeenCalled();
  });
});
