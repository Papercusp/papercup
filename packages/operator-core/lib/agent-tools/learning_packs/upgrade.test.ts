import { describe, it, expect, beforeEach, vi } from 'vitest';
import upgradeTool from './upgrade';
import { getFlag } from '@papercusp/flags/server';
import { loadLearningPack } from '../../learning-packs/load-packs';
import { planPackUpgrade, applyPackInstall } from '../../learning-packs/manage';
import { getSessionUserOrDefault } from '../../auth';

// PG-free unit: the upgrade planner has its own suite; this pins the TOOL — flag
// gate, pack_not_found, the upToDate short-circuit (no new items), the
// review_required hold on clashing new items, and the apply path
// (learning-packs-2026-06-11 P-013, D-003 never-clobber).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../learning-packs/load-packs', () => ({ loadLearningPack: vi.fn() }));
vi.mock('../../learning-packs/manage', () => ({ planPackUpgrade: vi.fn(), applyPackInstall: vi.fn() }));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockLoad = vi.mocked(loadLearningPack);
const mockPlan = vi.mocked(planPackUpgrade);
const mockApply = vi.mocked(applyPackInstall);
const mockUser = vi.mocked(getSessionUserOrDefault);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    upgradeTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
function plan(p: Record<string, unknown> = {}) {
  return {
    newItems: { items: [{ itemId: 'i1' }], duplicates: 0, conflicts: 0 },
    installedVersions: ['1.0.0'],
    availableVersion: '1.1.0',
    ...p,
  };
}

describe('learning_packs:upgrade tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockLoad.mockResolvedValue({ pack: { id: 'p1' } } as unknown as Awaited<ReturnType<typeof loadLearningPack>>);
    mockPlan.mockResolvedValue(plan() as unknown as Awaited<ReturnType<typeof planPackUpgrade>>);
    mockApply.mockResolvedValue({ ok: true, installed: 1 } as unknown as Awaited<ReturnType<typeof applyPackInstall>>);
    mockUser.mockResolvedValue({ id: 'user-1' } as Awaited<ReturnType<typeof getSessionUserOrDefault>>);
  });

  it('refuses when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await callTool({ pot: 'h', pack: 'p1' }))).toMatchObject({ ok: false, reason: 'feature-disabled' });
  });

  it('returns pack_not_found when the pack does not resolve', async () => {
    mockLoad.mockResolvedValue(null as never);
    expect(body(await callTool({ pot: 'h', pack: 'ghost' }))).toMatchObject({ ok: false, reason: 'pack_not_found' });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('short-circuits upToDate when there are no new items', async () => {
    mockPlan.mockResolvedValue(
      plan({ newItems: { items: [], duplicates: 0, conflicts: 0 } }) as unknown as Awaited<ReturnType<typeof planPackUpgrade>>,
    );
    const res = body(await callTool({ pot: 'h', pack: 'p1' }));
    expect(res).toMatchObject({ ok: true, upToDate: true });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('holds review_required when new items clash and no resolutions/acceptDefaults', async () => {
    mockPlan.mockResolvedValue(
      plan({ newItems: { items: [{ itemId: 'i1' }], duplicates: 1, conflicts: 0 } }) as unknown as Awaited<
        ReturnType<typeof planPackUpgrade>
      >,
    );
    expect(body(await callTool({ pot: 'h', pack: 'p1' }))).toMatchObject({ ok: false, reason: 'review_required' });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('applies the new items (clean) and reports installed/available versions', async () => {
    const res = body(await callTool({ pot: 'h', pack: 'p1' }));
    expect(mockApply).toHaveBeenCalledWith(expect.objectContaining({ hiveSlug: 'h', createdBy: 'user-1' }));
    expect(res).toMatchObject({ ok: true, installedVersions: ['1.0.0'], availableVersion: '1.1.0' });
  });
});
