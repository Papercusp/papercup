import { describe, it, expect, beforeEach, vi } from 'vitest';
import uninstallTool from './uninstall';
import { getFlag } from '@papercusp/flags/server';
import { loadLearningPack } from '../../learning-packs/load-packs';
import { uninstallPack } from '../../learning-packs/manage';

// PG-free unit: the uninstall core has its own suite; this pins the TOOL — flag
// gate, the null-pack tolerance (uninstall by id even if the pack no longer
// resolves), and the keepEdited pass-through (learning-packs-2026-06-11 P-009).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../learning-packs/load-packs', () => ({ loadLearningPack: vi.fn() }));
vi.mock('../../learning-packs/manage', () => ({ uninstallPack: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockLoad = vi.mocked(loadLearningPack);
const mockUninstall = vi.mocked(uninstallPack);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    uninstallTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('learning_packs:uninstall tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockLoad.mockResolvedValue({ pack: { id: 'p1' } } as unknown as Awaited<ReturnType<typeof loadLearningPack>>);
    mockUninstall.mockResolvedValue({ ok: true, removed: 5, keptEdited: [] } as unknown as Awaited<
      ReturnType<typeof uninstallPack>
    >);
  });

  it('refuses when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await callTool({ pot: 'h', pack: 'p1' }))).toMatchObject({ ok: false, reason: 'feature-disabled' });
    expect(mockUninstall).not.toHaveBeenCalled();
  });

  it('uninstalls by id even when the pack no longer resolves (pack:null tolerated)', async () => {
    mockLoad.mockResolvedValue(null as never);
    await callTool({ pot: 'h', pack: 'p-gone' });
    expect(mockUninstall).toHaveBeenCalledWith(expect.objectContaining({ hiveSlug: 'h', packId: 'p-gone', pack: null }));
  });

  it('forwards keepEdited when provided', async () => {
    await callTool({ pot: 'h', pack: 'p1', keepEdited: false });
    expect(mockUninstall).toHaveBeenCalledWith(expect.objectContaining({ keepEdited: false }));
  });

  it('returns the core result', async () => {
    expect(body(await callTool({ pot: 'h', pack: 'p1' }))).toMatchObject({ ok: true, removed: 5 });
  });
});
