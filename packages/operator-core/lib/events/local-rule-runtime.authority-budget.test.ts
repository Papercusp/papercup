import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolvePot: vi.fn(), withWorkspace: vi.fn(), listLocal: vi.fn(),
  reserve: vi.fn(), release: vi.fn(),
}));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), withWorkspace: h.withWorkspace,
  getOrgPg: () => ({ sql: { reserve: h.reserve }, poolLabel: 'org-admin-priority' }),
}));
vi.mock('../memory/hive-scope', () => ({ resolvePotSlugsForHarnesses: h.resolvePot }));
vi.mock('./local-rule-store', () => ({ listLocalRules: h.listLocal, localRuleSource: vi.fn() }));
vi.mock('./standalone-rules', () => ({ registerStandaloneReactionRule: vi.fn() }));
vi.mock('./registry', () => ({
  listReactionRules: vi.fn(), registerReactionRule: vi.fn(), unregisterReactionRule: vi.fn(), matchReactions: vi.fn(),
}));
vi.mock('./identity-reaction', () => ({ executeIdentityReaction: vi.fn() }));
vi.mock('../agent-identities/sync-hook-rules', async original => ({
  ...await original<typeof import('../agent-identities/sync-hook-rules')>(),
  setLocalSyncRulesReader: vi.fn(),
}));
vi.mock('./engine', () => ({ setLocalRuleMatcher: vi.fn() }));

import { readLocalSyncRules } from './local-rule-runtime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let now: number;
beforeEach(() => {
  vi.resetAllMocks();
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  h.resolvePot.mockResolvedValue(['pot']);
  h.listLocal.mockResolvedValue([]);
  h.withWorkspace.mockImplementation(async (_workspace, run) => run({}));
  h.reserve.mockResolvedValue({ release: h.release });
});
afterEach(() => vi.restoreAllMocks());

describe('local sync rules share the native authority lifetime', () => {
  it('reads current rules when the app transaction pool is unavailable', async () => {
    h.withWorkspace.mockRejectedValue(new Error('app transaction pool unavailable'));
    await expect(readLocalSyncRules('owner', 'ws', 'harness', {
      signal: new AbortController().signal, deadlineAtMs: 100,
    })).resolves.toEqual({ rules: [], unreadable: [] });
    expect(h.withWorkspace).not.toHaveBeenCalled();
    expect(h.reserve).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.listLocal).toHaveBeenCalledWith(
      { workspaceId: 'ws', potSlug: 'pot' },
      { includeWorkspace: true, enabledOnly: true },
      expect.objectContaining({ release: h.release }),
    );
  });

  it('does not resolve a registry after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('native call ended');
    controller.abort(reason);
    await expect(readLocalSyncRules('owner', 'ws', 'harness', {
      signal: controller.signal, deadlineAtMs: 100,
    })).rejects.toBe(reason);
    expect(h.resolvePot).not.toHaveBeenCalled();
  });

  it('does not acquire SQL when registry resolution outlives its caller', async () => {
    const registry = deferred<string[]>();
    const registryStarted = deferred<void>();
    h.resolvePot.mockImplementation(() => {
      registryStarted.resolve();
      return registry.promise;
    });
    const controller = new AbortController();
    const reason = new Error('native call ended during registry read');
    const pending = readLocalSyncRules('owner', 'ws', 'harness', {
      signal: controller.signal, deadlineAtMs: 100,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await registryStarted.promise;
    expect(h.resolvePot).toHaveBeenCalledOnce();
    controller.abort(reason);
    registry.resolve(['pot']);
    await rejected;
    expect(h.withWorkspace).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.listLocal).not.toHaveBeenCalled();
  });

  it('releases a late SQL reservation without reading rules', async () => {
    const acquired = deferred<void>();
    const queued = deferred<void>();
    h.reserve.mockImplementation(async () => {
      queued.resolve();
      await acquired.promise;
      return { release: h.release };
    });
    const controller = new AbortController();
    const reason = new Error('native call ended while acquiring');
    const pending = readLocalSyncRules('owner', 'ws', 'harness', {
      signal: controller.signal, deadlineAtMs: 100,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await queued.promise;
    controller.abort(reason);
    acquired.resolve();
    await rejected;
    expect(h.listLocal).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
  });

  it('does not return rules completed after cancellation', async () => {
    const reading = deferred<void>();
    const rows = deferred<never[]>();
    h.listLocal.mockImplementation(() => { reading.resolve(); return rows.promise; });
    const controller = new AbortController();
    const reason = new Error('native call ended during rules read');
    const pending = readLocalSyncRules('owner', 'ws', 'harness', {
      signal: controller.signal, deadlineAtMs: 100,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await reading.promise;
    controller.abort(reason);
    rows.resolve([]);
    await rejected;
  });

  it.each([99, 100, 101])('checks the absolute deadline at %ims', async elapsed => {
    now = elapsed;
    const pending = readLocalSyncRules('owner', 'ws', 'harness', {
      signal: new AbortController().signal, deadlineAtMs: 100,
    });
    if (elapsed < 100) {
      await expect(pending).resolves.toEqual({ rules: [], unreadable: [] });
      expect(h.reserve).toHaveBeenCalledOnce();
      expect(h.withWorkspace).not.toHaveBeenCalled();
    } else {
      await expect(pending).rejects.toThrow('identity rule read budget expired');
      expect(h.resolvePot).not.toHaveBeenCalled();
    }
  });
});
