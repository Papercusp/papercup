import { describe, it, expect, beforeEach, vi } from 'vitest';
import decideTool from './decide_candidate';
import { getFlag } from '@papercusp/flags/server';
import { decideKnowledgePackCandidate } from '../../knowledge-packs/candidates';
import { getSessionUserOrDefault } from '../../auth';
import { proposeIdentityMemory } from '../../knowledge-packs/identity-learning';

// PG-free unit: the decide core has its own suite; this pins the TOOL — flag
// gate, the by=session-user wiring, the bulk { ok, results, counts } envelope,
// the adopt-only hint, and a partial-failure case (self-improvement-consume-edges
// P-032 / B-11; bulk-endpoint-standardization-2026-06-21).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../workspace-registry', () => ({
  resolveConcreteWorkspaceId: vi.fn((...candidates: Array<string | null | undefined>) =>
    candidates.find((candidate) => typeof candidate === 'string' && candidate.trim() && candidate.trim() !== '*')?.trim() ?? 'ws-active',
  ),
}));
vi.mock('../../knowledge-packs/candidates', () => ({ decideKnowledgePackCandidate: vi.fn() }));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: vi.fn() }));
vi.mock('../../knowledge-packs/identity-learning', () => ({ proposeIdentityMemory: vi.fn(async () => ({ ok: true, staged: true, id: 'proposal' })) }));

const mockFlag = vi.mocked(getFlag);
const mockDecide = vi.mocked(decideKnowledgePackCandidate);
const mockUser = vi.mocked(getSessionUserOrDefault);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    decideTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ data?: any; content?: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { data?: any; content?: Array<{ text: string }> }) => (r.data ?? JSON.parse(r.content![0].text));

describe('knowledge_packs:decide_candidate tool (bulk keyed-array)', () => {
  it('proposes only through the explicit write operation with server-derived writer/workspace', async () => {
    mockFlag.mockResolvedValue(true);
    const result = body(await callTool({ action: 'propose', memoryId: 'memory', identityId: 'identity' }, {
      uiClientId: 'writer', principal: { workspaceId: 'ws-writer' },
    }));
    expect(result).toMatchObject({ ok: true, staged: true, id: 'proposal' });
    expect(proposeIdentityMemory).toHaveBeenCalledWith({ memoryId: 'memory', identityId: 'identity', packId: undefined, ownerId: 'writer', workspaceId: 'ws-writer' });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockUser.mockResolvedValue({ id: 'owner-1' } as Awaited<ReturnType<typeof getSessionUserOrDefault>>);
    mockDecide.mockResolvedValue({ ok: true, action: 'adopt', packId: 'fleet-lessons', packVersion: '1.1.0' } as unknown as Awaited<
      ReturnType<typeof decideKnowledgePackCandidate>
    >);
  });

  it('refuses when the flag is off (top-level)', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await callTool({ id: 'c1', action: 'adopt' }))).toMatchObject({ ok: false, reason: 'feature-disabled' });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('inline { id, action } decides with the session user as `by`, forwarding edits', async () => {
    const r = body(await callTool({ id: 'c1', action: 'adopt', note: 'good lesson', title: 'T', text: 'B' }));
    expect(r).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(r.results[0]).toMatchObject({ ok: true, id: 'c1', action: 'adopt' });
    expect(mockDecide).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', action: 'adopt', by: 'owner-1', note: 'good lesson', title: 'T', text: 'B' }),
    );
  });

  it('ids:[…] decides MANY with the same action; per-item results keyed by id', async () => {
    const r = body(await callTool({ ids: ['c1', 'c2'], action: 'dismiss' }));
    expect(r.counts).toEqual({ ok: 2, failed: 0 });
    expect(r.results.map((x: { id: string }) => x.id)).toEqual(['c1', 'c2']);
    expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2', action: 'dismiss', by: 'owner-1' }));
  });

  it('a core failure fails only that item; top-level ok stays true', async () => {
    mockDecide.mockImplementation(async (a: { id: string }) =>
      a.id === 'gone'
        ? ({ ok: false, reason: 'not_found' } as never)
        : ({ ok: true, action: 'adopt', packVersion: '1.1.0' } as never),
    );
    const r = body(await callTool({ ids: ['c1', 'gone'], action: 'adopt' }));
    expect(r).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(r.results[0]).toMatchObject({ ok: true, id: 'c1' });
    expect(r.results[1]).toMatchObject({ ok: false, id: 'gone', reason: 'not_found' });
  });

  it('adds the upgrade hint on adopt, but not on dismiss', async () => {
    const adopted = body(await callTool({ id: 'c1', action: 'adopt' }));
    expect(adopted.results[0].hint).toMatch(/fleet-lessons pack/);

    mockDecide.mockResolvedValue({ ok: true, action: 'dismiss' } as unknown as Awaited<
      ReturnType<typeof decideKnowledgePackCandidate>
    >);
    const dismissed = body(await callTool({ id: 'c1', action: 'dismiss' }));
    expect(dismissed.results[0].hint).toBeUndefined();
  });
});
