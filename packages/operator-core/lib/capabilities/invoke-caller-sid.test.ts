/**
 * invoke-caller-sid.test.ts — EI-1751: invokeServerCapability threads an
 * optional `callerSid` into the dispatch ctx as `uiClientId` (attribution
 * only), while `spawnId` STAYS the fixed literal 'palette' every existing
 * 'palette'-keyed consumer (fleet-ekg/features.ts, decision-ledger/emit.ts's
 * isReadShapedCoordPoll) depends on.
 *
 * External layers (catalog lookup + dispatch + workspace tx) are mocked at
 * the module boundary; `dispatchProjectedToolToMcp` is stubbed to CAPTURE the
 * ctx it was called with so the test can assert on it directly, instead of
 * inferring it indirectly through a real dispatch.
 *
 * Run: cd packages/operator-core && npx vitest run lib/capabilities/invoke-caller-sid.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

const fakeProjected = {
  description: 'a low-risk test tool',
  inputSchema: {},
  capabilities: [] as string[],
};

vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    lookupByMcpName: vi.fn(() => fakeProjected),
    tierFor: vi.fn(() => 'low'),
  };
});

let capturedCtx: UnifiedToolContext | null = null;
vi.mock('@papercusp/tooldef-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/tooldef-mcp')>()),
  dispatchProjectedToolToMcp: vi.fn(async (_projected: unknown, _name: string, _args: unknown, ctx: UnifiedToolContext) => {
    capturedCtx = ctx;
    return { ok: true };
  }),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) => fn({})),
  };
});

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws1') }));

const { invokeServerCapability } = await import('./invoke');

beforeEach(() => {
  capturedCtx = null;
});

describe('invokeServerCapability — EI-1751 callerSid attribution', () => {
  it('no callerSid ⇒ ctx.uiClientId stays null (today\'s behavior)', async () => {
    const r = await invokeServerCapability({ name: 't:x' });
    expect(r.ok).toBe(true);
    expect(capturedCtx?.spawnId).toBe('palette');
    expect(capturedCtx?.uiClientId).toBeNull();
  });

  it('a callerSid is folded into ctx.uiClientId WITHOUT touching spawnId', async () => {
    const r = await invokeServerCapability({ name: 't:x', callerSid: 'pui-4242' });
    expect(r.ok).toBe(true);
    expect(capturedCtx?.spawnId).toBe('palette');
    expect(capturedCtx?.uiClientId).toBe('pui-4242');
  });
});
