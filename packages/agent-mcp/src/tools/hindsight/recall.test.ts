/**
 * hindsight:recall — PURE unit tests for `resolveCompanyId` + the handler's
 * always-degraded contract + deprecation log, exercised directly.
 *
 * Focus:
 *   - resolveCompanyId: file-absent → null; malformed-JSON → null (via
 *     catch); workspace-not-found → null; happy path → the companyId.
 *   - handler is ALWAYS degraded:
 *       · no companyId → ['hindsight_not_configured_for_workspace',
 *                         'tool_deprecated_use_features_tools'].
 *       · companyId resolved → degraded reason naming the resolved bank.
 *   - the deprecation `ctx.log('info', ...)` call fires on every invocation.
 *
 * `@papercusp/host-platform`'s `getHostPlatform` is mocked so `readTextFileSync`
 * and `homedir` are scriptable per-test without touching the real FS.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

let readImpl: (path: string) => string | null = () => null;

vi.mock('@papercusp/host-platform', () => ({
  getHostPlatform: () => ({
    readTextFileSync: (p: string) => readImpl(p),
    homedir: () => '/home/test',
  }),
}));

import tool from './recall';

const CTX = (over: { workspaceId?: string; slug?: string } = {}) => {
  const log = vi.fn();
  return {
    log,
    principal: {
      slug: over.slug ?? 'pi:abc',
      workspaceId: over.workspaceId ?? 'ws-1',
    } as never,
    tx: {} as never,
    _log: log,
  };
};

beforeEach(() => {
  readImpl = () => null;
});

function registryJson(entries: Array<{ id: string; name?: string; companyId?: string | null }>) {
  return JSON.stringify({ workspaces: entries.map((e) => ({ name: 'n', ...e })) });
}

describe('hindsight:recall — resolveCompanyId via handler degraded reasons', () => {
  it('file absent (readTextFileSync→null) → not configured', async () => {
    readImpl = () => null;
    const res = await tool.handler({ query: 'auth', limit: 10 } as never, CTX() as never);
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toEqual([
      'hindsight_not_configured_for_workspace',
      'tool_deprecated_use_features_tools',
    ]);
  });

  it('malformed JSON → catch → not configured (does NOT throw)', async () => {
    readImpl = () => '{ this is not valid json ';
    const res = await tool.handler({ query: 'auth', limit: 10 } as never, CTX() as never);
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toContain('hindsight_not_configured_for_workspace');
  });

  it('workspace not found in registry → not configured', async () => {
    readImpl = () => registryJson([{ id: 'other-ws', companyId: 'acme' }]);
    const res = await tool.handler({ query: 'auth', limit: 10 } as never, CTX({ workspaceId: 'ws-1' }) as never);
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toContain('hindsight_not_configured_for_workspace');
  });

  it('workspace found but companyId null/absent → not configured', async () => {
    readImpl = () => registryJson([{ id: 'ws-1', companyId: null }]);
    const res = await tool.handler({ query: 'auth', limit: 10 } as never, CTX({ workspaceId: 'ws-1' }) as never);
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toContain('hindsight_not_configured_for_workspace');
  });

  it('happy path: companyId resolves → bank name surfaces in the degraded reason', async () => {
    readImpl = () => registryJson([{ id: 'ws-1', companyId: 'acme-co' }]);
    const res = await tool.handler(
      { query: 'login flow', limit: 5 } as never,
      CTX({ workspaceId: 'ws-1' }) as never,
    );
    expect(res.degraded).toBe(true);
    expect(res.data).toEqual([]);
    const reason = res.degradedReasons?.[0] ?? '';
    // bank = paperclip::<companyId>
    expect(reason).toContain('bank=paperclip::acme-co');
    expect(reason).toContain(JSON.stringify('login flow'));
    // The "not configured" sentinel is NOT present on the resolved path.
    expect(res.degradedReasons).not.toContain('hindsight_not_configured_for_workspace');
  });
});

describe('hindsight:recall — always-degraded + deprecation log', () => {
  it('emits the deprecation info log on every call (configured path)', async () => {
    readImpl = () => registryJson([{ id: 'ws-1', companyId: 'acme' }]);
    const ctx = CTX({ workspaceId: 'ws-1', slug: 'pi:xyz' });
    await tool.handler({ query: 'q', limit: 10 } as never, ctx as never);
    expect(ctx._log).toHaveBeenCalledTimes(1);
    const [level, msg, meta] = ctx._log.mock.calls[0];
    expect(level).toBe('info');
    expect(String(msg)).toContain('deprecated');
    expect(meta).toMatchObject({ principal: 'pi:xyz', query_len: 1 });
  });

  it('emits the deprecation log even on the not-configured path', async () => {
    readImpl = () => null;
    const ctx = CTX();
    await tool.handler({ query: 'hello', limit: 10 } as never, ctx as never);
    expect(ctx._log).toHaveBeenCalledTimes(1);
    expect(ctx._log.mock.calls[0][1]).toContain('features:get');
  });

  it('is degraded with empty data regardless of input', async () => {
    readImpl = () => registryJson([{ id: 'ws-1', companyId: 'x' }]);
    const res = await tool.handler({ query: 'anything', limit: 50 } as never, CTX({ workspaceId: 'ws-1' }) as never);
    expect(res.data).toEqual([]);
    expect(res.degraded).toBe(true);
  });
});
