import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { Route } from 'playwright-core';
import { browserScope, browserSessionArg, runBrowserSession, type BrowserDeps } from './browser-session';
import fetchTool from './fetch';

const trusted = { kind: 'trusted', reason: 'superuser' } as const;
const ctx = (owner = 'browser-test-owner', workspace = 'browser-test-workspace') => ({
  uiClientId: owner, workspaceId: workspace, harnessSlug: 'papercusp', role: 'operator',
  signal: new AbortController().signal, log: vi.fn(),
  isSuperuser: true,
}) as unknown as UnifiedToolContext;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });
function fixture() {
  let relay!: (route: Route) => Promise<void>;
  const page = { goto: vi.fn(async () => {}), locator: vi.fn(() => ({ waitFor: vi.fn(async () => {}) })),
    evaluate: vi.fn(async () => ({ url: 'https://example.com/', title: 'page', text: 'rendered', links: [], truncated: false })),
    screenshot: vi.fn(async () => Buffer.from('png')) };
  const context = { route: vi.fn(async (_pattern, handler) => { relay = handler; }), routeWebSocket: vi.fn(async () => {}),
    newPage: vi.fn(async () => page), on: vi.fn() };
  const server = { close: vi.fn(async () => {}), kill: vi.fn(async () => {}), on: vi.fn() };
  const profile = vi.fn<BrowserDeps['profile']>(async () => trusted);
  const release = vi.fn(async () => {});
  const deps = {
    profile,
    launch: vi.fn(async () => ({ server, browser: { newContext: vi.fn(async () => context) }, taskId: 'browser-fixture-task', profile: trusted, sandbox: { mode: 'bwrap', sandboxed: true } })),
    fetch: vi.fn(async () => ({ response: new Response('safe'), release })),
  } as unknown as BrowserDeps;
  async function call(args: Parameters<typeof runBrowserSession>[0], owner = ctx(), url?: string) {
    const result = await runBrowserSession(args, url, owner, { timeoutMs: 1000, maxText: 500 }, deps);
    return { result, payload: JSON.parse(result.content[0].text!) };
  }
  async function open(owner = ctx()) {
    const { payload } = await call({ op: 'open' }, owner);
    expect(payload.ok).toBe(true); const id = payload.browser.id as string;
    cleanup.push(() => call({ op: 'close', id }, owner)); return id;
  }
  return { deps, page, server, profile, context, release, call, open, relay: () => relay };
}
function request(url = 'https://example.com/', method = 'GET') {
  return { request: () => ({ url: () => url, method: () => method, headers: () => ({ accept: 'text/html' }), redirectedFrom: () => null }),
    abort: vi.fn(async () => {}), fulfill: vi.fn(async () => {}) } as unknown as Route;
}

describe('managed browser authority and lifecycle', () => {
  it('keeps HTTP input compatible and validates lifecycle without model-authored authority', () => {
    expect(fetchTool.args.safeParse({ url: 'https://example.com' }).success).toBe(true);
    expect(fetchTool.args.safeParse({}).success).toBe(false);
    expect(fetchTool.args.safeParse({ browser: { op: 'open' } }).success).toBe(true);
    expect(fetchTool.args.safeParse({ browser: { op: 'navigate' } }).success).toBe(false);
    expect(fetchTool.args.safeParse({ browser: { op: 'open', scope: 'foreign' } }).success).toBe(false);
    expect(fetchTool.args.safeParse({ browser: { op: 'open' }, headers: { cookie: 'secret' } }).success).toBe(false);
    expect(browserSessionArg.safeParse({ op: 'open', id: crypto.randomUUID() }).success).toBe(false);
    expect(browserScope(ctx('a:b', 'c'))).not.toBe(browserScope(ctx('b', 'c:a')));
    expect(() => browserScope({ workspaceId: 'unattributed' } as UnifiedToolContext)).toThrow();
  });
  it('refuses file and credential URLs before launching any browser', async () => {
    const f = fixture();
    expect((await f.call({ op: 'open' }, ctx(), 'file:///etc/passwd')).payload.ok).toBe(false);
    expect((await f.call({ op: 'open' }, ctx(), 'https://user:password@example.com')).payload.ok).toBe(false);
    expect(f.deps.launch).not.toHaveBeenCalled();
  });
  it('denies another owner/workspace, closes explicitly, and reports ended handles unrecoverable', async () => {
    const f = fixture(); const id = await f.open();
    expect((await f.call({ op: 'observe', id }, ctx('foreign'))).payload.error).toBe('browser_unrecoverable');
    expect((await f.call({ op: 'close', id }, ctx('browser-test-owner', 'foreign'))).payload.ok).toBe(false);
    expect(f.server.close).not.toHaveBeenCalled();
    expect((await f.call({ op: 'close', id })).payload.browser.state).toBe('closed');
    expect((await f.call({ op: 'observe', id })).payload.error).toBe('browser_unrecoverable');
  });
  it('refuses cached authority after a role/profile change before another navigation', async () => {
    const f = fixture(); const id = await f.open();
    f.profile.mockResolvedValueOnce({ kind: 'confined', reason: 'autonomous-caller' });
    expect((await f.call({ op: 'navigate', id }, ctx(), 'https://example.com')).payload.error).toBe('browser_authority_changed');
    expect(f.page.goto).not.toHaveBeenCalled(); expect(f.server.close).toHaveBeenCalledOnce();
  });
  it('relays read requests only during a current operation and never caches its authority', async () => {
    const f = fixture(); const id = await f.open(); const idle = request();
    await f.relay()(idle); expect(idle.abort).toHaveBeenCalled(); expect(f.deps.fetch).not.toHaveBeenCalled();
    f.page.goto.mockImplementationOnce(async () => {
      const read = request(); await f.relay()(read); expect(read.fulfill).toHaveBeenCalled();
      const write = request('https://example.com/', 'POST'); await f.relay()(write); expect(write.abort).toHaveBeenCalled();
    });
    const { payload } = await f.call({ op: 'navigate', id }, ctx(), 'https://example.com/');
    expect(payload.network.refused).toContain('browser_remote_write_forbidden');
    expect(f.deps.fetch).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
    expect(f.deps.fetch).toHaveBeenCalledWith(expect.objectContaining({ profile: trusted, redirectMode: 'manual' }));
  });
  it('rejects overlapping calls, bounds media, and resets output between observations', async () => {
    const f = fixture(); const id = await f.open();
    let resume!: () => void; const held = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: () => void; const entry = new Promise<void>((resolve) => { entered = resolve; });
    f.page.goto.mockImplementationOnce(async () => { entered(); await held; });
    const first = f.call({ op: 'navigate', id, screenshot: true }, ctx(), 'https://example.com'); await entry;
    expect((await f.call({ op: 'observe', id })).payload.error).toBe('browser_busy');
    resume(); expect((await first).result.content[1].type).toBe('image');
    expect((await f.call({ op: 'observe', id })).result.content).toHaveLength(1);
  });
  it('fails closed on launch/confinement failure and releases pending capacity', async () => {
    const f = fixture(); vi.mocked(f.deps.launch).mockRejectedValueOnce(new Error('capability_exec_confinement_unavailable'));
    expect((await f.call({ op: 'open' })).payload).toMatchObject({ ok: false, executed: false });
    await f.open(); await f.open();
    expect((await f.call({ op: 'open' })).payload.error).toBe('browser_scope_limit');
  });
  it('serializes explicit close with active cancellation and never reports closure early', async () => {
    const f = fixture(); const owner = ctx(); const id = await f.open(owner);
    let entered!: () => void; const entry = new Promise<void>((resolve) => { entered = resolve; });
    let stop!: () => void;
    f.page.goto.mockImplementationOnce(async () => { entered(); await new Promise<void>((resolve) => { stop = resolve; }); throw new Error('closed'); });
    f.server.close.mockImplementationOnce(async () => { stop(); });
    const running = f.call({ op: 'navigate', id }, owner, 'https://example.com'); await entry;
    const closed = await f.call({ op: 'close', id }, owner);
    expect(closed.payload.browser.state).toBe('closed');
    expect((await running).payload.ok).toBe(false);
    expect(f.server.close).toHaveBeenCalledOnce();
  });
});
