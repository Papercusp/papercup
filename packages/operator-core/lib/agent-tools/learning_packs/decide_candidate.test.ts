import { describe, it, expect, beforeEach, vi } from 'vitest';
import decideTool from './decide_candidate';
import { getFlag } from '@papercusp/flags/server';
import { decideLearningPackCandidate } from '../../learning-packs/candidates';
import { getSessionUserOrDefault } from '../../auth';

// PG-free unit: the decide core has its own suite; this pins the TOOL — flag
// gate, the by=session-user wiring, the bulk { ok, results, counts } envelope,
// the adopt-only hint, and a partial-failure case (self-improvement-consume-edges
// P-032 / B-11; bulk-endpoint-standardization-2026-06-21).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../learning-packs/candidates', () => ({ decideLearningPackCandidate: vi.fn() }));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockDecide = vi.mocked(decideLearningPackCandidate);
const mockUser = vi.mocked(getSessionUserOrDefault);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    decideTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { data: any }) => (r.data);

describe('learning_packs:decide_candidate tool (bulk keyed-array)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockUser.mockResolvedValue({ id: 'owner-1' } as Awaited<ReturnType<typeof getSessionUserOrDefault>>);
    mockDecide.mockResolvedValue({ ok: true, action: 'adopt', packVersion: '1.1.0' } as unknown as Awaited<
      ReturnType<typeof decideLearningPackCandidate>
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
    expect(r).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(r.results[0]).toMatchObject({ ok: true, id: 'c1' });
    expect(r.results[1]).toMatchObject({ ok: false, id: 'gone', reason: 'not_found' });
  });

  it('adds the upgrade hint on adopt, but not on dismiss', async () => {
    const adopted = body(await callTool({ id: 'c1', action: 'adopt' }));
    expect(adopted.results[0].hint).toMatch(/fleet-lessons pack/);

    mockDecide.mockResolvedValue({ ok: true, action: 'dismiss' } as unknown as Awaited<
      ReturnType<typeof decideLearningPackCandidate>
    >);
    const dismissed = body(await callTool({ id: 'c1', action: 'dismiss' }));
    expect(dismissed.results[0].hint).toBeUndefined();
  });
});
