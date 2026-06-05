/**
 * substrate:revoke_contributor tool — metadata, args schema, and the
 * delegate-and-wrap handler contract.
 *
 * The GitHub branch-delete logic lives in
 * `@/lib/sync/hyperbee/revoke-contributor` (covered by `revoke-contributor.test.ts`
 * there). This tests only the MCP surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID = { workspaceId: 'ws1', harnessSlug: 'papercup', githubUserId: 12345 };

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock('../../../sync/hyperbee/revoke-contributor'));

async function loadTool(revokeContributorViaGithub = vi.fn()) {
  vi.doMock('../../../sync/hyperbee/revoke-contributor', () => ({ revokeContributorViaGithub }));
  const { default: tool } = await import('../revoke-contributor');
  return tool;
}

describe('substrate:revoke_contributor tool', () => {
  it('exposes the expected metadata + a non-empty guidance.when (tools-md-sync gate)', async () => {
    const tool = await loadTool();
    expect(tool.name).toBe('substrate:revoke_contributor');
    expect(tool.capability).toBe('intel:write');
    expect(typeof tool.guidance?.when).toBe('string');
    expect((tool.guidance?.when ?? '').length).toBeGreaterThan(0);
    expect(tool.agentRoles).toContain('operator');
  });

  it('args schema accepts a valid numeric githubUserId', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse(VALID).success).toBe(true);
  });

  it('args schema rejects non-numeric / non-positive / non-integer github user ids', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse({ ...VALID, githubUserId: 'alice' }).success).toBe(false);
    expect(tool.args.safeParse({ ...VALID, githubUserId: -1 }).success).toBe(false);
    expect(tool.args.safeParse({ ...VALID, githubUserId: 1.5 }).success).toBe(false);
    expect(tool.args.safeParse({ workspaceId: 'ws1', harnessSlug: 'papercup' }).success).toBe(false);
  });

  it('handler delegates to revokeContributorViaGithub and wraps the result', async () => {
    const result = { ok: true, deleted: true, branch: 'user/12345' };
    const revoke = vi.fn(async () => result);
    const tool = await loadTool(revoke);
    const res = await tool.handler(VALID);
    expect(revoke).toHaveBeenCalledWith(VALID);
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  });

  it('passes a not_admin failure through verbatim', async () => {
    const result = { ok: false, code: 'not_admin' };
    const tool = await loadTool(vi.fn(async () => result));
    const res = await tool.handler(VALID);
    expect(JSON.parse(res.content[0].text)).toEqual(result);
  });
});
