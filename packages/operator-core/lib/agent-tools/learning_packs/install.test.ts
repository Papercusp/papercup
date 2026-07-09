import { describe, it, expect, beforeEach, vi } from 'vitest';
import installTool from './install';
import { getFlag } from '@papercusp/flags/server';
import { loadLearningPack } from '../../learning-packs/load-packs';
import { classifyPackInstall, applyPackInstall } from '../../learning-packs/manage';
import { getSessionUserOrDefault } from '../../auth';

// PG-free unit: the classify/apply core has its own suite; this pins the TOOL's
// two-step install contract — flag gate, pack_not_found, the review_required
// hold-on-clashes branch (unless resolutions / acceptDefaults), and the apply
// path (learning-packs-2026-06-11 P-009/P-010, D-003).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../learning-packs/load-packs', () => ({ loadLearningPack: vi.fn() }));
vi.mock('../../learning-packs/manage', () => ({ classifyPackInstall: vi.fn(), applyPackInstall: vi.fn() }));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockLoad = vi.mocked(loadLearningPack);
const mockClassify = vi.mocked(classifyPackInstall);
const mockApply = vi.mocked(applyPackInstall);
const mockUser = vi.mocked(getSessionUserOrDefault);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    installTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const review = (p: Record<string, number> = {}) => ({ clean: 3, duplicates: 0, conflicts: 0, ...p });

describe('learning_packs:install tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockLoad.mockResolvedValue({ pack: { id: 'p1', items: [] } } as unknown as Awaited<ReturnType<typeof loadLearningPack>>);
    mockClassify.mockResolvedValue(review() as unknown as Awaited<ReturnType<typeof classifyPackInstall>>);
    mockApply.mockResolvedValue({ ok: true, installed: 3 } as unknown as Awaited<ReturnType<typeof applyPackInstall>>);
    mockUser.mockResolvedValue({ id: 'user-1' } as Awaited<ReturnType<typeof getSessionUserOrDefault>>);
  });

  it('refuses when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await callTool({ pot: 'h', pack: 'p1' }))).toMatchObject({ ok: false, reason: 'feature-disabled' });
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('returns pack_not_found when the pack does not resolve', async () => {
    mockLoad.mockResolvedValue(null as never);
    expect(body(await callTool({ pot: 'h', pack: 'ghost' }))).toMatchObject({ ok: false, reason: 'pack_not_found', pack: 'ghost' });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('holds with review_required when there are clashes and no resolutions/acceptDefaults', async () => {
    mockClassify.mockResolvedValue(review({ duplicates: 1, conflicts: 1 }) as unknown as Awaited<
      ReturnType<typeof classifyPackInstall>
    >);
    const res = body(await callTool({ pot: 'h', pack: 'p1' }));
    expect(res).toMatchObject({ ok: false, reason: 'review_required' });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('installs a clean pack immediately (no clashes → straight to apply)', async () => {
    const res = body(await callTool({ pot: 'h', pack: 'p1' }));
    expect(mockApply).toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, review: { clean: 3, duplicates: 0, conflicts: 0 } });
  });

  it('applies with resolutions even when clashes exist (acceptDefaults bypass)', async () => {
    mockClassify.mockResolvedValue(review({ duplicates: 2 }) as unknown as Awaited<ReturnType<typeof classifyPackInstall>>);
    await callTool({ pot: 'h', pack: 'p1', acceptDefaults: true });
    expect(mockApply).toHaveBeenCalledWith(expect.objectContaining({ potSlug: 'h', createdBy: 'user-1' }));
  });
});
