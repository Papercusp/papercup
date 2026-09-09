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
  withCodexCapacityFallback,
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

  it('preserves an explicit Codex model and uses the canonical fallback only when a legacy Claude lane is empty', () => {
    const backend = (model: string | undefined) => (/^(chatgpt:|gpt-)/.test(model ?? '') ? 'codex' : 'anthropic-direct');

    expect(resolveScoutModel('claude-opus-4-8', { claudeAvailable: false, codexAvailable: true }, backend, 'claude-opus-4-8'))
      .toBe(SCOUT_CODEX_FALLBACK_MODEL);
    expect(resolveScoutModel('claude-opus-4-8', { claudeAvailable: true, codexAvailable: true }, backend, 'claude-opus-4-8'))
      .toBe('claude-opus-4-8');
    expect(resolveScoutModel('gpt-5.6-luna:medium', { claudeAvailable: false, codexAvailable: true }, backend, 'claude-opus-4-8'))
      .toBe('gpt-5.6-luna:medium');
    expect(resolveScoutModel('gpt-5.6-sol:xhigh', { claudeAvailable: true, codexAvailable: true }, backend, 'claude-opus-4-8'))
      .toBe('gpt-5.6-sol:xhigh');
    expect(resolveScoutModel('claude-opus-4-8', { claudeAvailable: false, codexAvailable: false }, backend, 'claude-opus-4-8'))
      .toBe('claude-opus-4-8');
  });
});

describe('withCodexCapacityFallback — one Codex retry on an ATTESTED mid-cycle capacity denial (WI-5391 item 3)', () => {
  const backend = (model: string | undefined) => (/^(chatgpt:|gpt-)/.test(model ?? '') ? 'codex' : 'anthropic-direct');
  const attestedDenial = (via: 'governor' | 'http-429', reason = 'provider-429') =>
    Object.assign(new Error('capacity walled'), { admissionDenial: { reason, via } });

  it('retries ONCE on the fallback model and records a succeeded event (the discriminator)', async () => {
    const calls: (string | undefined)[] = [];
    const events: import('./capacity-errors').CapacityFallbackEvent[] = [];
    const wrapped = withCodexCapacityFallback(
      async (o: { model?: string }) => {
        calls.push(o.model);
        if (o.model !== SCOUT_CODEX_FALLBACK_MODEL) throw attestedDenial('http-429');
        return 'codex-answer';
      },
      { capacity: { claudeAvailable: true, codexAvailable: true }, backendForModel: backend, events },
    );
    await expect(wrapped({ model: 'claude-opus-4-8' })).resolves.toBe('codex-answer');
    expect(calls).toEqual(['claude-opus-4-8', SCOUT_CODEX_FALLBACK_MODEL]);
    expect(events).toEqual([
      { from: 'claude-opus-4-8', to: SCOUT_CODEX_FALLBACK_MODEL, succeeded: true, via: 'http-429', reason: 'provider-429' },
    ]);
  });

  it('rethrows the ORIGINAL attested denial when the fallback also fails — event stays succeeded:false', async () => {
    const original = attestedDenial('governor', 'rate-limit-blocked');
    const events: import('./capacity-errors').CapacityFallbackEvent[] = [];
    const wrapped = withCodexCapacityFallback(
      async (o: { model?: string }) => {
        if (o.model === SCOUT_CODEX_FALLBACK_MODEL) throw new Error('codex quota exhausted');
        throw original;
      },
      { capacity: { claudeAvailable: true, codexAvailable: true }, backendForModel: backend, events },
    );
    // The original carries the attestation the capacity classifier needs; the codex miss
    // must not replace it with an evidence-free error.
    await expect(wrapped({ model: 'claude-opus-4-8' })).rejects.toBe(original);
    expect(events).toEqual([
      { from: 'claude-opus-4-8', to: SCOUT_CODEX_FALLBACK_MODEL, succeeded: false, via: 'governor', reason: 'rate-limit-blocked' },
    ]);
  });

  it('does NOT divert on an evidence-free capacity-shaped error (same bar as the classifier)', async () => {
    const events: import('./capacity-errors').CapacityFallbackEvent[] = [];
    const unattested = Object.assign(new Error('rate limit exceeded'), {
      admissionDenial: { reason: 'provider-429' }, // no via stamp
    });
    let calls = 0;
    const wrapped = withCodexCapacityFallback(
      async () => {
        calls += 1;
        throw unattested;
      },
      { capacity: { claudeAvailable: true, codexAvailable: true }, backendForModel: backend, events },
    );
    await expect(wrapped({ model: 'claude-opus-4-8' })).rejects.toBe(unattested);
    expect(calls).toBe(1);
    expect(events).toEqual([]);
  });

  it('does NOT divert when codex is unavailable or the call is already on codex', async () => {
    const events: import('./capacity-errors').CapacityFallbackEvent[] = [];
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw attestedDenial('http-429');
    };
    const noCodex = withCodexCapacityFallback(failing, {
      capacity: { claudeAvailable: true, codexAvailable: false },
      backendForModel: backend,
      events,
    });
    await expect(noCodex({ model: 'claude-opus-4-8' })).rejects.toThrow('capacity walled');
    const alreadyCodex = withCodexCapacityFallback(failing, {
      capacity: { claudeAvailable: false, codexAvailable: true },
      backendForModel: backend,
      events,
    });
    await expect(alreadyCodex({ model: SCOUT_CODEX_FALLBACK_MODEL })).rejects.toThrow('capacity walled');
    expect(calls).toBe(2); // one attempt each — no retries
    expect(events).toEqual([]);
  });

  it('does NOT divert on a non-capacity error (transport death stays loud)', async () => {
    const events: import('./capacity-errors').CapacityFallbackEvent[] = [];
    const wrapped = withCodexCapacityFallback(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      { capacity: { claudeAvailable: true, codexAvailable: true }, backendForModel: backend, events },
    );
    await expect(wrapped({ model: 'claude-opus-4-8' })).rejects.toThrow('ECONNREFUSED');
    expect(events).toEqual([]);
  });
});
