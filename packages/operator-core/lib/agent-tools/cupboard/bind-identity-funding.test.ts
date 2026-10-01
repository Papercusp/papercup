/**
 * cupboard:bind-identity-funding — the explicit bind door for a priced identity
 * release's funding channel (agent-economy-flywheel-2026-08-30 P-016, D-011).
 *
 * The door must read the channel back from the hosted owner-only route BEFORE it
 * stores anything: an unknown or foreign channel (hosted 404 → null) and an
 * unreachable Cupboard are both refused with nothing written. A confirmed channel
 * is bound with source 'explicit', keyed to the caller's workspace, using the
 * channel id the hosted read returned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ readHostedPaymentChannel: vi.fn() }));
const store = vi.hoisted(() => ({ bindIdentityReleaseFundingChannel: vi.fn() }));
const registry = vi.hoisted(() => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
const sqlHandle = vi.hoisted(() => ({ tag: 'org-sql' }));

vi.mock('../../cupboard/identity-activation-gate-io', () => io);
vi.mock('../../cupboard/identity-release-funding-store', () => store);
vi.mock('../../workspace-registry', () => registry);
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: sqlHandle }),
}));

import tool from './bind-identity-funding';

function body(result: unknown): Record<string, unknown> {
  const response = result as { content: Array<{ text: string }> };
  return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

const ARGS = { identityId: 'acme/reviewer', version: '1.2.0', channelId: 'pch_1' };
const SKU = 'identity-release:acme/reviewer@1.2.0';
const OWNED = { channelId: 'pch_1', state: 'open', escrowMicros: 5_000_000, committedMicros: 0 };

describe('cupboard:bind-identity-funding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.bindIdentityReleaseFundingChannel.mockResolvedValue(undefined);
  });

  it('publishes a harness:write contract that needs identity, version and channel', () => {
    expect(tool.name).toBe('cupboard:bind-identity-funding');
    expect(tool.capability).toBe('harness:write');
    expect(tool.args.safeParse(ARGS).success).toBe(true);
    expect(tool.args.safeParse({ identityId: 'acme/reviewer', version: '1.2.0' }).success).toBe(false);
    expect(tool.args.safeParse({ ...ARGS, channelId: '' }).success).toBe(false);
  });

  it('refuses a channel the hosted owner-only read does not return, and stores nothing', async () => {
    io.readHostedPaymentChannel.mockResolvedValue({ ok: true, value: null });
    const out = body(await tool.handler(ARGS, { principal: { workspaceId: 'ws-1' } } as never));
    expect(io.readHostedPaymentChannel).toHaveBeenCalledWith('pch_1');
    expect(out).toMatchObject({ ok: false, error: 'channel-not-found', skuRef: SKU });
    expect(store.bindIdentityReleaseFundingChannel).not.toHaveBeenCalled();
  });

  it('refuses when the hosted Cupboard cannot confirm the channel, and stores nothing', async () => {
    io.readHostedPaymentChannel.mockResolvedValue({ ok: false, detail: 'the Cupboard channel read answered 503' });
    const out = body(await tool.handler(ARGS, { principal: { workspaceId: 'ws-1' } } as never));
    expect(out).toMatchObject({
      ok: false,
      error: 'channel-unverifiable',
      detail: 'the Cupboard channel read answered 503',
      skuRef: SKU,
    });
    expect(store.bindIdentityReleaseFundingChannel).not.toHaveBeenCalled();
  });

  it('binds a confirmed channel as explicit funding for the caller workspace', async () => {
    io.readHostedPaymentChannel.mockResolvedValue({ ok: true, value: OWNED });
    const out = body(
      await tool.handler(ARGS, { principal: { workspaceId: 'ws-1', slug: 'su-buyer' } } as never),
    );
    expect(store.bindIdentityReleaseFundingChannel).toHaveBeenCalledTimes(1);
    expect(store.bindIdentityReleaseFundingChannel).toHaveBeenCalledWith(sqlHandle, {
      workspaceId: 'ws-1',
      skuRef: SKU,
      channelId: 'pch_1',
      source: 'explicit',
      boundBy: 'su-buyer',
    });
    expect(out).toMatchObject({ ok: true, workspaceId: 'ws-1', skuRef: SKU, channel: OWNED });
    expect(registry.activeWorkspaceId).not.toHaveBeenCalled();
  });

  it('falls back to the active workspace and the tool name when no principal is attached', async () => {
    io.readHostedPaymentChannel.mockResolvedValue({ ok: true, value: OWNED });
    const out = body(await tool.handler(ARGS, {} as never));
    expect(store.bindIdentityReleaseFundingChannel).toHaveBeenCalledWith(
      sqlHandle,
      expect.objectContaining({ workspaceId: 'ws-active', boundBy: 'cupboard:bind-identity-funding' }),
    );
    expect(out).toMatchObject({ ok: true, workspaceId: 'ws-active' });
  });
});
