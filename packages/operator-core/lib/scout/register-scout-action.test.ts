/**
 * register-scout-action.test.ts — Scout P-008 activation keystone.
 * Pins that importing the boot wire self-registers `system:scout-cycle` (so a
 * refactor can't silently un-activate the autonomous loop), and that the no-op
 * archive + setScoutArchive seam behave (the P-012 hand-off point).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  noopArchive,
  resolveArchive,
  setScoutArchiveBuilder,
  productionScoutRunner,
  readScoutProviderCapacity,
  resetScoutProviderCapacityCache,
  cachedScoutProviderCapacity,
  resolveScoutModel,
  SCOUT_CODEX_FALLBACK_MODEL,
} from './register-scout-action';

afterEach(() => {
  delete process.env.PAPERCUSP_SCOUT_ARCHIVE_RESOLVE_TIMEOUT_MS;
  setScoutArchiveBuilder(async () => noopArchive);
  resetScoutProviderCapacityCache();
  vi.unstubAllGlobals();
});

describe('register-scout-action (Scout production runner provider)', () => {
  it('exports productionScoutRunner — the blender:cycle blueprint op’s production cycle deps (P-130)', () => {
    // Scout runs as the `scout` BLUEPRINT now: the seed fires system:blueprint-run
    // {blueprintId:'scout'} → the blender:cycle deterministic step → runScoutCycleTick,
    // which calls productionScoutRunner. The bespoke system:scout-cycle action is RETIRED,
    // so this module no longer self-registers — it stays as the production-runner home.
    expect(productionScoutRunner).toBeTypeOf('function');
  });

  it('noopArchive reads empty + admits nothing (gym rail safe fallback)', async () => {
    expect(noopArchive.listElites()).toEqual([]);
    const r = noopArchive.seed({
      candidateId: 'x',
      descriptor: { coords: { scope: 'module', domain: 'Sync', risk: 'low' }, features: [0.5, 0.5] },
    });
    expect(r).toEqual({ admitted: false, nicheKey: 'module|sync|low' });
    await expect(noopArchive.flush()).resolves.toBeUndefined();
  });

  it('exposes setScoutArchiveBuilder so the archive can be overridden (tests / alternate store)', () => {
    expect(setScoutArchiveBuilder).toBeTypeOf('function');
  });

  it('falls back to noopArchive when archive resolution throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setScoutArchiveBuilder(async () => {
      throw new Error('archive down');
    });

    const archive = await resolveArchive({ workspaceId: 'ws', harnessSlug: 'h' });

    expect(archive).toBe(noopArchive);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive unavailable'), 'archive down');
    warn.mockRestore();
  });

  it('falls back to noopArchive when archive resolution hangs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PAPERCUSP_SCOUT_ARCHIVE_RESOLVE_TIMEOUT_MS = '5';
    setScoutArchiveBuilder(() => new Promise(() => undefined));

    const archive = await resolveArchive({ workspaceId: 'ws', harnessSlug: 'h' });

    expect(archive).toBe(noopArchive);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive unavailable'), 'archive resolve timed out after 5ms');
    warn.mockRestore();
  });

  it('reads Claude and Codex serviceable capacity from the gateway without mutating routing', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/stats')) {
        return new Response(JSON.stringify({ healthyAccounts: 0, codexHealthyAccounts: 1 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ providers: { codex: { configured: true, cliAccountCount: 1 } } }),
        { status: 200 },
      );
    });

    await expect(readScoutProviderCapacity(fetchMock as unknown as typeof fetch)).resolves.toEqual({
      claudeAvailable: false,
      codexAvailable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches the paired capacity probes for parallel Scout calls', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/stats')) {
        return new Response(JSON.stringify({ healthyAccounts: 2, codexHealthyAccounts: 1 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ providers: { codex: { configured: true, cliAccountCount: 1 } } }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([cachedScoutProviderCapacity(), cachedScoutProviderCapacity()]);

    expect(a).toEqual({ claudeAvailable: true, codexAvailable: true });
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses Codex only when Claude capacity is empty, preserving the historical Claude pin otherwise', () => {
    const backend = (model: string | undefined) => (model?.startsWith('chatgpt:') ? 'codex' : 'anthropic-direct');

    expect(resolveScoutModel('claude-opus-4-8', { claudeAvailable: false, codexAvailable: true }, backend, 'claude-opus-4-8'))
      .toBe(SCOUT_CODEX_FALLBACK_MODEL);
    expect(resolveScoutModel('claude-opus-4-8', { claudeAvailable: true, codexAvailable: true }, backend, 'claude-opus-4-8'))
      .toBe('claude-opus-4-8');
    expect(resolveScoutModel('chatgpt:5.5', { claudeAvailable: true, codexAvailable: true }, backend, 'claude-opus-4-8'))
      .toBe('claude-opus-4-8');
    expect(resolveScoutModel('claude-opus-4-8', { claudeAvailable: false, codexAvailable: false }, backend, 'claude-opus-4-8'))
      .toBe('claude-opus-4-8');
  });
});
