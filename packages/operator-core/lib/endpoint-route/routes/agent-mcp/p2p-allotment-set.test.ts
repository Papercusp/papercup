/**
 * Unit tests for POST /api/agent-mcp/p2p-allotment-set
 * (agent-allocation-framework-2026-07-03 P-002 — the loopback-wraps-the-tool refactor).
 *
 * Pins the body → delegateResource CORE mapping, most load-bearingly the P-003
 * UI contract: an agent_slot body carries `quantity` (the store column name),
 * which MUST reach the core as `count` — the pre-refactor route silently
 * dropped it, turning every slot write into a quantity_required refusal. Also:
 * the `count` alias, the account/gpu body unchanged, remove, the refusal→400
 * passthrough, and the loopback gate.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/agent-mcp/p2p-allotment-set.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const delegateMock = vi.fn(async (_i: unknown) => ({ ok: true as const, action: 'set' as const, allotment: { fleetSlug: 'f' } }));
const isLoopbackMock = vi.fn(() => true);

vi.mock('../../../superuser-token', () => ({ isLoopbackRequest: () => isLoopbackMock() }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../harness/usage-actor', () => ({ resolveUsageActor: vi.fn(async () => ({ githubUserId: 9 })) }));
vi.mock('../../../agent-tools/resource/delegate', () => ({ delegateResource: (i: unknown) => delegateMock(i) }));

async function callPost(body: unknown): Promise<Response> {
  const mod = await import('./p2p-allotment-set');
  const route = mod.default as unknown as { handler: (r: Request) => Promise<Response> };
  return route.handler(
    new Request('http://localhost:3070/api/agent-mcp/p2p-allotment-set', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const coreInput = () => delegateMock.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  isLoopbackMock.mockReturnValue(true);
  delegateMock.mockResolvedValue({ ok: true, action: 'set', allotment: { fleetSlug: 'f' } } as never);
});

describe('p2p-allotment-set — the P-003 agent_slot body reaches the core intact', () => {
  it("forwards `quantity` as the core's count (the silently-dropped field the refactor exists for)", async () => {
    const res = await callPost({
      action: 'set',
      fleetSlug: 'x',
      resourceKind: 'agent_slot',
      resourceRef: 'opus:xhigh:AUTO',
      quantity: 5,
      axis: { model: 'opus', effort: 'xhigh', account: 'AUTO' },
    });
    expect(res.status).toBe(200);
    expect(coreInput()).toMatchObject({
      workspaceId: 'ws-test',
      fleetSlug: 'x',
      kind: 'agent_slot',
      ref: 'opus:xhigh:AUTO',
      count: 5,
      axis: { model: 'opus', effort: 'xhigh', account: 'AUTO' },
      remove: false,
      createdByGithubUserId: 9,
    });
  });

  it('accepts `count` as an alias; `quantity` wins when both are sent', async () => {
    await callPost({ action: 'set', fleetSlug: 'x', resourceKind: 'agent_slot', count: 3 });
    expect(coreInput().count).toBe(3);
    delegateMock.mockClear();
    await callPost({ action: 'set', fleetSlug: 'x', resourceKind: 'agent_slot', quantity: 7, count: 3 });
    expect(coreInput().count).toBe(7);
  });
});

describe('p2p-allotment-set — account/gpu bodies unchanged (P-201)', () => {
  it('forwards sharePct + axis; count stays undefined', async () => {
    await callPost({ action: 'set', fleetSlug: 'x', resourceKind: 'account', resourceRef: 'pool-main', sharePct: 50, axis: { windows: [] } });
    expect(coreInput()).toMatchObject({ kind: 'account', ref: 'pool-main', sharePct: 50, axis: { windows: [] } });
    expect(coreInput().count).toBeUndefined();
  });

  it('remove maps to the core remove path with the row ref', async () => {
    delegateMock.mockResolvedValue({ ok: true, action: 'remove', removed: 1 } as never);
    const res = await callPost({ action: 'remove', fleetSlug: 'x', resourceKind: 'agent_slot', resourceRef: 'opus:xhigh:AUTO' });
    expect(coreInput()).toMatchObject({ kind: 'agent_slot', ref: 'opus:xhigh:AUTO', remove: true });
    expect(await res.json()).toMatchObject({ ok: true, action: 'remove', removed: 1 });
  });
});

describe('p2p-allotment-set — gates + refusal passthrough', () => {
  it('a core refusal maps to 400 { error: code, detail }', async () => {
    delegateMock.mockResolvedValue({ ok: false, refusal: { code: 'quantity_required', detail: 'q' } } as never);
    const res = await callPost({ action: 'set', fleetSlug: 'x', resourceKind: 'agent_slot' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'quantity_required', detail: 'q' });
  });

  it('non-loopback → 403; missing action → 400 (never touches the core)', async () => {
    isLoopbackMock.mockReturnValue(false);
    expect((await callPost({ action: 'set' })).status).toBe(403);
    isLoopbackMock.mockReturnValue(true);
    expect((await callPost({ fleetSlug: 'x' })).status).toBe(400);
    expect(delegateMock).not.toHaveBeenCalled();
  });
});
