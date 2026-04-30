import { describe, expect, it, vi } from 'vitest';
import {
  ServerActionRegistry,
  ActionRegistryError,
  type ActionDecl,
} from './actions';
import { InMemoryAuditWriter } from './audit';

const decl = (over: Partial<ActionDecl> = {}): ActionDecl => ({
  name: 'publish',
  capabilities: ['http:fetch:publish.papercuspai.com'],
  serverHandler: { timeoutSec: 1 },
  ...over,
});

const ctx = { installSlug: 'sheets' };

describe('ServerActionRegistry construction', () => {
  it('accepts an action whose caps are subset of plugin caps', () => {
    const r = new ServerActionRegistry([decl()], {
      pluginName: '@x/p',
      pluginCapabilities: ['http:fetch:publish.papercuspai.com'],
    });
    expect(r.declaredNames()).toEqual(['publish']);
  });

  it('rejects an action whose caps escalate beyond plugin caps', () => {
    expect(
      () =>
        new ServerActionRegistry([decl({ capabilities: ['secrets:read:OPENAI'] })], {
          pluginName: '@x/p',
          pluginCapabilities: ['http:fetch:publish.papercuspai.com'],
        }),
    ).toThrow(ActionRegistryError);
  });

  it('honors wildcard plugin caps when validating actions', () => {
    expect(
      () =>
        new ServerActionRegistry([decl({ capabilities: ['http:fetch:api.cloudflare.com'] })], {
          pluginName: '@x/p',
          pluginCapabilities: ['http:fetch:*.cloudflare.com'],
        }),
    ).not.toThrow();
  });

  it('rejects duplicate action declarations', () => {
    expect(
      () =>
        new ServerActionRegistry([decl(), decl()], {
          pluginName: '@x/p',
          pluginCapabilities: ['http:fetch:publish.papercuspai.com'],
        }),
    ).toThrow(/duplicate/);
  });

  it('accepts an empty/missing actions array', () => {
    expect(() => new ServerActionRegistry(undefined, { pluginName: '@x/p' })).not.toThrow();
    expect(() => new ServerActionRegistry([], { pluginName: '@x/p' })).not.toThrow();
  });
});

describe('register / seal / invoke', () => {
  it('register requires a declared action name', () => {
    const r = new ServerActionRegistry([decl()], { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] });
    expect(() => r.register('other', async () => ({ ok: true }))).toThrow(/not declared/);
  });

  it('register fails for non-function handler', () => {
    const r = new ServerActionRegistry([decl()], { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] });
    expect(() => r.register('publish', 'not-a-fn' as unknown as () => Promise<{ok:boolean}>)).toThrow(/must be a function/);
  });

  it('register rejects duplicates', () => {
    const r = new ServerActionRegistry([decl()], { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] });
    r.register('publish', async () => ({ ok: true }));
    expect(() => r.register('publish', async () => ({ ok: true }))).toThrow(/already registered/);
  });

  it('register fails after seal', () => {
    const r = new ServerActionRegistry([decl()], { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] });
    r.seal();
    expect(() => r.register('publish', async () => ({ ok: true }))).toThrow(/sealed/);
  });

  it('invoke dispatches handler and returns its envelope', async () => {
    const r = new ServerActionRegistry([decl()], { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] });
    r.register('publish', async () => ({ ok: true, result: { url: 'https://x' } }));
    r.seal();
    const out = await r.invoke({ name: 'publish', ctx, triggerSource: 'cli', triggerId: 't1' });
    expect(out).toEqual({ ok: true, result: { url: 'https://x' } });
  });

  it('invoke wraps a thrown error', async () => {
    const r = new ServerActionRegistry([decl()], { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] });
    r.register('publish', async () => { throw new Error('boom'); });
    r.seal();
    const out = await r.invoke({ name: 'publish', ctx, triggerSource: 'cli', triggerId: 't1' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('boom');
  });

  it('invoke fails on unknown action name', async () => {
    const r = new ServerActionRegistry([decl()], { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] });
    r.seal();
    const out = await r.invoke({ name: 'nope', ctx, triggerSource: 'cli', triggerId: 't1' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not declared/);
  });

  it('invoke times out via AbortSignal', async () => {
    vi.useFakeTimers();
    const r = new ServerActionRegistry(
      [decl({ serverHandler: { timeoutSec: 1 } })],
      { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] },
    );
    r.register('publish', async (_c, _p, signal) =>
      new Promise<{ ok: boolean }>(() => {
        // never resolves; relies on AbortSignal
        signal.addEventListener('abort', () => { /* no-op */ });
      }),
    );
    r.seal();
    const p = r.invoke({ name: 'publish', ctx, triggerSource: 'cli', triggerId: 't1' });
    vi.advanceTimersByTime(1500);
    const out = await p;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/timed out/);
    vi.useRealTimers();
  });

  it('audits each invoke', async () => {
    const audit = new InMemoryAuditWriter();
    const r = new ServerActionRegistry([decl()], {
      pluginName: '@x/p',
      pluginCapabilities: ['http:fetch:publish.papercuspai.com'],
      audit,
    });
    r.register('publish', async () => ({ ok: true }));
    r.seal();
    await r.invoke({ name: 'publish', ctx, triggerSource: 'ui', triggerId: 'click-1', params: { dryRun: true } });
    const rows = audit.rowsForInspection();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('ok');
    expect(rows[0]?.actionName).toBe('publish');
    expect(rows[0]?.installSlug).toBe('sheets');
    expect(rows[0]?.triggerSource).toBe('ui');
    expect(rows[0]?.params).toEqual({ dryRun: true });
  });

  it('passes params to handler', async () => {
    const r = new ServerActionRegistry([decl()], { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] });
    let captured: unknown;
    r.register('publish', async (_c, params) => { captured = params; return { ok: true }; });
    r.seal();
    await r.invoke({ name: 'publish', ctx, triggerSource: 'cli', triggerId: 't', params: { exportDir: 'dist' } });
    expect(captured).toEqual({ exportDir: 'dist' });
  });

  it('normalizes raw value into {ok:true,result:<value>}', async () => {
    const r = new ServerActionRegistry([decl()], { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] });
    r.register('publish', async () => 'plain string' as unknown as { ok: boolean });
    r.seal();
    const out = await r.invoke({ name: 'publish', ctx, triggerSource: 'cli', triggerId: 't1' });
    expect(out).toEqual({ ok: true, result: 'plain string' });
  });

  it('handles synchronous handler return', async () => {
    const r = new ServerActionRegistry([decl()], { pluginName: '@x/p', pluginCapabilities: ['http:fetch:publish.papercuspai.com'] });
    r.register('publish', () => ({ ok: true, result: 'sync' }));
    r.seal();
    const out = await r.invoke({ name: 'publish', ctx, triggerSource: 'cli', triggerId: 't1' });
    expect(out).toEqual({ ok: true, result: 'sync' });
  });
});
