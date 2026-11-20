import { describe, it, expect, beforeEach, vi } from 'vitest';
import upgradeTool from './upgrade';
import { getFlag } from '@papercusp/flags/server';
import { loadKnowledgePack } from '../../knowledge-packs/load-packs';
import { planPackUpgrade, applyPackInstall } from '../../knowledge-packs/manage';
import type { KnowledgePack } from '../../knowledge-packs/pack-format';
import { packItemMemoryWrite } from '../../knowledge-packs/seed';
import type { MemoryBackend, MemoryEntry } from '../../memory/backend';
import { getSessionUserOrDefault } from '../../auth';

// PG-free unit: the upgrade planner has its own suite; this pins the TOOL — flag
// gate, pack_not_found, the upToDate short-circuit (no new items), the
// review_required hold on clashing new items, and the apply path
// (learning-packs-2026-06-11 P-013, D-003 never-clobber).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../workspace-registry', () => ({
  resolveConcreteWorkspaceId: vi.fn((...candidates: Array<string | null | undefined>) =>
    candidates.find((candidate) => typeof candidate === 'string' && candidate.trim() && candidate.trim() !== '*')?.trim() ?? 'ws-active',
  ),
}));
vi.mock('../../knowledge-packs/load-packs', () => ({ loadKnowledgePack: vi.fn() }));
vi.mock('../../knowledge-packs/manage', () => ({ planPackUpgrade: vi.fn(), applyPackInstall: vi.fn() }));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockLoad = vi.mocked(loadKnowledgePack);
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

describe('knowledge_packs:upgrade tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockLoad.mockResolvedValue({ pack: { id: 'p1' } } as unknown as Awaited<ReturnType<typeof loadKnowledgePack>>);
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

  it('preserves local resolutions on an exact knowledge upgrade and holds newly conflicting items', async () => {
    const manage = await vi.importActual<typeof import('../../knowledge-packs/manage')>('../../knowledge-packs/manage');
    const original: KnowledgePack = {
      manifest: { id: 'p1', title: 'Formatting', description: 'List formatting choices', version: '1.0.0' },
      items: [{ id: 'lists', title: 'Lists', kind: 'feedback', appliesTo: ['any'], text: 'Use numbered lists.' }],
    };
    const written = packItemMemoryWrite({ workspaceId: 'ws-active', potSlug: 'h', pack: original,
      item: original.items[0], createdBy: 'user-1' });
    const saved: MemoryEntry = { id: 'local-lists', scope: written.options.scope, text: 'Use bullet lists here.',
      metadata: written.options.metadata };
    const backend: MemoryBackend = {
      name: 'fixture', available: async () => ({ ok: true }), list: async ({ scope }) => scope === saved.scope ? [saved] : [],
      search: vi.fn(async () => [{ ...saved, score: 0.4 }]), get: async id => id === saved.id ? saved : null,
      remember: vi.fn(), forget: vi.fn(), update: vi.fn(),
    };
    const deps = { backend, judge: async () => ({ conflicts: [{ memory_id: saved.id, summary: 'Contradicts the local list style' }] }),
      notifyInvalidate: vi.fn() };
    mockPlan.mockImplementation(opts => manage.planPackUpgrade(opts, deps));
    mockApply.mockImplementation(opts => manage.applyPackInstall(opts, deps));
    mockLoad.mockResolvedValue({ pack: original, source: 'installed', warnings: [] });
    const args = { pot: 'h', pack: 'p1' };
    for (let i = 0; i < 2; i++) {
      expect(body(await callTool(args))).toMatchObject({ ok: true, upToDate: true, installedVersions: ['1.0.0'] });
    }
    expect(backend.search).not.toHaveBeenCalled();
    const changed: KnowledgePack = { manifest: { ...original.manifest, version: '1.1.0' },
      items: [...original.items, { id: 'outline', title: 'Outlines', text: 'Always number every list.', kind: 'feedback', appliesTo: ['any'] }] };
    mockLoad.mockResolvedValue({ pack: changed, source: 'installed', warnings: [] });
    expect(body(await callTool(args))).toMatchObject({ ok: false, reason: 'review_required',
      plan: { availableVersion: '1.1.0', newItems: { conflicts: 1, items: [{ itemId: 'outline', existing: { id: saved.id } }] } } });
    expect(mockApply).not.toHaveBeenCalled();
    expect(body(await callTool({ ...args, resolutions: [{ itemId: 'outline', action: 'skip' }] })))
      .toMatchObject({ ok: true, installed: 0, skipped: 1 });
    expect(await backend.get(saved.id)).toMatchObject({ text: 'Use bullet lists here.', metadata: { pack_version: '1.0.0' } });
    expect(backend.remember).not.toHaveBeenCalled();
    expect(backend.forget).not.toHaveBeenCalled();
    expect(backend.update).not.toHaveBeenCalled();
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
    expect(mockApply).toHaveBeenCalledWith(expect.objectContaining({ potSlug: 'h', createdBy: 'user-1' }));
    expect(res).toMatchObject({ ok: true, installedVersions: ['1.0.0'], availableVersion: '1.1.0' });
  });
});
