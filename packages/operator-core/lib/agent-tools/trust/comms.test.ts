/**
 * trust:comms handler unit tests — cross-machine-coord-parity-and-trust-2026-07-01
 * P-013 (the requests surface + one-call grant residual: the comms-tier
 * enforcement itself — comms-tier-gate.ts, coord-message.ts, bee-claim-spec.ts —
 * already had coverage; this tool's own actions did not).
 *
 * PG-free: mocks `../../workspace-registry`, `../../trust/comms-trust`, and
 * `../../sync/hyperbee/coord-quarantine-store` (mirrors trust/add.test.ts's
 * doMock + dynamic-import pattern, since the handler `await import()`s its deps).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTIVE_WS = 'ws-active';

type Body = Record<string, unknown>;
const body = (r: { content?: Array<{ text: string }> }): Body => JSON.parse(r.content![0].text);

function ctxWith(principal: { workspaceId?: string; slug?: string } | null): unknown {
  return { principal: principal ?? undefined } as never;
}

let activeWorkspaceId: ReturnType<typeof vi.fn>;
let listCommsTrust: ReturnType<typeof vi.fn>;
let setCommsTrust: ReturnType<typeof vi.fn>;
let removeCommsTrust: ReturnType<typeof vi.fn>;
let setGateTrust: ReturnType<typeof vi.fn>;
let listCoordQuarantine: ReturnType<typeof vi.fn>;
let clearCoordQuarantineForAuthor: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  activeWorkspaceId = vi.fn(() => ACTIVE_WS);
  listCommsTrust = vi.fn(async () => []);
  setCommsTrust = vi.fn(async (_ws: string, opts: Record<string, unknown>) => ({ ...opts }));
  removeCommsTrust = vi.fn(async () => ({ removed: true }));
  setGateTrust = vi.fn(async (_ws: string, opts: Record<string, unknown>) => ({ ...opts }));
  listCoordQuarantine = vi.fn(async () => []);
  clearCoordQuarantineForAuthor = vi.fn(async () => ({ cleared: 0 }));
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));
  vi.doMock('../../trust/comms-trust', () => ({
    listCommsTrust,
    setCommsTrust,
    removeCommsTrust,
    setGateTrust,
    FALLBACK_COMMS_TIER: 'message',
  }));
  vi.doMock('../../sync/hyperbee/coord-quarantine-store', () => ({
    listCoordQuarantine,
    clearCoordQuarantineForAuthor,
  }));
});

afterEach(() => {
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../trust/comms-trust');
  vi.doUnmock('../../sync/hyperbee/coord-quarantine-store');
});

async function commsTool() {
  return (await import('./comms')).default as unknown as {
    handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
  };
}

describe("trust:comms action:'requests' — the quarantine 'X wants to message you' surface", () => {
  it('lists every quarantined author when githubUserId is omitted', async () => {
    listCoordQuarantine.mockResolvedValueOnce([
      { msgId: 'm1', authorGithubUserId: 42, reason: 'below-message-tier' },
      { msgId: 'm2', authorGithubUserId: 7, reason: 'rate-exceeded' },
    ]);
    const tool = await commsTool();
    const b = body(await tool.handler({ action: 'requests' }, ctxWith({ workspaceId: 'ws-1', slug: 'owner' })));
    expect(listCoordQuarantine).toHaveBeenCalledWith({ workspaceId: 'ws-1', authorGithubUserId: undefined });
    expect(b).toMatchObject({ ok: true, workspaceId: 'ws-1', count: 2 });
    expect((b.requests as unknown[]).length).toBe(2);
  });

  it('filters to one author when githubUserId is given', async () => {
    const tool = await commsTool();
    await tool.handler({ action: 'requests', githubUserId: 42 }, ctxWith({ workspaceId: 'ws-1' }));
    expect(listCoordQuarantine).toHaveBeenCalledWith({ workspaceId: 'ws-1', authorGithubUserId: 42 });
  });

  it("SECURITY: principal workspace '*' falls back to the active workspace, not '*'", async () => {
    const tool = await commsTool();
    await tool.handler({ action: 'requests' }, ctxWith({ workspaceId: '*', slug: 'owner' }));
    expect(listCoordQuarantine).toHaveBeenCalledWith({ workspaceId: ACTIVE_WS, authorGithubUserId: undefined });
    expect(activeWorkspaceId).toHaveBeenCalledTimes(1);
  });

  it('does NOT require githubUserId (unlike set/remove/gate/grant)', async () => {
    const tool = await commsTool();
    const b = body(await tool.handler({ action: 'requests' }, ctxWith({ workspaceId: 'ws-1' })));
    expect(b.ok).toBe(true);
  });
});

describe("trust:comms action:'grant' — one-call requests-queue approve (P-013)", () => {
  it('raises the tier AND clears the backlog in one call', async () => {
    clearCoordQuarantineForAuthor.mockResolvedValueOnce({ cleared: 3 });
    const tool = await commsTool();
    const b = body(
      await tool.handler(
        { action: 'grant', githubUserId: 42, tier: 'wake' },
        ctxWith({ workspaceId: 'ws-1', slug: 'owner' }),
      ),
    );
    expect(setCommsTrust).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ githubUserId: 42, tier: 'wake', actor: 'owner' }),
    );
    expect(clearCoordQuarantineForAuthor).toHaveBeenCalledWith({ workspaceId: 'ws-1', authorGithubUserId: 42 });
    expect(b).toMatchObject({ ok: true, workspaceId: 'ws-1', clearedRequests: 3 });
    expect(b.entry).toMatchObject({ githubUserId: 42, tier: 'wake' });
  });

  it("defaults the tier to FALLBACK_COMMS_TIER ('message') when omitted — the minimum that unblocks quarantine", async () => {
    const tool = await commsTool();
    await tool.handler({ action: 'grant', githubUserId: 42 }, ctxWith({ workspaceId: 'ws-1', slug: 'owner' }));
    expect(setCommsTrust).toHaveBeenCalledWith('ws-1', expect.objectContaining({ tier: 'message' }));
  });

  it('is idempotent when the backlog is already empty (cleared:0, still ok:true)', async () => {
    const tool = await commsTool();
    const b = body(
      await tool.handler({ action: 'grant', githubUserId: 42, tier: 'message' }, ctxWith({ workspaceId: 'ws-1' })),
    );
    expect(b).toMatchObject({ ok: true, clearedRequests: 0 });
  });

  it("SECURITY: principal workspace '*' falls back to the active workspace for BOTH the tier set and the clear", async () => {
    const tool = await commsTool();
    await tool.handler({ action: 'grant', githubUserId: 42, tier: 'wake' }, ctxWith({ workspaceId: '*', slug: 'owner' }));
    expect(setCommsTrust.mock.calls[0]![0]).toBe(ACTIVE_WS);
    expect(clearCoordQuarantineForAuthor).toHaveBeenCalledWith({ workspaceId: ACTIVE_WS, authorGithubUserId: 42 });
  });

  // NOTE: the `githubUserId`-required-for-grant rule is a zod `.refine()` enforced by the
  // defineTool dispatch wrapper BEFORE `.handler` runs — calling `.handler` directly here
  // (as every test in this file does) bypasses that layer, so it isn't re-asserted per-test
  // (mirrors trust/add.test.ts, which likewise never exercises the schema layer directly).
});

describe('trust:comms — existing actions still resolve workspace the same way (regression guard)', () => {
  it("action:'set' still requires tier and threads workspace/actor unchanged", async () => {
    const tool = await commsTool();
    const b = body(
      await tool.handler(
        { action: 'set', githubUserId: 7, tier: 'steer' },
        ctxWith({ workspaceId: 'ws-1', slug: 'owner' }),
      ),
    );
    expect(setCommsTrust).toHaveBeenCalledWith('ws-1', expect.objectContaining({ githubUserId: 7, tier: 'steer' }));
    expect(b.ok).toBe(true);
  });

  it("action:'list' does not touch the quarantine store", async () => {
    const tool = await commsTool();
    await tool.handler({ action: 'list' }, ctxWith({ workspaceId: 'ws-1' }));
    expect(listCoordQuarantine).not.toHaveBeenCalled();
  });
});
