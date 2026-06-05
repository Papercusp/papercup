/**
 * substrate:revoke_self_device tool — metadata, args schema, and the
 * delegate-and-wrap handler contract.
 *
 * The hard logic (own-key guard, revoked_pubkeys union, handle.revoke) lives
 * in `@/lib/sync/hyperbee/revoke-self-device` and is covered by
 * `revoke-self-device.test.ts` there. This tests only the MCP surface: the
 * tool delegates to it verbatim and wraps the result as JSON text content.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID = { workspaceId: 'ws1', harnessSlug: 'papercup', devicePubkey: 'dev-AAAA' };

beforeEach(() => vi.resetModules());
afterEach(() => vi.doUnmock('../../../sync/hyperbee/revoke-self-device'));

async function loadTool(revokeSelfDevice = vi.fn()) {
  vi.doMock('../../../sync/hyperbee/revoke-self-device', () => ({ revokeSelfDevice }));
  const { default: tool } = await import('../revoke-self-device');
  return tool;
}

describe('substrate:revoke_self_device tool', () => {
  it('exposes the expected metadata + a non-empty guidance.when (tools-md-sync gate)', async () => {
    const tool = await loadTool();
    expect(tool.name).toBe('substrate:revoke_self_device');
    expect(tool.capability).toBe('intel:write');
    expect(typeof tool.guidance?.when).toBe('string');
    expect((tool.guidance?.when ?? '').length).toBeGreaterThan(0);
    expect(tool.agentRoles).toContain('operator');
  });

  it('args schema accepts a valid call', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse(VALID).success).toBe(true);
  });

  it('args schema rejects missing/empty fields', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse({ workspaceId: 'ws1', harnessSlug: 'papercup' }).success).toBe(false);
    expect(tool.args.safeParse({ ...VALID, devicePubkey: '' }).success).toBe(false);
    expect(tool.args.safeParse({ ...VALID, workspaceId: '' }).success).toBe(false);
  });

  it('handler delegates to revokeSelfDevice and wraps the result as JSON text content', async () => {
    const result = { ok: true, revoked: VALID.devicePubkey, live: true };
    const revokeSelfDevice = vi.fn(async () => result);
    const tool = await loadTool(revokeSelfDevice);
    const res = await tool.handler(VALID);
    expect(revokeSelfDevice).toHaveBeenCalledWith(VALID);
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  });

  it('passes a not_your_key failure through verbatim', async () => {
    const result = { ok: false, code: 'not_your_key' };
    const tool = await loadTool(vi.fn(async () => result));
    const res = await tool.handler(VALID);
    expect(JSON.parse(res.content[0].text)).toEqual(result);
  });
});
