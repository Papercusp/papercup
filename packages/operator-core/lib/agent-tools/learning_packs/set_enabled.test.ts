import { describe, it, expect, beforeEach, vi } from 'vitest';
import setEnabledTool from './set_enabled';
import { getFlag } from '@papercusp/flags/server';
import { setPackEnabled } from '../../learning-packs/manage';

// PG-free unit: the mute/unmute core has its own suite; this pins the TOOL —
// flag gate, the workspace + arg wiring, the bulk { ok, results, counts }
// envelope keyed by hive+pack, and a partial-failure case
// (learning-packs-2026-06-11 P-009; bulk-endpoint-standardization-2026-06-21).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../learning-packs/manage', () => ({ setPackEnabled: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockSet = vi.mocked(setPackEnabled);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    setEnabledTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ data?: any; content?: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { data?: any; content?: Array<{ text: string }> }) => (r.data ?? JSON.parse(r.content![0].text));

describe('learning_packs:set_enabled tool (bulk keyed-array)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockSet.mockResolvedValue({ ok: true, disabled: [] } as unknown as Awaited<ReturnType<typeof setPackEnabled>>);
  });

  it('refuses when the flag is off (top-level)', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await callTool({ pot: 'h', pack: 'p1', enabled: false }))).toMatchObject({ ok: false, reason: 'feature-disabled' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('inline { hive, pack, enabled } wires through; one ok result keyed by hive+pack', async () => {
    const r = body(await callTool({ pot: 'h', pack: 'p1', enabled: false }, { principal: { workspaceId: 'ws-prin' } }));
    expect(r).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(r.results[0]).toMatchObject({ ok: true, pot: 'h', pack: 'p1', enabled: false });
    expect(mockSet).toHaveBeenCalledWith({ workspaceId: 'ws-prin', potSlug: 'h', packId: 'p1', enabled: false });
  });

  it('packs:[…] flips MANY for the same hive; per-item results keyed by hive+pack', async () => {
    const r = body(await callTool({ pot: 'h', packs: ['p1', 'p2'], enabled: true }));
    expect(r.counts).toEqual({ ok: 2, failed: 0 });
    expect(r.results.map((x: { pack: string }) => x.pack)).toEqual(['p1', 'p2']);
    expect(mockSet).toHaveBeenCalledWith({ workspaceId: 'ws-active', potSlug: 'h', packId: 'p2', enabled: true });
  });

  it('a core throw fails only that item; top-level ok stays true', async () => {
    mockSet.mockImplementation(async (o: { packId: string }) => {
      if (o.packId === 'bad') throw new Error('store write failed');
      return { ok: true, disabled: [] } as never;
    });
    const r = body(await callTool({ pot: 'h', packs: ['p1', 'bad'], enabled: false }));
    expect(r).toMatchObject({ ok: true, counts: { ok: 1, failed: 1 } });
    expect(r.results[0]).toMatchObject({ ok: true, pot: 'h', pack: 'p1' });
    expect(r.results[1]).toMatchObject({ ok: false, pot: 'h', pack: 'bad', error: 'store write failed' });
  });

  it('items:[…] heterogeneous flips across hives', async () => {
    const r = body(await callTool({ items: [{ pot: 'h1', pack: 'p1', enabled: true }, { pot: 'h2', pack: 'p2', enabled: false }] }));
    expect(r.counts).toEqual({ ok: 2, failed: 0 });
    expect(mockSet).toHaveBeenCalledWith({ workspaceId: 'ws-active', potSlug: 'h1', packId: 'p1', enabled: true });
    expect(mockSet).toHaveBeenCalledWith({ workspaceId: 'ws-active', potSlug: 'h2', packId: 'p2', enabled: false });
  });
});
